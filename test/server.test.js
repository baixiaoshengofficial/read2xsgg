import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Jimp, JimpMime } from "jimp";
import { chapterPageCandidates, compileBookBridgePlan, createAppServer, decodeBridgePlan, decodeXbs, downloadSource, encodeBridgePlan, filterReachableSources, normalizeEmbeddedSourceUrl, pageImageUrls, pageTocUrl, serverConfig, skippedBuckets, sourceUrlCandidates } from "../src/index.js";
import { encodeSsrEpisodePlan } from "../src/siteAnalyze/ssrEpisodes.js";

const source = {
  bookSourceName: "在线示例",
  bookSourceUrl: "https://example.com",
  searchUrl: "/search?q={{key}}&page={{page}}",
  ruleSearch: {
    checkKeyWord: "测试",
    bookList: ".book-list > li",
    name: "h3 > a",
    author: ".author",
    bookUrl: "h3 > a@href",
  },
  ruleBookInfo: { name: "h1", intro: ".intro" },
  ruleToc: { chapterList: "#list dd", chapterName: "a", chapterUrl: "a@href" },
  ruleContent: { content: "#content" },
};

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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function testServerConfig() {
  return serverConfig({
    PREFLIGHT_SOURCES: "false",
    PREFLIGHT_DEEP_SOURCES: "false",
    VERIFY_CONVERTED_SOURCES: "false",
    ANALYZE_FALLBACK: "false",
  });
}

test("手拼阅读源地址可还原为完整 URL", () => {
  assert.equal(
    normalizeEmbeddedSourceUrl("www.example.com/sources/all.json.xbs"),
    "https://www.example.com/sources/all.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("https/www.example.com/a.json.xbs"),
    "https://www.example.com/a.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("https://www.example.com/a.json.xbs"),
    "https://www.example.com/a.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("http%3A%2F%2F127.0.0.1%3A9%2Fa.json"),
    "http://127.0.0.1:9/a.json",
  );
});

test("源地址候选仅对目录段生成通用单复数回退", () => {
  assert.deepEqual(sourceUrlCandidates("https://example.com/source.json"), ["https://example.com/source.json"]);
  assert.deepEqual(sourceUrlCandidates("https://example.com/api/sources/json/id/1.json"), [
    "https://example.com/api/sources/json/id/1.json",
    "https://example.com/api/source/json/id/1.json",
  ]);
});

test("深度预检为 JSON API 详情尝试同源 HTML 章节页", () => {
  assert.deepEqual(chapterPageCandidates("https://comic.example/api/comic/123?from=list"), [
    "https://comic.example/api/comic/123?from=list",
    "https://comic.example/comic/123",
  ]);
  assert.deepEqual(chapterPageCandidates("https://comic.example/comic/123"), [
    "https://comic.example/comic/123",
  ]);
});

test("在线 URL 接口输出 XBS、JSON、缓存标识和健康状态", async (context) => {
  const upstreamRequests = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(source));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 60_000 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const health = await fetch(`${appBase}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const sourceUrl = `${upstreamBase}/source.json?token=abc`;
  const xbsResponse = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(sourceUrl)}`);
  assert.equal(xbsResponse.status, 200);
  assert.equal(xbsResponse.headers.get("content-type"), "application/octet-stream");
  assert.equal(xbsResponse.headers.get("x-converted-count"), "1");
  assert.equal(xbsResponse.headers.get("x-skipped-count"), "0");
  const etag = xbsResponse.headers.get("etag");
  assert.ok(etag);
  const converted = JSON.parse(decodeXbs(Buffer.from(await xbsResponse.arrayBuffer())).toString("utf8"));
  assert.equal(converted["在线示例"].sourceName, "在线示例");

  const pathSourceUrl = `${upstreamBase}/source.json?token=path`;
  const pathResponse = await fetch(`${appBase}/source/${encodeURIComponent(pathSourceUrl)}.xbs`);
  assert.equal(pathResponse.status, 200);
  assert.ok(pathResponse.url.endsWith(".xbs"));
  assert.equal(upstreamRequests.at(-1), "/source.json?token=path");
  assert.equal(
    JSON.parse(decodeXbs(Buffer.from(await pathResponse.arrayBuffer())).toString("utf8"))["在线示例"].sourceName,
    "在线示例",
  );

  // /source/{host}{path}.xbs — 去掉 https:// 后直接拼接
  const upstreamUrl = new URL(`${upstreamBase}/source.json`);
  const easyResponse = await fetch(`${appBase}/source/${upstreamUrl.host}${upstreamUrl.pathname}.xbs`);
  assert.equal(easyResponse.status, 200);
  assert.equal(upstreamRequests.at(-1), "/source.json");
  assert.equal(
    JSON.parse(decodeXbs(Buffer.from(await easyResponse.arrayBuffer())).toString("utf8"))["在线示例"].sourceName,
    "在线示例",
  );

  // /xbs/ 仍为兼容别名
  const aliasResponse = await fetch(`${appBase}/xbs/${upstreamUrl.host}${upstreamUrl.pathname}.xbs`);
  assert.equal(aliasResponse.status, 200);

  // /x.xbs?u=完整地址 — 路径带 .xbs，查询参数通常无需编码
  const shortQuery = await fetch(`${appBase}/x.xbs?u=${upstreamBase}/source.json?token=short`);
  assert.equal(shortQuery.status, 200);
  assert.equal(upstreamRequests.at(-1), "/source.json?token=short");

  const notModified = await fetch(`${appBase}/convert?url=${encodeURIComponent(sourceUrl)}`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(notModified.status, 304);

  const jsonResponse = await fetch(`${appBase}/j/${upstreamUrl.host}${upstreamUrl.pathname}`);
  assert.equal(jsonResponse.status, 200);
  const debug = await jsonResponse.json();
  assert.equal(debug.sources["在线示例"].sourceName, "在线示例");
  assert.ok(Array.isArray(debug.warnings));
});

