import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  convertLegado,
  createAppServer,
  isPlayableMediaResponse,
  runXbsPipeline,
} from "../src/index.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("媒体响应校验拒绝伪装成播放地址的 HTML 页面", () => {
  const response = (contentType, url = "https://example.test/play") => ({
    ok: true,
    url,
    headers: { get: (name) => name === "content-type" ? contentType : null },
  });
  assert.equal(isPlayableMediaResponse(response("text/html; charset=utf-8")), false);
  assert.equal(isPlayableMediaResponse(response("application/json")), false);
  assert.equal(isPlayableMediaResponse(response("audio/mpeg")), true);
  assert.equal(isPlayableMediaResponse(response("application/octet-stream", "https://cdn.test/1.mp3")), true);
  assert.equal(isPlayableMediaResponse(response("text/html", "https://cdn.test/1.mp3")), false);
});

test("香色动作链执行器验证分类、详情、章节和正文", async (context) => {
  const upstream = createServer((request, response) => {
    if (request.url === "/category/12?page=2" || request.url === "/search?q=%E6%B5%8B%E8%AF%95") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip" });
      response.end(gzipSync('<section class="book"><h2><span>测试作品</span></h2><a href="/detail/1">详情</a></section>'));
    } else if (request.url === "/detail/1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<h1>测试作品</h1><div id="chapters"><a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a></div>');
    } else if (request.url === "/chapter/1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<article id="content">这是经过完整动作链取得的正文。</article>');
    } else {
      response.writeHead(404);
      response.end("not found");
    }
  });
  const base = await listen(upstream);
  context.after(() => close(upstream));
  const bridge = createAppServer({ config: { allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const bridgeBase = await listen(bridge);
  context.after(() => close(bridge));

  const legado = {
    bookSourceName: "运行时测试",
    bookSourceUrl: base,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { checkKeyWord: "测试", bookList: ".book", name: "h2@text", bookUrl: "a@href" },
    exploreUrl: Array.from({ length: 12 }, (_, index) => ({
      title: `分类 ${index + 1}`,
      url: `/category/${index + 1}?page={{page}}`,
    })),
    ruleExplore: { bookList: ".book", name: "h2@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "#chapters a", chapterName: "a@text", chapterUrl: "a@href" },
    ruleContent: { content: "#content@html" },
  };
  const converted = convertLegado(legado, { imageProxyBase: bridgeBase, omitNonPortable: true }).sources["运行时测试"];
  assert.equal(converted.bookWorld["分类"].responseFormatType, "json");
  assert.equal(converted.bookWorld["分类"].list, "$.data");
  assert.match(converted.chapterList.requestInfo, /\/adapter\/chapters/);
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/text/);
  const report = await runXbsPipeline(converted, { filter: "分类 12", pageIndex: 2 });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.listCount, 1);
  assert.equal(new URL(report.steps.bookWorld.requestUrl).searchParams.get("url"), "/category/12?page=2");
  assert.equal(report.steps.chapterList.listCount, 2);
  assert.equal(report.steps.chapterContent.itemCount > 0, true);

  const searchOnly = { ...converted, bookWorld: {} };
  const searchReport = await runXbsPipeline(searchOnly, { keyWord: "测试" });
  assert.equal(searchReport.ok, true, searchReport.error);
  assert.equal(searchReport.steps.bookWorld.title, "搜索");
  assert.equal(
    new URL(new URL(searchReport.steps.bookWorld.requestUrl).searchParams.get("url")).pathname,
    "/search",
  );
  assert.equal(
    new URL(new URL(searchReport.steps.bookWorld.requestUrl).searchParams.get("url")).searchParams.get("q"),
    "测试",
  );

  const firstCategoryBroken = {
    ...converted,
    bookWorld: {
      失效分类: { ...converted.bookWorld["分类"], requestInfo: `${base}/missing` },
      可用分类: converted.bookWorld["分类"],
    },
  };
  const fallbackReport = await runXbsPipeline(firstCategoryBroken, { filter: "分类 12", pageIndex: 2 });
  assert.equal(fallbackReport.ok, true, fallbackReport.error);
  assert.equal(fallbackReport.steps.bookWorld.title, "可用分类");
  assert.equal(fallbackReport.attemptedWorlds, 2);
});

test("纯脚本正文规则接收纯文本章节的原始响应", async (context) => {
  const upstream = createServer((request, response) => {
    if (request.url === "/books") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<a class="book" href="/book/1">纯文本作品</a>');
    } else if (request.url === "/book/1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<a class="chapter" href="/chapter/1.txt">第一章</a>');
    } else if (request.url === "/chapter/1.txt") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("这是纯文本章节正文，应当原样交给后处理脚本。");
    } else {
      response.writeHead(404);
      response.end("not found");
    }
  });
  const base = await listen(upstream);
  context.after(() => close(upstream));

  const source = {
    sourceName: "纯文本运行时测试",
    sourceUrl: base,
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: base,
        requestInfo: "/books",
        list: "//a[@class='book']",
        bookName: "//a",
        detailUrl: "//a/@href",
      },
    },
    bookDetail: { actionID: "bookDetail", host: base, requestInfo: "%@result" },
    chapterList: {
      actionID: "chapterList",
      host: base,
      requestInfo: "%@result",
      list: "//a[@class='chapter']",
      title: "//a",
      url: "//a/@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: base,
      requestInfo: "%@result",
      content: "@js:\nreturn result;",
    },
  };

  const report = await runXbsPipeline(source);
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.chapterContent.itemCount > 0, true);
  assert.equal(report.steps.chapterContent.requestUrl, `${base}/chapter/1.txt`);
});
