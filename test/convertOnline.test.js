import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { convertParsedSource } from "../src/convertOnline.js";
import { serverConfig } from "../src/server.js";

function source(name) {
  return {
    bookSourceName: name,
    bookSourceUrl: "https://example.com",
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/list?page={{page}}",
    ruleSearch: { bookList: ".book", name: "a", author: ".author", bookUrl: "a@href" },
    ruleExplore: { bookList: ".book", name: "a", author: ".author", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1" },
    ruleToc: { chapterList: "#chapters a", chapterName: "a", chapterUrl: "a@href" },
    ruleContent: { content: "#content" },
  };
}

test("conversion retains structurally convertible sources before quality verification", async () => {
  let verificationCalls = 0;
  const result = await convertParsedSource([source("one"), source("two"), source("three")], {
    ...serverConfig({}),
    preflightSources: false,
    verifyConvertedSources: false,
  }, "", {
    downloadSource: async () => {
      verificationCalls += 1;
      throw new Error("verification is disabled");
    },
  });

  assert.equal(verificationCalls, 0);
  assert.equal(result.count, 3);
  assert.equal(result.unverifiedCount, 3);
  assert.equal(result.verifiedCount, 0);
});

test("完整阅读规则验链使用抓取时限，而不继承 3 秒内的探活时限", async (context) => {
  const upstream = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const body = pathname.startsWith("/chapter/")
      ? `<div id="content">${"这是经过完整验链的正文内容。".repeat(80)}</div>`
      : pathname.startsWith("/book/")
        ? "<h1>慢响应书籍</h1><div id='chapters'><a href='/chapter/1'>第一章</a></div>"
        : "<div class='book'><a href='/book/1'>慢响应书籍</a><span class='author'>作者</span></div>";
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    }, 80);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const result = await convertParsedSource([{
    ...source("慢响应但可用"),
    bookSourceUrl: base,
  }], {
    ...serverConfig({
      ALLOW_PRIVATE_NETWORKS: "true",
      FETCH_TIMEOUT_MS: "500",
      PREFLIGHT_TIMEOUT_MS: "20",
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "true",
      VERIFY_WORKERS: "1",
      ANALYZE_FALLBACK: "false",
      RETAIN_UNVERIFIED_SOURCES: "false",
      VERIFY_SOURCE_BUDGET_MS: "5000",
    }),
    verifyWorkers: 1,
  });

  assert.equal(result.count, 1);
  assert.deepEqual(result.skipped, []);
});

test("preflight filters unreachable sources before conversion", async () => {
  await assert.rejects(
    () => convertParsedSource([
      source("one"),
    ], {
      ...serverConfig({}),
      preflightSources: true,
      verifyConvertedSources: false,
    }, "", {
      filterReachableSources: async (input) => ({
        input: [],
        skipped: input.map((item) => ({
          source: item.bookSourceName,
          reason: "上游站点不可访问",
        })),
      }),
      downloadSource: async () => {
        throw new Error("upstream unavailable during probe");
      },
    }),
    /上游站点不可访问|没有可转换的阅读源/,
  );
});

test("CPU worker pool verifies multiple sources without cross-source loss", async (context) => {
  const app = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (pathname.startsWith("/chapter/")) {
      response.end(`<article>${"这是可验证正文。".repeat(80)}</article>`);
      return;
    }
    if (pathname.startsWith("/book/")) {
      response.end("<h1>测试作品</h1><a href='/chapter/1'>第一章</a>");
      return;
    }
    response.end("<ul><li class='book'><a href='/book/1'>测试作品</a></li></ul>");
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  context.after(() => app.close());
  const port = app.address().port;
  const makeSource = (name) => ({
    bookSourceName: name,
    bookSourceUrl: `http://127.0.0.1:${port}`,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".book", name: "a", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1" },
    ruleToc: { chapterList: "a", chapterName: "a", chapterUrl: "a@href" },
    ruleContent: { content: "article" },
  });
  const result = await convertParsedSource(
    [makeSource("worker-one"), makeSource("worker-two")],
    {
      ...serverConfig({
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "true",
        ALLOW_PRIVATE_NETWORKS: "true",
        PREFLIGHT_TIMEOUT_MS: "500",
        ANALYZE_TIMEOUT_MS: "1000",
      }),
      verifyWorkers: 2,
      jobVerifyWorkers: 2,
    },
    "",
    { workerPoolEnabled: true },
  );
  assert.equal(result.count, 2);
  assert.equal(result.skipped.length, 0);
});

test("post-conversion Xiangse validation filters invalid output", async () => {
  await assert.rejects(
    () => convertParsedSource([
      {
        ...source("bad"),
        bookSourceUrl: "",
      },
    ], {
      ...serverConfig({}),
      preflightSources: false,
      verifyConvertedSources: false,
    }, "", {
    }),
    /香色结构校验失败|没有可转换的阅读源/,
  );
});

test("failed verification skips the original converted source", async () => {
  const result = await convertParsedSource([
    source("one"),
    {
      ...source("two"),
      bookSourceUrl: "https://example.org",
      searchUrl: "https://example.org/list",
      ruleSearch: { bookList: "li", name: "a", author: ".author", bookUrl: "a@href" },
      ruleBookInfo: { name: "h1" },
      ruleToc: { chapterList: "a", chapterName: "a", chapterUrl: "a@href" },
      ruleContent: { content: "article" },
    },
  ], {
    ...serverConfig({}),
    preflightSources: false,
    verifyConvertedSources: true,
    analyzeFallback: true,
    retainUnverifiedSources: false,
    verifyBudgetMs: 0,
  }, "", {
    downloadSource: async (url) => {
      if (String(url).includes("example.org")) {
        const path = new URL(String(url)).pathname;
        if (path === "/book/1") {
          return Buffer.from("<html><h1>书名</h1><a href='/chapter/1'>第一章</a></html>");
        }
        if (path === "/chapter/1") {
          return Buffer.from(`<html><article>${"有效正文。".repeat(80)}</article></html>`);
        }
        return Buffer.from("<html><ul><li><a href='/book/1'>书名</a></li></ul></html>");
      }
      throw new Error("upstream unavailable during probe");
    },
  });

  assert.equal(result.count, 1);
  assert.ok(result.sources.two);
  assert.equal(result.unverifiedCount, 0);
  assert.ok(result.skipped.some((item) => item.source === "one"));
  assert.match(
    result.warnings.find((warning) => warning.source === "one" && /已过滤/.test(warning.message)).message,
    /已过滤/,
  );
});

test("failed live verification retains a structurally valid source as unverified", async () => {
  const result = await convertParsedSource([source("reachable-but-temporary")], {
    ...serverConfig({}),
    preflightSources: false,
    verifyConvertedSources: true,
    analyzeFallback: false,
    retainUnverifiedSources: true,
    verifyBudgetMs: 0,
  }, "", {
    downloadSource: async () => {
      throw new Error("temporary upstream failure");
    },
  });

  assert.equal(result.count, 1);
  assert.ok(result.sources["reachable-but-temporary"]);
  assert.equal(result.unverifiedCount, 1);
  assert.equal(result.skipped.length, 0);
  assert.match(result.warnings.find((warning) => warning.source === "reachable-but-temporary").message, /未验证/);
});