test("发布接口允许最大阅读源大小内的 payload", async (context) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "read2xsgg-publish-"));
  const worker = { enqueue() {}, cancel() {}, syncQueued() {} };
  const app = createAppServer({
    config: { ...testServerConfig(), adminToken: "test-token", dataDir },
    worker,
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await rm(dataDir, { recursive: true, force: true });
  });

  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
  const created = await fetch(`${appBase}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.com/source.json", name: "large-payload" }),
  });
  assert.equal(created.status, 202);
  const job = await created.json();

  const payload = { ...source, bookSourceComment: "x".repeat(1_048_576) };
  const body = JSON.stringify({ source: payload });
  assert.ok(Buffer.byteLength(body) > 1_048_576);
  const published = await fetch(`${appBase}/api/jobs/${job.id}/publish`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).status, "done");
});

test("/url/ 对网站地址执行识站并返回 XBS", async (context) => {
  const novelHome = `<!doctype html><html><head><title>示例小说网</title></head><body>
<ul class="list">
  <li><a href="/book/1.html">第一本书</a></li>
  <li><a href="/book/2.html">第二本书</a></li>
  <li><a href="/book/3.html">第三本书</a></li>
  <li><a href="/book/4.html">第四本书</a></li>
</ul>
</body></html>`;
  const novelDetail = `<!doctype html><html><body>
<h1>第一本书</h1>
<div class="chapter-list">
  <a href="/chapter/1.html">第一章</a>
  <a href="/chapter/2.html">第二章</a>
  <a href="/chapter/3.html">第三章</a>
</div>
</body></html>`;
  const novelChapter = `<!doctype html><html><body>
<div id="content"><p>${"正文内容。".repeat(40)}</p></div>
</body></html>`;

  const upstream = createServer((request, response) => {
    const path = request.url || "/";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (/\/book\/1\.html/.test(path)) response.end(novelDetail);
    else if (/\/chapter\//.test(path)) response.end(novelChapter);
    else response.end(novelHome);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const site = new URL(upstreamBase);
  const xbsResponse = await fetch(`${appBase}/url/${site.host}.xbs`);
  assert.equal(xbsResponse.status, 200);
  assert.equal(xbsResponse.headers.get("x-converted-count"), "1");
  assert.equal(xbsResponse.headers.get("x-analyze-kind"), "text");
  const sources = JSON.parse(decodeXbs(Buffer.from(await xbsResponse.arrayBuffer())).toString("utf8"));
  const names = Object.keys(sources);
  assert.equal(names.length, 1);
  assert.equal(sources[names[0]].sourceType, "text");
  assert.ok(sources[names[0]].chapterContent?.content);

  const jsonResponse = await fetch(`${appBase}/url/${site.host}/`);
  assert.equal(jsonResponse.status, 200);
  const debug = await jsonResponse.json();
  assert.equal(debug.kind, "text");
  assert.ok(debug.sources);
});

test("同一在线源的并发转换会合并为一个上游任务", async (context) => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(source));
    }, 50);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0, maxConcurrent: 1 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const sourceUrl = `${upstreamBase}/source.json`;
  const requestUrl = `${appBase}/convert.xbs?url=${encodeURIComponent(sourceUrl)}`;
  const [first, second] = await Promise.all([fetch(requestUrl), fetch(requestUrl)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(requests, 1);
});

test("聚合源转换会在转换前过滤不可访问上游站点", async (context) => {
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    if (request.url?.startsWith("/source.json")) {
      const reachable = { ...structuredClone(source), bookSourceName: "可访问", bookSourceUrl: upstreamBase };
      const unreachable = { ...structuredClone(source), bookSourceName: "不可访问", bookSourceUrl: "http://127.0.0.1:1" };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify([reachable, unreachable]));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: {
      ...testServerConfig(),
      allowPrivateNetworks: true,
      preflightSources: true,
      preflightTimeoutMs: 250,
      preflightConcurrency: 2,
    },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/convert/json?url=${encodeURIComponent(`${upstreamBase}/source.json`)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-converted-count"), "1");
  assert.equal(response.headers.get("x-skipped-count"), "1");
  const payload = await response.json();
  assert.ok(payload.sources["可访问"]);
  assert.equal(payload.sources["不可访问"], undefined);
  assert.deepEqual(payload.skipped, [{ source: "不可访问", reason: "上游站点不可访问" }]);
});

test("预检使用 GET 并尝试源声明的绝对搜索入口", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const input = [{
    ...structuredClone(source),
    bookSourceName: "备用入口",
    bookSourceUrl: "http://127.0.0.1:1",
    searchUrl: `${upstreamBase}/search?q={{key}}`,
  }];
  const result = await filterReachableSources(input, {
    ...testServerConfig(),
    allowPrivateNetworks: true,
    preflightSources: true,
    preflightTimeoutMs: 250,
    preflightConcurrency: 1,
  });
  assert.equal(result.input.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("预检在根路径受限时尝试源声明的实际搜索入口", async (context) => {
  const upstream = createServer((request, response) => {
    if (request.url.startsWith("/search")) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("forbidden");
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const result = await filterReachableSources([{
    ...structuredClone(source),
    bookSourceUrl: upstreamBase,
    searchUrl: "/search?q={{key}}&page={{page}}",
  }], {
    ...testServerConfig(),
    allowPrivateNetworks: true,
    preflightSources: true,
    preflightTimeoutMs: 250,
    preflightConfirmTimeoutMs: 500,
    preflightConcurrency: 1,
  });
  assert.equal(result.input.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("快速预检超时后使用较长时限二次确认", async (context) => {
  const upstream = createServer((_request, response) => {
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("slow-ok");
    }, 120);
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const result = await filterReachableSources([{
    ...structuredClone(source),
    bookSourceUrl: upstreamBase,
  }], {
    ...testServerConfig(),
    allowPrivateNetworks: true,
    preflightSources: true,
    preflightTimeoutMs: 30,
    preflightConfirmTimeoutMs: 300,
    preflightConcurrency: 1,
  });
  assert.equal(result.input.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("预检三次超时后只跳过该站点，不中断合集转换", async (context) => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("too late");
    }, 100);
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const result = await filterReachableSources([{
    ...structuredClone(source),
    bookSourceName: "连续超时",
    bookSourceUrl: upstreamBase,
  }], {
    ...testServerConfig(),
    allowPrivateNetworks: true,
    preflightSources: true,
    preflightTimeoutMs: 10,
    preflightConfirmTimeoutMs: 10,
    preflightRetries: 3,
    preflightConcurrency: 1,
  });
  // Each retry may try the source's declared entry, home page, and protocol
  // fallback. The contract is three retry rounds, not one fixed URL count.
  assert.ok(requests >= 3);
  assert.deepEqual(result.input, []);
  assert.deepEqual(result.skipped, [{ source: "连续超时", reason: "上游站点不可访问" }]);
});

test("POST 表单可在 302 后切换 GET 且不会重放请求体", async (context) => {
  const requests = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/search") {
        response.writeHead(302, { Location: "/result" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const output = await downloadSource(`${upstreamBase}/search`, {
    ...testServerConfig(),
    allowPrivateNetworks: true,
  }, {
    "Content-Type": "application/x-www-form-urlencoded",
  }, {
    method: "POST",
    body: "keyword=test",
    followPostRedirects: true,
  });
  assert.equal(output.toString("utf8"), "ok");
  assert.deepEqual(requests, [
    { method: "POST", url: "/search", body: "keyword=test" },
    { method: "GET", url: "/result", body: "" },
  ]);
});

test("下载器默认使用浏览器请求头且允许书源覆盖", async (context) => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({
      userAgent: request.headers["user-agent"],
      language: request.headers["accept-language"],
    });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const config = { ...testServerConfig(), allowPrivateNetworks: true };

  await downloadSource(`${upstreamBase}/default`, config);
  await downloadSource(`${upstreamBase}/custom`, config, {
    "User-Agent": "SourceClient/1.0",
    "Accept-Language": "ja-JP",
  });

  assert.match(requests[0].userAgent, /^Mozilla\/5\.0/);
  assert.equal(requests[0].language, "zh-CN,zh;q=0.9,en;q=0.7");
  assert.deepEqual(requests[1], {
    userAgent: "SourceClient/1.0",
    language: "ja-JP",
  });
});

test("下载总时限可中止尚未返回响应的连接", async (context) => {
  const upstream = createServer(() => {
    // Intentionally leave the request pending to exercise the wall-clock cap.
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const started = Date.now();
  await assert.rejects(
    downloadSource(`${upstreamBase}/pending`, {
      ...testServerConfig(),
      allowPrivateNetworks: true,
      fetchTimeoutMs: 100,
    }),
    /超时/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("深度预检可安全解析搜索 JS URL，并从 API 详情回退到 HTML 目录", async (context) => {
  let upstreamBase = "";
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/search?keyword=%E5%B0%8F%E8%AF%B4&page=1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ name: "测试书", url: `${upstreamBase}/api/book/1` }] }));
      return;
    }
    if (request.url === "/api/book/1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { name: "测试书" } }));
      return;
    }
    if (request.url === "/book/1") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<div id="chapters"><a href="/chapter/1">第一章</a></div>');
      return;
    }
    if (request.url === "/chapter/1") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<article id="content">可读正文</article>');
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const searchShape = {
    host: upstreamBase,
    responseFormatType: "json",
    list: "$.data",
    bookName: "$.name",
    detailUrl: "$.url",
  };
  const searchPlan = encodeBridgePlan(compileBookBridgePlan(searchShape));
  const convertedSource = {
    sourceName: "API/HTML 混合源",
    sourceUrl: upstreamBase,
    sourceType: "text",
    bookWorld: {},
    searchBook: {
      ...searchShape,
      requestInfo: [
        "@js:",
        'let url = config.host + "/search?keyword=" + encodeURIComponent(params.keyWord) + "&page=" + params.pageIndex;',
        `return "http://bridge.example/adapter/books?plan=${searchPlan}&url=" + encodeURIComponent(url);`,
      ].join("\n"),
    },
    chapterList: {
      host: upstreamBase,
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//*[@id='chapters']//a",
      title: ".",
      url: "//@href",
    },
    chapterContent: {
      host: upstreamBase,
      responseFormatType: "html",
      requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const result = await filterReachableSources([convertedSource], {
    ...testServerConfig(),
    allowPrivateNetworks: true,
    preflightSources: true,
    preflightDeep: true,
    preflightTimeoutMs: 1_000,
    preflightConcurrency: 1,
  });
  assert.equal(result.input.length, 1, JSON.stringify(requests));
  assert.deepEqual(result.skipped, []);
});

test("在线抓取默认禁止访问本机和内网地址", async (context) => {
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: false } });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/convert?url=${encodeURIComponent("http://127.0.0.1/source.json")}`);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /内网地址/);
});

test("通用书籍桥接器检测上游翻页重复并停止追加", async (context) => {
  const page = `<!doctype html><html><body>
  <ul class="list">
    <li><a href="/book/1">重复书一</a></li>
    <li><a href="/book/2">重复书二</a></li>
  </ul>
  </body></html>`;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan(compileBookBridgePlan({
    host: upstreamBase,
    responseFormatType: "html",
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  }));
  const page1 = await fetch(`${appBase}/adapter/books?plan=${plan}&pageSize=2&url=${encodeURIComponent(`${upstreamBase}/list?page=1`)}`);
  assert.equal(page1.status, 200);
  const page1Body = await page1.json();
  assert.equal(page1Body.data.length, 2);

  const page2 = await fetch(`${appBase}/adapter/books?plan=${plan}&pageSize=2&url=${encodeURIComponent(`${upstreamBase}/list?page=2`)}`);
  assert.equal(page2.status, 200);
  const page2Body = await page2.json();
  assert.deepEqual(page2Body.data, []);
  assert.equal(page2Body.hasMore, false);
  assert.equal(page2Body.duplicateOfPage1, true);
});

