import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichLrtsSource,
  fetchLrtsResourceBooks,
  isLrtsSource,
  lrtsExploreEntriesFromCategory,
  rememberLrtsBookIds,
} from "../src/lrtsAdapter.js";
import { convertLegado } from "../src/converter.js";

test("isLrtsSource 识别懒人听书域名", () => {
  assert.equal(isLrtsSource({ bookSourceUrl: "https://m.lrts.me/" }), true);
  assert.equal(isLrtsSource({ bookSourceUrl: "https://example.com/" }), false);
});

test("lrtsExploreEntriesFromCategory 展开子分类为 adapter URL", () => {
  const entries = lrtsExploreEntriesFromCategory({
    data: {
      bookTypeList: [{
        name: "有声小说",
        subList: [{ name: "玄幻奇幻", url: "11", subList: [] }],
      }],
    },
  }, "https://convert.example");
  assert.equal(entries.length, 1);
  assert.match(entries[0].url, /adapter\/lrts-books\?entityId=11/);
  assert.equal(entries[0].pageSize, 20);
});

test("fetchLrtsResourceBooks 第二页使用 bookIds 切片", async () => {
  rememberLrtsBookIds("11", Array.from({ length: 40 }, (_, i) => i + 1));
  const calls = [];
  const download = async (url) => {
    calls.push(url);
    if (String(url).includes("entityId=0")) {
      return Buffer.from(JSON.stringify({
        books: [{ id: 21, name: "第二页书" }],
      }));
    }
    return Buffer.from("{}");
  };
  const output = await fetchLrtsResourceBooks("11", 2, 20, download);
  assert.equal(output.data.length, 1);
  assert.equal(output.data[0].name, "第二页书");
  assert.match(calls[0], /bookIds=%5B/);
});

test("懒人听书 enrich 后生成分类筛选与 15 条搜索分页", async () => {
  const source = {
    bookSourceName: "懒人听书",
    bookSourceUrl: "https://m.lrts.me/",
    bookSourceType: 1,
    searchUrl: "https://m.lrts.me/ajax/searchBook?keyWord={{key}}&pageSize=15&pageNum={{page}}",
    exploreUrl: "@js:\ngetCategory = () => JSON.parse(java.ajax('https://m.lrts.me/ajax/getCategory')).data.bookTypeList;",
    ruleSearch: {
      bookList: "$.books[*]",
      name: "$.name",
      bookUrl: "https://m.lrts.me/ajax/getBookDetail?bookId={{$.id}}",
      checkKeyWord: "御兽之王",
    },
    ruleToc: {
      chapterList: "$.list[*]",
      chapterName: "$.name",
      chapterUrl: "https://m.lrts.me/ajax/getListenPath?entityId={{baseUrl.match(/bookId=(\\d+)/)[1]}}&section={{$.section}}&id={{$.id}}",
    },
    ruleBookInfo: {
      name: "$.name",
      tocUrl: "https://m.lrts.me/ajax/getBookMenu?bookId={{$.id}}&pageNum=1&pageSize=50&sortType=0",
    },
    ruleContent: { content: "@js:return $.data.path;" },
  };
  const enriched = await enrichLrtsSource(source, {
    imageProxyBase: "https://convert.example",
    download: async () => Buffer.from(JSON.stringify({
      data: {
        bookTypeList: [{
          name: "有声小说",
          subList: Array.from({ length: 7 }, (_, i) => ({
            name: `分类${i + 1}`,
            url: String(100 + i),
            subList: [],
          })),
        }],
      },
    })),
  });
  assert.ok(Array.isArray(enriched.exploreUrl));
  assert.equal(enriched.exploreUrl.length, 7);
  const { sources } = convertLegado(enriched, { imageProxyBase: "https://convert.example" });
  const converted = sources["懒人听书"];
  assert.ok(converted.bookWorld["分类"]);
  assert.equal(converted.searchBook.moreKeys.pageSize, 15);
  assert.match(converted.chapterContent.content, /body\.data\.path/);
  assert.doesNotMatch(converted.chapterContent.content, /\/adapter\/media/);
});
