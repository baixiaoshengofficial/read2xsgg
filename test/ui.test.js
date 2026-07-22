import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
