import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAiModels, readCodexModels } from "../src/aiModels.js";
import { createAgentBridge } from "../src/agentBridge.js";

test("Codex 模型缓存只返回模型元数据，不返回账号身份或隐藏模型", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-model-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual((await readCodexModels({ directory })).models, []);
  await writeFile(path.join(directory, "models_cache.json"), JSON.stringify({
    fetched_at: "2026-10-07", identity: { token: "private-identity" },
    models: [{ slug: "fixture-model", display_name: "Fixture", visibility: "list", extra: "private-field", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra", description: "private-description" }, { effort: "invalid" }, { effort: "low" }] },
      { slug: "hidden-model", visibility: "hide" }, { slug: "invalid model" }],
  }));
  const result = await readCodexModels({ directory });
  assert.deepEqual(result.models, [{ id: "fixture-model", name: "Fixture", reasoningEfforts: ["low", "medium", "ultra"], defaultReasoningEffort: "medium" }]);
  assert.doesNotMatch(JSON.stringify(result), /private-identity|private-field|private-description|hidden-model/);
});

test("Codex 模型列表经私有 socket 读取，不需要生成调用或外挂凭据", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-model-bridge-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = createAgentBridge({ dataDir: directory, adapters: {}, listModels: async () => ({ source: "codex-cache", models: [{ id: "fixture-model", name: "Fixture", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }] }) });
  await bridge.listen();
  context.after(() => bridge.close());
  const result = await listAiModels({ provider: "cli", cliSocketPath: bridge.socketPath });
  assert.equal(result.source, "codex-cache");
  assert.deepEqual(result.models, [{ id: "fixture-model", name: "Fixture", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }]);
});

test("API 与本地模型读取对应服务的 /models，凭据不会跨模式发送", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ data: [{ id: "fixture-model", owned_by: "private-owner" }] }));
  };
  const result = await listAiModels({ provider: "api", baseUrl: "https://api.example.test/v1/chat/completions", apiKey: "private-key" }, { fetchImpl });
  assert.deepEqual(result.models, [{ id: "fixture-model", name: "fixture-model" }]);
  assert.equal(seen[0].url, "https://api.example.test/v1/models");
  assert.equal(seen[0].options.headers.Authorization, "Bearer private-key");
  assert.equal(seen[0].options.redirect, "error");
  await listAiModels({ provider: "local-http", localBaseUrl: "http://127.0.0.1:11434/v1", apiKey: "private-key" }, { fetchImpl });
  assert.equal(seen[1].options.headers.Authorization, undefined);
  await assert.rejects(listAiModels({ provider: "api", baseUrl: "https://api.example.test/v1", apiKey: "private-key" }, {
    fetchImpl: async () => new Response('{"error":"private-key"}', { status: 401 }),
  }), /^Error: 模型列表 HTTP 401$/);
});