test("通用桥接器保留上游 JSON 查询参数的百分号编码", async (context) => {
  let requestUrl = "";
  const upstream = createServer((request, response) => {
    requestUrl = request.url || "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ items: [{ id: "1", name: "编码节目" }] }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    version: 1,
    kind: "books",
    host: upstreamBase,
    responseType: "json",
    list: "items",
    fields: {
      name: { selector: "name" },
      url: {
        selector: "id",
        matchTemplate: { pattern: "^([\\s\\S]+)$", prefix: `${upstreamBase}/detail/`, suffix: "" },
      },
    },
  });
  const query = new URLSearchParams({ performanceId: JSON.stringify({ pageNo: 1 }) });
  const target = `${upstreamBase}/feed?${query}`;
  const bridged = await fetch(`${appBase}/adapter/books?plan=${plan}&url=${encodeURIComponent(target)}`);
  assert.equal(bridged.status, 200);
  assert.equal((await bridged.json()).data[0].name, "编码节目");
  assert.match(requestUrl, /performanceId=%7B%22pageNo%22%3A1%7D/);
});

test("通用详情桥接器从目录最后一页补全最新章节标题", async (context) => {
  const menuPages = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://upstream.local");
    response.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname === "/detail") {
      response.end(JSON.stringify({ data: { book: { id: 7, name: "测试节目", sections: 5 } } }));
      return;
    }
    const page = Number(url.searchParams.get("pageNum") || 1);
    menuPages.push(page);
    response.end(JSON.stringify({
      list: page === 3 ? [{ name: "第5集 最终节目" }] : [{ name: `第${page * 2 - 1}集` }, { name: `第${page * 2}集` }],
    }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "json",
    fields: { name: "data/book/name" },
    latestChapter: {
      urlTemplate: `${upstreamBase}/menu?bookId={{value1}}&pageNum=__PAGE__&pageSize=2`,
      responseType: "json",
      list: "list",
      title: "name",
      count: "data/book/sections||data/book/total",
      values: { value1: "data/book/id" },
      pageSize: 2,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/detail?id=7`)}`,
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.name, "测试节目");
  assert.equal(detail.lastChapterTitle, "第5集 最终节目");
  assert.deepEqual(menuPages, [3]);
});

test("通用详情桥接器从当前 JSON 章节清单补全最新章节", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      name: "图册",
      data: [
        { page: "180", pic: "https://cdn.example/180.jpg" },
        { page: "208", pic: "https://cdn.example/208.jpg" },
      ],
    }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "json",
    fields: { name: "name", author: { selector: "author", fallback: "原站未标注" } },
    latestChapter: {
      mode: "direct",
      responseType: "json",
      list: "data",
      title: "page",
      url: "pic",
      pageSize: 100,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/book/7`)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: "图册",
    author: "原站未标注",
    lastChapterTitle: "208",
  });
});

test("通用详情桥接器可从目录第一页读取总数后请求末页", async (context) => {
  const menuPages = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://upstream.local");
    response.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname === "/detail") {
      response.end(JSON.stringify({ data: { book: { id: 7, name: "分页节目" } } }));
      return;
    }
    const page = Number(url.searchParams.get("pageNum") || 1);
    menuPages.push(page);
    response.end(JSON.stringify({
      sections: 5,
      list: page === 3 ? [{ name: "第5集 末章" }] : [{ name: `第${page * 2 - 1}集` }, { name: `第${page * 2}集` }],
    }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "json",
    fields: { name: "data/book/name" },
    latestChapter: {
      urlTemplate: `${upstreamBase}/menu?bookId={{entityId}}&pageNum=__PAGE__&pageSize=2`,
      responseType: "json",
      list: "list",
      title: "name",
      count: "sections",
      countSource: "menu",
      values: { entityId: "data/book/id" },
      pageSize: 2,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/detail?id=7`)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "分页节目", lastChapterTitle: "第5集 末章" });
  assert.deepEqual(menuPages, [1, 3]);
});

test("通用详情桥接器从 HTML 独立目录末项补全最新章节", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/book/7") {
      response.end('<h1>测试书</h1><span class="cat">第3章 终章</span><a class="catalog" href="/book/7/chapters">章节目录</a><a href="#top">返回顶部↑</a>');
      return;
    }
    response.end([
      '<div id="chapters">',
      '<a href="/read/1">第1章 开始</a>',
      '<a href="/read/2">第2章 继续</a>',
      '<a href="/read/3">第3章 终章</a>',
      '<a href="#top">返回顶部↑</a>',
      '<a href="/book/7">测试书</a>',
      "</div>",
    ].join(""));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "html",
    fields: {
      name: "//h1",
      cat: { selector: "//span[@class='cat']", fallback: "小说" },
    },
    latestChapter: {
      responseType: "html",
      tocSelector: "//a[contains(normalize-space(.), '章节目录')]/@href",
      list: "//*[@id='chapters']/a[@href]",
      title: ".",
      url: "./@href",
      pageSize: 100,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/book/7`)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "测试书", cat: "小说", lastChapterTitle: "第3章 终章" });
});

test("通用详情桥接器跟随目录页声明的动态 HTML 补全最新章节", async (context) => {
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/book/8") {
      response.end('<h1>动态漫画</h1><a class="catalog" href="/chapterlist/8">章节目录</a>');
      return;
    }
    if (request.url === "/chapterlist/8") {
      response.end(`<script>const endpoint = "${upstreamBase}/manga/get?id=8"; fetch(endpoint);</script>`);
      return;
    }
    if (request.url === "/manga/get?id=8") {
      response.end('<a href="/manga/8/1">第1话</a><a href="/manga/8/9">第9话 终章</a>');
      return;
    }
    response.end("");
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "html",
    fields: { name: "//h1" },
    latestChapter: {
      responseType: "html",
      tocSelector: "//a[@class='catalog']/@href",
      dynamicHtml: true,
      list: "//a[contains(@href, '/manga/')]",
      title: ".",
      url: "./@href",
      pageSize: 100,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/book/8`)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "动态漫画", lastChapterTitle: "第9话 终章" });
});

