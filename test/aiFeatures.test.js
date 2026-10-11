import assert from "node:assert/strict";
import { chown, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiSettingsStore, publicAiSettings } from "../src/aiSettings.js";
import { aiProviderReady } from "../src/aiProvider.js";
import { requestAiCompletion, probeAiProvider } from "../src/aiProvider.js";
import { createAgentBridge } from "../src/agentBridge.js";
import { normalizeCliMessage, runCodex } from "../src/cliAdapters.js";
import { generateXiangseCandidate } from "../src/aiSiteAnalyzer.js";
import { connectMcp, probeMcp } from "../src/mcpClient.js";
import { requestChatCompletion, testAiProvider } from "../src/openAiCompat.js";
import { createAppServer, serverConfig } from "../src/server.js";
import { aiAttemptsThatFitBudget, applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
import { runLibraryJob } from "../src/jobRunner.js";

function testSource(host = "https://example.test") {
  const action = (actionID, fields = {}) => ({
    actionID,
    validConfig: "",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    ...fields,
  });
  return {
    sourceName: "Example",
    sourceUrl: host,
    sourceType: "text",
    weight: "100",
    miniAppVersion: "2.56.1",
    bookWorld: {
      全部: action("bookWorld", {
        requestInfo: `${host}/books`,
        list: "//article",
        bookName: "normalize-space(.//a)",
        detailUrl: ".//a/@href",
      }),
    },
    searchBook: action("searchBook", {
      requestInfo: `${host}/search?q=%@keyWord`,
      list: "//article",
      bookName: "normalize-space(.//a)",
      detailUrl: ".//a/@href",
    }),
    bookDetail: action("bookDetail", { requestInfo: "%@result" }),
    chapterList: action("chapterList", {
      requestInfo: "%@result",
      list: "//a",
      title: "normalize-space(.)",
      url: "//@href",
    }),
    chapterContent: action("chapterContent", { requestInfo: "%@result", content: "//article" }),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("AI 识站预算按模型调用和完整验链时间计算", () => {
  assert.equal(aiAttemptsThatFitBudget({
    remainingMs: 300_000,
    maxAttempts: 2,
    timeoutMs: 30_000,
    verificationTimeoutMs: 100_000,
  }), 2);
  assert.equal(aiAttemptsThatFitBudget({
    remainingMs: 230_000,
    maxAttempts: 2,
    timeoutMs: 30_000,
    verificationTimeoutMs: 100_000,
  }), 1);
  assert.equal(aiAttemptsThatFitBudget({
    remainingMs: 100_000,
    maxAttempts: 2,
    timeoutMs: 30_000,
    verificationTimeoutMs: 100_000,
  }), 0);
  assert.equal(aiAttemptsThatFitBudget({ remainingMs: 300_000, maxAttempts: 0 }), 0);
});

test("AI 配置持久化为私有文件，公开视图不回显密钥并支持显式清除", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-ai-settings-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createAiSettingsStore(dataDir);
  const saved = await store.save({
    enabled: true,
    baseUrl: "https://api.example.test/v1",
    model: "test-model",
    apiKey: "secret-ai-key",
    mcpEndpoint: "https://mcp.example.test/mcp",
    mcpToken: "secret-mcp-token",
  });
  assert.equal(saved.apiKey, "secret-ai-key");
  assert.equal(saved.mcpToken, "secret-mcp-token");
  const publicView = publicAiSettings(saved);
  assert.equal(publicView.apiKeyConfigured, true);
  assert.equal(publicView.crawlMode, "builtin-auto");
  assert.equal("mcpEndpoint" in publicView, false);
  assert.equal("maxToolCalls" in publicView, false);
  assert.equal("apiKey" in publicView, false);
  assert.equal("mcpToken" in publicView, false);

  const settingsPath = path.join(dataDir, "private-settings", "ai.json");
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(settingsPath))).mode & 0o777, 0o700);
  const onDisk = await readFile(settingsPath, "utf8");
  assert.match(onDisk, /secret-ai-key/);
  assert.match(onDisk, /secret-mcp-token/);

  const preserved = await store.save({ model: "next-model", apiKey: "", mcpToken: "" });
  assert.equal(preserved.apiKey, "secret-ai-key");
  assert.equal(preserved.mcpToken, "secret-mcp-token");
  assert.equal(preserved.baseUrl, "https://api.example.test/v1");
  assert.equal(preserved.mcpEndpoint, "https://mcp.example.test/mcp");
  const cleared = await store.save({ clearApiKey: true, clearMcpToken: true });
  assert.equal(cleared.apiKey, "");
  assert.equal(cleared.mcpToken, "");
  assert.equal(cleared.model, "next-model");
  assert.equal(cleared.baseUrl, "https://api.example.test/v1");

  const local = await store.save({
    enabled: true,
    provider: "local-http",
    localBaseUrl: "http://127.0.0.1:11434/v1",
    localModel: "local-model",
  });
  assert.equal(aiProviderReady(local), true);
  assert.equal(publicAiSettings(local).apiKeyConfigured, false);
  assert.equal(publicAiSettings(local).provider, "local-http");
  const cli = await store.save({ enabled: true, provider: "cli", cliClient: "codex", cliModel: "fixture-codex-model", cliReasoningEffort: "xhigh", reasoningEffort: "low", localReasoningEffort: "medium" });
  assert.equal(aiProviderReady(cli), true);
  assert.equal(publicAiSettings(cli).cliClient, "codex");
  assert.equal(publicAiSettings(cli).cliModel, "fixture-codex-model");
  assert.equal(publicAiSettings(cli).cliReasoningEffort, "xhigh");
  const reloaded = await createAiSettingsStore(dataDir).get();
  assert.equal(reloaded.cliReasoningEffort, "xhigh");
  assert.equal(reloaded.reasoningEffort, "low");
  assert.equal(reloaded.localReasoningEffort, "medium");
  assert.equal((await store.save({ cliReasoningEffort: "" })).cliReasoningEffort, "");
  await assert.rejects(() => store.save({ cliReasoningEffort: 'high"; arbitrary' }), /推理档位无效/);
  assert.equal((await store.save({ provider: "api", model: "api-model" })).cliModel, "fixture-codex-model");
  assert.equal((await store.save({ cliModel: "" })).cliModel, "");
  await assert.rejects(() => store.save({ cliModel: "--model x; command" }), /模型名称格式无效/);
  await assert.rejects(() => store.save({ cliClient: "arbitrary-command" }), /当前仅支持 Codex CLI/);
});

test("Codex CLI bridge uses private socket and normalizes model and tool replies", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-bridge-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const bridge = createAgentBridge({ dataDir, adapters: {
    codex: async (body) => {
      calls.push(body);
      return body.tools.length
        ? { content: "", toolCalls: [{ name: "mcp_browser_navigate", arguments: { url: "https://example.test/" } }] }
        : { content: "READY", toolCalls: [] };
    },
  } });
  await bridge.listen();
  context.after(() => bridge.close());
  assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
  const settings = { enabled: true, provider: "cli", cliClient: "codex", cliModel: "fixture-codex-model", cliReasoningEffort: "high", cliSocketPath: bridge.socketPath, timeoutMs: 5_000 };
  assert.equal((await probeAiProvider(settings)).response, "READY");
  const tool = { type: "function", function: { name: "mcp_browser_navigate", parameters: { type: "object" } } };
  const message = await requestAiCompletion({ settings, messages: [{ role: "user", content: "read page" }], tools: [tool] });
  assert.equal(message.tool_calls[0].function.name, "mcp_browser_navigate");
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).url, "https://example.test/");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((body) => body.model === "fixture-codex-model"));
  assert.ok(calls.every((body) => body.reasoningEffort === "high"));
  assert.equal((await probeAiProvider(settings)).reasoningEffort, "high");
  assert.equal((await probeAiProvider(settings)).model, "Codex CLI · fixture-codex-model");
  assert.throws(() => normalizeCliMessage({ content: "", toolCalls: [{ name: "evil", arguments: {} }] }, [tool]), /未批准/);
});

