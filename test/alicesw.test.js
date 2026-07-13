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

test("alicesw.com 源会经站点适配后再转换出可用规则", () => {
  const { sources, warnings } = convertLegado([raw]);
  const converted = sources["爱丽丝书屋"];
  assert.match(converted.searchBook.list, /list-group-item/);
  assert.match(converted.searchBook.bookName, /h5/);
  assert.match(converted.bookDetail.tocUrl, /\/\/a\[contains/);
  assert.match(converted.bookDetail.tocUrl, /查看所有章节/);
  assert.match(converted.chapterList.list, /mulu_list/);
  assert.match(converted.chapterContent.content, /read-content/);
  assert.match(converted.chapterContent.content, /\|@js:/);
  assert.doesNotMatch(converted.chapterContent.content, /\|\|@js:/);
  // 不依赖 tocUrl 透传：按 /novel/{id} 推导目录页
  assert.match(converted.chapterList.requestInfo, /other\/chapters\/id/);
  assert.match(converted.chapterList.requestInfo, /novel/);
  assert.match(converted.chapterList.url, /alicesw\.com/);
  assert.ok(warnings.some((w) => /alicesw\.com/.test(w.message)));
});