test("通用详情桥在目录链接失效时回退详情页并保留标题转换", async (context) => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/book/7") {
      response.end([
        "<h1>分页作品</h1><a class='catalog' href='/author/7'>作者主页</a>",
        "<div id='chapters'><a href='/read/1'>1</a><a href='/read/91'>91</a></div>",
      ].join(""));
      return;
    }
    response.end("<h1>作者主页</h1>");
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "html",
    fields: { name: "//h1", lastChapterTitle: "//a[@class='placeholder']" },
    latestChapter: {
      responseType: "html",
      tocSelector: "//a[@class='catalog']/@href",
      list: "//*[@id='chapters']/a",
      title: { selector: ".", replacements: [{ pattern: "^(\\d+)$", replacement: "第$1页" }] },
      url: "./@href",
      pageSize: 100,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/book/7`)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "分页作品", lastChapterTitle: "第91页" });
});

test("通用详情桥在旧目录选择器为空时解析内嵌目录", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end([
      "<h1>内嵌目录作品</h1>",
      "<div id='chapters'><a href='/read/1'>开始</a><a href='/read/2'>大结局</a></div>",
    ].join(""));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    kind: "detail",
    host: upstreamBase,
    responseType: "html",
    fields: { name: "//h1" },
    latestChapter: {
      responseType: "html",
      tocSelector: "//a[@class='removed-catalog']/@href",
      list: "//*[@id='chapters']/a",
      title: ".",
      url: "./@href",
      pageSize: 100,
    },
  });
  const response = await fetch(
    `${appBase}/adapter/detail?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/book/7`)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "内嵌目录作品", lastChapterTitle: "大结局" });
});

test("通用媒体适配端点解析 JSON 音频并直通视频播放地址", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { trackUrl: "/media/chapter.m4a" } }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const audioPlan = Buffer.from(JSON.stringify({
    version: 1, kind: "audio", properties: ["trackUrl"], attributes: [],
  })).toString("base64url");
  const audioChapter = `${upstreamBase}/chapter/1`;
  const audio = await fetch(`${appBase}/adapter/media?kind=audio&plan=${audioPlan}&url=${encodeURIComponent(audioChapter)}`);
  assert.equal(audio.status, 200);
  assert.deepEqual(await audio.json(), {
    url: `${upstreamBase}/media/chapter.m4a`,
    httpHeaders: { Referer: audioChapter },
  });
  const detailReferer = `${upstreamBase}/book/1`;
  const referred = await fetch(`${appBase}/adapter/media?kind=audio&plan=${audioPlan}&url=${encodeURIComponent(audioChapter)}&referer=${encodeURIComponent(detailReferer)}`);
  assert.equal(referred.status, 200);
  assert.deepEqual(await referred.json(), {
    url: `${upstreamBase}/media/chapter.m4a`,
    httpHeaders: { Referer: detailReferer },
  });

  const prefixedPlan = Buffer.from(JSON.stringify({
    version: 1,
    kind: "audio",
    properties: ["trackUrl"],
    attributes: [],
    resultPrefix: `${upstreamBase}/cdn`,
  })).toString("base64url");
  const prefixed = await fetch(`${appBase}/adapter/media?kind=audio&plan=${prefixedPlan}&url=${encodeURIComponent(audioChapter)}`);
  assert.equal(prefixed.status, 200);
  assert.deepEqual(await prefixed.json(), {
    url: `${upstreamBase}/cdn/media/chapter.m4a`,
    httpHeaders: { Referer: audioChapter },
  });

  const direct = "https://cdn.example/live/master.m3u8?token=abc";
  const video = await fetch(`${appBase}/adapter/media?kind=video&url=${encodeURIComponent(direct)}`);
  assert.equal(video.status, 200);
  assert.deepEqual(await video.json(), { url: direct, httpHeaders: { Referer: direct } });

  const encoded = "https://cdn.example/audio/%E7%AC%AC%E4%B8%80%E9%9B%86.m4a";
  const echoed = await fetch(`${appBase}/adapter/direct-media?url=${encodeURIComponent(encoded)}`);
  assert.equal(echoed.status, 200);
  assert.deepEqual(await echoed.json(), { url: encoded });

  const single = await fetch(`${appBase}/adapter/single-chapter?url=${encodeURIComponent(encoded)}`);
  assert.equal(single.status, 200);
  assert.deepEqual(await single.json(), { data: [{ title: "播放", url: encoded }] });
});

test("规则桥接接受空 host 计划中的绝对目标 URL", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ rows: [{ title: "第一章", item_id: "42" }] }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    version: 1,
    kind: "chapters",
    host: "",
    responseType: "json",
    list: "rows",
    fields: {
      title: { selector: "title" },
      url: { selector: "item_id", urlTemplate: `${upstreamBase}/play?item_id={{item_id}}` },
    },
  });
  const response = await fetch(
    `${appBase}/adapter/chapters?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/toc`)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{
    title: "第一章",
    url: `${upstreamBase}/play?item_id=42`,
  }]);
});

test("章节桥接从详情 HTML 捕获 ID 后请求目录接口", async (context) => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/detail/18") {
      response.end('<main data-mid="18"><h1>漫画</h1></main>');
      return;
    }
    response.end('<div id="allchapterlist"><a data-ct="第一话" data-cs="387"></a></div>');
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeBridgePlan({
    version: 1,
    kind: "chapters",
    host: upstreamBase,
    responseType: "html",
    list: "//*[@id='allchapterlist']//a",
    tocRequest: {
      pattern: 'data-mid="(.*?)"',
      prefix: `${upstreamBase}/menu?mid=`,
      suffix: "&all=1",
      capture: 1,
    },
    fields: {
      title: { selector: "/@data-ct" },
      url: {
        selector: "/@data-cs",
        urlTemplate: `${upstreamBase}/content?m={{base:bookId}}&c={{raw:id}}`,
      },
    },
  });
  const response = await fetch(
    `${appBase}/adapter/chapters?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/detail/18`)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requests, ["/detail/18", "/menu?mid=18&all=1"]);
  assert.deepEqual((await response.json()).data, [{
    title: "第一话",
    url: `${upstreamBase}/content?m=18&c=387`,
  }]);
});

test("通用媒体适配端点在过期 Cookie 导致空结果时无 Cookie 重试", async (context) => {
  const cookies = [];
  const upstream = createServer((request, response) => {
    cookies.push(request.headers.cookie || "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.headers.cookie
      ? { status: 114, message: "session expired", data: null }
      : { status: 0, data: { path: "/media/recovered.m4a" } }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = Buffer.from(JSON.stringify({
    version: 1,
    kind: "audio",
    properties: ["path"],
    attributes: [],
    headers: { Cookie: "token=expired", "X-Requested-With": "XMLHttpRequest" },
  })).toString("base64url");
  const chapterUrl = `${upstreamBase}/chapter/1`;
  const result = await fetch(
    `${appBase}/adapter/media?kind=audio&plan=${plan}&url=${encodeURIComponent(chapterUrl)}`,
  );

  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    url: `${upstreamBase}/media/recovered.m4a`,
    httpHeaders: { Referer: chapterUrl },
  });
  assert.deepEqual(cookies, ["token=expired", ""]);
});

test("通用兜底封面端点返回可解码 PNG", async (context) => {
  const app = createAppServer({ config: testServerConfig() });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/adapter/cover?kind=audio`);
  const body = Buffer.from(await response.arrayBuffer());
  const image = await Jimp.read(body);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(image.width, 360);
  assert.equal(image.height, 480);
});

test("通用 SSR 节目适配端点返回真实且不重复的指定页", async (context) => {
  const calls = [];
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, upstreamBase);
    calls.push(url.pathname + url.search);
    response.writeHead(200, { "Content-Type": url.pathname === "/detail" ? "text/html" : "application/json" });
    if (url.pathname === "/detail") {
      response.end(`<!doctype html><a href="/programs/p1">第一集</a><a href="/programs/p2">第二集</a>
        <script>window.__initStores={"channel":{"id":"42","version":"v1234","programCount":4,"programs":[{"programId":"p1","title":"第一集"},{"programId":"p2","title":"第二集"}]}};</script>`);
      return;
    }
    const page = Number(url.searchParams.get("page_index"));
    response.end(JSON.stringify({
      total: 4,
      programs: page === 1
        ? [{ programId: "p1", title: "第一集" }, { programId: "p2", title: "第二集" }]
        : [{ programId: "p3", title: "第三集" }, { programId: "p4", title: "第四集" }],
    }));
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = encodeSsrEpisodePlan({
    apiTemplate: `${upstreamBase}/api/channels/{{entityId}}/programs?version={{version}}&page_index={{page}}`,
    pageSize: 2,
    total: 4,
  });
  const detail = encodeURIComponent(`${upstreamBase}/detail`);
  const firstResponse = await fetch(`${appBase}/adapter/episode-list?plan=${plan}&page=1&url=${detail}`);
  const secondResponse = await fetch(`${appBase}/adapter/episode-list?plan=${plan}&page=2&url=${detail}`);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.deepEqual(first.data.map((item) => item.url), [
    `${upstreamBase}/programs/p1`,
    `${upstreamBase}/programs/p2`,
  ]);
  assert.deepEqual(second.data.map((item) => item.url), [
    `${upstreamBase}/programs/p3`,
    `${upstreamBase}/programs/p4`,
  ]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.ok(calls.includes("/api/channels/42/programs?version=v1234&page_index=1"));
  assert.ok(calls.includes("/api/channels/42/programs?version=v1234&page_index=2"));
});

test("通用 catalog 适配端点按声明式 idList 计划分页", async (context) => {
  const calls = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/list" && url.searchParams.get("entityId") === "11") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        bookIds: Array.from({ length: 25 }, (_, i) => i + 1),
        books: [{ id: 1, name: "第一本", author: "A" }],
      }));
      return;
    }
    if (url.pathname === "/list" && url.searchParams.has("bookIds")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        books: [{ id: 21, name: "第二本", author: "B" }],
      }));
      return;
    }
    response.writeHead(404);
    response.end("missing");
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = Buffer.from(JSON.stringify({
    version: 1,
    kind: "idList",
    origin: upstreamBase,
    pageSize: 20,
    headers: { "X-Demo": "catalog" },
    first: {
      url: "{{origin}}/list?entityId={{entityId}}&dsize={{pageSize}}",
      idsProperty: "bookIds",
      itemsProperty: "books",
    },
    next: {
      url: "{{origin}}/list?bookIds={{idsJson}}",
      itemsProperty: "books",
    },
    item: {
      id: "id",
      name: "name",
      detailUrl: "{{origin}}/book/{{id}}",
      author: "author",
    },
  })).toString("base64url");

  const page1 = await fetch(`${appBase}/adapter/catalog?plan=${plan}&entityId=11&page=1&pageSize=20`);
  assert.equal(page1.status, 200);
  const first = await page1.json();
  assert.equal(first.data[0].name, "第一本");
  assert.equal(first.data[0].url, `${upstreamBase}/book/1`);
  assert.equal(first.hasMore, true);

  const page2 = await fetch(`${appBase}/adapter/catalog?plan=${plan}&entityId=11&page=2&pageSize=20`);
  assert.equal(page2.status, 200);
  const second = await page2.json();
  assert.equal(second.data[0].name, "第二本");
  assert.ok(calls.some((entry) => /bookIds=/.test(entry)));

  const missing = await fetch(`${appBase}/adapter/catalog?plan=${plan}&page=1`);
  assert.equal(missing.status, 400);
});