test("Codex CLI reads the structured final message instead of transcript output", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-executable-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nconst target = args[args.indexOf("--output-last-message") + 1];\nconst index = args.indexOf("--model");\nconst content = index < 0 ? "DEFAULT" : args[index + 1];\nawait writeFile(target, JSON.stringify({ content, toolCalls: [] }));\nprocess.stdout.write("progress transcript that is not JSON\\n");\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const result = await runCodex({ messages: [{ role: "user", content: "test" }], tools: [], maxTokens: 16 }, { executable });
  assert.deepEqual(result, { content: "DEFAULT", toolCalls: [] });
  const selected = await runCodex({ model: "fixture-codex-model", messages: [], tools: [] }, { executable });
  assert.deepEqual(selected, { content: "fixture-codex-model", toolCalls: [] });
  await assert.rejects(runCodex({ model: "--dangerous-option" }, { executable }), /模型名称格式无效/);
});

test("Codex CLI failure diagnostics classify stderr without exposing its contents", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stderr.write("HTTP 429 rate limit: private-token at /root/private/path\\n");\nprocess.exit(7);\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(
    runCodex({ messages: [{ role: "user", content: "test" }], tools: [] }, { executable }),
    (error) => {
      assert.match(error.message, /额度或请求限流/);
      assert.doesNotMatch(error.message, /private-token|\/root\/private\/path|HTTP 429/);
      return true;
    },
  );
});

test("root-run host bridge gives private settings and socket to the data-volume owner", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-owner-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const expectedUid = process.getuid?.() === 0 ? 65534 : process.getuid();
  if (process.getuid?.() === 0) await chown(dataDir, expectedUid, 65534);
  const bridge = createAgentBridge({ dataDir, adapters: { codex: async () => ({ content: "READY", toolCalls: [] }) } });
  await bridge.listen();
  context.after(() => bridge.close());
  assert.equal((await stat(path.dirname(bridge.socketPath))).uid, expectedUid);
  assert.equal((await stat(bridge.socketPath)).uid, expectedUid);
  assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
});

test("CLI bridge propagates cancellation without retaining the running request", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-abort-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let cancelled = false;
  const bridge = createAgentBridge({ dataDir, adapters: { codex: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
  }) } });
  await bridge.listen();
  context.after(() => bridge.close());
  const settings = { enabled: true, provider: "cli", cliClient: "codex", cliSocketPath: bridge.socketPath };
  await assert.rejects(() => requestAiCompletion({ settings, messages: [], timeoutMs: 50 }), /超时/);
  for (let i = 0; i < 20 && !cancelled; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
});

test("CLI candidate enters the same Xiangse rule safety gate as API candidates", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-cli-candidate-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = "https://example.test";
  const candidate = testSource(host);
  const bridge = createAgentBridge({ dataDir, adapters: { codex: async () => ({
    content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }),
    toolCalls: [],
  }) } });
  await bridge.listen();
  context.after(() => bridge.close());
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, provider: "cli", cliClient: "codex", cliSocketPath: bridge.socketPath, timeoutMs: 5_000, maxToolCalls: 0 },
    host,
    sourceName: "Example",
    source: candidate,
    preferredKind: "text",
    download: async () => Buffer.from('<html><body><a href="/books">Books</a></body></html>'),
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.detectedType, "text");
  assert.equal(generated.source.sourceType, "text");
});

test("AI 返回局部动作修复时保留原源其余声明式规则再进入统一校验", async () => {
  const host = "https://example.test";
  const original = testSource(host);
  const replacement = `${host}/search?q=%@keyWord`;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: original,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async () => ({ content: JSON.stringify({
      detectedType: "text",
      confidence: 0.9,
      source: { searchBook: { requestInfo: replacement } },
    }) }),
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.source.searchBook.requestInfo, replacement);
  assert.equal(generated.source.searchBook.list, original.searchBook.list);
  assert.deepEqual(generated.source.bookDetail, original.bookDetail);
  assert.deepEqual(generated.source.chapterList, original.chapterList);
  assert.deepEqual(generated.source.chapterContent, original.chapterContent);
});

test("AI 局部修复保留转换器已有的香色支持脚本，但不能新增可执行代码", async () => {
  const host = "https://example.test";
  const original = testSource(host);
  original.chapterContent.content = "@js: return String(result);";
  const request = `${host}/search?q=%@keyWord`;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: original,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async () => ({ content: JSON.stringify({
      detectedType: "text",
      confidence: 0.9,
      source: { searchBook: { requestInfo: request } },
    }) }),
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.source.chapterContent.content, original.chapterContent.content);
  assert.equal(generated.source.searchBook.requestInfo, request);

  await assert.rejects(generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: original,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async () => ({ content: JSON.stringify({
      detectedType: "text",
      confidence: 0.9,
      source: { chapterContent: { content: "@js: return process.env.ADMIN_TOKEN;" } },
    }) }),
  }), /AI 输出包含可执行代码/);
});

test("AI 候选域名扫描忽略香色 URL 字段模板占位符", async () => {
  const host = "https://example.test";
  const original = testSource(host);
  const generatedRule = `${host}{{$.vertical_image_url}}`;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: original,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async () => ({ content: JSON.stringify({
      detectedType: "text",
      confidence: 0.9,
      source: { searchBook: { bookName: generatedRule } },
    }) }),
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.source.searchBook.bookName, generatedRule);
});

test("AI 按失败阶段定向修复动作，目录修复保留尚未验证的漫画正文", async () => {
  const host = "https://example.test";
  const original = testSource(host);
  original.sourceType = "comic";
  original.chapterContent.content = "$.proxyUrls||$.urls||@js:\nreturn String(result);";
  const chapterRequest = `${host}/api/chapters?id=%@result`;
  const ignoredContentRule = "@js: return java.getString(result);";
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example Comic",
    source: original,
    preferredKind: "comic",
    failureReason: "rules-stale: empty-toc",
    verification: { reason: "rules-stale: empty-toc" },
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async ({ messages }) => {
      const prompt = JSON.parse(messages[1].content);
      assert.deepEqual(prompt.outputRequirements.preserveActions, ["bookWorld", "searchBook", "chapterContent"]);
      return { content: JSON.stringify({
        detectedType: "comic",
        confidence: 0.9,
        source: {
          chapterList: { requestInfo: chapterRequest },
          chapterContent: { content: ignoredContentRule },
        },
      }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.source.chapterList.requestInfo, chapterRequest);
  assert.equal(generated.source.chapterContent.content, original.chapterContent.content);
  assert.deepEqual(generated.preservedActions, ["chapterContent"]);
});

test("AI 的空/不完整候选会把证据缺口写进可重试诊断", async () => {
  const host = "https://example.test";
  await assert.rejects(generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: { sourceName: "Example", sourceUrl: host, sourceType: "text" },
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async () => ({ content: JSON.stringify({
      detectedType: "text",
      confidence: 0.2,
      source: {},
      evidence: ["缺少可观察的章节正文入口"],
    }) }),
  }), /Xiangse 结构校验失败.*AI 识站证据：缺少可观察的章节正文入口/);
});

