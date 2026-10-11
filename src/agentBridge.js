import { createServer } from "node:http";
import { chmod, chown, lstat, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { cliAdapters, normalizeCliMessage } from "./cliAdapters.js";

const MAX_REQUEST_BYTES = 160 * 1024;
const MAX_ACTIVE = 8;

export function createAgentBridge({ dataDir = "./data", adapters = cliAdapters } = {}) {
  const directory = path.join(path.resolve(dataDir), "private-settings");
  const socketPath = path.join(directory, "agent.sock");
  let active = 0;
  const running = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/completion") {
      response.writeHead(404).end();
      return;
    }
    if (active >= MAX_ACTIVE) {
      response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "CLI 桥接繁忙" }));
      return;
    }
    active += 1;
    const controller = new AbortController();
    running.add(controller);
    response.on("close", () => { if (!response.writableEnded) controller.abort(new Error("客户端已断开")); });
    const timer = setTimeout(() => controller.abort(new Error("CLI 运行超时")), 120_000);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("CLI 输入超过 160 KiB 上限");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || body.client !== "codex" || !Array.isArray(body.messages) || !Array.isArray(body.tools || [])) {
        throw new Error("CLI 请求格式错误或客户端不受支持");
      }
      body.tools ||= [];
      const adapter = adapters[body.client];
      if (typeof adapter !== "function") throw new Error("CLI 客户端不可用");
      const result = await adapter(body, { signal: controller.signal });
      const message = normalizeCliMessage(result, body.tools || []);
      if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message }));
    } catch (error) {
      if (!response.destroyed) response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error?.message || "CLI 桥接失败").slice(0, 240) }));
    } finally {
      clearTimeout(timer);
      running.delete(controller);
      active -= 1;
    }
  });

  async function listen() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      const info = await lstat(socketPath);
      if (!info.isSocket()) throw new Error("CLI socket 路径被非 socket 文件占用");
      // Never replace another live bridge.
      const { connect } = await import("node:net");
      const occupied = await new Promise((resolve) => {
        const probe = connect(socketPath);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", () => resolve(false));
      });
      if (occupied) throw new Error("CLI 桥接已在运行");
      await unlink(socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const owner = await stat(directory);
    if (process.getuid?.() === 0) await chown(socketPath, owner.uid, owner.gid);
    return socketPath;
  }

  async function close() {
    for (const controller of running) controller.abort(new Error("CLI 桥接正在关闭"));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    try { await unlink(socketPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  return { listen, close, socketPath, server };
}
