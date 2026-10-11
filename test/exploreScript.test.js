import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado } from "../src/converter.js";
import { extractDataDrivenExploreEntries } from "../src/exploreScript.js";
import { resolveChapterListUrls } from "../src/verifySource.js";

const exploreScript = `@js:
const legacyText = "误识别::https://wrong.example/";
(function() {
  const state = { channel: "all", category: "genre", sort: "hot" };
  const sortMap = { hot: "popular", latest: "new" };
  const channelMap = { all: 0, female: 1 };
  const dict = {
    all: {
      genre: "都市|奇幻".split("|"),
      status: "连载|完结".split("|")
    },
    female: { genre: "言情|古风".split("|") }
  };
  const items = dict[state.channel][state.category] || [];
  const sortValue = sortMap[state.sort];
  const channelValue = channelMap[state.channel];
  const ui = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const url = (state.category === "genre")
      ? "https://api.example/list?sort=" + sortValue + "&channel=" + channelValue + "&q=" + encodeURIComponent(item)
      : "https://api.example/status?sort=" + sortValue + "&channel=" + channelValue + "&q=" + encodeURIComponent(item);
    ui.push({ title: item, url: url });
  }
  return JSON.stringify(ui);
})()`;

test("data-driven explore JavaScript is statically extracted without execution", () => {
  delete globalThis.__exploreScriptExecuted;
  const entries = extractDataDrivenExploreEntries(`
    globalThis.__exploreScriptExecuted = true;
    ${exploreScript}
  `);

  assert.deepEqual(entries, [
    { title: "都市", url: "https://api.example/list?sort=popular&channel=0&q=%E9%83%BD%E5%B8%82", group: "" },
    { title: "奇幻", url: "https://api.example/list?sort=popular&channel=0&q=%E5%A5%87%E5%B9%BB", group: "" },
  ]);
  assert.equal(globalThis.__exploreScriptExecuted, undefined);
});

test("statically extracted explore categories flow into converted audio sources", () => {
  const { sources, warnings } = convertLegado({
    bookSourceName: "data-driven audio",
    bookSourceUrl: "https://api.example/",
    bookSourceType: 1,
    exploreUrl: exploreScript,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.data[*]", name: "$.name", bookUrl: "$.id" },
    ruleExplore: { bookList: "$.data[*]", name: "$.name", bookUrl: "$.id" },
    ruleBookInfo: { name: "$.name" },
    ruleToc: { chapterList: "$.data[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: { content: "$.data" },
  });

  const converted = sources["data-driven audio"];
  assert.deepEqual(Object.keys(converted.bookWorld), ["都市", "奇幻"]);
  assert.match(converted.bookWorld["都市"].requestInfo, /q=%E9%83%BD%E5%B8%82/);
  assert.ok(warnings.some(({ message }) => message.includes("静态分类字典和 URL 模板安全提取")));
});

test("a safe detail-URL string transform feeds the Xiangse chapter-list result contract", () => {
  const { sources } = convertLegado({
    bookSourceName: "toc URL transform",
    bookSourceUrl: "https://api.example/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.data[*]", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: {
      name: "$.data.name",
      tocUrl: '<js> String(baseUrl).replace("/bookinfo/", "/audiolist/").split("?")[0] + "?https=1"; </js>',
    },
    ruleToc: { chapterList: "$.data.chapterCon", chapterName: "$.tit", chapterUrl: "$.url" },
    ruleContent: { content: "$.data" },
  }, { imageProxyBase: "https://bridge.example" });
  const converted = sources["toc URL transform"];

  assert.match(converted.chapterList.requestInfo, /read2xsgg:chapter-toc-url/);
  const [adapterUrl] = resolveChapterListUrls(
    converted.chapterList.requestInfo,
    "https://api.example/bookinfo/42?language=zh_cn",
  );
  assert.ok(adapterUrl);
  const parsed = new URL(adapterUrl);
  assert.equal(parsed.pathname, "/adapter/chapters");
  assert.equal(parsed.searchParams.get("url"), "https://api.example/audiolist/42?https=1");
});