test("Codex CLI 的大源规则和页面证据会先压缩到桥接输入上限以内", async () => {
  const host = "https://example.test";
  const source = testSource(host);
  source.bookWorld = Object.fromEntries(Array.from({ length: 48 }, (_, index) => [`World ${index}`, {
    ...source.bookWorld["全部"],
    validConfig: "x".repeat(3_500),
    requestInfo: `${host}/books?query=${"q".repeat(2_500)}`,
  }]));
  const candidate = testSource(host);
  const settings = {
    enabled: true,
    provider: "cli",
    cliClient: "codex",
    cliModel: "test-model",
    cliReasoningEffort: "max",
    timeoutMs: 5_000,
  };
  const generated = await generateXiangseCandidate({
    settings,
    host,
    sourceName: "Large source",
    source,
    preferredKind: "text",
    requireBookWorld: true,
    verification: { reason: "rules-stale: empty-list" },
    download: async () => Buffer.from(`<main>${"site evidence ".repeat(1_200)}</main>`),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async ({ messages, tools, maxTokens }) => {
      const body = JSON.stringify({
        client: settings.cliClient,
        model: settings.cliModel,
        reasoningEffort: settings.cliReasoningEffort,
        messages,
        tools,
        maxTokens,
      });
      assert.ok(Buffer.byteLength(body) < 160 * 1024);
      const payload = JSON.parse(messages.find((message) => message.role === "user").content);
      assert.equal(payload.existingRuleSummary.sourceType, "text");
      assert.equal(payload.outputRequirements.requireBookWorld, true);
      assert.match(payload.outputRequirements.browseRequirement, /searchBook 不能替代/);
      assert.ok(payload.pages.length > 0);
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(generated.ok, true);
});

test("AI 识站获得脱敏的原始发现线索但不执行脚本或泄漏线索到候选", async () => {
  const host = "https://example.test";
  const source = testSource(host);
  source.__read2xsggAiHints = {
    exploreUrl: "@js: var api='https://api.example.test/v1/catalog?access_token=never-send'; JSON.stringify([]);",
    ruleExplore: { bookList: "$.data.items[*]", name: "$.title", bookUrl: "$.url" },
    declaredUrls: ["https://api.example.test/v1/catalog?access_token=never-send"],
  };
  const candidate = testSource(host);
  let supplied;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source,
    preferredKind: "text",
    verification: { reason: "rules-stale: empty-list" },
    download: async () => Buffer.from("<main>Evidence</main>"),
    lookupHost: async () => [{ address: "8.8.8.8", family: 4 }],
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async ({ messages }) => {
      supplied = JSON.parse(messages.find((message) => message.role === "user").content);
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });

  assert.equal(generated.ok, true);
  assert.match(JSON.stringify(supplied.legacyDiscoveryEvidence), /v1\/catalog/);
  assert.match(JSON.stringify(supplied.legacyDiscoveryEvidence), /(?:\[redacted\]|%5Bredacted%5D)/i);
  assert.doesNotMatch(JSON.stringify(supplied.legacyDiscoveryEvidence), /never-send/);
  assert.ok(supplied.allowedHosts.includes("api.example.test"));
  assert.equal(Object.hasOwn(generated.source, "__read2xsggAiHints"), false);
});

test("完整验收要求分类入口时，AI 不能用 searchBook 单独通过候选门", async () => {
  const host = "https://example.test";
  const source = testSource(host);
  source.bookWorld = {};
  const candidate = structuredClone(source);
  let requireBrowse;
  await assert.rejects(generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source,
    preferredKind: "text",
    requireBookWorld: true,
    verification: { reason: "rules-stale: empty-list" },
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async ({ messages }) => {
      const payload = JSON.parse(messages.find((message) => message.role === "user").content);
      requireBrowse = payload.outputRequirements.requireBookWorld;
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  }), /AI 未生成分类\/浏览入口/);
  assert.equal(requireBrowse, true);
});

test("AI API 调用兼容 chat completions，错误不会回显 API Key", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "READY" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const settings = { baseUrl: "https://llm.example.test/v1", model: "model-a", apiKey: "sk-test" };
  const result = await testAiProvider(settings, { fetchImpl });
  assert.equal(result.response, "READY");
  assert.equal(request.url, "https://llm.example.test/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer sk-test");
  assert.equal(request.body.model, "model-a");
  assert.equal(request.options.redirect, "error");

  await assert.rejects(requestChatCompletion({
    settings,
    messages: [],
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad key sk-test" } }), { status: 401 }),
  }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sk-test/);
    return true;
  });
});

test("MCP Streamable HTTP client initializes, lists tools, and sends session/auth headers", async (context) => {
  const seen = [];
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ method: request.method, headers: request.headers, body });
    if (body.method === "initialize") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "session-1",
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp", version: "1" },
        },
      }));
    } else if (body.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
    } else if (body.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "browser_navigate", inputSchema: { type: "object", properties: {} } }] } }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const endpoint = await listen(server);
  context.after(() => close(server));
  const result = await probeMcp({ mcpEndpoint: endpoint, mcpToken: "mcp-secret" });
  assert.equal(result.toolCount, 1);
  assert.deepEqual(result.toolNames, ["browser_navigate"]);
  assert.equal(seen[0].body.method, "initialize");
  assert.equal(seen[1].headers["mcp-session-id"], "session-1");
  assert.equal(seen[1].headers.authorization, "Bearer mcp-secret");
  assert.equal(seen[1].headers["mcp-protocol-version"], "2025-11-25");
  assert.equal(seen[2].body.method, "tools/list");
});

test("MCP 协议协商兼容仅支持较早稳定版本的服务器", async (context) => {
  const versions = [];
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.method === "initialize") {
      versions.push(body.params.protocolVersion);
      response.writeHead(200, {
        "Content-Type": "application/json",
        ...(body.params.protocolVersion === "2025-06-18" ? { "Mcp-Session-Id": "older-session" } : {}),
      });
      response.end(JSON.stringify(body.params.protocolVersion === "2025-06-18"
        ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "older-mcp", version: "1" } } }
        : { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Protocol version not supported" } }));
    } else if (body.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
    } else if (body.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    } else {
      response.writeHead(405);
      response.end();
    }
  });
  const endpoint = await listen(server);
  context.after(() => close(server));
  const client = await connectMcp({ endpoint });
  try {
    assert.deepEqual(await client.listTools(), []);
  } finally {
    await client.close();
  }
  assert.deepEqual(versions, ["2025-11-25", "2025-06-18"]);
});

