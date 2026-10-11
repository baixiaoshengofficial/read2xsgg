const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;

function parseSse(text) {
  const messages = [];
  let data = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) {
      if (data.length) {
        const joined = data.join("\n");
        if (joined !== "[DONE]") {
          try { messages.push(JSON.parse(joined)); } catch { /* Ignore comments/partial server events. */ }
        }
      }
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length) {
    const joined = data.join("\n");
    if (joined !== "[DONE]") {
      try { messages.push(JSON.parse(joined)); } catch { /* Ignore incomplete SSE tail. */ }
    }
  }
  return messages;
}

async function responseMessages(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP 响应超过 2 MiB 上限");
  if (!text.trim()) return [];
  if (contentType.includes("text/event-stream")) return parseSse(text);
  try {
    return [JSON.parse(text)];
  } catch {
    throw new Error("MCP 返回了无效 JSON/SSE 响应");
  }
}

/** Minimal Streamable HTTP MCP client for trusted, admin-configured endpoints. */
export async function connectMcp({
  endpoint,
  bearerToken = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  signal: parentSignal,
} = {}) {
  const url = new URL(String(endpoint || ""));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("MCP 地址必须是有效的 http(s) URL");
  }
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有 fetch() 支持");

  let requestId = 0;
  let sessionId = "";
  let initialized = false;
  let negotiatedProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

  async function send(method, params = {}, { notification = false } = {}) {
    const id = notification ? undefined : ++requestId;
    const payload = {
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params && Object.keys(params).length ? { params } : {}),
    };
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    if (sessionId) headers["MCP-Session-Id"] = sessionId;
    if (initialized) headers["MCP-Protocol-Version"] = negotiatedProtocolVersion;

    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason || new Error("MCP 请求已取消"));
    if (parentSignal?.aborted) onAbort();
    else parentSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("MCP 请求超时")), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`MCP 请求超时（${timeoutMs}ms）`);
      throw new Error(`MCP 连接失败：${error?.message || error}`);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok && response.status !== 202) {
      throw new Error(`MCP HTTP ${response.status}`);
    }
    const receivedSession = response.headers.get("mcp-session-id");
    if (receivedSession) sessionId = receivedSession;
    const messages = await responseMessages(response);
    if (notification) return null;
    const result = messages.find((message) => message?.id === id);
    if (!result) throw new Error(`MCP ${method} 未返回匹配的 JSON-RPC 响应`);
    if (result.error) {
      const message = String(result.error.message || `JSON-RPC ${result.error.code || "error"}`)
        .replaceAll(bearerToken, bearerToken ? "[redacted]" : "");
      throw new Error(`MCP ${method} 失败：${message.slice(0, 300)}`);
    }
    return result.result;
  }

  let initializedResult;
  let initializeError;
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    try {
      initializedResult = await send("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "read2xsgg", version: "1.0.0" },
      });
      negotiatedProtocolVersion = String(initializedResult?.protocolVersion || protocolVersion);
      break;
    } catch (error) {
      initializeError = error;
      sessionId = "";
      if (!/(?:protocol\s*version|version\s*(?:not supported|unsupported)|unsupported\s*version)/i.test(String(error?.message || error))) throw error;
    }
  }
  if (!initializedResult || typeof initializedResult !== "object") {
    throw initializeError || new Error("MCP 初始化响应格式无效");
  }
  initialized = true;
  await send("notifications/initialized", {}, { notification: true });

  async function listTools() {
    let cursor;
    const result = [];
    for (let page = 0; page < 8; page += 1) {
      const response = await send("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(response?.tools)) result.push(...response.tools);
      cursor = String(response?.nextCursor || "");
      if (!cursor) return result;
    }
    throw new Error("MCP 工具分页超过 8 页限制");
  }

  async function callTool(name, arguments_) {
    return send("tools/call", { name: String(name), arguments: arguments_ || {} });
  }

  async function close() {
    if (!sessionId) return;
    try {
      await fetchImpl(url, {
        method: "DELETE",
        headers: {
          "MCP-Session-Id": sessionId,
          "MCP-Protocol-Version": negotiatedProtocolVersion,
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
        redirect: "error",
      });
    } catch {
      // Stateless/legacy MCP servers commonly do not implement session DELETE.
    }
  }

  return { listTools, callTool, close };
}

export async function probeMcp(settings, options = {}) {
  if (!settings?.mcpEndpoint) throw new Error("尚未配置 MCP 地址");
  const client = await connectMcp({
    endpoint: settings.mcpEndpoint,
    bearerToken: settings.mcpToken,
    ...options,
  });
  try {
    const tools = await client.listTools();
    return { toolCount: tools.length, toolNames: tools.map((tool) => String(tool.name || "")).slice(0, 40) };
  } finally {
    await client.close();
  }
}
