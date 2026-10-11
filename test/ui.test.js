import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createAppServer, createLibraryStore, serverConfig } from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function withUiServer(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-ui-"));
  const app = createAppServer({
    config: {
      ...serverConfig({ ADMIN_TOKEN: "ui-token", DATA_DIR: dir }),
      adminToken: "ui-token",
      dataDir: dir,
      publicDir: PUBLIC_DIR,
    },
    store: createLibraryStore(dir),
    worker: { enqueue() {}, recover: async () => {} },
    recoverJobs: false,
  });
  const base = await listen(app);
  try {
    await run(base);
  } finally {
    await close(app);
    await rm(dir, { recursive: true, force: true });
  }
}

test("public UI 提供窄屏 viewport 与可触达控件标记", async () => {
  const html = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  assert.match(html, /name=["']viewport["'][^>]*content=["'][^"']*width=device-width[^"']*["']/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<dialog[^>]+id=["']confirm-dialog["']/);
  assert.match(html, /aria-labelledby=["']confirm-title["']/);
  assert.match(html, /inputmode=["']url["']/);
  assert.match(html, /href=["']\/ui\/app\.css["']/);
  assert.match(html, /src=["']\/ui\/app\.js["']/);
});

test("public CSS 覆盖 overflow / touch / safe-area / 窄屏布局", async () => {
  const css = await readFile(path.join(PUBLIC_DIR, "app.css"), "utf8");
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /--touch-min:\s*2\.75rem/);
  assert.match(css, /min-height:\s*var\(--touch-min\)/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /font-size:\s*16px/);
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /code\s*\{[^}]*word-break:\s*break-all/s);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /@media\s*\(max-width:\s*360px\)/);
  assert.match(css, /\.actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /label\.inline\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.confirm-dialog\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("public JS 使用 dialog 确认删除并回退到 confirm", async () => {
  const js = await readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
  assert.match(js, /function confirmAction\(/);
  assert.match(js, /dialog\.showModal\(/);
  assert.match(js, /window\.confirm\(/);
  assert.match(js, /confirmAction\("删除该任务及制品？"/);
  assert.match(js, /role="progressbar"/);
  assert.doesNotMatch(js, /if\s*\(\s*!window\.confirm\(/);
});

test("public JS 为运行中的任务提供暂停、并为暂停任务提供继续入口", async () => {
  const js = await readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
  assert.match(js, /data-pause=/);
  assert.match(js, /data-resume=/);
  assert.match(js, /已暂停/);
  assert.match(js, /将从头重跑/);
});

async function loadUiDocument(context) {
  const [html, css, script] = await Promise.all([
    readFile(path.join(PUBLIC_DIR, "index.html"), "utf8"),
    readFile(path.join(PUBLIC_DIR, "app.css"), "utf8"),
    readFile(path.join(PUBLIC_DIR, "app.js"), "utf8"),
  ]);
  const dom = new JSDOM(html, { url: "https://converter.test/ui/", runScripts: "outside-only" });
  context.after(() => dom.window.close());
  const style = dom.window.document.createElement("style");
  style.textContent = css;
  dom.window.document.head.append(style);
  dom.window.eval(script);
  return dom.window;
}

test("AI 接入切换后只显示对应字段，抓取工具自动选择而不要求用户配置", async (context) => {
  const window = await loadUiDocument(context);
  const document = window.document;
  const provider = document.getElementById("ai-provider");
  const groups = { api: "ai-api-fields", "local-http": "ai-local-fields", cli: "ai-cli-fields" };
  for (const selected of Object.keys(groups)) {
    provider.value = selected;
    provider.dispatchEvent(new window.Event("change"));
    for (const [kind, id] of Object.entries(groups)) {
      const group = document.getElementById(id);
      assert.equal(group.hidden, kind !== selected);
      assert.equal(window.getComputedStyle(group).display, kind === selected ? "grid" : "none");
    }
  }
  assert.equal(document.getElementById("ai-browser-settings"), null);
  assert.equal(document.getElementById("mcp-endpoint"), null);
  assert.match(document.getElementById("ai-auto-crawl").textContent, /自动选择.*无需配置/);
  assert.equal(document.getElementById("ai-performance-settings").open, false);
});

test("AI 连接检查先保存当前填写值，明确显示连接失败和零个验链成功", async (context) => {
  const window = await loadUiDocument(context);
  const document = window.document;
  const calls = [];
  let connected = true;
  window.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    const saving = options.method === "PUT";
    const body = saving
      ? { settings: calls.at(-1).body }
      : connected ? { model: "Codex CLI", response: "READY" } : { error: "连接超时" };
    return { ok: saving || connected, status: saving || connected ? 200 : 502, text: async () => JSON.stringify(body) };
  };
  document.getElementById("ai-enabled").checked = true;
  document.getElementById("ai-provider").value = "cli";
  const button = document.getElementById("ai-test");
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["PUT", "/api/settings/ai"], ["POST", "/api/settings/ai/test"],
  ]);
  assert.equal(calls[0].body.provider, "cli");
  assert.equal(calls[0].body.enabled, true);
  assert.match(document.getElementById("ai-settings-status").textContent, /AI 连接成功/);
  assert.equal(button.disabled, false);
  assert.match(window.phaseLabel({ status: "done", count: 363, aiRepairCount: 0, progress: { skipped: 554 } }), /AI 验链成功 0/);
  assert.match(window.phaseLabel({ status: "done", count: 363, aiAttemptCount: 7, aiRepairCount: 0, progress: { skipped: 554 } }), /AI 尝试 7 次/);
  assert.match(window.phaseLabel({ status: "running", phase: "verify", progress: { step: "ai-analyze", done: 8, total: 20, aiAttemptsTotal: 3, aiRepaired: 1 } }), /AI 识站 8\/20 .*AI 累计尝试 3 \/ 验链成功 1/);
  assert.match(window.phaseLabel({ status: "running", phase: "verify", progress: { step: "ai-verify", done: 8, total: 20 } }), /AI 候选验链 8\/20/);
  assert.doesNotMatch(window.phaseLabel({ status: "running", phase: "verify", progress: { step: "ai-analyze", done: 8, total: 20 } }), /1\/1/);

  connected = false;
  document.getElementById("ai-provider").value = "api";
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[2].body.provider, "api");
  assert.match(document.getElementById("ai-settings-status").textContent, /设置已保存，但 AI 连接检查失败：连接超时/);
  assert.equal(button.disabled, false);
});

test("Codex 模型可选择或手动输入，保存与连接检查使用同一个模型", async (context) => {
  const window = await loadUiDocument(context);
  const document = window.document;
  const calls = [];
  window.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const body = url.includes("/models?")
      ? { source: "codex-cache", models: [{ id: "fixture-model", name: "Fixture", reasoningEfforts: ["low", "high", "ultra"], defaultReasoningEffort: "high" }, { id: "small-model", name: "Small", reasoningEfforts: ["low"] }] }
      : options.method === "PUT" ? { settings: calls.at(-1).body } : { model: "Codex CLI · custom-model", response: "READY" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const provider = document.getElementById("ai-provider");
  provider.value = "cli";
  provider.dispatchEvent(new window.Event("change"));
  await new Promise((resolve) => setImmediate(resolve));
  const model = document.getElementById("ai-cli-model");
  assert.ok([...model.options].some((option) => option.value === "fixture-model"));
  assert.match(document.getElementById("ai-models-status").textContent, /缓存模型/);
  model.value = "fixture-model";
  model.dispatchEvent(new window.Event("change"));
  const effort = document.getElementById("ai-cli-reasoning-effort");
  assert.deepEqual([...effort.options].map((option) => option.value), ["", "low", "high", "ultra"]);
  assert.match(effort.options[0].textContent, /模型默认.*high/);
  effort.value = "ultra";
  effort.dispatchEvent(new window.Event("change"));
  document.getElementById("ai-test").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.find((call) => call.method === "PUT").body.cliModel, "fixture-model");
  assert.equal(calls.find((call) => call.method === "PUT").body.cliReasoningEffort, "ultra");
  assert.equal(document.getElementById("ai-cli-custom-fields").hidden, true);
  model.value = "small-model";
  model.dispatchEvent(new window.Event("change"));
  assert.equal(effort.value, "ultra");
  assert.match(document.getElementById("ai-cli-reasoning-hint").textContent, /不支持原档位/);
  const writes = calls.filter((call) => call.method === "PUT").length;
  document.getElementById("ai-test").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "PUT").length, writes);
  assert.match(document.getElementById("ai-settings-status").textContent, /请重新选择/);
  effort.value = "low";
  effort.dispatchEvent(new window.Event("change"));
  model.value = "__custom__";
  model.dispatchEvent(new window.Event("change"));
  assert.equal(document.getElementById("ai-cli-custom-fields").hidden, false);
  document.getElementById("ai-cli-model-custom").value = "custom-model";
  document.getElementById("ai-test").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "PUT").at(-1).body.cliModel, "custom-model");
  assert.equal(calls.filter((call) => call.method === "PUT").at(-1).body.cliReasoningEffort, "low");
});

test("推理档位刷新后恢复，API、本地与 CLI 独立且空能力列表仅允许默认", async (context) => {
  const window = await loadUiDocument(context);
  const document = window.document;
  const saved = { enabled: true, provider: "cli", cliModel: "fixture", cliReasoningEffort: "max", reasoningEffort: "low", localReasoningEffort: "high" };
  window.fetch = async (url) => ({ ok: true, text: async () => JSON.stringify(url.includes("/models?")
    ? { models: [{ id: "fixture", name: "Fixture", reasoningEfforts: ["low", "max"], defaultReasoningEffort: "low" }, { id: "plain", reasoningEfforts: [] }] }
    : { settings: saved }) });
  await window.loadAiSettings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.getElementById("ai-cli-fields").hidden, false);
  assert.equal(document.getElementById("ai-cli-model").value, "fixture");
  assert.deepEqual([...document.getElementById("ai-cli-reasoning-effort").options].map((option) => option.value), ["", "low", "max"]);
  assert.equal(document.getElementById("ai-cli-reasoning-effort").value, "max");
  assert.equal(document.getElementById("ai-reasoning-effort").value, "low");
  assert.equal(document.getElementById("ai-local-reasoning-effort").value, "high");
  assert.match(document.getElementById("ai-config-state").textContent, /档位.*max/);
  const model = document.getElementById("ai-cli-model");
  const effort = document.getElementById("ai-cli-reasoning-effort");
  effort.value = "";
  effort.dispatchEvent(new window.Event("change"));
  model.value = "plain";
  model.dispatchEvent(new window.Event("change"));
  assert.deepEqual([...effort.options].map((option) => option.value), [""]);
  assert.match(document.getElementById("ai-cli-reasoning-hint").textContent, /未公布可用推理档位/);
});

test("/ui 路由提供 HTML/CSS/JS 且 content-type 正确", async () => {
  await withUiServer(async (base) => {
    const page = await fetch(`${base}/ui/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    const html = await page.text();
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /confirm-dialog/);

    const css = await fetch(`${base}/ui/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    const cssText = await css.text();
    assert.match(cssText, /@media\s*\(max-width:\s*640px\)/);
    assert.match(cssText, /safe-area-inset-top/);

    const js = await fetch(`${base}/ui/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") || "", /javascript/);
    const jsText = await js.text();
    assert.match(jsText, /confirmAction/);

    const trailing = await fetch(`${base}/ui`);
    assert.equal(trailing.status, 200);
  });
});