test("AI 识站只向模型提供脱敏证据、只调用只读 MCP 工具并输出声明式源", async () => {
  const host = "https://example.test";
  const source = testSource(host);
  source.searchBook.headers = { Cookie: "private-cookie-value", Authorization: "Bearer private-source-token" };
  const candidateSource = testSource(host);
  let calls = 0;
  let mcpCalls = 0;
  const client = {
    async listTools() {
      return [{
        name: "browser_navigate",
        description: "Navigate to a public page and read its rendered content.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      }];
    },
    async callTool(name, args) {
      mcpCalls += 1;
      assert.equal(name, "browser_navigate");
      assert.equal(args.url, host);
      return { content: [{ type: "text", text: 'Read-only page snapshot {"token":"private-mcp-token"}' }] };
    },
    async close() {},
  };
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "never-share-this", mcpToken: "private-mcp-token", model: "test", baseUrl: "https://llm.test/v1", mcpEndpoint: "https://mcp.test/mcp", timeoutMs: 10_000, maxToolCalls: 2 },
    host,
    sourceName: "Example",
    source,
    preferredKind: "text",
    failureReason: "rules-stale: empty-list",
    verification: { reason: "rules-stale: empty-list" },
    seedRequests: [],
    download: async () => Buffer.from('<html><head><meta name="csrf-token" content="private-meta-token"></head><body><a href="/books">Books</a><p>{"csrf":"private-body-token"}</p><script>token=should-not-send</script></body></html>'),
    crawlerFactory: async () => client,
    request: async ({ messages }) => {
      calls += 1;
      assert.doesNotMatch(JSON.stringify(messages), /never-share-this|should-not-send|private-source-token|private-cookie-value|private-mcp-token|private-meta-token|private-body-token/);
      if (calls === 1) {
        return {
          role: "assistant",
          tool_calls: [{ id: "tool-1", type: "function", function: { name: "mcp_browser_navigate", arguments: JSON.stringify({ url: host }) } }],
        };
      }
      return { role: "assistant", content: JSON.stringify({ detectedType: "text", confidence: 0.92, source: candidateSource }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.detectedType, "text");
  assert.equal(generated.toolCalls, 1);
  assert.equal(mcpCalls, 1);

  await assert.rejects(generateXiangseCandidate({
    settings: { enabled: true, apiKey: "x", model: "test", baseUrl: "https://llm.test/v1", mcpEndpoint: "https://mcp.test/mcp", timeoutMs: 10_000, maxToolCalls: 1 },
    host,
    sourceName: "Example",
    source,
    download: async () => Buffer.from("<html></html>"),
    crawlerFactory: async () => client,
    request: async () => ({
      tool_calls: [{ id: "tool-evil", type: "function", function: { name: "mcp_browser_navigate", arguments: JSON.stringify({ url: "https://evil.example/" }) } }],
    }),
  }), /超过 MCP 只读爬取调用预算/);
});

test("AI 识站允许跨过四次只读爬取后完成规则合成", async () => {
  const host = "https://example.test";
  const candidate = testSource(host);
  let turns = 0;
  let crawls = 0;
  const client = {
    async listTools() {
      return [{ name: "browser_navigate", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool(_name, args) {
      crawls += 1;
      return { content: [{ type: "text", text: `Observed page ${args.url}` }] };
    },
    async close() {},
  };
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source: candidate,
    preferredKind: "text",
    download: async () => Buffer.from('<main><a href="/books">Books</a></main>'),
    crawlerFactory: async () => client,
    request: async () => {
      turns += 1;
      if (turns <= 5) {
        return { tool_calls: [{ id: `read-${turns}`, type: "function", function: {
          name: "mcp_browser_navigate",
          arguments: JSON.stringify({ url: `${host}/page/${turns}` }),
        } }] };
      }
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.toolCalls, 5);
  assert.equal(crawls, 5);
  assert.equal(turns, 6);
});

test("只读爬取预算用尽后强制综合已有证据而不立即放弃识站", async () => {
  const host = "https://example.test";
  const candidate = testSource(host);
  let turns = 0;
  let crawls = 0;
  const client = {
    async listTools() {
      return [{ name: "browser_navigate", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool() {
      crawls += 1;
      return { content: [{ type: "text", text: "Observed source flow page" }] };
    },
    async close() {},
  };
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source: candidate,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => client,
    request: async ({ tools, messages }) => {
      turns += 1;
      if (turns <= 8) {
        assert.ok(tools.length > 0, "正常阶段应提供受限只读工具");
        return { tool_calls: [{ id: `read-${turns}`, type: "function", function: {
          name: "mcp_browser_navigate",
          arguments: JSON.stringify({ url: `${host}/page/${turns}` }),
        } }] };
      }
      assert.deepEqual(tools, [], "预算用尽后应强制最终合成且不给模型新工具");
      assert.match(messages.at(-1).content, /预算已用完/);
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.toolCalls, 8);
  assert.equal(crawls, 8);
  assert.equal(turns, 9);
});

test("最大推理档超时后仅将当前识站请求降至 high，并按 detectedType 规范化旧类型码", async () => {
  const host = "https://example.test";
  const candidate = testSource(host);
  candidate.sourceType = 0;
  const settings = {
    enabled: true,
    provider: "cli",
    cliClient: "codex",
    cliModel: "test-model",
    cliReasoningEffort: "max",
    timeoutMs: 5_000,
  };
  const efforts = [];
  const generated = await generateXiangseCandidate({
    settings,
    host,
    sourceName: "Example",
    source: candidate,
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    request: async ({ settings: requestSettings }) => {
      efforts.push(requestSettings.cliReasoningEffort);
      if (efforts.length === 1) throw new Error("CLI 请求超时（5000ms）");
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.source.sourceType, "text");
  assert.equal(generated.reasoningEffortFallback, "high");
  assert.deepEqual(efforts, ["max", "high"]);
  assert.equal(settings.cliReasoningEffort, "max", "AI 用户设置不能被转换过程修改");
});

test("MCP 被安全策略拒绝后把原因交还 AI，可改用证据中的公开站点继续", async () => {
  const host = "https://example.test";
  const candidate = testSource(host);
  let turns = 0;
  let crawlCalls = 0;
  const client = {
    async listTools() {
      return [{ name: "browser_navigate", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool(_name, args) {
      crawlCalls += 1;
      assert.equal(args.url, host);
      return { content: [{ type: "text", text: "Observed root page" }] };
    },
    async close() {},
  };
  const result = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source: testSource(host),
    preferredKind: "text",
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async () => client,
    request: async ({ messages }) => {
      turns += 1;
      if (turns === 1) return { tool_calls: [{ id: "blocked", type: "function", function: {
        name: "mcp_browser_navigate", arguments: JSON.stringify({ url: "https://not-observed.example/" }),
      } }] };
      if (turns === 2) {
        assert.match(messages.at(-1).content, /blocked this read-only crawl request/i);
        return { tool_calls: [{ id: "allowed", type: "function", function: {
          name: "mcp_browser_navigate", arguments: JSON.stringify({ url: host }),
        } }] };
      }
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.toolCalls, 2);
  assert.equal(crawlCalls, 1);
});

test("MCP 可访问页面证据中实际观察到并通过公网校验的链接域名", async () => {
  const host = "https://example.test";
  const observedUrl = "https://93.184.216.34/books";
  const semaphore = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const aiSlots = new Int32Array(semaphore);
  const client = {
    async listTools() {
      return [{ name: "browser_navigate", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool(_name, args) {
      assert.equal(Atomics.load(aiSlots, 0), 0, "MCP 抓取不应占用模型并发名额");
      assert.equal(args.url, observedUrl);
      return { content: [{ type: "text", text: "Public linked page" }] };
    },
    async close() {},
  };
  let turns = 0;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000, concurrency: 1, semaphore },
    host,
    sourceName: "Example",
    source: testSource(host),
    preferredKind: "text",
    failureReason: "rules-stale: empty-list",
    verification: { reason: "rules-stale: empty-list" },
    seedRequests: [],
    download: async () => {
      assert.equal(Atomics.load(aiSlots, 0), 0, "证据抓取不应占用模型并发名额");
      return Buffer.from(`<a href="${observedUrl}">Books</a>`);
    },
    crawlerFactory: async () => client,
    request: async ({ messages, timeoutMs }) => {
      assert.equal(Atomics.load(aiSlots, 0), 1, "模型请求应受 AI 并发上限控制");
      assert.equal(timeoutMs, 10_000);
      turns += 1;
      if (turns === 1) {
        const evidence = JSON.parse(messages[1].content);
        assert.ok(evidence.allowedHosts.includes("93.184.216.34"));
        return { role: "assistant", tool_calls: [{ id: "observed-link", type: "function", function: {
          name: "mcp_browser_navigate", arguments: JSON.stringify({ url: observedUrl }),
        } }] };
      }
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: testSource(host) }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.toolCalls, 1);
  assert.equal(Atomics.load(aiSlots, 0), 0, "模型请求结束后应释放并发名额");
});

test("AI 识站优先校验书源声明的 API 域名，不让页面杂链挤掉章节接口", async () => {
  const host = "https://example.test";
  const apiUrl = "https://8.8.8.8/api/toc";
  const source = testSource(host);
  source.chapterList.requestInfo = apiUrl;
  const incidentalLinks = Array.from({ length: 20 }, (_, index) => (
    `<a href="https://93.184.216.${index + 1}/link">link</a>`
  )).join("");
  let turns = 0;
  const client = {
    async listTools() {
      return [{ name: "fetch_page", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool(_name, args) {
      assert.equal(args.url, apiUrl);
      return { content: [{ type: "text", text: "Observed public chapter API" }] };
    },
    async close() {},
  };
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000 },
    host,
    sourceName: "Example",
    source,
    preferredKind: "text",
    failureReason: "rules-stale: empty-toc",
    verification: { reason: "rules-stale: empty-toc" },
    download: async () => Buffer.from(`<main>${incidentalLinks}</main>`),
    crawlerFactory: async () => client,
    request: async ({ messages }) => {
      turns += 1;
      if (turns === 1) {
        const evidence = JSON.parse(messages[1].content);
        assert.ok(evidence.allowedHosts.includes("8.8.8.8"));
        return { tool_calls: [{ id: "api-read", type: "function", function: {
          name: "mcp_fetch_page", arguments: JSON.stringify({ url: apiUrl }),
        } }] };
      }
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.toolCalls, 1);
  assert.equal(turns, 2);
});

test("AI 识站只在配置开启时允许域名解析到专用 DNS 代理段", async () => {
  const host = "https://example.test";
  const apiUrl = "https://api.example/toc";
  const source = testSource(host);
  source.chapterList.requestInfo = apiUrl;
  const client = {
    async listTools() {
      return [{ name: "fetch_page", description: "Read a public page", inputSchema: {
        type: "object", properties: { url: { type: "string" } }, required: ["url"],
      } }];
    },
    async callTool(_name, args) {
      assert.equal(args.url, apiUrl);
      return { content: [{ type: "text", text: "Observed chapter endpoint" }] };
    },
    async close() {},
  };
  const run = (allowDnsProxyNetworks) => {
    let turns = 0;
    return generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 10_000, allowDnsProxyNetworks },
    host,
    sourceName: "Example",
    source,
    preferredKind: "text",
    failureReason: "rules-stale: empty-toc",
    verification: { reason: "rules-stale: empty-toc" },
    download: async () => Buffer.from("<main>Evidence</main>"),
    crawlerFactory: async ({ authorizeNetwork }) => {
      assert.equal(await authorizeNetwork(apiUrl), allowDnsProxyNetworks);
      return client;
    },
    lookupHost: async () => [{ address: "198.18.28.75", family: 4 }],
    request: async ({ messages }) => {
      turns += 1;
      if (turns === 1) return { tool_calls: [{ id: "proxy-api", type: "function", function: {
        name: "mcp_fetch_page", arguments: JSON.stringify({ url: apiUrl }),
      } }] };
      if (allowDnsProxyNetworks) assert.match(messages.at(-1).content, /Observed chapter endpoint/);
      else assert.match(messages.at(-1).content, /public站点域名|公开站点域名/i);
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source }) };
    },
  });
  };

  const allowed = await run(true);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.source.chapterList.requestInfo, apiUrl);
  await assert.rejects(run(false), /证据之外的域名/);
});

test("证据抓取耗时不挤占单次 AI 模型请求超时预算", async () => {
  const host = "https://example.test";
  const candidate = testSource(host);
  let turns = 0;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "test", model: "test", baseUrl: "https://llm.test/v1", timeoutMs: 5_000 },
    host,
    sourceName: "Example",
    source: candidate,
    preferredKind: "text",
    download: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      return Buffer.from("<main>Evidence</main>");
    },
    request: async ({ timeoutMs }) => {
      turns += 1;
      assert.equal(timeoutMs, 5_000);
      return { content: JSON.stringify({ detectedType: "text", confidence: 0.9, source: candidate }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(turns, 1);
});

test("自动抓取不被旧零预算禁用，AI 优先收到失败的章节和详情页面", async () => {
  const downloaded = [];
  let turns = 0;
  const generated = await generateXiangseCandidate({
    settings: { enabled: true, apiKey: "x", model: "test", timeoutMs: 10_000, maxToolCalls: 0, mcpEndpoint: "https://unused.test/mcp" },
    host: "https://example.test", sourceName: "Example", source: testSource(), preferredKind: "text",
    failureReason: "rules-stale: empty-content",
    verification: { chapterUrl: "https://example.test/chapter/1", bookUrl: "https://example.test/book/1" },
    download: async (url, headers) => {
      downloaded.push(url);
      assert.deepEqual(headers, {});
      return Buffer.from(`<article>${url}</article>`);
    },
    request: async ({ messages, tools }) => {
      turns += 1;
      if (turns === 1) {
        const report = JSON.parse(messages[1].content);
        assert.deepEqual(report.pages.slice(0, 2).map((page) => page.url), ["https://example.test/chapter/1", "https://example.test/book/1"]);
        assert.ok(tools.some((tool) => tool.function.name === "mcp_fetch_page"));
        assert.ok(tools.some((tool) => tool.function.name === "mcp_browser_snapshot"));
        return { role: "assistant", tool_calls: [{ id: "read", type: "function", function: { name: "mcp_fetch_page", arguments: '{"url":"https://example.test/chapter/2"}' } }] };
      }
      assert.match(messages.at(-1).content, /chapter\/2/);
      return { content: JSON.stringify({ detectedType: "text", source: testSource() }) };
    },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.toolCalls, 1);
  assert.equal(downloaded.at(-1), "https://example.test/chapter/2");
  assert.ok(downloaded.every((url) => !url.includes("unused.test")));
});

test("转换管线只在通用识站失败后调用 AI，且只保留完整链路实测通过的候选", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/books") {
      response.end('<article><a href="/book/1">A novel</a></article>');
    } else if (request.url === "/book/1") {
      response.end('<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>');
    } else if (request.url === "/chapter/1") {
      response.end("<article>This is the complete chapter body with enough readable words to verify.</article>");
    } else {
      response.end("not found");
    }
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const workingSource = testSource(host);
  workingSource.__read2xsggAiHints = { exploreUrl: "@js: static category evidence" };
  const brokenSource = structuredClone(workingSource);
  brokenSource.sourceName = "Broken";
  brokenSource.bookWorld["全部"].requestInfo = `${host}/missing`;
  let genericAttempts = 0;
  let aiAttempts = 0;
  const progressEvents = [];
  const download = async (url, headers = {}, options = {}) => {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body || undefined,
      signal: options.signal,
    });
    const result = Buffer.from(await response.arrayBuffer());
    result.read2xsggResponseUrl = response.url;
    result.httpHeaders = Object.fromEntries(response.headers.entries());
    return result;
  };
  const gated = await applyVerifyAndAnalyzeFallback({ Broken: brokenSource }, {
    download,
    concurrency: 1,
    timeoutMs: 2_000,
    sourceTimeoutMs: 12_000,
    analyzeTimeoutMs: 2_000,
    sourceBudgetMs: 30_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 3 },
    analyze: async () => {
      genericAttempts += 1;
      return { ok: false, reason: "analyze-failed: 通用识站超时（2000ms）" };
    },
    generateAiCandidate: async ({ host: observedHost, failureReason, requireBookWorld }) => {
      aiAttempts += 1;
      assert.equal(observedHost, host);
      assert.match(failureReason, /rules-stale/);
      assert.equal(requireBookWorld, true);
      return { ok: true, source: workingSource, detectedType: "text", confidence: 0.9, toolCalls: 0 };
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
    requireBookWorld: true,
    onProgress: (progress) => progressEvents.push(progress),
  });
  assert.equal(genericAttempts, 1);
  assert.equal(aiAttempts, 1);
  assert.equal(Object.keys(gated.sources).length, 1);
  assert.equal(gated.sources.Broken.bookWorld["全部"].requestInfo, `${host}/books`);
  assert.equal(Object.hasOwn(gated.sources.Broken, "__read2xsggAiHints"), false);
  assert.equal(gated.fallbackCount, 1);
  assert.equal(gated.aiAttemptCount, 1);
  assert.equal(gated.aiRepairCount, 1);
  assert.ok(progressEvents.some((progress) => progress.step === "ai-analyze"
    && progress.aiAttempt === 1 && progress.aiAttempts === 3 && progress.aiAttemptsTotal === 1));
  assert.equal(gated.verifiedCount, 0);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.skipped.length, 0);
});

test("AI 修复失败会保留脱敏后的诊断和真实尝试数", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/books") response.end('<article><a href="/book/1">A novel</a></article>');
    else if (request.url === "/book/1") response.end('<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>');
    else if (request.url === "/chapter/1") response.end(`<article>${"This is enough chapter text to verify the source. ".repeat(4)}</article>`);
    else response.end("not found");
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const brokenSource = testSource(host);
  brokenSource.bookWorld["全部"].requestInfo = `${host}/missing`;
  const download = async (url, headers = {}, options = {}) => {
    const response = await fetch(url, { headers, signal: options.signal });
    const result = Buffer.from(await response.arrayBuffer());
    result.read2xsggResponseUrl = response.url;
    result.httpHeaders = Object.fromEntries(response.headers.entries());
    return result;
  };
  const result = await applyVerifyAndAnalyzeFallback({ Broken: brokenSource }, {
    download,
    concurrency: 1,
    timeoutMs: 2_000,
    sourceTimeoutMs: 12_000,
    analyzeTimeoutMs: 2_000,
    sourceBudgetMs: 30_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 1 },
    analyze: async () => ({ ok: false, reason: "analyze-failed: fixture did not find a candidate" }),
    generateAiCandidate: async () => { throw new Error("CLI failed: api_key=secret-value"); },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
  });
  assert.equal(result.aiAttemptCount, 1);
  assert.equal(result.aiRepairCount, 0);
  assert.match(result.skipped[0].reason, /AI 已尝试 1 次/);
  assert.match(result.skipped[0].reason, /CLI failed/);
  assert.doesNotMatch(result.skipped[0].reason, /secret-value/);
});

test("AI 首次调用超时/失败后会使用剩余预算执行配置的第二次尝试", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/books") response.end('<article><a href="/book/1">A novel</a></article>');
    else if (request.url === "/book/1") response.end('<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>');
    else if (request.url === "/chapter/1") response.end(`<article>${"This is a readable chapter for the complete source verification. ".repeat(4)}</article>`);
    else response.end("not found");
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const workingSource = testSource(host);
  const brokenSource = structuredClone(workingSource);
  brokenSource.sourceName = "Retryable";
  brokenSource.bookWorld["全部"].requestInfo = `${host}/missing`;
  let aiCalls = 0;
  const result = await applyVerifyAndAnalyzeFallback({ Retryable: brokenSource }, {
    download: async (url, headers = {}, options = {}) => {
      const response = await fetch(url, { headers, signal: options.signal });
      const data = Buffer.from(await response.arrayBuffer());
      data.read2xsggResponseUrl = response.url;
      data.httpHeaders = Object.fromEntries(response.headers.entries());
      return data;
    },
    timeoutMs: 1_000,
    sourceTimeoutMs: 120_000,
    analyzeTimeoutMs: 1_000,
    runtimeFallbackTimeoutMs: 1_000,
    sourceBudgetMs: 120_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 2 },
    repairBooks: async () => null,
    repairDetail: async () => null,
    repairChapter: async () => null,
    repairJsonChapter: async () => null,
    repairContent: async () => null,
    analyze: async (_host, { onProbeBatch }) => {
      onProbeBatch("generic-evidence");
      return { ok: false, reason: "analyze-failed: fixture needs AI", probeBatchFingerprint: "generic-evidence" };
    },
    generateAiCandidate: async () => {
      aiCalls += 1;
      if (aiCalls === 1) throw new Error("fixture transient AI timeout");
      return { ok: true, source: workingSource, detectedType: "text", confidence: 0.9 };
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    originReachabilityConfirmed: true,
  });
  assert.equal(aiCalls, 2);
  assert.equal(result.aiAttemptCount, 2);
  assert.equal(result.aiRepairCount, 1);
  assert.equal(Object.keys(result.sources).length, 1);
  assert.equal(result.skipped.length, 0);
});

test("持续验链先完成首轮通用识站，再让 AI 修复；AI 失败后仍继续通用识站", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/books") response.end('<article><a href="/book/1">A novel</a></article>');
    else if (request.url === "/book/1") response.end('<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>');
    else if (request.url === "/chapter/1") response.end(`<article>${"This chapter body is long enough for the complete source verification. ".repeat(4)}</article>`);
    else response.end("not found");
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const workingSource = testSource(host);
  const brokenSource = structuredClone(workingSource);
  brokenSource.sourceName = "Broken";
  brokenSource.bookWorld["全部"].requestInfo = `${host}/missing`;
  const events = [];
  const download = async (url, headers = {}, options = {}) => {
    const response = await fetch(url, { headers, signal: options.signal });
    const result = Buffer.from(await response.arrayBuffer());
    result.read2xsggResponseUrl = response.url;
    result.httpHeaders = Object.fromEntries(response.headers.entries());
    return result;
  };
  const result = await applyVerifyAndAnalyzeFallback({ Broken: brokenSource }, {
    download,
    concurrency: 1,
    timeoutMs: 2_000,
    sourceTimeoutMs: 12_000,
    analyzeTimeoutMs: 2_000,
    sourceBudgetMs: 30_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 1 },
    analyze: async (_host, { attempt, onProbeBatch }) => {
      events.push(`generic-${attempt}`);
      const probeBatchFingerprint = `attempt-${attempt}`;
      onProbeBatch(probeBatchFingerprint);
      if (attempt === 0) return { ok: false, reason: "analyze-failed: first pass miss", probeBatchFingerprint };
      return { ok: true, sources: { Recovered: workingSource }, probeBatchFingerprint };
    },
    generateAiCandidate: async () => {
      events.push("ai");
      throw new Error("fixture model unavailable");
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    originReachabilityConfirmed: true,
  });
  assert.deepEqual(events, ["generic-0", "ai", "generic-1"]);
  assert.equal(result.aiAttemptCount, 1);
  assert.equal(result.aiRepairCount, 0);
  assert.equal(Object.keys(result.sources).length, 1, JSON.stringify(result.skipped));
  assert.equal(result.skipped.length, 0);
});

test("持续识站期间的早期 AI 与最终 AI 共用每源尝试上限", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("unrecognized page");
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const broken = testSource(host);
  broken.bookWorld["全部"].requestInfo = `${host}/missing`;
  let aiCalls = 0;
  const result = await applyVerifyAndAnalyzeFallback({ Broken: broken }, {
    download: async (url, headers = {}, options = {}) => {
      const response = await fetch(url, { headers, signal: options.signal });
      const data = Buffer.from(await response.arrayBuffer());
      data.read2xsggResponseUrl = response.url;
      data.httpHeaders = Object.fromEntries(response.headers.entries());
      return data;
    },
    timeoutMs: 1_000,
    sourceTimeoutMs: 5_000,
    analyzeTimeoutMs: 500,
    sourceBudgetMs: 30_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 1 },
    repairBooks: async () => null,
    repairChapter: async () => null,
    repairJsonChapter: async () => null,
    repairContent: async () => null,
    analyze: async (_host, { onProbeBatch }) => {
      const repeated = !onProbeBatch("same-evidence");
      return {
        ok: false,
        reason: repeated ? "analyze-failed: 重复证据" : "analyze-failed: fixture generic miss",
        ...(repeated ? { repeatedEvidence: true } : {}),
        probeBatchFingerprint: "same-evidence",
      };
    },
    generateAiCandidate: async () => {
      aiCalls += 1;
      throw new Error("fixture AI miss");
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    originReachabilityConfirmed: true,
  });
  assert.equal(aiCalls, 1);
  assert.equal(result.aiAttemptCount, 1);
  assert.equal(result.aiRepairCount, 0);
  assert.match(result.skipped[0].reason, /AI 配置的 1 次识站尝试已用尽/);
});

test("本地 HTTP 模型无需 API Key，失败源经真实请求进入 AI 并通过完整验链", async (context) => {
  const host = "https://books.example.test";
  const working = testSource(host);
  const broken = structuredClone(working);
  broken.bookWorld["全部"].requestInfo = `${host}/missing`;
  let modelCalls = 0;
  let authHeader;
  const model = createServer((request, response) => {
    modelCalls += 1;
    authHeader = request.headers.authorization;
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ source: working, detectedType: "text", confidence: 0.93 }),
    } }] }));
  });
  const modelEndpoint = await listen(model);
  context.after(() => close(model));
  const download = async (url) => {
    const pathname = new URL(url).pathname;
    const html = pathname === "/books"
      ? '<article><a href="/book/1">A novel</a></article>'
      : pathname === "/book/1"
        ? '<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>'
        : pathname === "/chapter/1"
          ? "<article>This is a full chapter body with enough readable words to validate the generated rule.</article>"
          : '<a href="/books">Books</a>';
    const result = Buffer.from(html);
    result.read2xsggResponseUrl = url;
    result.httpHeaders = { "content-type": "text/html; charset=utf-8" };
    return result;
  };
  const gated = await applyVerifyAndAnalyzeFallback({ Broken: broken }, {
    download,
    concurrency: 1,
    timeoutMs: 2_000,
    sourceTimeoutMs: 12_000,
    analyzeTimeoutMs: 2_000,
    sourceBudgetMs: 30_000,
    aiSettings: {
      enabled: true,
      provider: "local-http",
      localBaseUrl: `${modelEndpoint}/v1`,
      localModel: "fixture-local",
      timeoutMs: 5_000,
      maxAttempts: 1,
      maxToolCalls: 0,
    },
    analyze: async () => ({ ok: false, reason: "analyze-failed: fixture generic miss" }),
    workerPoolEnabled: false,
  });
  assert.equal(modelCalls, 1);
  assert.equal(authHeader, undefined);
  assert.equal(gated.aiRepairCount, 1, JSON.stringify(gated.skipped));
  assert.equal(gated.verifiedCount, 0);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.sources.Broken.bookWorld["全部"].requestInfo, `${host}/books`);
});