test("媒体适配按声明式两步计划二次请求，空计划不猜测网关", async (context) => {
  const playUrl = "https://cdn.example/a/42/play.mp3";
  let playBody = "";
  let playHeaders = {};
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/item/42-7") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!DOCTYPE html><html><head>
<meta name="_token" content="token-abc"/>
<link rel="alternate" href="https://m.example.com/item/42-7">
</head><body><a href="/item/42-8">下一集</a></body></html>`);
      return;
    }
    if (url.pathname === "/api/play" && request.method === "POST") {
      playHeaders = { ...request.headers };
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        playBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ playUrl, url: "https://cdn.example/fallback.mp3" }));
      });
      return;
    }
    response.writeHead(404);
    response.end("missing");
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const resolutionPlan = Buffer.from(JSON.stringify({
    version: 1,
    kind: "audio",
    properties: [],
    attributes: ["href"],
    urlHints: [],
    resolution: {
      extract: [
        { name: "result", source: "meta", key: "_token" },
        { name: "g1", source: "url", pattern: ".+/item/(\\d+)-(\\d+)", group: 1 },
        { name: "g2", source: "url", pattern: ".+/item/(\\d+)-(\\d+)", group: 2 },
      ],
      request: {
        url: "{{origin}}/api/play",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Token": "{{result}}",
          Referer: "{{chapterUrl}}",
        },
        body: "id={{g1}}&page={{g2}}",
      },
      response: { properties: ["playUrl", "url"] },
    },
  })).toString("base64url");
  const resolved = await fetch(
    `${appBase}/adapter/media?kind=audio&plan=${resolutionPlan}&url=${encodeURIComponent(`${upstreamBase}/item/42-7`)}`,
  );
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), {
    url: playUrl,
    httpHeaders: { Referer: `${upstreamBase}/item/42-7` },
  });
  assert.equal(playHeaders["x-token"], "token-abc");
  assert.match(playBody, /id=42/);
  assert.match(playBody, /page=7/);

  // Published-style empty plan: only navigation links → no invented gateway call.
  const emptyPlan = Buffer.from(JSON.stringify({
    version: 1, kind: "audio", properties: [], attributes: ["href"], urlHints: [],
  })).toString("base64url");
  const empty = await fetch(
    `${appBase}/adapter/media?kind=audio&plan=${emptyPlan}&url=${encodeURIComponent(`${upstreamBase}/item/42-7`)}`,
  );
  assert.equal(empty.status, 422);
  const emptyBody = await empty.json();
  assert.match(String(emptyBody.error || ""), /重新转换|resolution|href/);
  assert.doesNotMatch(String(emptyBody.url || ""), /item\/42-7/);
});

test("媒体代理转发音频字节流并带 Referer", async (context) => {
  const payload = Buffer.from("ID3fake-audio-bytes");
  let seenReferer = "";
  const upstream = createServer((request, response) => {
    seenReferer = String(request.headers.referer || "");
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end(payload);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/media?url=${encodeURIComponent(`${upstreamBase}/chapter.mp3`)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  assert.match(seenReferer, new RegExp(`^${upstreamBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
});

test("/media 代理允许显式 Referer", async (context) => {
  let seenReferer = "";
  const upstream = createServer((request, response) => {
    seenReferer = String(request.headers.referer || "");
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end("ok");
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const referer = "https://audio.example/book/14917-1";
  const response = await fetch(
    `${appBase}/media?url=${encodeURIComponent(`${upstreamBase}/chapter.mp3`)}&referer=${encodeURIComponent(referer)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(seenReferer, referer);
});

test("INSECURE_MEDIA_HOSTS 可配置，空字符串关闭 TLS 例外", () => {
  assert.deepEqual(serverConfig({}).insecureMediaHosts, []);
  assert.deepEqual(serverConfig({ INSECURE_MEDIA_HOSTS: "" }).insecureMediaHosts, []);
  assert.deepEqual(
    serverConfig({ INSECURE_MEDIA_HOSTS: "a.example, B.EXAMPLE  c.example" }).insecureMediaHosts,
    ["a.example", "b.example", "c.example"],
  );
});

test("/media 仅对 insecureMediaHosts 跳过 TLS 校验", async (context) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createServer: createHttpsServer } = await import("node:https");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-tls-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes",
    "-subj", "/CN=127.0.0.1",
  ]);
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const upstream = createHttpsServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end("secure-ok");
  });
  const upstreamBase = await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      resolve(`https://127.0.0.1:${upstream.address().port}`);
    });
  });

  const denied = createAppServer({
    config: {
      ...testServerConfig(),
      allowPrivateNetworks: true,
      insecureMediaHosts: [],
    },
  });
  const deniedBase = await listen(denied);
  const allowed = createAppServer({
    config: {
      ...testServerConfig(),
      allowPrivateNetworks: true,
      insecureMediaHosts: ["127.0.0.1"],
    },
  });
  const allowedBase = await listen(allowed);
  context.after(async () => {
    await close(denied);
    await close(allowed);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  });

  const mediaUrl = `${upstreamBase}/chapter.mp3`;
  const blocked = await fetch(`${deniedBase}/media?url=${encodeURIComponent(mediaUrl)}`);
  assert.equal(blocked.status, 502);

  const ok = await fetch(`${allowedBase}/media?url=${encodeURIComponent(mediaUrl)}`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "secure-ok");
});

test("通用漫画适配端点聚合 JSON API 的全部分页", async (context) => {
  const requestedPages = [];
  const requestedReferers = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://upstream.local");
    if (url.pathname.startsWith("/pages/")) {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return;
    }
    const page = Number(url.searchParams.get("page") || 1);
    requestedPages.push(page);
    requestedReferers.push(request.headers.referer);
    const images = page === 1
      ? [{ url: "/pages/001.webp" }, { url: "/pages/002.webp" }]
      : [{ url: `/pages/00${page + 1}.webp` }];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: { images, pagination: { current_page: page, page_size: 2, total: 6, total_pages: 3 } },
    }));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, comicPageConcurrency: 2 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const plan = Buffer.from(JSON.stringify({
    version: 1,
    properties: ["url"],
    attributes: [],
    headers: { Referer: "https://comic.example/reader" },
  })).toString("base64url");
  const response = await fetch(
    `${appBase}/adapter/images?plan=${plan}&url=${encodeURIComponent(`${upstreamBase}/api/images?id=7&page=1`)}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.urls, [
    `${upstreamBase}/pages/001.webp`,
    `${upstreamBase}/pages/002.webp`,
    `${upstreamBase}/pages/003.webp`,
    `${upstreamBase}/pages/004.webp`,
  ]);
  assert.equal(payload.proxyUrls.length, 4);
  assert.match(payload.proxyUrls[0], new RegExp(`^${appBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/image/auto\\?url=`));
  assert.match(payload.proxyUrls[0], /&referer=http/);
  assert.deepEqual(requestedPages.sort(), [1, 2, 3]);
  assert.deepEqual(requestedReferers, Array(3).fill("https://comic.example/reader"));
});

test("通用漫画适配端点执行页面脚本声明的 POST 分批图片 API", async (context) => {
  const offsets = [];
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://upstream.local");
    if (url.pathname === "/chapter/20/91.html") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end([
        '<img class="book-cover" src="/cover/20.png">',
        '<figure data-chapter-id="91" data-aid="20" data-pic-index="0"></figure>',
        '<script src="/assets/reader-pics.js"></script>',
      ].join(""));
      return;
    }
    if (url.pathname === "/assets/reader-pics.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end([
        "var BATCH = 2;",
        "function load(chapterId, offset) {",
        "$.post('/api/comic/read/pics', { id: chapterId, aid: getAid(chapterId), offset: offset, limit: BATCH }, done, 'json');",
        "}",
      ].join("\n"));
      return;
    }
    if (url.pathname === "/api/comic/read/pics") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const offset = Number(form.get("offset") || 0);
        offsets.push(offset);
        const total = 5;
        const rows = Array.from({ length: Math.min(2, total - offset) }, (_, index) => ({
          pic: `${upstreamBase}/pages/${String(offset + index + 1).padStart(3, "0")}.png`,
        }));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { pic: rows, offset, limit: 2, total }, code: 1 }));
      });
      return;
    }
    if (url.pathname.startsWith("/pages/") || url.pathname.startsWith("/cover/")) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      response.end(png);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, comicPageConcurrency: 2 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(
    `${appBase}/adapter/images?url=${encodeURIComponent(`${upstreamBase}/chapter/20/91.html`)}`,
  );
  if (response.status !== 200) assert.fail(await response.text());
  const payload = await response.json();
  assert.equal(payload.urls.length, 5);
  assert.deepEqual(offsets.sort((left, right) => left - right), [0, 2, 4]);
  const image = await fetch(payload.proxyUrls[0]);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
});

test("通用漫画适配器跟随章节页声明的同源动态 HTML 正文", async (context) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", upstreamBase || "http://127.0.0.1");
    if (url.pathname === "/chapter/1") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end([
        '<div id="chapterContent" data-mid="7" data-cid="11" data-host="' + upstreamBase + '"></div>',
        '<img src="/covers/recommendation-a.webp"><img src="/covers/recommendation-b.webp">',
        '<script>const root=document.getElementById("chapterContent");const host=root.dataset.host;const mid=root.dataset.mid;const cid=root.dataset.cid;const endpoint=`${host}/chapter/getcontent?m=${mid}&c=${cid}`;fetch(endpoint)</script>',
      ].join(""));
      return;
    }
    if (url.pathname === "/chapter/getcontent") {
      assert.equal(url.searchParams.get("m"), "7");
      assert.equal(url.searchParams.get("c"), "11");
      assert.equal(request.headers.referer, `${upstreamBase}/chapter/1`);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<img data-src="/pages/001.webp"><img data-src="/pages/002.webp"><img data-src="/pages/003.webp">');
      return;
    }
    if (url.pathname.startsWith("/pages/") || url.pathname.startsWith("/covers/")) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      response.end(png);
      return;
    }
    response.writeHead(404).end();
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(
    `${appBase}/adapter/images?url=${encodeURIComponent(`${upstreamBase}/chapter/1`)}`,
  );
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const payload = JSON.parse(body);
  assert.deepEqual(payload.urls, [
    `${upstreamBase}/pages/001.webp`,
    `${upstreamBase}/pages/002.webp`,
    `${upstreamBase}/pages/003.webp`,
  ]);
});

test("通用漫画适配器从页面脚本提取 AES 计划并用真实图片验密钥", async (context) => {
  const keyText = "0123456789abcdef";
  const key = Buffer.from(keyText);
  const iv = Buffer.from("abcdef0123456789");
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(plain), cipher.final()]);
  const script = [
    `const base64Key = "${key.toString("base64")}";`,
    "const DECRYPT_LOGIC = `function(buffer) { const bytes = new Uint8Array(buffer); const iv = bytes.slice(0, 16); return CryptoJS.AES.decrypt({ciphertext: bytes.slice(16)}, CryptoJS.enc.Utf8.parse(atob(base64Key)), {iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7}); }`;",
  ].join("\n");
  const upstream = createServer((request, response) => {
    if (request.url === "/decrypt-image.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(script);
      return;
    }
    if (request.url?.startsWith("/encrypted/")) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(encrypted);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end([
      '<img data-src="/encrypted/1.webp">',
      '<img data-src="/encrypted/2.webp">',
      '<script src="/decrypt-image.js"></script>',
    ].join(""));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, maxImageBytes: 1024 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(
    `${appBase}/adapter/images?url=${encodeURIComponent(`${upstreamBase}/chapter/1`)}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.urls.length, 2);
  assert.match(payload.proxyUrls[0], /\/image\/aes-cbc-prefix-iv-MDEyMzQ1Njc4OWFiY2RlZg\?url=/);

  const image = await fetch(payload.proxyUrls[0]);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), plain);
});

