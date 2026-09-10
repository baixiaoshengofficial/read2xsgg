import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import iconv from "iconv-lite";
import {
  convertLegado,
  createAppServer,
  downloadAsFetch,
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

test("原生 GBK 动作按响应编码解码，UTF-8 JSON 桥接不继承请求编码", async () => {
  const host = "https://charset.example";
  for (const encodingSource of ["action", "header", "meta", "decoded"]) {
    const responseFields = ["action", "decoded"].includes(encodingSource) ? { responseEncode: "2147485234" } : {};
    const htmlAction = { host, responseFormatType: "html", ...responseFields };
    const source = {
      sourceName: "中文编码回归",
      sourceUrl: host,
      sourceType: "text",
      bookWorld: {
        分类: {
          ...htmlAction, actionID: "bookWorld", requestInfo: "/books",
          list: "//a[contains(., '作品')]", bookName: ".", detailUrl: "./@href",
        },
      },
      bookDetail: {
        host, actionID: "bookDetail", responseFormatType: "json",
        requestInfo: "/detail", bookName: "name", author: "author",
        requestParamsEncode: "2147485234",
      },
      chapterList: {
        ...htmlAction, actionID: "chapterList", requestInfo: "%@result",
        list: "//a[contains(., '第一章')]", title: ".", url: "./@href",
      },
      chapterContent: {
        ...htmlAction, actionID: "chapterContent", requestInfo: "%@result",
        content: "//article",
      },
    };
    const pages = {
      "/books": '<a href="/book/1">中文作品</a>',
      "/book/1": '<a href="/chapter/1">第一章 启程</a>',
      "/chapter/1": "<article>这是正确解码的中文正文。</article>",
    };
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      assert.ok(pathname === "/detail" || pages[pathname], pathname);
      const json = pathname === "/detail";
      const body = json
        ? Buffer.from(JSON.stringify({ name: "中文作品", author: "测试作者" }))
        : iconv.encode((["meta", "decoded"].includes(encodingSource) ? '<meta charset="gb2312">' : "")
          + pages[pathname], encodingSource === "decoded" ? "utf8" : "gbk");
      if (encodingSource === "decoded") {
        Object.defineProperty(body, "read2xsggDecodedText", { value: true });
        Object.defineProperty(body, "httpHeaders", {
          value: { "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=gbk" },
        });
        return downloadAsFetch(async () => body)(url);
      }
      const response = new Response(body, {
        headers: { "Content-Type": json ? "application/json; charset=utf-8"
          : encodingSource === "header" ? "text/html; charset=gbk" : "text/html" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const report = await runXbsPipeline(source, { fetchImpl, bookIndex: 0, chapterIndex: 0 });
    assert.equal(report.ok, true, `${encodingSource}: ${report.error}`);
    assert.equal(report.steps.bookWorld.bookName, "中文作品");
    assert.equal(report.steps.bookDetail.name, "中文作品");
    assert.equal(report.steps.bookDetail.author, "测试作者");
    assert.equal(report.steps.chapterList.chapterTitle, "第一章 启程");
    assert.equal(report.steps.chapterContent.itemCount, "这是正确解码的中文正文。".length);
  }
});

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

test("整源取消后不再重试其它分类、书籍或章节", async () => {
  const host = "https://cancel.example";
  const controller = new AbortController();
  const world = {
    actionID: "bookWorld", host, requestInfo: "/books",
    list: "//a", bookName: ".", detailUrl: "./@href",
  };
  const source = {
    sourceName: "取消回归", sourceUrl: host, sourceType: "text",
    bookWorld: { 首选: world, 备用: { ...world, requestInfo: "/other-books" } },
    searchBook: { ...world, requestInfo: "/search" },
    bookDetail: { actionID: "bookDetail", host, requestInfo: "%@result" },
    chapterList: {
      actionID: "chapterList", host, requestInfo: "%@result",
      list: "//a", title: ".", url: "./@href",
    },
    chapterContent: { actionID: "chapterContent", host, requestInfo: "%@result", content: "//article" },
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(new URL(url).pathname);
    if (url.endsWith("/chapter/1")) {
      controller.abort(new Error("单源预算耗尽"));
      throw controller.signal.reason;
    }
    const response = new Response(url.endsWith("/books")
      ? '<a href="/book/1">作品一</a><a href="/book/2">作品二</a>'
      : '<a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a>');
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const report = await runXbsPipeline(source, { fetchImpl, signal: controller.signal });
  assert.equal(report.ok, false);
  assert.match(report.error, /单源预算耗尽/);
  assert.deepEqual(requested, ["/books", "/book/1", "/book/1", "/chapter/1"]);
  requested.length = 0;
  const cancelled = await runXbsPipeline(source, { fetchImpl, signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /单源预算耗尽/);
  assert.deepEqual(requested, []);
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

test("JSON 动作链会展开分组数组中的书籍列表", async (context) => {
  const upstream = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.url === "/books") {
      response.end(JSON.stringify({ data: { groups: [
        { books: [{ name: "分组作品一", url: "/detail/1" }] },
        { books: [{ name: "分组作品二", url: "/detail/2" }] },
      ] } }));
    } else if (request.url === "/detail/1") {
      response.end(JSON.stringify({ name: "分组作品一", chapters: [
        { title: "第一章", url: "/chapter/1" },
      ] }));
    } else if (request.url === "/chapter/1") {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("分组数组作品的正文内容。");
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  const base = await listen(upstream);
  context.after(() => close(upstream));
  const source = {
    sourceName: "分组 JSON 运行时测试",
    sourceUrl: base,
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: base,
        requestInfo: "/books",
        responseFormatType: "json",
        list: "data/groups/books",
        bookName: "name",
        detailUrl: "url",
      },
    },
    bookDetail: {
      actionID: "bookDetail",
      host: base,
      requestInfo: "%@result",
      responseFormatType: "json",
      bookName: "name",
    },
    chapterList: {
      actionID: "chapterList",
      host: base,
      requestInfo: "%@result",
      responseFormatType: "json",
      list: "chapters",
      title: "title",
      url: "url",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: base,
      requestInfo: "%@result",
      content: "@js:\nreturn result;",
    },
  };

  const report = await runXbsPipeline(source, { fetchMedia: false });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.listCount, 2);
  assert.equal(report.steps.bookWorld.bookName, "分组作品一");
  assert.equal(report.steps.chapterList.listCount, 1);
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
