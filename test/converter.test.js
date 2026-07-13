import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { convertLegado, convertRequest, convertRule, decodeXbs, encodeXbs } from "../src/index.js";

const sampleSource = {
  bookSourceName: "示例书源",
  bookSourceUrl: "https://example.com/",
  bookSourceGroup: "测试",
  bookSourceType: 0,
  customOrder: 7,
  enabled: true,
  header: '{"Referer":"https://example.com/","User-Agent":"Test"}',
  searchUrl: "/search.html,{" + '"method":"POST","body":"searchkey={{key}}&page={{page}}","charset":"gbk"}',
  exploreUrl: "玄幻::/list/1/{{page}}\n都市::/list/2/{{page}}",
  ruleSearch: {
    bookList: "id.sitembox@tag.dl",
    name: "tag.dd@tag.h3@tag.a@text##免费阅读",
    author: "class.book_other.0@tag.span.0@text",
    intro: "class.book_des@text",
    kind: "class.book_other.0@tag.span.2@text",
    lastChapter: "class.book_other.1@tag.a@text",
    bookUrl: "tag.dd@tag.h3@tag.a@href",
    coverUrl: "tag.dt@tag.a@img@src",
  },
  ruleExplore: {
    bookList: ".book-list > li",
    name: "h3 > a",
    bookUrl: "h3 > a@href",
  },
  ruleBookInfo: {
    name: "id.info@h1@text",
    author: "id.info@tag.p.0@a@text",
    intro: "id.intro@tag.p.0@text",
    coverUrl: "id.fmimg@tag.img@src",
  },
  ruleToc: {
    chapterList: "class.box_con@tag.dd",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: {
    content: "id.content@html##广告.*##",
    nextContentUrl: "text.下一页@href",
  },
};

test("转换一个完整的 HTML 阅读源", () => {
  const { sources, warnings } = convertLegado([sampleSource]);
  const converted = sources["示例书源"];

  assert.equal(Object.keys(sources).length, 1);
  assert.equal(converted.sourceUrl, "https://example.com");
  assert.deepEqual(converted.httpHeaders, { Referer: "https://example.com/", "User-Agent": "Test" });
  assert.match(converted.searchBook.requestInfo, /POST:true/);
  assert.match(converted.searchBook.requestInfo, /params\.keyWord/);
  assert.equal(converted.searchBook.requestParamsEncode, "2147485234");
  assert.equal(converted.searchBook.list, "//*[@id='sitembox']//dl");
  assert.equal(
    converted.searchBook.author,
    "(.//*[contains(concat(' ', normalize-space(@class), ' '), ' book_other ')])[1]/(.//span)[1]/text()",
  );
  assert.equal(converted.chapterList.list, "//*[contains(concat(' ', normalize-space(@class), ' '), ' box_con ')]//dd");
  assert.match(converted.chapterContent.content, /new RegExp\("广告\.\*"/);
  assert.equal(converted.chapterContent.nextPageUrl, "//a[contains(normalize-space(.), '下一页')]/@href");
  assert.deepEqual(Object.keys(converted.bookWorld), ["玄幻", "都市"]);
  assert.equal(warnings.length, 0);
});

test("转换 JSONPath 规则和 JSON 响应", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "JSON API";
  source.searchUrl = "https://api.example.com/search?q={{key}}&page={{page}}";
  source.exploreUrl = "";
  source.ruleSearch = {
    bookList: "$.data.books[*]",
    name: "$.title",
    author: "$.author.name",
    bookUrl: "$.id",
  };
  const { sources } = convertLegado(source);
  assert.equal(sources["JSON API"].searchBook.responseFormatType, "json");
  assert.equal(sources["JSON API"].searchBook.list, "data/books");
  assert.equal(sources["JSON API"].searchBook.author, "author/name");
});

test("CSS、阅读链式选择器和分页选择器转换为 XPath", () => {
  assert.equal(convertRule("id.info@tag.p.0@a@text"), "//*[@id='info']/(.//p)[1]//a/text()");
  assert.equal(
    convertRule(".txt-list > li:nth-child(n+2)"),
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' txt-list ')]/li[position() >= 2]",
  );
  assert.equal(convertRule("tbody>tr!0"), "//tbody/tr[position() > 1]");
  assert.equal(convertRule("a.1@href"), "(.//a)[2]/@href");
  assert.equal(convertRule("tag.a.0:1:2@text"), "(.//a)[position() = 1 or position() = 2 or position() = 3]/text()");
});

test("相对属性 text/href 与 CSS 目录规则不会被误判为 JSON", () => {
  assert.equal(convertRule("text"), "/text()");
  assert.equal(convertRule("href"), "//@href");
  assert.equal(convertRule("@text"), "/text()");
  assert.equal(convertRule("a@text"), "//a/text()");
  assert.equal(
    convertRule("a[href~=/read/\\d+]"),
    "//a[contains(@href, '/read/')]",
  );
  assert.equal(
    convertRule("tag.a.0:1:2@text"),
    "(.//a)[position() = 1 or position() = 2 or position() = 3]/text()",
  );

  const source = {
    bookSourceName: "目录相对属性",
    bookSourceUrl: "https://example.com/",
    searchUrl: "https://example.com/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text", tocUrl: "text.查看全部章节@href" },
    ruleToc: {
      chapterList: "a[href~=/read/\\d+]",
      chapterName: "text",
      chapterUrl: "href",
    },
    ruleContent: { content: "id.content@html" },
  };
  const { sources, warnings } = convertLegado([source]);
  const converted = sources["目录相对属性"];
  assert.equal(converted.chapterList.responseFormatType, "html");
  assert.equal(converted.chapterList.list, "//a[contains(@href, '/read/')]");
  assert.equal(converted.chapterList.title, "/text()");
  assert.equal(converted.chapterList.url, "//@href");
  assert.match(converted.bookDetail.tocUrl, /\/\/a\[contains/);
  assert.match(converted.bookDetail.tocUrl, /查看全部章节/);
  assert.match(converted.chapterList.requestInfo, /q\.tocUrl/);
  assert.ok(warnings.some((warning) => warning.field === "tocUrl"));
});

test("GET/POST 请求模板转换", () => {
  assert.equal(
    convertRequest("/search/{{key}}/{{page}}").requestInfo,
    "/search/%@keyWord/%@pageIndex",
  );
  const post = convertRequest('/search,{"method":"post","body":"q={{key}}&offset={{page-1}}"}');
  assert.match(post.requestInfo, /"q": params\.keyWord/);
  assert.match(post.requestInfo, /"offset": \(params\.pageIndex - 1\)/);
});

test("XBS 加解密无损往返", () => {
  const value = { "示例书源": { sourceName: "示例书源", enable: 1 } };
  const xbs = encodeXbs(value);
  assert.equal(xbs.length % 4, 0);
  assert.deepEqual(JSON.parse(decodeXbs(xbs).toString("utf8")), value);
});

test("重名书源自动改名且告警去重", () => {
  const { sources, warnings } = convertLegado([sampleSource, sampleSource]);
  assert.deepEqual(Object.keys(sources), ["示例书源", "示例书源 (2)"]);
  assert.ok(warnings.some((warning) => warning.message.includes("重名")));
});

test("CLI 可从标准输入读取并输出 JSON", () => {
  const result = spawnSync(process.execPath, ["bin/read2xsgg.js", "-", "--json-only", "--compact"], {
    cwd: new URL("..", import.meta.url),
    input: JSON.stringify(sampleSource),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)["示例书源"].sourceName, "示例书源");
});