test("通用漫画适配器结合 API、章节脚本和基础脚本验证 WebCrypto 密钥", async (context) => {
  const keyText = "0B6666A0-BB59-1381-B746-a0E4C9AC";
  const key = Buffer.from(keyText).subarray(0, 32);
  const iv = Buffer.from("chapter-prefixiv");
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(plain), cipher.final()]);
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    if (request.url === "/api/images/1?page=1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: { images: [{ url: `${upstreamBase}/encrypted/1.jpg` }, { url: `${upstreamBase}/encrypted/2.jpg` }] },
      }));
      return;
    }
    if (request.url === "/chapter/1") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<script src="/chapter-reader.js"></script><script src="/base.js"></script>');
      return;
    }
    if (request.url === "/chapter-reader.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end([
        "async function decryptImage(arrayBuffer) {",
        "const iv = arrayBuffer.slice(0, 16);",
        "const ciphertext = arrayBuffer.slice(16);",
        "const keyBytes = new TextEncoder().encode(BaseUtil.AES_KEY).slice(0, 32);",
        "const cryptoKey = await window.crypto.subtle.importKey('raw', keyBytes, {name:'AES-CBC'}, false, ['decrypt']);",
        "return window.crypto.subtle.decrypt({name:'AES-CBC', iv:new Uint8Array(iv)}, cryptoKey, ciphertext);",
        "}",
      ].join("\n"));
      return;
    }
    if (request.url === "/base.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(`const BaseUtil = { AES_KEY: ${JSON.stringify(keyText)} };`);
      return;
    }
    if (request.url?.startsWith("/encrypted/")) {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(encrypted);
      return;
    }
    response.writeHead(404).end();
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, maxImageBytes: 1024 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch([
    `${appBase}/adapter/images?url=${encodeURIComponent(`${upstreamBase}/api/images/1?page=1`)}`,
    `referer=${encodeURIComponent(`${upstreamBase}/chapter/1`)}`,
  ].join("&"));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const payload = JSON.parse(body);
  assert.equal(payload.urls.length, 2);
  assert.match(payload.proxyUrls[0], /\/image\/aes-cbc-prefix-iv-/);
  assert.match(payload.proxyUrls[0], /referer=/);

  const image = await fetch(payload.proxyUrls[0]);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), plain);
});

test("通用漫画适配器解密页面参数中的图片清单并保持哈希文件顺序", async (context) => {
  const key = Buffer.from("manifest-key-123");
  const iv = Buffer.from("manifest-iv--123");
  const paths = ["a1b2c3d4.webp", "9f8e7d6c.webp", "0011aabb.webp"];
  const manifest = Buffer.from(JSON.stringify({ images: paths.map((name) => `/pages/${name}`) }));
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const params = Buffer.concat([iv, cipher.update(manifest), cipher.final()]).toString("base64");
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const upstream = createServer((request, response) => {
    if (request.url === "/reader.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end([
        `var key = "${key.toString("utf8")}";`,
        'var algorithm = "AES/CBC/PKCS5Padding";',
        'var layout = "slice(0,16)";',
      ].join("\n"));
      return;
    }
    if (request.url?.startsWith("/pages/")) {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(plain);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<script>var tpl_path = "/theme/", params = "${params}";</script><script src="/reader.js"></script>`);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(
    `${appBase}/adapter/images?url=${encodeURIComponent(`${upstreamBase}/chapter/1`)}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.urls, paths.map((name) => `${upstreamBase}/pages/${name}`));
});

test("通用目录跳转器从详情页选择章节目录而不是开始阅读", async (context) => {
  const html = `
    <a href="/novel/read/1"><span>开始阅读</span></a>
    <a href="/novel/rcatalog/1"><i></i><span>章节目录</span></a>
  `;
  assert.equal(pageTocUrl(html, "https://book.example/detail/1", "章节目录"), "https://book.example/novel/rcatalog/1");
  assert.equal(
    pageTocUrl('<a class="book_more" href="/catalog/7">More</a>', "https://book.example/detail/7", "", "//*[contains(concat(' ', normalize-space(@class), ' '), ' book_more ')]//a/@href || //*[@class='book_more']/@href"),
    "https://book.example/catalog/7",
  );

  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });
  const response = await fetch(
    `${appBase}/adapter/toc?hint=${encodeURIComponent("章节目录")}&url=${encodeURIComponent(`${upstreamBase}/detail/1`)}`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${upstreamBase}/novel/rcatalog/1`);
});

test("通用目录跳转器解析目录页声明的同源动态 HTML 接口", async (context) => {
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/detail/1") {
      response.end('<a class="catalogue" href="/chapterlist/1">章节目录</a>');
      return;
    }
    if (request.url === "/chapterlist/1") {
      response.end(`<div id="chapters" data-mid="42" data-host="${upstreamBase}"></div>
        <script>const n=document.getElementById("chapters"),s=n.dataset.mid,e=n.dataset.host;
        fetch(\`${'${e}'}/manga/get?mid=${'${s}'}&mode=all\`);</script>`);
      return;
    }
    if (request.url === "/manga/get?mid=42&mode=all") {
      response.end('<a href="/manga/1/1">第1话</a><a href="/manga/1/2">第2话</a>');
      return;
    }
    response.end("");
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(
    `${appBase}/adapter/toc?resolve=html&selector=${encodeURIComponent("//a[@class='catalogue']/@href")}&url=${encodeURIComponent(`${upstreamBase}/detail/1`)}`,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /第1话/);
  assert.match(html, new RegExp(`${upstreamBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/manga/1/2`));
});

