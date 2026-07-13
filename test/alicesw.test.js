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

test("alicesw：搜索改写到目录页，目录用 %@result（无 chapterList @js）", () => {
  const { sources, warnings } = convertLegado([raw]);
  const converted = sources["爱丽丝书屋"];

  // 搜索 detailUrl |@js: 改写成目录
  assert.match(converted.searchBook.detailUrl, /\|@js:/);
  assert.match(converted.searchBook.detailUrl, /other\/chapters\/id/);

  // 精华书阁式：chapterList 直接 %@result，不依赖 @js
  assert.equal(converted.chapterList.requestInfo, "%@result");
  assert.match(converted.chapterList.list, /mulu_list/);
  assert.equal(converted.chapterList.title, "//a/text()");
  assert.equal(converted.chapterList.url, "//a/@href");

  assert.match(converted.bookDetail.bookName, /h1/);
  assert.match(converted.chapterContent.content, /\|@js:/);
  assert.ok(warnings.some((w) => /alicesw\.com/.test(w.message)));
});
