import assert from "node:assert/strict";
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
