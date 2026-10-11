import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { reasoningCapabilities } from "./aiReasoning.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function modelList(items) {
  const models = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || item.slug || "");
    if (!MODEL_ID.test(id) || item.visibility === "hide") continue;
    models.set(id, { id, name: String(item.display_name || item.name || id).slice(0, 200), ...reasoningCapabilities(item) });
    if (models.size >= 200) break;
  }
  return [...models.values()];
}

/** Read only model metadata from the host CLI cache; never expose account identity. */
export async function readCodexModels({ directory = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  const filename = path.join(directory, "models_cache.json");
  try {
    if ((await stat(filename)).size > MAX_BYTES) throw new Error("模型缓存过大");
    const cache = JSON.parse(await readFile(filename, "utf8"));
    return { models: modelList(cache.models), source: "codex-cache", fetchedAt: String(cache.fetched_at || "").slice(0, 80) };
  } catch (error) {
    if (error?.code === "ENOENT") return { models: [], source: "codex-cache", warning: "Codex 暂无模型缓存；可输入模型名称，或先检查 AI 连接后重新读取" };
    throw new Error("读取 Codex 模型列表失败；仍可手动输入模型名称");
  }
}

function readBridgeModels(settings, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: settings.cliSocketPath, path: "/v1/models", method: "GET" }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        if ((size += chunk.length) > MAX_BYTES) request.destroy(new Error("模型列表过大"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("宿主机桥接不支持模型列表，请更新并重启桥接服务");
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("读取 Codex 模型列表超时")));
    request.on("error", () => reject(new Error("读取宿主机模型列表失败；请检查 Codex 桥接服务")));
    request.end();
  });
}

/** Providers supply their own model IDs; there is no hardcoded recommended-model list. */
export async function listAiModels(settings, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (settings.provider === "cli") {
    if (!settings.cliSocketPath) throw new Error("Codex CLI 桥接未配置");
    const result = await readBridgeModels(settings, timeoutMs);
    return { ...result, models: modelList(result.models) };
  }
  const local = settings.provider === "local-http";
  const baseUrl = local ? settings.localBaseUrl : settings.baseUrl;
  const apiKey = local ? "" : settings.apiKey;
  if (!baseUrl || (!local && !apiKey)) throw new Error("请先保存 AI 服务地址和密钥，再读取模型列表");
  const base = String(baseUrl).replace(/\/chat\/completions\/?$/i, "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), Accept: "application/json" },
      signal: controller.signal, redirect: "error",
    });
    if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.length) > MAX_BYTES) throw new Error("模型列表过大");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { models: modelList(body.data), source: "provider" };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("读取模型列表超时；仍可手动输入模型名称");
    if (/^模型列表 (?:HTTP|过大)/.test(error?.message || "")) throw error;
    throw new Error("AI 服务未提供可用的模型列表；仍可手动输入模型名称");
  } finally { clearTimeout(timer); }
}
