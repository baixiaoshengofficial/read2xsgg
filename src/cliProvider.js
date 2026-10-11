import { request as httpRequest } from "node:http";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function requestCliCompletion({ settings, messages, tools, timeoutMs = settings?.timeoutMs || 30_000, maxTokens = 2_000, signal } = {}) {
  if (settings?.cliClient !== "codex" || !settings?.cliSocketPath) throw new Error("Codex CLI 桥接未配置");
  const body = JSON.stringify({ client: settings.cliClient, model: settings.cliModel || "", reasoningEffort: settings.cliReasoningEffort || "", messages, tools, maxTokens });
  if (Buffer.byteLength(body) > 160 * 1024) throw new Error("CLI 识站输入超过 160 KiB 上限");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || new Error("CLI 请求已取消"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("CLI 请求超时")), timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: settings.cliSocketPath,
        path: "/v1/completion",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        signal: controller.signal,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error("CLI 响应超过 4 MiB 上限")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode !== 200) throw new Error(String(result.error || "CLI 桥接失败").slice(0, 240));
            if (!result.message || typeof result.message !== "object") throw new Error("CLI 桥接响应缺少 message");
            resolve(result.message);
          } catch (error) { reject(error); }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(body);
    });
  } catch (error) {
    if (controller.signal.aborted) throw signal?.aborted ? (signal.reason instanceof Error ? signal.reason : new Error("CLI 请求已取消")) : new Error(`CLI 请求超时（${timeoutMs}ms）`);
    if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") throw new Error("宿主机 CLI 桥接未启动；请运行 npm run agent:bridge");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
