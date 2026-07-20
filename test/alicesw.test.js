import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado } from "../src/index.js";

const raw = {
  bookSourceName: "爱丽丝书屋",
  bookSourceUrl: "https://www.alicesw.com",
  searchUrl: "https://www.alicesw.com/search.html?q={{key}}",
  ruleSearch: { bookList: ".x", name: "a@text", bookUrl: "a@href" },
  ruleBookInfo: { name: "h1@text" },
  ruleToc: { chapterList: "#chapters a", chapterName: "a@text", chapterUrl: "a@href" },
  ruleContent: { content: "#content@html" },
};

test("alicesw：详情保持 /novel/，目录兼容 section-list|mulu_list，chapterList 改写目录", () => {
  const { sources } = convertLegado([raw]);
  const c = sources["爱丽丝书屋"];

  // 搜索不落地到目录页
  assert.doesNotMatch(c.searchBook.detailUrl, /\|@js:/);
  assert.match(c.searchBook.detailUrl, /\/\/h5\/\/a\/@href|\/\/h5\/a\/@href/);

  // 封面可绝对化
  assert.match(c.bookDetail.cover, /og:image/);
  assert.match(c.bookDetail.cover, /\|@js:/);

  // 最新章
  assert.match(c.bookDetail.lastChapterTitle, /\/book\//);

  // 目录双模板
  assert.match(c.chapterList.list, /section-list/);
  assert.match(c.chapterList.list, /mulu_list/);
  assert.match(c.chapterList.list, /\|\|/);

  // §七 result → 目录
  assert.match(c.chapterList.requestInfo, /^@js:/);
  assert.match(c.chapterList.requestInfo, /other\/chapters\/id/);
  assert.equal(c.chapterList.title, "//a");
  assert.equal(c.chapterList.url, "//a/@href");
});
