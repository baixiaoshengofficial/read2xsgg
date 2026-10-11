function chatCompletionsUrl(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!value) throw new Error("尚未配置 AI Base URL");
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

function safeProviderError(status, text, apiKey = "") {
  let message = "";
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.error?.message || parsed?.message || "");
  } catch {
    // Avoid echoing HTML, credentials, and potentially large upstream bodies.
  }
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240);
  if (apiKey) message = message.split(apiKey).join("[redacted]");
  return new Error(`AI 服务 HTTP ${status}${message ? `：${message}` : ""}`);
}

export async function requestChatCompletion({
  settings,
  messages,
  tools,
  timeoutMs = settings?.timeoutMs || 30_000,
  maxTokens = 2_000,
  fetchImpl = globalThis.fetch,
  signal,
  allowAnonymous = false,
} = {}) {
  if (!settings?.apiKey && !allowAnonymous) throw new Error("尚未配置 AI API Key");
  if (!settings?.model) throw new Error("尚未配置 AI 模型名");
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有 fetch() 支持");

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(signal.reason || new Error("AI 请求已取消"));
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("AI 请求超时")), timeoutMs);
  try {
    const response = await fetchImpl(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: "auto" } : {}),
        max_tokens: Math.min(4_000, Math.max(32, Number(maxTokens) || 2_000)),
        temperature: 0,
      }),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("AI 响应超过 4 MiB 上限");
    if (!response.ok) throw safeProviderError(response.status, text, settings.apiKey);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("AI 服务返回了无效 JSON");
    }
    const message = body?.choices?.[0]?.message;
    if (!message || typeof message !== "object") throw new Error("AI 响应缺少 choices[0].message");
    return message;
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("AI 请求已取消");
      throw new Error(`AI 请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

export async function testAiProvider(settings, options = {}) {
  const message = await requestChatCompletion({
    settings,
    messages: [
      { role: "system", content: "Reply with exactly READY." },
      { role: "user", content: "Connection test. Reply with exactly READY." },
    ],
    maxTokens: 16,
    ...options,
  });
  return { model: settings.model, response: String(message.content || "").slice(0, 80) };
}
