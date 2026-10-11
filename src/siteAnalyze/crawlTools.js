import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const TOOL_SCHEMA = {
  type: "object",
  properties: { url: { type: "string", description: "An observed public page URL" } },
  required: ["url"],
  additionalProperties: false,
};
const MAX_REQUESTS = 60;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RENDER_BYTES = 8 * MAX_RESPONSE_BYTES;
const localBrowserCounter = new Int32Array(new SharedArrayBuffer(8));

/** Select capabilities from the failed stage, not the site's name. */
export function selectCrawlTools({ preferredKind, failureReason, pages = [] } = {}) {
  const names = ["fetch_page"];
  const media = /^(?:comic|audio|video)$/.test(preferredKind || "");
  const failedExtraction = /empty-(?:list|toc|content)|detail|chapter|正文|章节|列表/i.test(failureReason || "");
  const dynamic = pages.some((page) => page.dynamic);
  if (media || failedExtraction || dynamic) names.push("browser_snapshot");
  if (media) names.push("browser_network_requests");
  return names;
}

export async function browserExecutable() {
  const candidates = [process.env.CHROMIUM_EXECUTABLE_PATH, "/usr/bin/chromium", chromium.executablePath()].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try another installed browser. */ }
  }
  throw new Error("内置浏览器未安装；请使用包含 Chromium 的转换器镜像");
}

async function acquireBrowserSlot(settings, signal) {
  const shared = settings?.semaphore;
  const counter = shared instanceof SharedArrayBuffer && shared.byteLength >= 8 ? new Int32Array(shared) : localBrowserCounter;
  while (true) {
    signal?.throwIfAborted();
    const current = Atomics.load(counter, 1);
    if (current < 2 && Atomics.compareExchange(counter, 1, current, current + 1) === current) {
      return () => Atomics.sub(counter, 1, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** All browser HTTP requests use the converter's DNS-pinned, SSRF-guarded downloader. */
export async function renderSitePage({ url, download, authorizeNetwork, signal, settings, executablePath, timeoutMs = 12_000 }) {
  const release = await acquireBrowserSlot(settings, signal);
  let browser;
  let browserHome;
  const onAbort = () => { void browser?.close().catch(() => {}); };
  const network = [];
  let requests = 0;
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    if (!await authorizeNetwork(url)) throw new Error("浏览器拒绝非公开网页地址");
    browserHome = await mkdtemp(path.join(os.tmpdir(), "read2xsgg-browser-"));
    browser = await chromium.launch({
      executablePath: executablePath || await browserExecutable(),
      headless: true,
      timeout: timeoutMs,
      // Chromium's crash/cache directories must be writable in a read-only container.
      // Do not inherit ADMIN_TOKEN, AI credentials or CLI account settings.
      env: {
        ...Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
        HOME: browserHome, XDG_CONFIG_HOME: browserHome, XDG_CACHE_HOME: browserHome,
      },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-sync", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    context.setDefaultTimeout(timeoutMs);
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        signal?.throwIfAborted();
        if (++requests > MAX_REQUESTS || !["GET", "HEAD"].includes(request.method())
          || ["image", "media", "font"].includes(request.resourceType())
          || !await authorizeNetwork(request.url())) return await route.abort();
        // Never forward browser cookies, source credentials, or arbitrary request headers.
        const response = await download(request.url(), {}, { signal, method: request.method() });
        const body = Buffer.isBuffer(response) ? response : Buffer.from(response ?? "");
        const finalUrl = response?.read2xsggResponseUrl || request.url();
        if (!await authorizeNetwork(finalUrl) || body.length > MAX_RESPONSE_BYTES
          || (bytes += body.length) > MAX_RENDER_BYTES) return await route.abort();
        const contentType = String(response?.httpHeaders?.["content-type"] || "text/html; charset=utf-8");
        if (network.length < 20 && ["xhr", "fetch"].includes(request.resourceType())) {
          network.push({ url: finalUrl, contentType, body: body.subarray(0, 60_000).toString("utf8") });
        }
        await route.fulfill({ status: 200, contentType, body });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // networkidle is best effort: analytics must not prevent collecting useful DOM evidence.
    await page.waitForLoadState("networkidle", { timeout: Math.min(3_000, timeoutMs) }).catch(() => {});
    signal?.throwIfAborted();
    return { url: page.url(), html: (await page.content()).slice(0, 60_000), network };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
    if (browserHome) await rm(browserHome, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

/** In-process MCP tool contract: no endpoint, credentials, or exposed listener. */
export function createSiteCrawler({ plan, download, authorizeNetwork, sanitizePage, signal, settings, render = renderSitePage }) {
  const names = new Set(plan);
  const snapshots = new Map();
  let closed = false;
  return {
    async listTools() {
      return [...names].map((name) => ({
        name,
        description: name === "fetch_page" ? "Download and inspect a public category, detail or chapter page."
          : name === "browser_snapshot" ? "Render a dynamic page and inspect the resulting DOM and observed API responses."
            : "Observe read-only JSON/media API responses while rendering a page.",
        inputSchema: TOOL_SCHEMA,
      }));
    },
    async callTool(name, args) {
      signal?.throwIfAborted();
      if (closed || !names.has(name)) throw new Error("未批准的内置抓取工具");
      if (!args || Object.keys(args).some((key) => key !== "url") || typeof args.url !== "string") throw new Error("抓取工具仅接受网页 URL");
      if (!await authorizeNetwork(args.url)) throw new Error("抓取工具拒绝非公开网页地址");
      let result;
      if (name === "fetch_page") {
        const response = await download(args.url, {}, { signal });
        const url = response?.read2xsggResponseUrl || args.url;
        if (!await authorizeNetwork(url)) throw new Error("抓取工具拒绝非公开跳转地址");
        result = sanitizePage(response, url);
      } else {
        if (!snapshots.has(args.url)) snapshots.set(args.url, render({ url: args.url, download, authorizeNetwork, signal, settings }));
        const snapshot = await snapshots.get(args.url);
        result = {
          ...(name === "browser_snapshot" ? sanitizePage(Buffer.from(snapshot.html), snapshot.url) : {}),
          network: snapshot.network.map((response) => sanitizePage(Buffer.from(response.body), response.url, response.contentType)),
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
    async close() { closed = true; snapshots.clear(); },
  };
}