test("图片代理地址从本次 HTTPS 转换请求自动推导", async (context) => {
  const encryptedComicSource = {
    ...source,
    bookSourceName: "加密漫画",
    bookSourceType: 2,
    ruleContent: {
      content: "@js:JSON.parse(src).data.images.map(x => `<img src=\"${x.url}\">`).join('\\n');",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0B6666A0-BB59-1381-B746-a0E4C9AC'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
  };
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(encryptedComicSource));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...testServerConfig(), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(`${upstreamBase}/source.json`)}`, {
    headers: { "X-Forwarded-Host": "xs.example.com", "X-Forwarded-Proto": "https" },
  });
  assert.equal(response.status, 200);
  const converted = JSON.parse(decodeXbs(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.match(converted["加密漫画"].chapterContent.content, /https:\/\/xs\.example\.com\/image\/aes-cbc-prefix-iv-[A-Za-z0-9_-]+\?url=/);
});

test("通用章节图片提取选择最大的同目录正文序列并按数字文件名排序", () => {
  assert.deepEqual(pageImageUrls(`
    <img data-original="/media/categories/album/1.jpg"><img data-original="/media/categories/album/2.jpg">
    <img src="/ads/banner.png"><img data-original="https://cdn.example/media/photos/123/00001.webp">
    <img data-src="/media/photos/123/00002.webp"><img data-original="/media/photos/123/00001.webp">
  `, "https://18comic.example/photo/123"), [
    "https://cdn.example/media/photos/123/00001.webp",
    "https://18comic.example/media/photos/123/00001.webp",
    "https://18comic.example/media/photos/123/00002.webp",
  ]);
});

test("通用章节图片提取过滤浮动章节导航按钮", () => {
  assert.deepEqual(pageImageUrls(`
    <img class="imgFloat_1" src="/template/picture/floatw_1.png" alt="上一章">
    <img class="imgFloat_2" src="/template/picture/floatw_2.png" alt="下一章">
    <img class="imgFloat_3" src="/template/picture/floatw_3.png" alt="目录">
  `, "https://comic.example/chapter/1"), []);
});

test("通用章节图片提取优先读取脚本中的转义 imageUrl 序列", () => {
  assert.deepEqual(pageImageUrls(`
    <img src="/android-chrome-192x192.png">
    <script>self.__next.push("{\\"imageUrl\\":\\"https:\\/\\/cdn1.example\\/chapter\\/001.jpg\\",\\"imageUrl\\":\\"https:\\/\\/cdn2.example\\/chapter\\/002.jpg\\"}")</script>
  `, "https://comic.example/chapter/1"), [
    "https://cdn1.example/chapter/001.jpg",
    "https://cdn2.example/chapter/002.jpg",
  ]);

  const firstChunk = JSON.stringify([1, '{"imageUrl":"https://cdn.example/chapter/001']);
  const secondChunk = JSON.stringify([1, '.jpg","imageUrl":"https://cdn.example/chapter/002.jpg"}']);
  assert.deepEqual(pageImageUrls(`
    <script>self.__next_f.push(${firstChunk})</script>
    <script>self.__next_f.push(${secondChunk})</script>
  `, "https://comic.example/chapter/1"), [
    "https://cdn.example/chapter/001.jpg",
    "https://cdn.example/chapter/002.jpg",
  ]);
});

test("通用章节图片提取从主目录序列剔除孤立封面", () => {
  const html = JSON.stringify({
    images: [
      { imageUrl: "https://cdn.example/cover/book.jpg" },
      { imageUrl: "https://pages.example/comic/7/1.jpg" },
      { imageUrl: "https://pages.example/comic/7/2.jpg" },
      { imageUrl: "https://pages.example/comic/7/3.jpg" },
      { imageUrl: "https://pages.example/comic/7/4.jpg" },
    ],
  });
  assert.deepEqual(pageImageUrls(html, "https://site.example/chapter/7"), [
    "https://pages.example/comic/7/1.jpg",
    "https://pages.example/comic/7/2.jpg",
    "https://pages.example/comic/7/3.jpg",
    "https://pages.example/comic/7/4.jpg",
  ]);
});

test("通用章节图片提取不把预载下一章拼入当前章", () => {
  const images = [
    { imageUrl: "https://cdn.example/cover/book.jpg" },
    ...Array.from({ length: 4 }, (_, index) => ({
      imageUrl: `https://pages.example/comic/chapter-1/${index + 1}.jpg`,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      imageUrl: `https://pages.example/comic/chapter-2/${index + 1}.jpg`,
    })),
  ];
  assert.deepEqual(pageImageUrls(JSON.stringify({ images }), "https://site.example/chapter/1"), [
    "https://pages.example/comic/chapter-1/1.jpg",
    "https://pages.example/comic/chapter-1/2.jpg",
    "https://pages.example/comic/chapter-1/3.jpg",
    "https://pages.example/comic/chapter-1/4.jpg",
  ]);
});

test("图片属性计划不会把 data-src 误识别为 src", () => {
  const html = [
    '<meta property="og:image" content="/cover.jpg">',
    '<img data-src="/pages/1.jpg">',
    '<img data-src="/pages/2.jpg">',
    '<img data-src="/pages/3.jpg">',
  ].join("");
  assert.deepEqual(
    pageImageUrls(html, "https://comic.example/read/1", { attributes: ["src", "data-src"] }),
    [
      "https://comic.example/pages/1.jpg",
      "https://comic.example/pages/2.jpg",
      "https://comic.example/pages/3.jpg",
    ],
  );
});

test("通用章节图片提取优先按显式页面索引排序", () => {
  const html = [
    '<img data-index="2" data-src="/pages/random-100.jpg">',
    '<img data-index="0" data-src="/pages/random-300.jpg">',
    '<img data-index="1" data-src="/pages/random-200.jpg">',
  ].join("");
  assert.deepEqual(pageImageUrls(html, "https://comic.example/read/1"), [
    "https://comic.example/pages/random-300.jpg",
    "https://comic.example/pages/random-200.jpg",
    "https://comic.example/pages/random-100.jpg",
  ]);
});

test("通用章节图片提取解码静态 Base64 图片序列", () => {
  const sequence = [
    "https://cdn.example/comic/7/random-c.jpg",
    "https://cdn.example/comic/7/random-a.jpg",
    "https://cdn.example/comic/7/random-b.jpg",
  ].join("$separator$");
  const encoded = Buffer.from(sequence).toString("base64");
  assert.deepEqual(pageImageUrls(
    `<script>var encodedImages=${JSON.stringify(encoded)};</script><img src="/share_small.jpg">`,
    "https://comic.example/read/7",
  ), [
    "https://cdn.example/comic/7/random-c.jpg",
    "https://cdn.example/comic/7/random-a.jpg",
    "https://cdn.example/comic/7/random-b.jpg",
  ]);
});

test("通用章节图片提取安全解包 P.A.C.K.E.R. 图片序列", () => {
  const packed = `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?"":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1;};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p;}("0 1=['2://3.4/5/1.6','2://3.4/5/7.6'];",8,8,'var|pages|https|cdn|example|comic|jpg|second'.split('|'),0,{}))`;
  assert.deepEqual(pageImageUrls(`<script>${packed}</script>`, "https://comic.example/read/1"), [
    "https://cdn.example/comic/pages.jpg",
    "https://cdn.example/comic/second.jpg",
  ]);
});

test("通用章节图片提取接受打包数组中的无扩展名 CDN 页面", () => {
  const packed = `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?"":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1;};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p;}("0 1=['2://3.4/5/6','2://3.4/5/7','2://3.4/5/8'];",9,9,'var|pages|https|cdn|example|origin|first|second|third'.split('|'),0,{}))`;
  assert.deepEqual(pageImageUrls(`<script>${packed}</script>`, "https://comic.example/read/1"), [
    "https://cdn.example/origin/first",
    "https://cdn.example/origin/second",
    "https://cdn.example/origin/third",
  ]);
});

test("通用章节图片提取优先 DOM 懒加载真图而非 JSON-LD 品牌图", () => {
  const html = [
    '<script type="application/ld+json">{"logo":"https://comic.example/logo.png","image":"https://comic.example/cover.jpg"}</script>',
    '<img data-src="https://cdn.example/pages/1.jpg">',
    '<img data-src="https://cdn.example/pages/2.jpg">',
    '<img data-src="https://cdn.example/pages/3.jpg">',
  ].join("");
  assert.deepEqual(pageImageUrls(html, "https://comic.example/read/1"), [
    "https://cdn.example/pages/1.jpg",
    "https://cdn.example/pages/2.jpg",
    "https://cdn.example/pages/3.jpg",
  ]);
});

