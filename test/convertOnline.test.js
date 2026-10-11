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
  assert.equal(result.unverifiedCount, 0);
});

test("在线转换仅把原始发现线索传入验链并在 XBS 输出前剥离", async () => {
  const raw = source("临时 AI 发现线索");
  raw.exploreUrl = "@js: var api='https://api.example.com/v1/catalog'; JSON.stringify([]);";
  raw.ruleExplore = { bookList: "$.data.items[*]", name: "$.title", bookUrl: "$.url" };
  let seenByVerifier;
  const result = await convertParsedSource([raw], {
    ...serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "true",
      ANALYZE_FALLBACK: "true",
    }),
  }, "https://convert.example", {
    verifySources: async (sources) => {
      seenByVerifier = structuredClone(sources);
      return {
        sources,
        skipped: [],
        warnings: [],
        fallbackCount: 0,
        aiAttemptCount: 0,
        aiRepairCount: 0,
        unverifiedCount: 0,
      };
    },
  });

  assert.match(seenByVerifier[raw.bookSourceName].__read2xsggAiHints.exploreUrl, /v1\/catalog/);
  assert.equal(Object.hasOwn(result.sources[raw.bookSourceName], "__read2xsggAiHints"), false);
  assert.doesNotMatch(result.json.toString("utf8"), /__read2xsggAiHints|v1\/catalog/);
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

test("完整验链使用独立的上游请求超时，失败源不会以未验证状态发布", async () => {
  const seenTimeouts = [];
  await assert.rejects(() => convertParsedSource([source("slow-but-structured")], {
    ...serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "true",
      ANALYZE_FALLBACK: "false",
      RETAIN_UNVERIFIED_SOURCES: "true",
      VERIFY_REQUEST_TIMEOUT_MS: "12345",
      PREFLIGHT_TIMEOUT_MS: "300",
    }),
  }, "", {
    downloadSource: async (_url, config) => {
      seenTimeouts.push(config.fetchTimeoutMs);
      throw new Error("temporary upstream failure");
    },
  }), /temporary upstream failure|没有可转换的阅读源/);

  assert.ok(seenTimeouts.length > 0);
  assert.ok(seenTimeouts.every((value) => value === 12_345));
});

test("WebUI 完整验链把配置的单源预算用于整条验证链", async () => {
  let observed;
  const sourceBudgetMs = 91_000;
  const runtimeFallbackTimeoutMs = 17_000;
  const result = await convertParsedSource([source("预算贯通")], {
    ...serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "true",
      JOB_VERIFY_SOURCE_BUDGET_MS: String(sourceBudgetMs),
      JOB_VERIFY_RUNTIME_FALLBACK_TIMEOUT_MS: String(runtimeFallbackTimeoutMs),
    }),
  }, "", {
    fullVerify: true,
    verifySources: async (sources, options) => {
      observed = options;
      return {
        sources,
        skipped: [],
        warnings: [],
        fallbackCount: 0,
        unverifiedCount: 0,
      };
    },
  });

  assert.equal(result.count, 1);
  assert.equal(observed.sourceBudgetMs, sourceBudgetMs);
  assert.equal(observed.sourceTimeoutMs, sourceBudgetMs);
  assert.equal(observed.runtimeFallbackTimeoutMs, runtimeFallbackTimeoutMs);
  assert.equal(observed.continueRecognitionUntilTimeout, true);
  assert.equal(observed.requireBookWorld, true);
});

test("预检未收到响应的源进入完整验链时不会被误标为已确认可达", async () => {
  let observed;
  const result = await convertParsedSource([source("待确认入口")], {
    ...serverConfig({
      PREFLIGHT_SOURCES: "true",
      VERIFY_CONVERTED_SOURCES: "true",
      ANALYZE_FALLBACK: "false",
    }),
  }, "", {
    filterReachableSources: async (input) => ({
      input,
      skipped: [],
      unconfirmed: [{ source: "待确认入口", host: "example.com", stage: "preflight-unconfirmed" }],
      warnings: [],
    }),
    verifySources: async (sources, options) => {
      observed = options;
      return { sources, skipped: [], warnings: [], fallbackCount: 0, unverifiedCount: 0 };
    },
  });

  assert.equal(result.count, 1);
  assert.equal(observed.originReachabilityConfirmed, false);
  assert.deepEqual(observed.unconfirmedOriginHosts, ["example.com"]);
  assert.deepEqual(observed.unconfirmedOriginSources, ["待确认入口"]);
});

test("CPU worker pool periodically recycles workers without cross-source loss", async (context) => {
  const app = createServer(async (request, response) => {
    // Keep this above the fast preflight timeout below. A complete verifier
    // must still use its own request budget inside the Worker Thread.
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    exploreUrl: "测试分类::/",
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".book", name: "a", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1" },
    ruleToc: { chapterList: "a", chapterName: "a", chapterUrl: "a@href" },
    ruleContent: { content: "article" },
  });
  const result = await convertParsedSource(
    [
      makeSource("worker-one"),
      makeSource("worker-two"),
      makeSource("worker-three"),
      makeSource("worker-four"),
    ],
    {
      ...serverConfig({
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "true",
        ALLOW_PRIVATE_NETWORKS: "true",
        PREFLIGHT_TIMEOUT_MS: "5",
        ANALYZE_TIMEOUT_MS: "1000",
        VERIFY_WORKER_RECYCLE_AFTER: "1",
      }),
      verifyWorkers: 2,
      jobVerifyWorkers: 2,
    },
    "",
    { workerPoolEnabled: true },
  );
  assert.equal(result.count, 4);
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
    verifySourceBudgetMs: 1_000,
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

test("failed live verification never retains a structurally valid source as unverified", async () => {
  await assert.rejects(() => convertParsedSource([source("reachable-but-temporary")], {
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
  }), /temporary upstream failure|没有可转换的阅读源/);
});
