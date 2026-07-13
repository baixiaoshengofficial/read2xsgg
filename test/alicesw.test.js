import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado } from "../src/index.js";

const raw = {
  bookSourceName: "爱丽丝书屋",
  bookSourceUrl: "https://www.alicesw.com",
  searchUrl: "https://www.alicesw.com/search.html?q={{key}}",
  ruleSearch: {
    bookList: "h2 a, li:has(a), .novel-item",
    name: "a@text",
    bookUrl: "a@href",
  },
  ruleBookInfo: { name: "h1@text" },
  ruleToc: { chapterList: "#chapters a", chapterName: "a@text", chapterUrl: "a@href" },
  ruleContent: { content: "#content@html" },
};

test("alicesw.com 适配符合香色书源规则§五§七", () => {
  const { sources, warnings } = convertLegado([raw]);
  const converted = sources["爱丽丝书屋"];

  // §五：detailUrl 是详情页，不改写成目录
  assert.match(converted.searchBook.detailUrl, /\/\/h5\/\/a\/@href/);
  assert.doesNotMatch(converted.searchBook.detailUrl, /other\/chapters/);

  // §七 示例同构：list=li，title/url=a
  assert.match(converted.chapterList.list, /mulu_list/);
  assert.match(converted.chapterList.list, /\/li$/);
  assert.equal(converted.chapterList.title, "//a/text()");
  assert.equal(converted.chapterList.url, "//a/@href");

  // §七：requestInfo 用 result（详情 URL）推导目录；§九：返回 {url:...}
  assert.match(converted.chapterList.requestInfo, /^@js:/);
  assert.match(converted.chapterList.requestInfo, /typeof result/);
  assert.match(converted.chapterList.requestInfo, /other\/chapters\/id/);
  assert.match(converted.chapterList.requestInfo, /"url"/);
  assert.match(converted.chapterList.requestInfo, /config\.host/);

  // §八 / 精华书阁：正文 |@js:
  assert.match(converted.chapterContent.content, /\|@js:/);
  assert.doesNotMatch(converted.chapterContent.content, /\|\|@js:/);

  assert.ok(warnings.some((w) => /alicesw\.com/.test(w.message)));
});