test("预检确认站点可达后，局部无响应仍依次完成通用识站再交给 AI", async (context) => {
  const upstream = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://fixture.test").pathname;
    if (pathname === "/books") response.end('<article><a href="/book/1">A novel</a></article>');
    else if (pathname === "/book/1") response.end('<h1>A novel</h1><a href="/chapter/1">Chapter 1</a>');
    else if (pathname === "/chapter/1") response.end(`<article>${"This chapter body is long enough to pass the full content checks. ".repeat(5)}</article>`);
    else response.writeHead(404).end();
  });
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const working = testSource(host);
  const broken = structuredClone(working);
  broken.bookWorld["全部"].requestInfo = `${host}/offline-route`;
  const events = [];
  const result = await (await import("../src/pipeline.js")).applyVerifyAndAnalyzeFallback({ Example: broken }, {
    download: async (url, headers = {}, options = {}) => {
      const response = await fetch(url, { headers, signal: options.signal });
      const data = Buffer.from(await response.arrayBuffer());
      data.read2xsggResponseUrl = response.url;
      data.httpHeaders = Object.fromEntries(response.headers.entries());
      return data;
    },
    timeoutMs: 1_000,
    sourceTimeoutMs: 5_000,
    analyzeTimeoutMs: 1_000,
    sourceBudgetMs: 15_000,
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 2_000, maxAttempts: 1 },
    originReachabilityConfirmed: true,
    repairBooks: async () => null,
    repairChapter: async () => null,
    repairJsonChapter: async () => null,
    repairContent: async () => null,
    repairDetail: async () => null,
    analyze: async () => {
      events.push("generic-recognition");
      return { ok: false, reason: "analyze-failed: 首页及声明分类均不可访问", remainingSeedRequests: 0 };
    },
    generateAiCandidate: async () => {
      events.push("ai-recognition");
      return { ok: true, source: working, detectedType: "text", confidence: 0.9, toolCalls: 0 };
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
  });
  assert.deepEqual(events, ["generic-recognition", "ai-recognition"]);
  assert.equal(result.aiRepairCount, 1);
  assert.equal(result.skipped.length, 0);
});

