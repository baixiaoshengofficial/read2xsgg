import assert from "node:assert/strict";
import test from "node:test";
import { createSiteCrawler, selectCrawlTools } from "../src/siteAnalyze/crawlTools.js";

test("抓取能力按失败阶段和媒体类型自动选择，不按站点名称选择", () => {
  assert.deepEqual(selectCrawlTools({ preferredKind: "text" }), ["fetch_page"]);
  assert.deepEqual(selectCrawlTools({ preferredKind: "text", failureReason: "rules-stale: empty-toc" }), ["fetch_page", "browser_snapshot"]);
  for (const preferredKind of ["comic", "audio", "video"]) {
    assert.deepEqual(selectCrawlTools({ preferredKind }), ["fetch_page", "browser_snapshot", "browser_network_requests"]);
  }
  assert.deepEqual(selectCrawlTools({ pages: [{ dynamic: true }] }), ["fetch_page", "browser_snapshot"]);
});

test("内置抓取工具不依赖外部 MCP，渲染和接口观察复用同一页面", async () => {
  let renders = 0;
  const crawler = createSiteCrawler({
    plan: selectCrawlTools({ preferredKind: "audio" }),
    authorizeNetwork: async (url) => new URL(url).hostname === "example.test",
    download: async () => Buffer.from("static page"),
    sanitizePage: (buffer, url) => ({ url, html: buffer.toString() }),
    render: async ({ url }) => {
      renders += 1;
      return { url, html: "rendered page", network: [{ url: "https://example.test/api", body: '{"audio":"/episode.mp3"}' }] };
    },
  });
  assert.equal((await crawler.listTools()).length, 3);
  const args = { url: "https://example.test/chapter/1" };
  assert.match((await crawler.callTool("fetch_page", args)).content[0].text, /static page/);
  assert.match((await crawler.callTool("browser_snapshot", args)).content[0].text, /rendered page/);
  assert.match((await crawler.callTool("browser_network_requests", args)).content[0].text, /episode.mp3/);
  assert.equal(renders, 1);
  await assert.rejects(crawler.callTool("shell", args), /未批准/);
  await assert.rejects(crawler.callTool("fetch_page", { ...args, script: "x" }), /仅接受/);
  await assert.rejects(crawler.callTool("fetch_page", { url: "http://localhost/" }), /非公开/);
  await crawler.close();
  await assert.rejects(crawler.callTool("fetch_page", args), /未批准/);
});

test("抓取工具拒绝重定向到非公开网络并响应取消", async () => {
  const controller = new AbortController();
  const crawler = createSiteCrawler({
    plan: ["fetch_page"], signal: controller.signal,
    authorizeNetwork: async (url) => new URL(url).hostname === "example.test",
    download: async () => Object.assign(Buffer.from("private"), { read2xsggResponseUrl: "http://127.0.0.1/" }),
    sanitizePage: () => { throw new Error("private data must not reach sanitizer"); },
  });
  await assert.rejects(crawler.callTool("fetch_page", { url: "https://example.test/" }), /非公开跳转/);
  controller.abort(new Error("cancelled"));
  await assert.rejects(crawler.callTool("fetch_page", { url: "https://example.test/" }), /cancelled/);
});
