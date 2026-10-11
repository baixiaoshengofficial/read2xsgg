import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeReasoningEffort } from "./aiReasoning.js";

const EMPTY_SETTINGS = Object.freeze({
  enabled: false,
  provider: "api",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  reasoningEffort: "",
  apiKey: "",
  localBaseUrl: "",
  localModel: "",
  localReasoningEffort: "",
  cliClient: "codex",
  cliModel: "",
  cliReasoningEffort: "",
  mcpEndpoint: "",
  mcpToken: "",
  timeoutMs: 30_000,
  maxToolCalls: 4,
  maxAttempts: 2,
  concurrency: 2,
});

export class AiSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiSettingsError";
    this.status = 400;
  }
}

function cleanString(value, label, maxLength) {
  const result = String(value ?? "").trim();
  if (result.length > maxLength) throw new AiSettingsError(`${label}过长`);
  return result;
}

function normalizeHttpUrl(value, label, { allowEmpty = true } = {}) {
  const raw = cleanString(value, label, 2_048);
  if (!raw && allowEmpty) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AiSettingsError(`${label}必须是有效的 http(s) URL`);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new AiSettingsError(`${label}只支持不含用户名/密码的 http(s) URL`);
  }
  if (url.search || url.hash) throw new AiSettingsError(`${label}不能包含查询参数或片段`);
  return url.toString().replace(/\/$/, "");
}

function normalizeSettings(value = {}) {
  const efforts = {};
  for (const key of ["reasoningEffort", "localReasoningEffort", "cliReasoningEffort"]) {
    try { efforts[key] = normalizeReasoningEffort(value[key]); }
    catch { throw new AiSettingsError("推理档位无效"); }
  }
  const provider = cleanString(value.provider ?? EMPTY_SETTINGS.provider, "AI 接入方式", 32);
  if (!["api", "local-http", "cli"].includes(provider)) throw new AiSettingsError("不支持的 AI 接入方式");
  const cliClient = cleanString(value.cliClient ?? EMPTY_SETTINGS.cliClient, "CLI 客户端", 32);
  if (cliClient !== "codex") throw new AiSettingsError("当前仅支持 Codex CLI");
  const cliModel = cleanString(value.cliModel, "Codex 模型名称", 200);
  if (cliModel && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(cliModel)) throw new AiSettingsError("Codex 模型名称格式无效");
  return {
    ...efforts,
    enabled: Boolean(value.enabled),
    provider,
    baseUrl: normalizeHttpUrl(value.baseUrl ?? EMPTY_SETTINGS.baseUrl, "AI Base URL", { allowEmpty: false }),
    model: cleanString(value.model, "AI 模型名", 200),
    apiKey: cleanString(value.apiKey, "AI API Key", 8_192),
    localBaseUrl: normalizeHttpUrl(value.localBaseUrl, "本地模型地址"),
    localModel: cleanString(value.localModel, "本地模型名", 200),
    cliClient,
    cliModel,
    mcpEndpoint: normalizeHttpUrl(value.mcpEndpoint, "MCP 地址"),
    mcpToken: cleanString(value.mcpToken, "MCP Bearer Token", 8_192),
    timeoutMs: Math.min(120_000, Math.max(5_000, Number(value.timeoutMs) || EMPTY_SETTINGS.timeoutMs)),
    maxToolCalls: Math.min(8, Math.max(0, Number(value.maxToolCalls) || 0)),
    maxAttempts: Math.min(3, Math.max(1, Number(value.maxAttempts) || EMPTY_SETTINGS.maxAttempts)),
    concurrency: Math.min(8, Math.max(1, Number(value.concurrency) || EMPTY_SETTINGS.concurrency)),
  };
}

/**
 * Stores the optional AI integration under DATA_DIR, outside the source tree.
 * The file and its parent directory are owner-only; secret values are never
 * included in the public settings view or application logs.
 */
export function createAiSettingsStore(dataDir) {
  const directory = path.join(path.resolve(dataDir || "./data"), "private-settings");
  const filePath = path.join(directory, "ai.json");
  let cached;
  let writeTail = Promise.resolve();

  async function get() {
    if (cached) return structuredClone(cached);
    try {
      const raw = await readFile(filePath, "utf8");
      await chmod(directory, 0o700);
      await chmod(filePath, 0o600);
      cached = normalizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      cached = normalizeSettings(EMPTY_SETTINGS);
    }
    return structuredClone(cached);
  }

  async function save(input = {}) {
    const operation = writeTail.catch(() => {}).then(async () => {
      const current = await get();
      const supplied = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      const next = normalizeSettings({
        ...current,
        ...supplied,
        apiKey: input.clearApiKey
          ? ""
          : (String(input.apiKey ?? "").trim() ? input.apiKey : current.apiKey),
        mcpToken: input.clearMcpToken
          ? ""
          : (String(input.mcpToken ?? "").trim() ? input.mcpToken : current.mcpToken),
      });
      delete next.clearApiKey;
      delete next.clearMcpToken;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filePath);
        await chmod(filePath, 0o600);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      cached = next;
      return structuredClone(next);
    });
    writeTail = operation;
    return operation;
  }

  return { get, save };
}

export function publicAiSettings(settings = {}) {
  return {
    enabled: Boolean(settings.enabled),
    provider: settings.provider || EMPTY_SETTINGS.provider,
    baseUrl: settings.baseUrl || EMPTY_SETTINGS.baseUrl,
    model: settings.model || "",
    reasoningEffort: settings.reasoningEffort || "",
    apiKeyConfigured: Boolean(settings.apiKey),
    localBaseUrl: settings.localBaseUrl || "",
    localModel: settings.localModel || "",
    localReasoningEffort: settings.localReasoningEffort || "",
    cliClient: settings.cliClient || EMPTY_SETTINGS.cliClient,
    cliModel: settings.cliModel || "",
    cliReasoningEffort: settings.cliReasoningEffort || "",
    crawlMode: "builtin-auto",
    timeoutMs: Number(settings.timeoutMs) || EMPTY_SETTINGS.timeoutMs,
    maxAttempts: Number(settings.maxAttempts) || EMPTY_SETTINGS.maxAttempts,
    concurrency: Number(settings.concurrency) || EMPTY_SETTINGS.concurrency,
    skills: [
      { id: "site-to-xiangse", version: "1", types: ["text", "comic", "audio", "video"] },
    ],
  };
}