test("集合中另一个源预检未确认，不会阻止已确认站点在列表修复超时后继续识站", async (context) => {
  const upstream = createServer((_request, response) => response.writeHead(404).end("not found"));
  const host = await listen(upstream);
  context.after(() => close(upstream));
  const broken = testSource(host);
  broken.sourceName = "已确认站点";
  broken.bookWorld["全部"].requestInfo = `${host}/missing-list`;
  broken.searchBook.requestInfo = `${host}/missing-search`;
  let analyzeCalls = 0;

  const result = await applyVerifyAndAnalyzeFallback({ "已确认站点": broken }, {
    download: async (url, headers = {}, options = {}) => {
      const response = await fetch(url, { headers, signal: options.signal });
      const data = Buffer.from(await response.arrayBuffer());
      data.read2xsggResponseUrl = response.url;
      data.httpHeaders = Object.fromEntries(response.headers.entries());
      return data;
    },
    timeoutMs: 200,
    sourceTimeoutMs: 2_000,
    runtimeFallbackTimeoutMs: 100,
    analyzeTimeoutMs: 25,
    sourceBudgetMs: 5_000,
    requireBookWorld: true,
    originReachabilityConfirmed: false,
    unconfirmedOriginHosts: ["unconfirmed.example.test"],
    unconfirmedOriginSources: ["另一个待确认站点"],
    repairBooks: async () => new Promise(() => {}),
    repairChapter: async () => null,
    repairJsonChapter: async () => null,
    repairContent: async () => null,
    analyze: async () => {
      analyzeCalls += 1;
      return { ok: false, reason: "analyze-failed: fixture still needs generic recognition" };
    },
    workerPoolEnabled: false,
    recognitionAttempts: 1,
  });

  assert.equal(analyzeCalls, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].stage, "analyze");
  assert.match(result.skipped[0].reason, /fixture still needs generic recognition/);
});