test("DNS 代理兼容开关不会放行直接填写的保留网段 IP", async (context) => {
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: false, allowDnsProxyNetworks: true },
  });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/convert?url=${encodeURIComponent("http://198.18.0.1/source.json")}`);
  assert.equal(response.status, 403);
});

test("DNS 透明代理默认开启，origin 探活默认开启，深度预检默认关闭", () => {
  assert.equal(serverConfig({}).maxSourceBytes, 32 * 1024 * 1024);
  assert.equal(serverConfig({}).allowDnsProxyNetworks, true);
  assert.equal(serverConfig({}).preflightSources, true);
  assert.equal(serverConfig({}).preflightDeep, false);
  assert.equal(serverConfig({}).preflightTimeoutMs, 3000);
  assert.equal(serverConfig({}).preflightConfirmTimeoutMs, 10000);
  assert.equal(serverConfig({}).preflightConcurrency, 8);
  assert.equal(serverConfig({}).verifyConvertedSources, true);
  assert.equal(serverConfig({}).analyzeFallback, true);
  assert.equal(serverConfig({}).verifyBudgetMs, 20_000);
  assert.equal(serverConfig({}).verifyMaxSources, 50);
  assert.equal(serverConfig({ ALLOW_DNS_PROXY_NETWORKS: "false" }).allowDnsProxyNetworks, false);
  assert.equal(serverConfig({ PREFLIGHT_SOURCES: "false" }).preflightSources, false);
  assert.equal(serverConfig({ VERIFY_CONVERTED_SOURCES: "false" }).verifyConvertedSources, false);
  assert.equal(serverConfig({ ANALYZE_FALLBACK: "false" }).analyzeFallback, false);
  assert.equal(serverConfig({ ANALYZE_FALLBACK: "true" }).analyzeFallback, true);
  assert.equal(serverConfig({ VERIFY_BUDGET_MS: "5000" }).verifyBudgetMs, 5000);
  assert.equal(serverConfig({ PREFLIGHT_SOURCES: "true", PREFLIGHT_DEEP_SOURCES: "true" }).preflightSources, true);
  assert.equal(serverConfig({ PREFLIGHT_SOURCES: "true", PREFLIGHT_DEEP_SOURCES: "true" }).preflightDeep, true);
});

test("skippedBuckets 按原因分桶", () => {
  assert.deepEqual(skippedBuckets([
    { source: "a", reason: "上游站点不可访问" },
    { source: "b", reason: "未知 imageDecode，漫画图片将花屏" },
    { source: "c", reason: "依赖登录/分流变量 Get(...)，香色无法复现阅读登录 UI" },
    { source: "d", reason: "香色核心链路不可执行：world, content" },
    { source: "e", reason: "有声/视频缺少可播放正文，且章节链接不是可识别的媒体直链" },
  ]), {
    "dead-origin": 1,
    imageDecode: 1,
    login: 1,
    "core-chain": 1,
    media: 1,
  });
});

test("图片代理直通普通图片，并执行源规则参数化的图片算法", async (context) => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const iv = Buffer.alloc(16, 7);
  const genericKeyText = "0123456789abcdef0123456789abcdef";
  const genericCipher = createCipheriv("aes-256-cbc", Buffer.from(genericKeyText), iv);
  const genericEncrypted = Buffer.concat([iv, genericCipher.update(plain), genericCipher.final()]);
  const fixedKeyText = "abcdef0123456789";
  const fixedIvText = "1234567890abcdef";
  const fixedCipher = createCipheriv("aes-128-cbc", Buffer.from(fixedKeyText), Buffer.from(fixedIvText));
  const fixedEncrypted = Buffer.concat([fixedCipher.update(plain), fixedCipher.final()]);
  const originalPixels = Buffer.alloc(10 * 4);
  for (let row = 0; row < 10; row += 1) originalPixels.writeUInt32BE(((row + 1) << 24) | 0x0000ff, row * 4);
  const idTilePlan = {
    bypassToken: "",
    minimumId: 100,
    middleId: 200,
    upperId: 300,
    fixedTiles: 10,
    middleModulo: 10,
    upperModulo: 8,
    factor: 2,
  };
  const scrambledPixels = Buffer.alloc(originalPixels.length);
  for (let row = 0; row < 10; row += 1) {
    originalPixels.copy(scrambledPixels, row * 4, (9 - row) * 4, (10 - row) * 4);
  }
  const scrambled = await Jimp.fromBitmap({ data: scrambledPixels, width: 1, height: 10 }).getBuffer(JimpMime.png);
  const encodedPath = Buffer.from("s3://comic/images/chapter/001.jpg").toString("base64url");
  const md5Tiles = Number.parseInt(createHash("md5").update(Buffer.from("s3://comic/images/chapter/001.jpg")).digest("hex").slice(-2), 16) % 7 + 3;
  const md5OriginalPixels = Buffer.alloc(md5Tiles * 4);
  for (let row = 0; row < md5Tiles; row += 1) md5OriginalPixels.writeUInt32BE(((row + 1) << 24) | 0x0000ff, row * 4);
  const md5ScrambledPixels = Buffer.alloc(md5OriginalPixels.length);
  for (let row = 0; row < md5Tiles; row += 1) {
    md5OriginalPixels.copy(md5ScrambledPixels, row * 4, (md5Tiles - row - 1) * 4, (md5Tiles - row) * 4);
  }
  const md5Scrambled = await Jimp.fromBitmap({ data: md5ScrambledPixels, width: 1, height: md5Tiles }).getBuffer(JimpMime.png);
  let explicitReferer = "";
  const upstream = createServer((request, response) => {
    if (request.url === "/referer") explicitReferer = request.headers.referer || "";
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(request.url === "/generic-encrypted" ? genericEncrypted
      : request.url === "/fixed-encrypted" ? fixedEncrypted
      : request.url?.startsWith("/tiles/") ? scrambled
        : request.url?.includes("/sr:1/") ? md5Scrambled
          : plain);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...testServerConfig(), allowPrivateNetworks: true, maxImageBytes: 1024 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const direct = await fetch(`${appBase}/image?url=${encodeURIComponent(`${upstreamBase}/plain`)}`);
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("content-type"), "image/jpeg");
  assert.equal(direct.headers.get("x-image-decoder"), "passthrough");
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), plain);

  const referer = `${upstreamBase}/comic/chapter-1`;
  const withReferer = await fetch(`${appBase}/image/auto?url=${encodeURIComponent(`${upstreamBase}/referer`)}&referer=${encodeURIComponent(referer)}`);
  assert.equal(withReferer.status, 200);
  assert.equal(explicitReferer, referer);

  const encodedKey = Buffer.from(genericKeyText).toString("base64url");
  const genericAes = await fetch(`${appBase}/image/aes-cbc-prefix-iv-${encodedKey}?url=${encodeURIComponent(`${upstreamBase}/generic-encrypted`)}`);
  assert.equal(genericAes.status, 200);
  assert.match(genericAes.headers.get("x-image-decoder"), /^aes-cbc-prefix-iv-/);
  assert.deepEqual(Buffer.from(await genericAes.arrayBuffer()), plain);

  const encodedFixedKey = Buffer.from(fixedKeyText).toString("base64url");
  const encodedFixedIv = Buffer.from(fixedIvText).toString("base64url");
  const fixedAes = await fetch(`${appBase}/image/aes-cbc-fixed-iv-${encodedFixedKey}-${encodedFixedIv}?url=${encodeURIComponent(`${upstreamBase}/fixed-encrypted`)}`);
  assert.equal(fixedAes.status, 200);
  assert.match(fixedAes.headers.get("x-image-decoder"), /^aes-cbc-fixed-iv-/);
  assert.deepEqual(Buffer.from(await fixedAes.arrayBuffer()), plain);

  const encodedPlan = Buffer.from(JSON.stringify(idTilePlan)).toString("base64url");
  const tiled = await fetch(`${appBase}/image/id-md5-reverse-tiles-${encodedPlan}?url=${encodeURIComponent(`${upstreamBase}/tiles/150/1.jpg`)}`);
  assert.equal(tiled.status, 200);
  assert.equal(tiled.headers.get("content-type"), "image/png");
  assert.match(tiled.headers.get("x-image-decoder"), /^id-md5-reverse-tiles-/);
  const restored = await Jimp.read(Buffer.from(await tiled.arrayBuffer()));
  assert.deepEqual(Buffer.from(restored.bitmap.data), originalPixels);

  const md5Url = `${upstreamBase}/m/token/wm:0/sr:1/${encodedPath}.jpg`;
  const md5 = await fetch(`${appBase}/image/md5-reverse-tiles-7-3?url=${encodeURIComponent(md5Url)}`);
  assert.equal(md5.status, 200);
  assert.equal(md5.headers.get("content-type"), "image/png");
  assert.equal(md5.headers.get("x-image-decoder"), "md5-reverse-tiles-7-3");
  const md5Restored = await Jimp.read(Buffer.from(await md5.arrayBuffer()));
  assert.deepEqual(Buffer.from(md5Restored.bitmap.data), md5OriginalPixels);
});
