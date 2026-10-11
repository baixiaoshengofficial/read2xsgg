import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiSettingsStore, publicAiSettings } from "../src/aiSettings.js";
import { aiProviderReady } from "../src/aiProvider.js";
import { requestAiCompletion, probeAiProvider } from "../src/aiProvider.js";
import { createAgentBridge } from "../src/agentBridge.js";
import { normalizeCliMessage } from "../src/cliAdapters.js";
import { generateXiangseCandidate } from "../src/aiSiteAnalyzer.js";
import { connectMcp, probeMcp } from "../src/mcpClient.js";
import { requestChatCompletion, testAiProvider } from "../src/openAiCompat.js";
import { createAppServer, serverConfig } from "../src/server.js";
import { applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
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
  assert.equal(publicView.mcpTokenConfigured, true);
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
  const cli = await store.save({ enabled: true, provider: "cli", cliClient: "codex" });
  assert.equal(aiProviderReady(cli), true);
  assert.equal(publicAiSettings(cli).cliClient, "codex");
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
  const settings = { enabled: true, provider: "cli", cliClient: "codex", cliSocketPath: bridge.socketPath, timeoutMs: 5_000 };
  assert.equal((await probeAiProvider(settings)).response, "READY");
  const tool = { type: "function", function: { name: "mcp_browser_navigate", parameters: { type: "object" } } };
  const message = await requestAiCompletion({ settings, messages: [{ role: "user", content: "read page" }], tools: [tool] });
  assert.equal(message.tool_calls[0].function.name, "mcp_browser_navigate");
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).url, "https://example.test/");
  assert.equal(calls.length, 2);
  assert.throws(() => normalizeCliMessage({ content: "", toolCalls: [{ name: "evil", arguments: {} }] }, [tool]), /未批准/);
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
    mcpConnect: async () => client,
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
    mcpConnect: async () => client,
    request: async () => ({
      tool_calls: [{ id: "tool-evil", type: "function", function: { name: "mcp_browser_navigate", arguments: JSON.stringify({ url: "https://evil.example/" }) } }],
    }),
  }), /证据中出现的公开站点域名/);
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
  const brokenSource = structuredClone(workingSource);
  brokenSource.sourceName = "Broken";
  brokenSource.bookWorld["全部"].requestInfo = `${host}/missing`;
  let genericAttempts = 0;
  let aiAttempts = 0;
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
    aiSettings: { enabled: true, apiKey: "test", model: "test", timeoutMs: 5_000, maxAttempts: 1 },
    analyze: async () => {
      genericAttempts += 1;
      return { ok: false, reason: "analyze-failed: fixture generic miss" };
    },
    generateAiCandidate: async ({ host: observedHost, failureReason }) => {
      aiAttempts += 1;
      assert.equal(observedHost, host);
      assert.match(failureReason, /rules-stale/);
      return { ok: true, source: workingSource, detectedType: "text", confidence: 0.9, toolCalls: 0 };
    },
    workerPoolEnabled: false,
  });
  assert.equal(genericAttempts, 1);
  assert.equal(aiAttempts, 1);
  assert.equal(Object.keys(gated.sources).length, 1);
  assert.equal(gated.sources.Broken.bookWorld["全部"].requestInfo, `${host}/books`);
  assert.equal(gated.fallbackCount, 1);
  assert.equal(gated.aiRepairCount, 1);
  assert.equal(gated.verifiedCount, 1);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.skipped.length, 0);
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
  assert.equal(gated.verifiedCount, 1);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.sources.Broken.bookWorld["全部"].requestInfo, `${host}/books`);
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

  const bridge = createAgentBridge({ dataDir, adapters: { codex: async () => ({ content: "READY", toolCalls: [] }) } });
  await bridge.listen();
  context.after(() => bridge.close());
  const cliSaved = await fetch(`${endpoint}/api/settings/ai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, provider: "cli", cliClient: "codex" }),
  });
  assert.equal(cliSaved.status, 200);
  const cliView = await cliSaved.json();
  assert.equal(cliView.settings.provider, "cli");
  assert.equal(cliView.settings.cliClient, "codex");
  assert.equal("cliSocketPath" in cliView.settings, false);
  const cliTested = await fetch(`${endpoint}/api/settings/ai/test`, { method: "POST", headers });
  assert.equal(cliTested.status, 200, await cliTested.text());
});