test("网站识站只完成文本时仍会对失败的漫画类别进行 AI 修复", async () => {
  const host = "https://mixed.example.test";
  const textSource = testSource(host);
  const comicSource = { ...testSource(host), sourceName: "Mixed·comic", sourceType: "comic" };
  let job = { id: "job-1", status: "queued", mode: "site", sourceUrl: host, title: "Mixed" };
  let saved;
  let requestedKind = "";
  const store = {
    getJob: async () => job,
    updateJob: async (_id, patch) => { job = { ...job, ...patch }; },
    saveArtifacts: async (_id, artifacts) => { saved = artifacts; },
  };
  await runLibraryJob({
    store,
    jobId: job.id,
    config: {
      fetchTimeoutMs: 2_000,
      analyzeTimeoutMs: 2_000,
      aiSettings: { enabled: true, provider: "local-http", localBaseUrl: "http://127.0.0.1:11434/v1", localModel: "local", maxAttempts: 1 },
    },
    downloadSource: async () => Buffer.from(""),
    analyze: async () => ({
      ok: true,
      sources: { Text: textSource },
      skippedKinds: [{ kind: "comic", reason: "漫画正文未能识别" }],
    }),
    generateAiCandidate: async ({ preferredKind }) => {
      requestedKind = preferredKind;
      return { ok: true, source: comicSource, detectedType: "comic", confidence: 0.9 };
    },
    verifySource: async () => ({ ok: true, chapterUrl: `${host}/chapter/1` }),
  });
  assert.equal(requestedKind, "comic");
  assert.equal(job.status, "done", job.error);
  assert.equal(job.count, 2);
  assert.equal(job.aiAttemptCount, 1);
  assert.equal(job.aiRepairCount, 1);
  assert.equal(job.progress.skipped, 0);
  assert.ok(saved?.xbs?.length > 0);

  job = { id: "job-2", status: "queued", mode: "site", sourceUrl: host, title: "Mixed" };
  await runLibraryJob({
    store,
    jobId: job.id,
    config: {
      fetchTimeoutMs: 2_000,
      analyzeTimeoutMs: 2_000,
      aiSettings: { enabled: true, provider: "local-http", localBaseUrl: "http://127.0.0.1:11434/v1", localModel: "local", maxAttempts: 1 },
    },
    downloadSource: async () => Buffer.from(""),
    analyze: async () => ({
      ok: true,
      sources: { Text: textSource },
      skippedKinds: [{ kind: "comic", reason: "漫画正文未能识别" }],
    }),
    generateAiCandidate: async () => ({ ok: true, source: comicSource, detectedType: "comic", confidence: 0.9 }),
    verifySource: async () => ({ ok: false, reason: "rules-stale: empty-content" }),
  });
  assert.equal(job.status, "done", job.error);
  assert.equal(job.count, 1);
  assert.equal(job.aiAttemptCount, 1);
  assert.equal(job.aiRepairCount, 0);
  assert.equal(job.progress.skipped, 1);
});

