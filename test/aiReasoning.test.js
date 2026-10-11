import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeReasoningEffort, reasoningCapabilities, selectedReasoningEffort } from "../src/aiReasoning.js";
import { runCodex } from "../src/cliAdapters.js";
import { requestAiCompletion, probeAiProvider } from "../src/aiProvider.js";

test("推理档位为有限协议值，能力列表去重并保留明确不支持推理的模型", () => {
  assert.equal(normalizeReasoningEffort(undefined), "");
  assert.equal(normalizeReasoningEffort(" max "), "max");
  assert.throws(() => normalizeReasoningEffort('high" --config dangerous'), /档位无效/);
  assert.deepEqual(reasoningCapabilities({ supported_reasoning_levels: [] }), { reasoningEfforts: [] });
  assert.deepEqual(reasoningCapabilities({ supported_reasoning_levels: [null, { effort: "high" }, { effort: "high" }, { effort: "invalid" }], default_reasoning_level: "medium" }), { reasoningEfforts: ["high"] });
  assert.deepEqual(reasoningCapabilities({}), {});
  const settings = { reasoningEffort: "low", localReasoningEffort: "medium", cliReasoningEffort: "high" };
  assert.equal(selectedReasoningEffort({ ...settings, provider: "cli" }), "high");
  assert.equal(selectedReasoningEffort({ ...settings, provider: "local-http" }), "medium");
  assert.equal(selectedReasoningEffort({ ...settings, provider: "api" }), "low");
});

test("Codex 档位真实传入配置参数，默认不覆盖，非法或已知不兼容档位不执行", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-effort-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const target = args[args.indexOf("--output-last-message") + 1];
await writeFile(target, JSON.stringify({ content: JSON.stringify(args), toolCalls: [] }));
`, { mode: 0o700 });
  const listModels = async () => ({ models: [{ id: "fixture", reasoningEfforts: ["low", "high", "ultra"] }] });
  const options = { executable, listModels };
  const request = { model: "fixture", messages: [], tools: [] };
  const baseline = JSON.parse((await runCodex(request, options)).content);
  assert.equal(baseline.includes("--config"), false);
  for (const reasoningEffort of ["low", "high", "ultra"]) {
    const args = JSON.parse((await runCodex({ ...request, reasoningEffort }, options)).content);
    assert.equal(args[args.indexOf("--model") + 1], "fixture");
    assert.equal(args[args.indexOf("--config") + 1], `model_reasoning_effort="${reasoningEffort}"`);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(args.includes("--ignore-user-config"));
  }
  await assert.rejects(runCodex({ ...request, reasoningEffort: "max" }, options), /不支持该推理档位/);
  await assert.rejects(runCodex({ ...request, reasoningEffort: 'high"; exec' }, options), /档位无效/);
  const noCache = { ...options, listModels: async () => { throw new Error("missing cache"); } };
  const custom = JSON.parse((await runCodex({ ...request, model: "custom-model", reasoningEffort: "high" }, noCache)).content);
  assert.equal(custom[custom.indexOf("--config") + 1], 'model_reasoning_effort="high"');
});

test("API 与本地推理档位独立传递，默认兼容旧请求，推理调用省略温度", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "READY" } }] }));
  };
  const settings = { enabled: true, provider: "api", baseUrl: "https://api.example.test/v1", apiKey: "private-key", model: "api-model", localBaseUrl: "http://127.0.0.1:11434/v1", localModel: "local-model" };
  await requestAiCompletion({ settings, messages: [], fetchImpl });
  assert.equal(requests[0].body.reasoning_effort, undefined);
  assert.equal(requests[0].body.temperature, 0);
  assert.equal(requests[0].body.max_tokens, 2_000);
  const result = await probeAiProvider({ ...settings, reasoningEffort: "high", localReasoningEffort: "low" }, { fetchImpl });
  assert.equal(result.reasoningEffort, "high");
  assert.equal(requests[1].body.reasoning_effort, "high");
  assert.equal(requests[1].body.temperature, undefined);
  assert.equal(requests[1].body.max_tokens, undefined);
  assert.equal(requests[1].body.max_completion_tokens, 1_024);
  await requestAiCompletion({ settings: { ...settings, provider: "local-http", reasoningEffort: "high", localReasoningEffort: "low" }, messages: [], fetchImpl });
  assert.equal(requests[2].body.reasoning_effort, "low");
  assert.equal(requests[2].body.model, "local-model");
  assert.equal(requests[2].headers.Authorization, undefined);
  await requestAiCompletion({ settings: { ...settings, provider: "local-http", reasoningEffort: "high" }, messages: [], fetchImpl });
  assert.equal(requests[3].body.reasoning_effort, undefined);
  await assert.rejects(requestAiCompletion({ settings: { ...settings, reasoningEffort: "ultra" }, messages: [], fetchImpl }), /不支持 ultra/);
  await assert.rejects(requestAiCompletion({ settings: { ...settings, reasoningEffort: "invalid" }, messages: [], fetchImpl }), /档位无效/);
  assert.equal(requests.length, 4);
});