test("WebUI AI 设置接口要求管理员认证且绝不回显密钥", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-ai-api-"));
  const app = createAppServer({
    config: { ...serverConfig({}), adminToken: "admin-secret", dataDir },
    worker: { enqueue() {}, cancel() {}, syncQueued() {} },
  });
  const endpoint = await listen(app);
  context.after(async () => {
    await close(app);
    await rm(dataDir, { recursive: true, force: true });
  });
  const unauthorized = await fetch(`${endpoint}/api/settings/ai`);
  assert.equal(unauthorized.status, 401);
  const headers = { Authorization: "Bearer admin-secret", "Content-Type": "application/json" };
  const saved = await fetch(`${endpoint}/api/settings/ai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, baseUrl: "https://api.example.test/v1", model: "test", apiKey: "ultra-private-key" }),
  });
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.doesNotMatch(savedText, /ultra-private-key/);
  assert.match(savedText, /"apiKeyConfigured": true/);
  const read = await fetch(`${endpoint}/api/settings/ai`, { headers });
  assert.equal(read.status, 200);
  const view = await read.json();
  assert.equal(view.settings.apiKeyConfigured, true);
  assert.equal("apiKey" in view.settings, false);

  let localRequest;
  const localModel = createServer((request, response) => {
    localRequest = { url: request.url, authorization: request.headers.authorization };
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "READY" } }] }));
  });
  const localEndpoint = await listen(localModel);
  context.after(() => close(localModel));
  const localSaved = await fetch(`${endpoint}/api/settings/ai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: false, provider: "local-http", localBaseUrl: `${localEndpoint}/v1`, localModel: "fixture-local" }),
  });
  assert.equal(localSaved.status, 200);
  const localView = await localSaved.json();
  assert.equal(localView.settings.provider, "local-http");
  assert.equal(localView.settings.apiKeyConfigured, true);
  const tested = await fetch(`${endpoint}/api/settings/ai/test`, { method: "POST", headers });
  assert.equal(tested.status, 200, await tested.text());
  assert.equal(localRequest.url, "/v1/chat/completions");
  assert.equal(localRequest.authorization, undefined);

  const bridge = createAgentBridge({ dataDir, adapters: { codex: async () => ({ content: "READY", toolCalls: [] }) }, listModels: async () => ({ models: [{ id: "fixture-codex-model", name: "Fixture" }], source: "codex-cache" }) });
  await bridge.listen();
  context.after(() => bridge.close());
  const cliSaved = await fetch(`${endpoint}/api/settings/ai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, provider: "cli", cliClient: "codex", cliModel: "fixture-codex-model", cliReasoningEffort: "xhigh" }),
  });
  assert.equal(cliSaved.status, 200);
  const cliView = await cliSaved.json();
  assert.equal(cliView.settings.provider, "cli");
  assert.equal(cliView.settings.cliClient, "codex");
  assert.equal(cliView.settings.cliModel, "fixture-codex-model");
  assert.equal(cliView.settings.cliReasoningEffort, "xhigh");
  assert.equal("cliSocketPath" in cliView.settings, false);
  const cliTested = await fetch(`${endpoint}/api/settings/ai/test`, { method: "POST", headers });
  assert.equal(cliTested.status, 200);
  assert.equal((await cliTested.json()).reasoningEffort, "xhigh");
  const models = await fetch(`${endpoint}/api/settings/ai/models?provider=cli`, { headers });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).models, [{ id: "fixture-codex-model", name: "Fixture" }]);
  assert.equal((await fetch(`${endpoint}/api/settings/ai/models?provider=cli`)).status, 401);
  assert.equal((await fetch(`${endpoint}/api/settings/ai/models?provider=unsupported`, { headers })).status, 400);
});
