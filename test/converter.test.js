import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bridgeTocUrl, compileBookBridgePlan, compileChapterBridgePlan, compileDetailBridgePlan, compileMediaResolutionFromRule, compileTextBridgePlan, convertLegado, convertRequest, convertRule, decodeBridgePlan, decodeXbs, encodeXbs, executeBridgePlan, filterValidXiangseSources, hasUnsupportedLegadoRuntime, htmlToPlainText, inferResponseType, validateXiangseSource } from "../src/index.js";

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
    "(.//*[contains(concat(' ', normalize-space(@class), ' '), ' book_other ')])[1]//span[1]",
  );
  assert.equal(converted.chapterList.list, "(//*[contains(concat(' ', normalize-space(@class), ' '), ' box_con ')]//dd)[self::a[@href] or .//a[@href]]");
  assert.match(converted.chapterContent.content, /new RegExp\("广告\.\*"/);
  assert.equal(converted.chapterContent.nextPageUrl, "//a[contains(normalize-space(.), '下一页')]/@href");
  assert.deepEqual(Object.keys(converted.bookWorld), ["玄幻", "都市"]);
  assert.doesNotMatch(JSON.stringify(converted), /(^|[^|])\|@js:/);
  assert.equal(warnings.length, 0);
});

test("相同规则更换站名和域名不会改变转换策略", () => {
  const makeSource = (bookSourceName, bookSourceUrl) => ({
    bookSourceName,
    bookSourceUrl,
    searchUrl: "/search?q={{key}}&page={{page}}",
    exploreUrl: "分类::/list?page={{page}}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href", coverUrl: "img@src" },
    ruleExplore: { bookList: ".book", name: "a@text", bookUrl: "a@href", coverUrl: "img@src" },
    ruleBookInfo: { name: "h1@text", coverUrl: ".cover@src" },
    ruleToc: { chapterList: ".chapters a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "article@text" },
  });
  const first = convertLegado(makeSource("站点甲", "https://alpha.example")).sources["站点甲"];
  const second = convertLegado(makeSource("站点乙", "https://beta.example")).sources["站点乙"];
  const normalize = (value, name, host) => JSON.parse(
    JSON.stringify(value).replaceAll(name, "SOURCE_NAME").replaceAll(host, "SOURCE_HOST"),
  );
  assert.deepEqual(
    normalize(first, "站点甲", "https://alpha.example"),
    normalize(second, "站点乙", "https://beta.example"),
  );
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
  assert.equal(convertRule("title", { responseType: "json" }), "title");
  assert.equal(convertRule("content", { responseType: "json" }), "content");
  assert.equal(convertRule("a@href", { responseType: "json" }), "//a/@href");
});

test("JSON 字段拼接 URL 不会把字符串中的 book 子域误判为阅读变量", () => {
  const source = {
    bookSourceName: "字段 URL 拼接",
    bookSourceUrl: "https://api.example.com",
    searchUrl: "/search?key={{key}}",
    ruleSearch: {
      bookList: "$.data[*]",
      name: "$.title",
      bookUrl: '$.book_id@js:"https://book.example.com/chapter_list/" + result + ".txt"',
    },
    ruleBookInfo: {},
    ruleToc: {
      chapterList: "$.[*]",
      chapterName: "$.title",
      chapterUrl: "$.url",
    },
    ruleContent: { content: "$..content" },
  };

  const converted = convertLegado(source).sources["字段 URL 拼接"];
  assert.match(converted.searchBook.detailUrl, /^book_id\|\|@js:/);
  assert.match(converted.searchBook.detailUrl, /https:\/\/book\.example\.com\/chapter_list\//);
  assert.match(converted.searchBook.detailUrl, /return/);
  assert.equal(convertRule("$.[*]", { responseType: "json" }), ".");
  assert.equal(convertRule("$[*]", { responseType: "json" }), ".");
  assert.equal(convertRule("$", { responseType: "json" }), ".");
});

test("单花括号 JSON 章节字段编译为完整 URL 模板", () => {
  const source = {
    bookSourceName: "单花括号章节 URL",
    bookSourceUrl: "https://api.example.com",
    searchUrl: "/search?key={{key}}",
    ruleSearch: { bookList: "$.data[*]", name: "$.title", bookUrl: "$.toc" },
    ruleBookInfo: {},
    ruleToc: {
      chapterList: "$.[*]",
      chapterName: "$.title",
      chapterUrl: "https://book.example.com/chapter/{$.bookId}_{$.chapterId}.txt?md5={$.content_md5}",
    },
    ruleContent: { content: "$..content" },
  };
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
  }).sources["单花括号章节 URL"];
  const plan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1]);

  assert.equal(
    plan.fields.url.urlTemplate,
    "https://book.example.com/chapter/{{bookId}}_{{chapterId}}.txt?md5={{content_md5}}",
  );
});

test("CSS、阅读链式选择器和分页选择器转换为 XPath", () => {
  assert.equal(convertRule("id.info@tag.p.0@a@text"), "//*[@id='info']//p[1]//a/text()");
  assert.equal(
    convertRule(".txt-list > li:nth-child(n+2)"),
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' txt-list ')]/li[position() >= 2]",
  );
  assert.equal(convertRule("tbody>tr!0"), "//tbody/tr[position() > 1]");
  assert.equal(
    convertRule(".l li[0:-1]"),
    "(.//*[contains(concat(' ', normalize-space(@class), ' '), ' l ')]//li)[position() >= 1 and position() <= last() - 1]",
  );
  assert.equal(convertRule('##<a\\s*href="([^\"]+)"##$1###'), "//a/@href");
  assert.equal(convertRule("a.1@href"), "(.//a)[2]/@href");
  assert.equal(convertRule("a[1]@href"), "(.//a)[2]/@href");
  assert.equal(convertRule("tag.a.0:1:2@text"), "(.//a)[position() = 1 or position() = 2 or position() = 3]/text()");
});

test("相对属性 text/href 与 CSS 目录规则不会被误判为 JSON", () => {
  assert.equal(convertRule("text"), "/text()");
  assert.equal(convertRule("href"), "//@href");
  assert.equal(convertRule("@text"), "/text()");
  assert.equal(convertRule("@onclick"), "//@onclick");
  assert.equal(convertRule("a@text"), "//a/text()");
  assert.equal(convertRule(".book@onclick"), "//*[contains(concat(' ', normalize-space(@class), ' '), ' book ')]/@onclick");
  assert.equal(
    convertRule("@css:p.dec>a@href"),
    "//p[contains(concat(' ', normalize-space(@class), ' '), ' dec ')]/a/@href",
  );
  assert.equal(convertRule("@css:img@src"), "//img/@src");
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
  assert.equal(converted.chapterList.list, "(//a[contains(@href, '/read/')])[self::a[@href] or .//a[@href]]");
  assert.equal(converted.chapterList.title, ".");
  assert.equal(converted.chapterList.url, "//@href");
  assert.match(converted.bookDetail.tocUrl, /\/\/a\[contains/);
  assert.match(converted.bookDetail.tocUrl, /查看全部章节/);
  assert.match(converted.chapterList.requestInfo, /q\.tocUrl/);
  assert.ok(warnings.some((warning) => warning.field === "tocUrl"));
});

test("列表自定义属性中的正则捕获会安全提取详情 URL", () => {
  const plan = compileBookBridgePlan({
    responseFormatType: "html",
    list: "//*[contains(@class,'book')]",
    bookName: "//*[contains(@class,'title')]",
    detailUrl: "//@onclick||@js:\nreturn (result.match(/\\('(.*?)', '', ''\\)/)[1]);",
  });
  const output = executeBridgePlan([
    '<div class="book" onclick="openBook(\'/b/101.html\', \'\', \'\')">',
    '<span class="title">测试书</span></div>',
  ].join(""), "https://books.example/search", plan);
  assert.equal(output.data[0].url, "https://books.example/b/101.html");
});

test("GET/POST 请求模板转换", () => {
  assert.equal(
    convertRequest("/search/{{key}}/{{page}}").requestInfo,
    "/search/%@keyWord/%@pageIndex",
  );
  const post = convertRequest('/search,{"method":"post","body":"q={{key}}&offset={{page-1}}"}');
  assert.match(post.requestInfo, /"q": params\.keyWord/);
  assert.match(post.requestInfo, /"offset":\s*params\.pageIndex\s*-\s*1/);

  const jsonPost = convertRequest('/api/cate,{"method":"POST","body":"{\\"page\\":{\\"page\\":{{page}},\\"pageSize\\":10},\\"tag\\":\\"热血\\"}"}');
  assert.match(jsonPost.requestInfo, /let hp = JSON\.parse\(/);
  assert.match(jsonPost.requestInfo, /params\.pageIndex/);
  assert.match(jsonPost.requestInfo, /POST:true/);
  assert.match(jsonPost.requestInfo, /"Content-Type":\s*"application\/json"/);

  const branch = convertRequest("/tuijian<,/page/{{page}}>").requestInfo;
  const branchRequest = new Function("config", "params", branch.replace(/^@js:\s*/, ""));
  assert.equal(branchRequest({}, { pageIndex: 1 }).url, "/tuijian");
  assert.equal(branchRequest({}, { pageIndex: 3 }).url, "/tuijian/page/3");

  const headed = convertRequest('/api/list,{"headers":{"Referer":"https://example.com/","X-Requested-With":"XMLHttpRequest"}}');
  assert.deepEqual(headed.httpHeaders, {
    Referer: "https://example.com/",
    "X-Requested-With": "XMLHttpRequest",
  });

  const cleanCookie = convertRequest('{{url=source.getKey();cookie.removeCookie(url);java.put("url",url)}}/search,{"method":"POST","body":"keyword={{key}}"}').requestInfo;
  assert.doesNotMatch(cleanCookie, /source\.|cookie\.|java\./);
  assert.match(cleanCookie, /"keyword": params\.keyWord/);
  assert.match(cleanCookie, /POST:true/);

  const jsCookiePrefix = convertRequest('@js:cookie.removeCookie(source.key);</js>/search/index.php,{"method":"POST","body":"q={{key}}","charset":"gbk"}');
  assert.doesNotMatch(jsCookiePrefix.requestInfo, /<\/js>|cookie\.|source\./);
  assert.match(jsCookiePrefix.requestInfo, /"q": params\.keyWord/);
  assert.equal(jsCookiePrefix.requestParamsEncode, "2147485234");

  const taggedCookiePrefix = convertRequest('<js>cookie.removeCookie(source.key);</js> https://example.com/search,{"method":"POST","body":"q={{key}}"}');
  assert.doesNotMatch(taggedCookiePrefix.requestInfo, /<js>|cookie\.|source\./);
  assert.match(taggedCookiePrefix.requestInfo, /https:\/\/example\.com\/search/);

  const gbkKeyword = convertRequest('/search?word={{java.encodeURI(key,"GBK")}}&page={{page}}').requestInfo;
  assert.doesNotMatch(gbkKeyword, /java\.|\{\{/);
  assert.match(gbkKeyword, /params\.keyWord/);

  const mirrorFallback = convertRequest('{{source.getVariable()?source.getVariable():source.getKey()}}/s.php,{"method":"POST","body":"s={{key}}"}').requestInfo;
  assert.doesNotMatch(mirrorFallback, /source\.|\{\{/);
  assert.match(mirrorFallback, /config\.host/);

  const trimmedMirrorFallback = convertRequest('{{String(source.getVariable()!=""?source.getVariable():source.getKey()).replace(/\\\/$/, "")}}/search?q={{key}}').requestInfo;
  assert.doesNotMatch(trimmedMirrorFallback, /source\.|\{\{/);
  assert.match(trimmedMirrorFallback, /config\.host/);

  const t2sSearch = convertRequest('/search?keyword={{java.t2s(key)}}&page={{page}}').requestInfo;
  assert.doesNotMatch(t2sSearch, /java\.t2s|\{\{/);
  assert.match(t2sSearch, /params\.keyWord/);
  assert.match(t2sSearch, /params\.pageIndex/);

  const portableJsonPost = convertRequest(`@js:
var query = key;
var offset = (page - 1) * 20;
var limit = 20;
var endpoint = 'https://api.example/search';
var payload = JSON.stringify({query: query, offset: offset, limit: limit});
var signed = privateSignHelper(endpoint, payload);
signed['X-Signature'] = 'private';
endpoint + ',{"method":"POST","body":' + JSON.stringify(payload) + ',"headers":' + JSON.stringify(signed) + '}'`);
  assert.equal(hasUnsupportedLegadoRuntime(portableJsonPost.requestInfo), false);
  assert.doesNotMatch(portableJsonPost.requestInfo, /privateSignHelper|signed|\bkey\b|\bpage\b/);
  const portableRequest = new Function("config", "params", "result", portableJsonPost.requestInfo.replace(/^@js:\s*/, ""));
  assert.deepEqual(portableRequest({}, { keyWord: "测试", pageIndex: 3 }, ""), {
    url: "https://api.example/search",
    POST: true,
    httpParams: { query: "测试", offset: 40, limit: 20 },
    httpHeaders: { "Content-Type": "application/json; charset=utf-8" },
  });
});

test("搜索与条目 MD5 请求头签名共用通用请求适配器", () => {
  const signed = (body, endpoint) => `<js>
    body = ${body};
    url = "${endpoint}?"+body;
    sign = java.md5Encode(body+"test-secret");
    headers = {"headers":{"signature":String(sign)}};
    url+","+JSON.stringify(headers)
  </js>`;
  const source = {
    bookSourceName: "签名音频 API",
    bookSourceUrl: "https://api.example",
    bookSourceType: 1,
    searchUrl: signed('"keyword="+key+"&page="+page', "https://api.example/search"),
    ruleSearch: {
      bookList: "$.data.list[*]",
      name: "$.name",
      bookUrl: signed('"album_id={{$.album_id}}"', "https://api.example/album"),
    },
    ruleToc: { chapterList: "$.tracks[*]", chapterName: "$.name", chapterUrl: "$.src" },
    ruleContent: {},
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["签名音频 API"];
  assert.match(converted.searchBook.requestInfo, /\/adapter\/request\?plan=/);
  const bridgeToken = converted.searchBook.requestInfo.match(/\/adapter\/books\?plan=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(bridgeToken);
  const bridge = decodeBridgePlan(bridgeToken);
  assert.equal(bridge.fields.url.selector, "$.album_id");
  assert.match(bridge.fields.url.matchTemplate.prefix, /\/adapter\/request\?plan=/);
});

test("嵌套 JSON 递归字段保留在绝对详情 URL 模板中", () => {
  const source = {
    bookSourceName: "嵌套详情 API",
    bookSourceUrl: "https://api.example",
    bookSourceType: 1,
    searchUrl: "/search?key={{key}}",
    ruleSearch: {
      bookList: "$.data.items[*]",
      name: "$.album.title",
      bookUrl: "https://api.example/tracks?albumId={{$..albumId}}&page=1",
    },
    ruleToc: { chapterList: "$.tracks[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: {},
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["嵌套详情 API"];
  const token = converted.searchBook.requestInfo.match(/\/adapter\/books\?plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(token);
  assert.match(plan.fields.url.selector, /^@json-recursive:/);
  assert.equal(plan.fields.url.urlTemplate, "https://api.example/tracks?albumId={{albumId}}&page=1");
  const output = executeBridgePlan(JSON.stringify({ data: { items: [{ album: { title: "A", albumId: 42 } }] } }),
    "https://api.example/search", plan, { limit: 2 });
  assert.equal(output.data[0].url, "https://api.example/tracks?albumId=42&page=1");
  const largeId = executeBridgePlan(JSON.stringify({ data: { items: [{
    album: { title: "B", albumId: 2191110586031407000, albumIdStr: "2191110586031406999" },
  }] } }), "https://api.example/search", plan, { limit: 2 });
  assert.equal(largeId.data[0].url, "https://api.example/tracks?albumId=2191110586031406999&page=1");
});

test("JSON POST 搜索的嵌套 concat 列表静态展开且保留可执行详情 URL", () => {
  const source = {
    bookSourceName: "嵌套音频 API",
    bookSourceUrl: "描述性源地址",
    bookSourceGroup: "音频",
    bookSourceType: 1,
    searchUrl: `@js:
var query = key;
var offset = (page - 1) * 20;
var endpoint = 'https://api.example/search';
var body = JSON.stringify({query: query, offset: offset});
var headers = makePrivateHeaders(endpoint, body);
endpoint + ',{"method":"POST","body":' + JSON.stringify(body) + ',"headers":' + JSON.stringify(headers) + '}'`,
    ruleSearch: {
      checkKeyWord: "测试",
      bookList: `<js>
let response = JSON.parse(result);
let books = [];
for (let group of response.data.groups) {
  if (group.items) books = books.concat(group.items);
}
JSON.stringify(books)
</js>$[*]`,
      name: "$.title",
      bookUrl: "https://api.example/detail?book_id={{$.book_id}}",
    },
    ruleBookInfo: { name: "$.data[0].title" },
    ruleToc: { chapterList: "$.chapters[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: { content: "$.url" },
  };
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
    omitNonPortable: true,
  }).sources["嵌套音频 API"];
  assert.ok(converted);
  assert.equal(converted.searchBook.list, "data/groups/items");
  assert.equal(typeof converted.searchBook.detailUrl, "string");
  assert.match(converted.searchBook.detailUrl, /result\.book_id/);
  assert.deepEqual(validateXiangseSource(converted), { ok: true, errors: [] });
});

test("章节脚本的多字段静态拼接编译为完整 URL 模板", () => {
  const plan = compileChapterBridgePlan({
    host: "https://api.example",
    responseFormatType: "json",
    list: "data",
    title: "chapterName",
    url: '@js: return ("https://cdn.example/segment/" + String(result.bookId) + "_" + String(result.chapterId) + ".txt?md5=" + String(result.content_md5));',
  });
  assert.deepEqual(plan.fields.url, {
    selector: "bookId",
    replacements: [],
    hostPrefix: false,
    matchTemplate: null,
    urlTemplate: "https://cdn.example/segment/{{bookId}}_{{chapterId}}.txt?md5={{content_md5}}",
  });
  const output = executeBridgePlan(JSON.stringify({
    data: [{ chapterName: "第一章", bookId: 42, chapterId: 7, content_md5: "a1b2" }],
  }), "https://api.example/menu", plan);
  assert.equal(output.data[0].url, "https://cdn.example/segment/42_7.txt?md5=a1b2");

  const unsafe = compileChapterBridgePlan({
    host: "https://api.example",
    responseFormatType: "json",
    list: "data",
    title: "chapterName",
    url: '@js: return "https://cdn.example/" + String(result.bookId) + sign(result.chapterId);',
  });
  assert.equal(unsafe.fields.url.selector, "bookId");
  assert.equal(unsafe.fields.url.urlTemplate, undefined);
});

test("JSONPath 数组索引并集保留所选列表项", () => {
  const plan = compileBookBridgePlan({
    host: "https://api.example",
    responseFormatType: "json",
    list: "Novels[0,2]",
    bookName: "NovelName",
    detailUrl: "NovelID",
  });
  const output = executeBridgePlan(JSON.stringify({ Novels: [
    { NovelName: "第一本", NovelID: 1 },
    { NovelName: "第二本", NovelID: 2 },
    { NovelName: "第三本", NovelID: 3 },
  ] }), "https://api.example/search", plan);
  assert.deepEqual(output.data.map((book) => book.name), ["第一本", "第三本"]);
});

test("JSON 绝对封面 URL 模板展开字段并保留路径分隔符", () => {
  const plan = compileBookBridgePlan({
    host: "https://api.example",
    responseFormatType: "json",
    list: "Novels",
    bookName: "NovelName",
    detailUrl: "NovelID",
    cover: "https://img.example/covers/{$.NovelCover}",
  });
  const output = executeBridgePlan(JSON.stringify({ Novels: [{
    NovelName: "测试书",
    NovelID: 1,
    NovelCover: "2026/05/封面 one.jpg",
  }] }), "https://api.example/search", plan);
  assert.equal(output.data[0].cover, "https://img.example/covers/2026/05/%E5%B0%81%E9%9D%A2%20one.jpg");
});

test("阅读请求 JavaScript 的裸 page/key 与末尾表达式会编译为香色返回值", () => {
  const paged = convertRequest('@js:config.host + "/list?q=" + key + "&page=" + page').requestInfo;
  assert.match(paged, /return \(/);
  assert.match(paged, /params\.keyWord/);
  assert.match(paged, /params\.pageIndex/);
  assert.equal(hasUnsupportedLegadoRuntime(paged), false);
  assert.equal(new Function("config", "params", "result", paged.replace(/^@js:\s*/, ""))(
    { host: "https://example.com" },
    { keyWord: "书", pageIndex: 3 },
    "",
  ), "https://example.com/list?q=书&page=3");

  assert.equal(hasUnsupportedLegadoRuntime("@js:if (result) result.trim();"), true);
  assert.equal(hasUnsupportedLegadoRuntime('@js:return String(result).replace(/page|key/g, "");'), false);
  assert.equal(hasUnsupportedLegadoRuntime('@js:return String(result) + page;'), true);
  assert.equal(hasUnsupportedLegadoRuntime('@js:function decode(value, key) { return key + value; } return decode(result, "x");'), false);

  const sideEffect = convertRequest("@js:\nvar su = source.getKey();\nvar body = 'keyword=' + key;\nvar postUrl = su + '/search/,' + JSON.stringify({'method': 'POST', 'body': String(body)});\njava.put('url', postUrl);\npostUrl;").requestInfo;
  assert.doesNotMatch(sideEffect, /source\.|cookie\.|java\./);
  assert.equal(hasUnsupportedLegadoRuntime(sideEffect), false);
});

test("源变量默认分支、私有辅助库和末尾注释不会阻断静态请求", () => {
  const mirror = convertRequest(`@js:
var options = {};
try { options = JSON.parse(source.getVariable()); } catch (e) { options = {}; }
var origin = options.custom ? options.custom : "https://mirror.example";
try { java.log("selected " + origin); } catch (e) {}
origin + "/search?q=" + encodeURIComponent(key) + "&page=" + page
// shared-source mirror note`).requestInfo;
  assert.equal(hasUnsupportedLegadoRuntime(mirror), false);
  assert.equal(new Function("config", "params", "result", mirror.replace(/^@js:\s*/, ""))(
    { host: "https://source.example" },
    { keyWord: "测试", pageIndex: 4 },
    "",
  ), "https://mirror.example/search?q=%E6%B5%8B%E8%AF%95&page=4");

  const helper = convertRequest(`@js:
eval(String(source.bookSourceComment));
\`${"${host}"}/search?keyword=${"${key}"}&page=${"${page}"}\`
`).requestInfo;
  assert.equal(hasUnsupportedLegadoRuntime(helper), false);
  assert.equal(new Function("config", "params", "result", helper.replace(/^@js:\s*/, ""))(
    { host: "https://source.example" },
    { keyWord: "book", pageIndex: 2 },
    "",
  ), "https://source.example/search?keyword=book&page=2");
});

test("单花括号 JSON 字段 URL 和安全的 @put/@get 选择器会被统一编译", () => {
  assert.match(convertRule("https://api.example/book/{$.id}"), /result\.id/);
  const source = structuredClone(sampleSource);
  source.bookSourceName = "状态规则测试";
  source.ruleSearch.name = "a@text@put:{u:\"a@href\"}";
  source.ruleSearch.bookUrl = "@get:{u}";
  source.ruleExplore.name = "a@text@put:{u:\"a@href\"}";
  source.ruleExplore.bookUrl = "@get:{u}";
  source.ruleBookInfo = {
    init: '@put:{n:"[property$=book_name]@content",a:"[property$=author]@content"}',
    name: "@get:{n}",
    author: "@get:{a}",
  };
  const { sources, skipped } = convertLegado(source, { omitNonPortable: true });
  const converted = sources["状态规则测试"];
  assert.deepEqual(skipped, []);
  assert.equal(converted.searchBook.detailUrl, "//a/@href");
  assert.match(converted.bookDetail.bookName, /book_name/);
  assert.match(converted.bookDetail.author, /author/);
  assert.doesNotMatch(JSON.stringify(converted), /@(?:put|get):|\{\$\./i);
});

test("XBS 加解密无损往返", () => {
  const value = { "示例书源": { sourceName: "示例书源", enable: 1 } };
  const xbs = encodeXbs(value);
  assert.equal(xbs.length % 4, 0);
  assert.deepEqual(JSON.parse(decodeXbs(xbs).toString("utf8")), value);
});

test("香色结构校验会过滤转换后仍不可执行的源", () => {
  const warnings = [];
  const skipped = [];
  const { sources } = filterValidXiangseSources({
    坏源: {
      sourceName: "坏源",
      sourceUrl: "",
      sourceType: "text",
      miniAppVersion: "1.0.0",
      bookWorld: {},
      searchBook: { actionID: "searchBook", host: "", parserID: "DOM" },
      bookDetail: { actionID: "bookDetail", host: "", parserID: "DOM" },
      chapterList: { actionID: "chapterList", host: "", parserID: "DOM" },
      chapterContent: { actionID: "chapterContent", host: "", parserID: "DOM", content: "x|@js:return result;" },
    },
  }, { warnings, skipped, stage: "test" });

  assert.deepEqual(sources, {});
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /香色结构校验失败/);
  assert.match(warnings[0].message, /已过滤无法导入\/执行/);
});

test("香色结构校验会用可用分类入口修复坏搜索动作", () => {
  const warnings = [];
  const skipped = [];
  const world = {
    actionID: "分类",
    host: "https://example.com",
    parserID: "DOM",
    responseFormatType: "html",
    requestInfo: "/list",
    list: "//a",
    bookName: ".",
    detailUrl: "//@href",
  };
  const { sources } = filterValidXiangseSources({
    搜索降级: {
      sourceName: "搜索降级",
      sourceUrl: "https://example.com",
      sourceType: "text",
      miniAppVersion: "1.0.0",
      bookWorld: { 分类: world },
      searchBook: { ...world, actionID: "searchBook", requestInfo: "@js:return java.ajax('/search')" },
      bookDetail: { actionID: "bookDetail", host: "https://example.com", parserID: "DOM", requestInfo: "/detail" },
      chapterList: { actionID: "chapterList", host: "https://example.com", parserID: "DOM", requestInfo: "/toc", list: "//a", title: ".", url: "//@href" },
      chapterContent: { actionID: "chapterContent", host: "https://example.com", parserID: "DOM", requestInfo: "/read", content: "//*[@id='content']" },
    },
  }, { warnings, skipped, stage: "test" });

  assert.equal(skipped.length, 0);
  assert.equal(sources["搜索降级"].searchBook.requestInfo, "/list");
  assert.equal(sources["搜索降级"].searchBook.actionID, "searchBook");
  assert.match(warnings[0].message, /已降级为可用分类入口/);
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

test("bookSourceType 映射为香色 sourceType，weight 不为 0", () => {
  const cases = [
    [0, "text"],
    [1, "audio"],
    [2, "comic"],
    [3, "text"],
    [4, "video"],
  ];
  for (const [bookSourceType, expect] of cases) {
    const source = structuredClone(sampleSource);
    source.bookSourceName = `类型${bookSourceType}`;
    source.bookSourceType = bookSourceType;
    source.customOrder = 0;
    source.exploreUrl = "";
    const { sources } = convertLegado([source]);
    const converted = sources[`类型${bookSourceType}`];
    assert.equal(converted.sourceType, expect);
    assert.notEqual(converted.weight, "0");
    assert.match(converted.weight, /^[1-9]\d*$/);
  }
});

test("旧类型号可按分组和正文能力自动识别图片源", () => {
  const source = {
    ...structuredClone(sampleSource),
    bookSourceName: "旧版图片源",
    bookSourceType: 3,
    bookSourceGroup: "图片书源",
    ruleContent: { content: ".reader img@html" },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["旧版图片源"];
  assert.equal(converted.sourceType, "comic");
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/images/);
  assert.ok(warnings.some((warning) => warning.message.includes("自动识别为 comic")));
  assert.ok(!warnings.some((warning) => warning.message.includes("文件源类型")));
});

test("默认不抬高香色最低版本，输入显式版本则保留", () => {
  const compatible = structuredClone(sampleSource);
  compatible.bookSourceName = "兼容版本";
  const explicit = structuredClone(sampleSource);
  explicit.bookSourceName = "指定版本";
  explicit.miniAppVersion = "2.53.2";
  const { sources } = convertLegado([compatible, explicit]);
  assert.equal(sources["兼容版本"].miniAppVersion, "1.0.0");
  assert.equal(sources["指定版本"].miniAppVersion, "2.53.2");
});

test("分类规则剥离阅读 java.timeFormat，保留可供香色匹配的 JSON 分类", () => {
  const source = {
    bookSourceName: "漫画分类",
    bookSourceUrl: "https://comic.example.com",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "$.data.list[*]", name: "$.title", bookUrl: "$.id",
      kind: "@js:var $ = result; $.tags + ',' + java.timeFormat($.editTime * 1000);",
    },
    ruleBookInfo: {
      init: "$.data", name: "$.title",
      kind: "@js:var $ = result; $.tags + ',' + java.timeFormat($.editTime * 1000);",
    },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content" },
  };
  const { sources, warnings } = convertLegado(source);
  const converted = sources["漫画分类"];
  assert.equal(converted.searchBook.cat, "tags");
  assert.equal(converted.bookDetail.cat, "data/tags");
  assert.ok(warnings.some((warning) => warning.field === "kind" && warning.message.includes("可移植字段")));
});

test("JSON 详情 init 前缀应用到分类回退和封面字段", () => {
  const source = {
    bookSourceName: "JSON 详情元素",
    bookSourceUrl: "https://audio.example.com",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.list", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: {
      init: "$.data.bookDetail",
      name: "$.name",
      kind: "{{$.type}}\n{{$.tags[*].name##忽略标签}}",
      coverUrl: "$.cover",
    },
    ruleToc: { chapterList: "$.list", chapterName: "$.name", chapterUrl: "$.url" },
    ruleContent: { content: "$.path" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const plan = decodeBridgePlan(
    sources["JSON 详情元素"].bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1],
  );
  const detail = executeBridgePlan(JSON.stringify({
    data: { bookDetail: { name: "节目", type: "广播剧", tags: [{ name: "忽略标签" }], cover: "/cover.jpg" } },
  }), "https://audio.example.com/detail/1", plan);
  assert.equal(plan.fields.cat.selector, "data/bookDetail/type||data/bookDetail/tags/name");
  assert.equal(plan.fields.cover.selector, "data/bookDetail/cover");
  assert.equal(detail.name, "节目");
  assert.equal(detail.cat, "广播剧");
  assert.equal(detail.cover, "https://audio.example.com/cover.jpg");
});

test("JSON API 详情与 HTML 目录通过通用桥接计划转换", () => {
  const source = {
    bookSourceName: "通用漫画 API", bookSourceUrl: "https://comic.example", bookSourceType: 2,
    searchUrl: "{{Url()}}/api/search?keyword={{key}}&page={{page}}",
    ruleSearch: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "{{Url()}}/api/comic/{{$.id}}" },
    ruleBookInfo: { init: "$.data", name: "$.title", intro: "@js:source.getVariable(); return result.intro;", tocUrl: "{{Url()}}/comic/{{$.id}}" },
    ruleToc: {
      chapterList: "#chapter-grid-container a", chapterName: "[class$=\"name\"]@text",
      chapterUrl: "href##^.*?(\\d+)$##/api/comic/image/$1?page=1###",
    },
    ruleContent: {
      content: "#content",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0123456789abcdef0123456789abcdef'); return java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv);",
    },
    ruleExplore: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "{{Url()}}/api/comic/{{$.url##[^\\d]}}" },
    exploreUrl: [{ title: "热血", url: "{{Get('url')}}/api/cate/hotblooded,{\"method\":\"POST\",\"body\":\"{\\\"page\\\":{\\\"page\\\":{{page}}}}\"}" }],
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://xs.example.com" });
  const converted = sources["通用漫画 API"];
  assert.equal(converted.searchBook.detailUrl, "url");
  const searchPlan = decodeBridgePlan(converted.searchBook.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1]);
  assert.equal(searchPlan.host, "https://comic.example");
  assert.deepEqual(
    executeBridgePlan(JSON.stringify({ data: { list: [{ id: 13827, title: "测试漫画" }] } }), "https://comic.example/api/search", searchPlan),
    { data: [{ name: "测试漫画", url: "https://comic.example/api/comic/13827" }], hasMore: false, offset: 0, pageSize: 40 },
  );
  assert.match(converted.chapterList.requestInfo, /adapter\/chapters\?plan=/);
  assert.equal(converted.chapterList.responseFormatType, "json");
  assert.equal(converted.chapterList.list, "$.data");
  assert.equal(converted.chapterList.url, "url");
  const chapterPlan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1]);
  assert.deepEqual(
    executeBridgePlan('<div id="chapter-grid-container"><a href="/comic/13827/2101951"><span class="name">第一话</span></a></div>', "https://comic.example/comic/13827", chapterPlan),
    { data: [{ title: "第一话", url: "https://comic.example/api/comic/image/2101951?page=1" }], hasMore: false, offset: 0, pageSize: 100 },
  );
  const attributeTitlePlan = {
    ...chapterPlan,
    fields: { ...chapterPlan.fields, title: "/@data-title" },
  };
  assert.deepEqual(
    executeBridgePlan('<div id="chapter-grid-container"><a data-title="属性标题" href="/comic/13827/2101951"></a></div>', "https://comic.example/comic/13827", attributeTitlePlan),
    { data: [{ title: "属性标题", url: "https://comic.example/api/comic/image/2101951?page=1" }], hasMore: false, offset: 0, pageSize: 100 },
  );
  assert.equal(converted.bookDetail.tocUrl, undefined);
  assert.equal(converted.bookDetail.responseFormatType, "json");
  assert.match(converted.bookDetail.requestInfo, /adapter\/detail\?plan=/);
  assert.equal(converted.bookDetail.bookName, "$.name");
  assert.equal(converted.bookDetail.desc, "$.desc");
  assert.equal(converted.chapterContent.responseFormatType, "json");
  assert.match(converted.chapterContent.requestInfo, /adapter\/images\?/);
  assert.match(converted.chapterContent.content, /^\$\.proxyUrls\|\|\$\.urls\|\|@js:/);
});

test("章节 URL 的 split + 模板赋值由安全桥接计划执行", () => {
  const plan = compileChapterBridgePlan({
    host: "https://comic.example",
    responseFormatType: "html",
    list: "//*[@id='chapters']//a",
    title: "/@data-title",
    url: '//@href|@js:\na=result.split("/")[3];b=`https://api.example/image/${a}?count=true`',
  });
  assert.deepEqual(
    executeBridgePlan(
      '<div id="chapters"><a href="/comic/42/9001" data-title="第一话"></a></div>',
      "https://comic.example/comic/42",
      plan,
    ),
    { data: [{ title: "第一话", url: "https://api.example/image/9001?count=true" }], hasMore: false, offset: 0, pageSize: 100 },
  );
});

test("JSON 数组递归路径和纯字段 URL 模板由桥接计划展开", () => {
  const plan = compileBookBridgePlan({
    host: "https://video.example",
    responseFormatType: "json",
    list: "blocks/models||models",
    bookName: '@js:\nif (String(result.status)==="public") result=String(result.username);',
    detailUrl: '@js:\nreturn ("https://video.example/model/" + String(result.username) + "/cam");',
  });
  assert.deepEqual(
    executeBridgePlan(JSON.stringify({ blocks: [{ models: [
      { username: "hidden", status: "private" },
      { username: "alice", status: "public" },
    ] }] }), "https://video.example", plan),
    { data: [{ name: "alice", url: "https://video.example/model/alice/cam" }], hasMore: false, offset: 0, pageSize: 40 },
  );
});

test("JSON 字段映射表达式生成章节标题和媒体 URL", () => {
  const plan = compileChapterBridgePlan({
    host: "https://video.example",
    responseFormatType: "json",
    list: "$..item",
    title: '@js:return (({"true":"在线","false":"离线"}[result.isLive] || result.isLive) + ({"public":"免费","private":"私密"}[result.status] || result.status));',
    url: '@js:return "https://cdn.example/hls/" + result.modelId + "/" + ({"public":"auto","private":"off"}[result.status] || result.status) + ".m3u8";',
  });
  assert.deepEqual(
    executeBridgePlan(
      JSON.stringify({ item: [{ modelId: 42, isLive: "true", status: "public" }] }),
      "https://video.example/broadcasts/42",
      plan,
    ),
    {
      data: [{ title: "在线免费", url: "https://cdn.example/hls/42/auto.m3u8" }],
      hasMore: false,
      offset: 0,
      pageSize: 100,
    },
  );
});

test("详情页捕获 ID 后请求目录 API 并组合章节字段", () => {
  const source = {
    bookSourceName: "两阶段漫画目录",
    bookSourceUrl: "https://comic.example",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: {
      name: "h1@text",
      tocUrl: '<js>let found=result.match(/data-mid="(.*?)"/); if(found){url="https://api.example/menu?mid="+found[1]+"&all=1"} url;</js>',
    },
    ruleToc: {
      chapterList: "#allchapterlist@a",
      chapterName: '##data\\-ct\\=\\"(.*?)\\"##$1###',
      chapterUrl: '##data\\-cs\\=\\"(.*?)\\"##$1###<js>url=`https://api.example/content?m=${java.get("stored")}&c=${result}`;</js>',
    },
    ruleContent: { content: "img@src" },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" })
    .sources["两阶段漫画目录"];
  const token = converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1];
  const plan = decodeBridgePlan(token);
  assert.deepEqual(plan.tocRequest, {
    pattern: 'data-mid="(.*?)"',
    prefix: "https://api.example/menu?mid=",
    suffix: "&all=1",
    capture: 1,
  });
  assert.deepEqual(
    executeBridgePlan(
      '<div id="allchapterlist"><a data-ct="第一话" data-cs="387"></a></div>',
      "https://api.example/menu?mid=18&all=1",
      plan,
    ).data,
    [{ title: "第一话", url: "https://api.example/content?m=18&c=387" }],
  );
});

test("桥接请求不会把阅读请求选项拼进目标 URL", () => {
  const source = {
    bookSourceName: "动态请求选项",
    bookSourceUrl: "https://book.example",
    searchUrl: '@js:return "https://book.example/search?q=" + key + \' ,{\\"headers\\":{\\"Referer\\":\\"https://book.example/\\"}}\'.trim();',
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "a@text", chapterUrl: "a@href" },
    ruleContent: { content: "#content@html" },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" })
    .sources["动态请求选项"];
  const script = converted.searchBook.requestInfo.replace(/^@js:\s*/, "");
  const output = new Function("config", "params", "result", script)(
    { host: "https://book.example" },
    { pageIndex: 1, keyWord: "demo", queryInfo: {} },
    "",
  );
  const target = decodeURIComponent(new URL(output).searchParams.get("url"));
  assert.equal(target, "https://book.example/search?q=demo");
});

test("详情桥接把 HTML 元数据归一为香色 JSON 字段", () => {
  const plan = compileDetailBridgePlan({
    host: "https://book.example",
    responseFormatType: "html",
    bookName: "//h1",
    author: "//*[@class='author']",
    cover: "//img/@src",
  });
  assert.deepEqual(
    executeBridgePlan(
      '<h1>测试书</h1><span class="author">作者甲</span><img src="/cover.jpg">',
      "https://book.example/detail/1",
      plan,
    ),
    { name: "测试书", author: "作者甲", cover: "https://book.example/cover.jpg" },
  );
});

test("深度预检可以限制桥接结果数量而不遍历完整大目录", () => {
  const plan = compileChapterBridgePlan({
    host: "https://example.com",
    responseFormatType: "html",
    list: "//a",
    title: "/text()",
    url: "/@href",
  });
  const html = Array.from({ length: 2000 }, (_, index) => `<a href="/${index}">第 ${index} 章</a>`).join("");
  assert.deepEqual(executeBridgePlan(html, "https://example.com", plan, { limit: 1 }), {
    data: [{ title: "第 0 章", url: "https://example.com/0" }],
    hasMore: true,
    offset: 0,
    pageSize: 1,
  });
});

test("正文桥接输出纯文本，去掉 p/br 等 HTML 标签", () => {
  assert.equal(
    htmlToPlainText("<p>第一段</p><p>第二段<br/>续行</p>"),
    "第一段\n第二段\n续行",
  );
  const plan = compileTextBridgePlan({
    host: "https://novel.example",
    responseFormatType: "html",
    content: "//*[@id='content']",
  });
  const page = `<html><body><div id="content"><p>你好&nbsp;世界</p><p>第二段</p></div></body></html>`;
  const output = executeBridgePlan(page, "https://novel.example/chapter/1", plan);
  assert.equal(output.content, "你好 世界\n第二段");
  assert.doesNotMatch(output.content, /<p>/i);
});

test("桥接按 offset/limit 分页，而不是丢弃后续条目", () => {
  const bookPlan = compileBookBridgePlan({
    host: "https://example.com",
    responseFormatType: "html",
    list: "//a",
    bookName: "/text()",
    detailUrl: "/@href",
  });
  const bookHtml = Array.from({ length: 90 }, (_, index) => `<a href="/b/${index}">书 ${index}</a>`).join("");
  const page1 = executeBridgePlan(bookHtml, "https://example.com", bookPlan, { limit: 20, offset: 0 });
  const page2 = executeBridgePlan(bookHtml, "https://example.com", bookPlan, { limit: 20, offset: 20 });
  const page5 = executeBridgePlan(bookHtml, "https://example.com", bookPlan, { limit: 20, offset: 80 });
  assert.equal(page1.data.length, 20);
  assert.equal(page1.data[0].name, "书 0");
  assert.equal(page1.hasMore, true);
  assert.equal(page2.data[0].name, "书 20");
  assert.equal(page2.hasMore, true);
  assert.equal(page5.data.length, 10);
  assert.equal(page5.data[0].name, "书 80");
  assert.equal(page5.hasMore, false);

  const chapterPlan = compileChapterBridgePlan({
    host: "https://example.com",
    responseFormatType: "html",
    list: "//a",
    title: "/text()",
    url: "/@href",
  });
  const chapterHtml = Array.from({ length: 250 }, (_, index) => `<a href="/c/${index}">第 ${index} 章</a>`).join("");
  const chapters = executeBridgePlan(chapterHtml, "https://example.com", chapterPlan, {
    limit: 100,
    offset: 100,
  });
  assert.equal(chapters.data.length, 100);
  assert.equal(chapters.data[0].title, "第 100 章");
  assert.equal(chapters.hasMore, true);
});

test("章节桥接满页时 hasMore 为 true，避免上游分页目录停在第一页", () => {
  const plan = compileChapterBridgePlan({
    host: "https://audio.example",
    responseFormatType: "json",
    list: "list",
    title: "name",
    url: {
      selector: "id",
      urlTemplate: "https://audio.example/play?id={{id}}",
    },
  });
  const list = Array.from({ length: 50 }, (_, i) => ({ name: `第${i + 1}集`, id: i + 1 }));
  const page = executeBridgePlan(
    JSON.stringify({ list, sections: 966 }),
    "https://audio.example/ajax/getBookMenu?bookId=42&pageNum=1&pageSize=50",
    plan,
    { limit: 50 },
  );
  assert.equal(page.data.length, 50);
  assert.equal(page.hasMore, true);
  const short = executeBridgePlan(
    JSON.stringify({ list: list.slice(0, 16), sections: 966 }),
    "https://audio.example/ajax/getBookMenu?bookId=42&pageNum=20&pageSize=50",
    plan,
    { limit: 50 },
  );
  assert.equal(short.data.length, 16);
  assert.equal(short.hasMore, false);
});

test("章节桥接会把倒序目录排成从小到大", () => {
  const chapterPlan = compileChapterBridgePlan({
    host: "https://example.com",
    responseFormatType: "html",
    list: "//a",
    title: "/text()",
    url: "/@href",
  });
  const reverseHtml = Array.from({ length: 12 }, (_, index) => {
    const number = 12 - index;
    return `<a href="/c/${number}">第 ${number} 章</a>`;
  }).join("");
  const page = executeBridgePlan(reverseHtml, "https://example.com", chapterPlan, { limit: 5, offset: 0 });
  assert.deepEqual(page.data.map((item) => item.title), [
    "第 1 章",
    "第 2 章",
    "第 3 章",
    "第 4 章",
    "第 5 章",
  ]);
  assert.equal(page.hasMore, true);
  const page2 = executeBridgePlan(reverseHtml, "https://example.com", chapterPlan, { limit: 5, offset: 5 });
  assert.equal(page2.data[0].title, "第 6 章");
});

test("章节桥接展开按卷嵌套的 JSON 章节数组", () => {
  const plan = compileChapterBridgePlan({
    host: "https://api.example",
    responseFormatType: "json",
    list: "data/volumes",
    title: "title",
    url: "url",
  });
  const output = executeBridgePlan(JSON.stringify({ data: { volumes: [
    [{ title: "第一章", url: "/1" }],
    [{ title: "第二章", url: "/2" }],
  ] } }), "https://api.example/toc", plan);
  assert.deepEqual(output.data.map(({ title, url }) => ({ title, url })), [
    { title: "第一章", url: "https://api.example/1" },
    { title: "第二章", url: "https://api.example/2" },
  ]);
});

test("阅读目录规则前导 - 会保留倒序语义且不破坏选择器", () => {
  const source = {
    bookSourceName: "倒序目录源",
    bookSourceUrl: "https://novel.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href", checkKeyWord: "测" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: {
      chapterList: "-//div[@id='list']//a",
      chapterName: "text",
      chapterUrl: "href",
    },
    ruleContent: { content: "#content@text" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const toc = sources["倒序目录源"].chapterList;
  assert.equal(toc.reverseChapters, undefined);
  assert.match(toc.requestInfo, /adapter\/chapters\?plan=/);
  const plan = decodeBridgePlan(String(toc.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.reverse, true);
  assert.match(plan.list, /\/\/div\[@id='list'\]/);
  assert.doesNotMatch(plan.list, /^-\/\//);
});

test("目录倒序切片和缺省锚点 URL 转换为可分页章节", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "倒序锚点目录";
  source.ruleToc = {
    chapterList: ".chapter-list@li[-1:0]@a",
    chapterName: "text",
  };
  source.ruleContent = {};
  source.bookSourceType = 2;
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
  }).sources["倒序锚点目录"];
  const token = converted.chapterList.requestInfo.match(/plan=([^&]+)/)?.[1];
  const plan = decodeBridgePlan(token);
  assert.equal(plan.reverse, true);
  assert.doesNotMatch(plan.list, /position\(\).*last\(\).*position\(\)/);
  assert.equal(plan.fields.url.selector, "./@href");
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/images\?/);
  assert.equal(validateXiangseSource(converted).ok, true);
});

test("JSON 目录倒序前缀 -$.data 会剥离并设置 reverse", () => {
  const source = {
    bookSourceName: "漫画倒序 JSON",
    bookSourceUrl: "https://m.comic.example",
    bookSourceType: 2,
    searchUrl: "/api/search?q={{key}}",
    ruleSearch: {
      bookList: "$.data[*]",
      name: "$.name",
      bookUrl: "https://m.comic.example/{{$.comic_id}}/",
      checkKeyWord: "测",
    },
    ruleBookInfo: {
      name: "$.name",
      tocUrl: "https://m.comic.example/api/getchapterlist?comic_id={{$.comic_id}}",
    },
    ruleToc: {
      chapterList: "-$.data.[*]",
      chapterName: "$.chapter_name",
      chapterUrl: "https://m.comic.example/api/chapter?comic_id={{$.comic_id}}&chapter_newid={{$.chapter_newid}}",
    },
    ruleContent: { content: "$.images" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const toc = sources["漫画倒序 JSON"].chapterList;
  const plan = decodeBridgePlan(String(toc.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.reverse, true);
  assert.equal(plan.list, "data");
  assert.doesNotMatch(plan.list, /^-\$/);
  assert.match(plan.fields.url.urlTemplate, /comic_id=\{\{comic_id\}\}/);
  const page = executeBridgePlan(
    JSON.stringify({
      data: [
        { chapter_name: "第2话", chapter_newid: "c2" },
        { chapter_name: "第1话", chapter_newid: "c1" },
      ],
    }),
    "https://m.comic.example/api/getchapterlist?comic_id=99",
    plan,
    { limit: 10, offset: 0 },
  );
  assert.equal(page.data.length, 2);
  assert.match(page.data[0].url, /comic_id=99/);
  assert.match(page.data[0].url, /chapter_newid=c1|chapter_newid=c2/);
});

test("自定义属性 init-data 转为 /@init-data 而非元素路径", () => {
  const source = {
    bookSourceName: "单曲听站",
    bookSourceUrl: "https://so.audio.example",
    bookSourceType: 1,
    searchUrl: "/?k={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href", checkKeyWord: "海" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: {
      chapterList: "tag.html",
      chapterName: "tag.h1@textNodes",
      chapterUrl: "class.jp-jplayer@init-data",
    },
    ruleContent: {},
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const plan = decodeBridgePlan(String(sources["单曲听站"].chapterList.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.match(String(plan.fields.url.selector), /jp-jplayer/);
  assert.match(String(plan.fields.url.selector), /@init-data/);
  assert.doesNotMatch(String(plan.fields.url.selector), /\/\/init-data/);
  const page = executeBridgePlan(
    `<html><body><h1>我的海洋</h1><div class="jp-jplayer" init-data="https://cdn.example/a.mp3"></div></body></html>`,
    "https://www.audio.example/listen/1",
    plan,
    { limit: 5, offset: 0 },
  );
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].url, "https://cdn.example/a.mp3");
});

test("仅有搜索无分类时仍可保留可移植源", () => {
  const source = {
    bookSourceName: "无分类可搜",
    bookSourceUrl: "https://novel.example.com",
    searchUrl: "/search?q={{key}}",
    // 无 exploreUrl、无 checkKeyWord → 不会伪造「搜索入口」分类
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "#list a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "#content@text" },
  };
  const { sources, skipped } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  assert.ok(sources["无分类可搜"]);
  assert.equal(Object.keys(sources["无分类可搜"].bookWorld || {}).length, 0);
  assert.ok(sources["无分类可搜"].searchBook?.list);
  assert.ok(!skipped.some((item) => item.source === "无分类可搜"));
});

test("桥接 URL 在 plan 与 url 之间插入分页参数后仍可被抽测识别", () => {
  const source = {
    bookSourceName: "分页桥接识别",
    bookSourceUrl: "https://page.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
      checkKeyWord: "测试",
    },
    exploreUrl: "首页::https://page.example.com/list.html",
    ruleExplore: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "class.list@tag.a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "id.content@text" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const world = Object.values(sources["分页桥接识别"].bookWorld)[0];
  assert.match(String(world.requestInfo), /\/adapter\/books\?plan=[A-Za-z0-9_-]+[^"'\\\s]*&url=/);
  assert.match(String(world.requestInfo), /slice=1/);
  // Old brittle regex required plan= immediately before &url= and would miss these sources.
  assert.doesNotMatch(String(world.requestInfo), /plan=[A-Za-z0-9_-]+&url=/);
});

test("无上游分页时桥接请求会注入 page/pageSize/slice 供客户端翻页", () => {
  const source = {
    bookSourceName: "无分页站",
    bookSourceUrl: "https://nopage.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
      checkKeyWord: "测试",
    },
    exploreUrl: "首页::https://nopage.example.com/list.html",
    ruleExplore: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "class.list@tag.a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "id.content@text" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const world = Object.values(sources["无分页站"].bookWorld)[0];
  assert.match(world.requestInfo, /page=%@pageIndex/);
  assert.match(world.requestInfo, /slice=1/);
  assert.match(world.requestInfo, /pageSize=20/);
  assert.equal(world.moreKeys.pageSize, 20);
  assert.ok(world.moreKeys.maxPage >= 200);
  const worldPlan = decodeBridgePlan(String(world.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(worldPlan.fields.cat.constant, "首页");
});
test("Mustache {{@sel}} 与 Get('url') 请求可转换", () => {
  assert.equal(
    convertRule("{{@class.video-title@text}}"),
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' video-title ')]/text()",
  );
  const multi = convertRule(
    "{{@class.novel-content@html}}\n{{@class.row thumb-overlay-albums@tag.img@data-original}}\n@js:\nreturn result;",
  );
  assert.match(multi, /novel-content/);
  assert.match(multi, /data-original/);
  assert.match(multi, /\|\|@js:/);
  assert.equal(
    convertRule("{{@css:.text-content1 .c-en@text||.text-content1@text}}"),
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' text-content1 ')]//*[contains(concat(' ', normalize-space(@class), ' '), ' c-en ')]/text()||//*[contains(concat(' ', normalize-space(@class), ' '), ' text-content1 ')]/text()",
  );
  assert.doesNotMatch(convertRule("{{@css:.text-content1@text}}"), /\/\/css/);

  const nestedTextSource = {
    bookSourceName: "嵌套正文",
    bookSourceUrl: "https://nested.example",
    searchUrl: "/search/{{key}}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapters a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "{{@css:.text-content1 .c-en@text||.text-content1@text}}" },
  };
  const nestedConverted = convertLegado(nestedTextSource, {
    imageProxyBase: "https://convert.example",
  }).sources["嵌套正文"];
  const nestedPlan = decodeBridgePlan(
    String(nestedConverted.chapterContent.requestInfo).match(/plan=([^&]+)/)[1],
  );
  assert.doesNotMatch(nestedPlan.fields.content.selector, /\/text\(\)/);
  const nestedOutput = executeBridgePlan(
    '<div class="text-content1"><div>第一段</div><p>第二段</p></div>',
    "https://nested.example/chapter/1",
    nestedPlan,
  );
  assert.match(nestedOutput.content, /第一段/);
  assert.match(nestedOutput.content, /第二段/);

  const req = convertRequest(
    "{{Get('url')}}/search/photos?search_query={{key}}&page={{page}}",
    { warn() {} },
  );
  assert.match(req.requestInfo, /config\.host/);
  assert.match(req.requestInfo, /params\.keyWord/);
  assert.match(req.requestInfo, /params\.pageIndex/);
  assert.match(req.requestInfo, /return \{/);
});

test("Mustache 字符串常量转换为香色可执行规则", () => {
  assert.equal(convertRule('{{"固定作者"}}'), '@js:\nreturn "固定作者";');
  assert.equal(convertRule("{{'固定分类'}}"), '@js:\nreturn "固定分类";');
});

test("漫画源保留 comic 类型，图片 URL 包成 img，并告警 imageDecode", () => {
  const source = {
    bookSourceName: "示例漫画",
    bookSourceUrl: "https://comic.example.com/",
    bookSourceType: 2,
    customOrder: 10,
    searchUrl: "{{Get('url')}}/search?q={{key}}&page={{page}}",
    loginUrl: "https://comic.example.com/login",
    ruleSearch: {
      bookList: ".list-item",
      name: ".video-title@text",
      bookUrl: "tag.a.0@href",
      coverUrl: "img@data-original||img@src",
    },
    ruleBookInfo: {
      name: "h1@text",
      tocUrl: "baseUrl",
    },
    ruleToc: {
      chapterList: ".reading",
      chapterName: "text",
      chapterUrl: "href##(.*)##$1/?shunt={{Get('shunt')}}",
    },
    ruleContent: {
      content: "{{@class.row@tag.img@data-original}}",
      imageDecode: "JavaImporter...",
      imageStyle: "FULL",
    },
  };
  const { sources, warnings } = convertLegado([source]);
  const converted = sources["示例漫画"];
  assert.equal(converted.sourceType, "comic");
  assert.match(converted.chapterList.requestInfo, /params\.queryInfo/);
  assert.equal(converted.bookDetail.tocUrl, undefined);
  assert.match(converted.searchBook.requestInfo, /config\.host/);
  assert.match(converted.chapterContent.content, /data-original/);
  assert.match(converted.chapterContent.content, /<img src=/);
  assert.match(converted.chapterList.url, /shunt=/);
  assert.doesNotMatch(converted.chapterList.url, /\{\{Get/);
  assert.ok(warnings.some((w) => w.field === "imageDecode"));
  assert.ok(warnings.some((w) => w.field === "loginUrl"));
});

test("可识别的 AES 图片规则通过公开代理改写为香色图片正文", () => {
  const source = {
    bookSourceName: "AES 漫画",
    bookSourceUrl: "https://api-comic.example/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "$.id" },
    ruleBookInfo: { name: "$.data.title" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "@js:JSON.parse(src).data.images.map(x => `<img src=\"${x.url}\">`).join('\\n');",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0123456789abcdef0123456789abcdef'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example.com/" });
  const content = sources["AES 漫画"].chapterContent.content;
  assert.match(content, /^\$\.proxyUrls\|\|\$\.urls\|\|@js:/);
  assert.match(content, /https:\/\/convert\.example\.com\/image\/aes-cbc-prefix-iv-[A-Za-z0-9_-]+\?url=/);
  assert.match(sources["AES 漫画"].chapterContent.requestInfo, /adapter\/images\?plan=/);
  assert.match(content, /JSON\.stringify\(\{urls:/);
  assert.match(content, /encodeURIComponent\(value\)/);
  assert.doesNotMatch(content, /<img src=/);
  assert.doesNotMatch(content, /source\.getVariable|JSON\.parse\(src\)/);
  assert.ok(warnings.some((warning) => warning.message.includes("图片解码代理")));
});

test("通用提取 jsLib 声明的 AES 图片解密参数", () => {
  const source = {
    bookSourceName: "jsLib AES 漫画",
    bookSourceUrl: "https://script-comic.example/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "img@data-src", imageDecode: "decode(result);" },
    jsLib: [
      'var key = "0123456789abcdef";',
      'var algorithm = "AES/CBC/PKCS5Padding";',
      'var layout = "slice(0,16)";',
      'function decode(value) { return value; }',
    ].join("\n"),
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example.com" });

  assert.match(
    sources["jsLib AES 漫画"].chapterContent.content,
    /\/image\/aes-cbc-prefix-iv-MDEyMzQ1Njc4OWFiY2RlZg\?url=/,
  );
});

test("参数完整的 ID 分块图片规则转换为参数化图片代理", () => {
  const source = {
    bookSourceName: "ID 分块漫画",
    bookSourceUrl: "https://tiles.example/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "{{@class.row@tag.img@data-original}}\n@js:var url = baseUrl; result;",
      imageDecode: "var bookId = 1; var imgId = 2; var ascii = 97; var num; if (Number(bookId) < 100) return result; if (Number(bookId) >= 200) { if (Number(bookId) > 300) num = (ascii % 8 + 1) * 2; else num = (ascii % 10 + 1) * 2; } else { num = 10; } var img = BitmapFactory.decodeByteArray(result, 0, result.length); var canvas = new Canvas(img);",
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example.com" });
  const content = sources["ID 分块漫画"].chapterContent.content;
  assert.match(content, /^\$\.proxyUrls\|\|\$\.urls\|\|@js:/);
  assert.match(content, /https:\/\/convert\.example\.com\/image\/id-md5-reverse-tiles-[A-Za-z0-9_-]+\?url=/);
  assert.match(content, /encodeURIComponent\(value\)/);
  assert.doesNotMatch(content, /baseUrl/);
  assert.match(sources["ID 分块漫画"].chapterContent.requestInfo, /params\.queryInfo/);
  assert.ok(warnings.some((warning) => warning.message.includes("id-md5-reverse-tiles")));
  const chapterList = sources["ID 分块漫画"].chapterList;
  assert.equal(chapterList.responseFormatType, "json");
  assert.match(sources["ID 分块漫画"].bookDetail.requestInfo, /params\.queryInfo/);
  assert.match(chapterList.requestInfo, /params\.queryInfo/);
  const requestFunction = new Function("config", "params", "result", chapterList.requestInfo.replace(/^@js:\s*/, ""));
  assert.match(
    requestFunction({ host: "https://tiles.example" }, { queryInfo: { detailUrl: "/album/1/中文" } }, "%@result"),
    /adapter\/chapters\?plan=.*url=https%3A%2F%2Ftiles\.example%2Falbum%2F1%2F%25E4%25B8%25AD%25E6%2596%2587/,
  );
  assert.doesNotMatch(
    requestFunction(
      { host: "https://tiles.example" },
      { queryInfo: { detailUrl: "/album/1/中文" } },
      "https://convert.example/adapter/detail?plan=stale",
    ),
    /adapter%2Fdetail/,
  );
  assert.equal(chapterList.list, "$.data");
  assert.equal(chapterList.title, "title");
  assert.equal(chapterList.url, "url");
});

test("MD5 分块倒序图片规则通过通用正文与解码代理转换", () => {
  const source = {
    bookSourceName: "脚本图片漫画",
    bookSourceUrl: "https://comic.example/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: '//script/text()@js:var urlReg = /\\\\"imageUrl\\\\":\\\\"(.+?)\\\\"/g; return ["<img src=\\"https://cdn.example/1.jpg\\">"];',
      imageDecode: 'if (src.indexOf("sr:1") == -1) return result; var decodedPath = java.base64Decode(path); var md5Str = java.md5Encode(decodedPath); var lastTwo = md5Str.slice(-2); var num = (parseInt(lastTwo, 16) % 7) + 3; var canvas = new Canvas(BitmapFactory.decodeByteArray(result, 0, result.length));',
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example.com" });
  const chapterContent = sources["脚本图片漫画"].chapterContent;
  assert.match(chapterContent.requestInfo, /\/adapter\/images\?plan=.*&url=/);
  assert.match(chapterContent.content, /\/image\/md5-reverse-tiles-7-3\?url=/);
  assert.ok(warnings.some((warning) => warning.message.includes("md5-reverse-tiles")));
});

test("动态分类数组脚本转换为香色可见的静态分类", () => {
  const source = {
    bookSourceName: "动态分类测试",
    bookSourceUrl: "https://catalog.example",
    bookSourceType: 2,
    exploreUrl: `@js:
      var categories = [
        ["全部", "/albums?page={{page}}"],
        ["单本", "/albums/single?page={{page}}"]
      ];
      JSON.stringify(categories);`,
    searchUrl: "{{Get('url')}}/search/photos?search_query={{key}}&page={{page}}",
    ruleSearch: {
      bookList: ".list-col||.list-item",
      name: ".video-title@text",
      author: ".author@text",
      bookUrl: "tag.a.0@href",
      coverUrl: "img@data-original||img@src",
    },
    ruleExplore: [],
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".reading", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".thumb-overlay-albums@img@data-original" },
  };
  const { sources } = convertLegado(source);
  const converted = sources["动态分类测试"];

  assert.deepEqual(Object.keys(converted.bookWorld), ["全部", "单本"]);
  assert.match(converted.bookWorld["全部"].requestInfo, /albums\?page=/);
  assert.match(converted.bookWorld["全部"].requestInfo, /%@pageIndex/);
  assert.equal(converted.bookWorld["全部"].moreKeys.pageSize, 10);
  assert.match(converted.bookWorld["全部"].list, /list-col/);
  assert.match(converted.bookWorld["全部"].bookName, /video-title/);
  assert.match(converted.bookWorld["全部"].detailUrl, /href/);
  assert.match(converted.bookWorld["全部"].author, /author/);
  assert.match(converted.bookDetail.requestInfo, /params\.queryInfo/);
  assert.doesNotMatch(JSON.stringify(converted.bookDetail), /java\.|Packages/);
  assert.doesNotMatch(JSON.stringify(converted.searchBook), /java\.|Packages/);
  assert.match(converted.chapterList.requestInfo, /params\.queryInfo/);
  assert.match(converted.chapterList.list, /reading/);
  assert.doesNotMatch(converted.chapterList.list, /java\.|book\.type/);
  assert.equal(converted.chapterList.title, ".");
  assert.equal(converted.chapterList.url, "//@href");
});

test("阅读 cookie 清理模板与 java.getString 正文可降级为香色请求和选择器", () => {
  const source = {
    bookSourceName: "Java DOM 文本测试",
    bookSourceUrl: "https://book.example.com",
    searchUrl: "{{cookie.removeCookie(source.key)}}/search.html,{\"method\":\"POST\",\"body\":\"q={{key}}\"}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "@js:var body=java.getString('.reader@p@html');result=body;" },
  };
  const { sources, warnings } = convertLegado(source);
  const converted = sources["Java DOM 文本测试"];
  assert.match(converted.searchBook.requestInfo, /POST:true/);
  assert.match(converted.searchBook.requestInfo, /search\.html/);
  assert.doesNotMatch(converted.searchBook.requestInfo, /removeCookie/);
  assert.match(converted.chapterContent.content, /reader/);
  assert.match(converted.chapterContent.content, /\/p/);
  assert.doesNotMatch(converted.chapterContent.content, /java\.getString/);
  assert.ok(warnings.some((warning) => warning.message.includes("cookie 清理表达式")));
  assert.ok(warnings.some((warning) => warning.message.includes("静态 DOM 选择器")));
});

test("发现页分组标题和同名分类不会相互覆盖", () => {
  const source = {
    bookSourceName: "分组发现测试",
    bookSourceUrl: "https://book.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content@html" },
    exploreUrl: "——热门——\n玄幻::/hot/{{page}}\n都市::/city/{{page}}\n——最新——\n玄幻::/new/{{page}}",
    ruleExplore: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
  };
  const { sources } = convertLegado(source);
  const world = sources["分组发现测试"].bookWorld;
  assert.deepEqual(Object.keys(world), ["热门·玄幻", "热门·都市", "最新·玄幻"]);
  assert.match(world["热门·玄幻"].requestInfo, /\/hot\//);
  assert.match(world["最新·玄幻"].requestInfo, /\/new\//);
});

test("以空 URL 的 title:: 行表示的发现分组会进入分类名称", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "空 URL 分组测试";
  source.exploreUrl = "小说::\n热门::/novel/{{page}}\n音乐::\n热门::/music/{{page}}";
  const { sources } = convertLegado(source);
  assert.deepEqual(Object.keys(sources["空 URL 分组测试"].bookWorld), ["小说·热门", "音乐·热门"]);
});

test("大量普通 GET 分类压缩为一个香色原生筛选动作", () => {
  const source = {
    bookSourceName: "大型分类测试",
    bookSourceUrl: "https://book.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content@html" },
    exploreUrl: Array.from({ length: 12 }, (_, index) => ({
      title: `分类 ${index + 1}`,
      url: `{{Get('url')}}/category/${index + 1}?page={{page}}`,
    })),
    ruleExplore: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
  };
  const { sources, warnings } = convertLegado(source);
  const world = sources["大型分类测试"].bookWorld;
  assert.deepEqual(Object.keys(world), ["分类"]);
  assert.match(world["分类"].moreKeys.requestFilters, /^_category$/m);
  assert.match(world["分类"].moreKeys.requestFilters, /^分类 1::\/category\/1\?page=__READ2XSGG_PAGE__$/m);
  assert.match(world["分类"].moreKeys.requestFilters, /分类 12::\/category\/12\?page=__READ2XSGG_PAGE__$/m);
  assert.match(world["分类"].requestInfo, /params\.filters\.category/);
  assert.match(world["分类"].requestInfo, /params\.pageIndex/);
  assert.doesNotMatch(world["分类"].moreKeys.requestFilters, /%@pageIndex/);
  assert.equal(world["分类"].moreKeys.pageSize, 10);
  assert.ok(warnings.some((warning) => warning.message.includes("压缩为香色 requestFilters")));
});

test("压缩分类中的重名项会生成唯一筛选标题", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "重名筛选测试";
  source.exploreUrl = Array.from({ length: 7 }, (_, index) => ({
    title: "热门",
    url: `/category/${index + 1}?page={{page}}`,
  }));
  const { sources } = convertLegado(source);
  const filters = sources["重名筛选测试"].bookWorld["分类"].moreKeys.requestFilters;
  assert.match(filters, /^热门::\/category\/1/m);
  assert.match(filters, /^热门 \(7\)::\/category\/7/m);
});

test("宽松 JSON 分类支持单引号、裸键、尾逗号和控制字符", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "宽松分类测试";
  source.exploreUrl = "[{title:'玄幻\u0000',url:'/fantasy?page={{page}}',},]";
  const { sources } = convertLegado(source);
  const world = sources["宽松分类测试"].bookWorld;
  assert.deepEqual(Object.keys(world), ["玄幻"]);
  assert.equal(world["玄幻"].requestInfo, "/fantasy?page=%@pageIndex");
});

test("动态发现配置无法编译时不会把发现选择器错误套到站点首页", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "动态分类拒绝首页兜底";
  source.exploreUrl = "@js:return java.ajax('/categories');";
  source.ruleSearch.checkKeyWord = "";
  const { sources, warnings } = convertLegado(source, { omitNonPortable: true });
  const converted = sources["动态分类拒绝首页兜底"];
  // 无可用分类时保留搜索链路，不再用发现选择器硬套站点首页。
  assert.ok(converted);
  assert.deepEqual(Object.keys(converted.bookWorld || {}), []);
  assert.ok(converted.searchBook?.list);
  assert.ok(warnings.some((warning) => /发现页依赖阅读 Android JavaScript|缺少可移植发现分类/.test(warning.message)));
});

test("从 @js 模板字符串中静态提取 title::url 发现分类", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "脚本内嵌分类";
  source.exploreUrl = `@js:
var inputData = \`全部榜单
最近更新::/zuixin/{{page}}.html
热门小说::/paihang/{{page}}.html
都市小说::/dushi/{{page}}.html\`;
JSON.stringify([]);`;
  source.ruleSearch.checkKeyWord = "";
  const { sources, warnings } = convertLegado(source, { omitNonPortable: true });
  const converted = sources["脚本内嵌分类"];
  assert.ok(converted);
  assert.ok(Object.keys(converted.bookWorld).length >= 3);
  assert.ok(warnings.some((item) => item.message.includes("静态提取")));
});

test("脚本内嵌分类的 pageSize 对齐页长且忽略装饰分组头", () => {
  const source = {
    bookSourceName: "内嵌分类分页",
    bookSourceUrl: "https://novel.example",
    searchUrl: "/i/sor.aspx?key={{key}}",
    ruleSearch: {
      bookList: ".item",
      name: "a.1@text",
      bookUrl: "a@href",
      coverUrl: "img@src",
    },
    ruleBookInfo: { name: "h1@a@text" },
    ruleToc: { chapterList: "#list@ul@li@a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".con@html" },
    ruleExplore: [],
    exploreUrl: `@js:
var inputData = \`°・*.☆ 全部榜单 ☆.*・°
最近更新::/zuixin/{{page}}.html
热门小说::/paihang/{{page}}.html
连载小说::/lianzai/{{page}}.html
完结小说::/wanjie/{{page}}.html
玄幻小说::/xuanhuan/{{page}}.html
都市小说::/dushi/{{page}}.html
历史小说::/lishi/{{page}}.html\`;
JSON.stringify([]);`,
  };
  const { sources } = convertLegado(source);
  const world = sources["内嵌分类分页"].bookWorld["分类"];
  assert.equal(world.moreKeys.pageSize, 10);
  assert.match(world.moreKeys.requestFilters, /^最近更新::\/zuixin\/__READ2XSGG_PAGE__\.html$/m);
  assert.doesNotMatch(world.moreKeys.requestFilters, /全部榜单·/);
  assert.doesNotMatch(sources["内嵌分类分页"].searchBook.requestInfo, /page=%@pageIndex/);
  assert.equal(sources["内嵌分类分页"].searchBook.moreKeys.pageSize, 20);
});

test("正文清理规则与既有后处理合并为单个香色 JavaScript", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "正文后处理合并";
  source.ruleContent = {
    content: ".content@text@js:return String(result).trim();",
    replaceRegex: ["广告", "推广"],
  };
  const { sources } = convertLegado(source);
  const content = sources["正文后处理合并"].chapterContent.content;
  assert.equal((content.match(/\|\|\s*@js:/gi) || []).length, 1);
  const script = content.slice(content.search(/@js:/i) + 4);
  assert.doesNotThrow(() => new Function("result", script));

  source.bookSourceName = "纯脚本正文后处理合并";
  source.ruleContent = {
    content: "@js:var data=JSON.parse(result); result=data.content;",
    replaceRegex: "广告",
  };
  const pure = convertLegado(source).sources["纯脚本正文后处理合并"].chapterContent.content;
  assert.equal((pure.match(/@js:/gi) || []).length, 1);
  assert.equal(hasUnsupportedLegadoRuntime(pure), false);
  assert.equal(new Function("config", "params", "result", pure.replace(/^@js:\s*/, ""))(
    {},
    {},
    '{"content":"正广告文"}',
  ), "正文");
});

test("纯脚本媒体正文包装保持单个香色 JavaScript", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "脚本视频正文";
  source.bookSourceType = 4;
  source.ruleContent = {
    content: "@js:var data=JSON.parse(result); result=data.url;",
  };
  const content = convertLegado(source).sources["脚本视频正文"].chapterContent.content;
  assert.equal((content.match(/@js:/gi) || []).length, 1);
  assert.equal(hasUnsupportedLegadoRuntime(content), false);
  const output = new Function("config", "params", "result", content.replace(/^@js:\s*/, ""))(
    { httpHeaders: {} },
    { queryInfo: {} },
    '{"url":"https://cdn.example/play.m3u8"}',
  );
  assert.equal(JSON.parse(output).url, "https://cdn.example/play.m3u8");
});

test("缺少发现页时使用搜索规则生成可选择的分类入口", () => {
  const source = {
    bookSourceName: "仅搜索源",
    bookSourceUrl: "https://search-only.example.com",
    searchUrl: "/search?q={{key}}&page={{page}}",
    ruleSearch: {
      checkKeyWord: "测试书名 | 备用书名",
      bookList: ".result",
      name: ".name@text",
      bookUrl: "a@href",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content@text" },
  };
  const { sources, warnings } = convertLegado(source);
  const entry = sources["仅搜索源"].bookWorld["搜索入口"];
  assert.ok(entry);
  assert.match(entry.requestInfo, /%E6%B5%8B%E8%AF%95%E4%B9%A6%E5%90%8D/);
  assert.equal(sources["仅搜索源"].searchBook._verifyKeyWord, "测试书名");
  assert.equal(entry.list, "//*[contains(concat(' ', normalize-space(@class), ' '), ' result ')]");
  assert.ok(warnings.some((warning) => warning.message.includes("生成分类入口")));
});

test("没有发现分类和测试关键词的搜索源不会伪造空分类", () => {
  const source = {
    bookSourceName: "空分类源",
    bookSourceUrl: "https://empty.example.com",
    searchUrl: "/search?q={{key}}&page={{page}}",
    ruleSearch: { bookList: ".result", name: ".name@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content@text" },
  };
  const { sources, skipped, warnings } = convertLegado(source, { omitNonPortable: true });
  const converted = sources["空分类源"];
  assert.ok(converted);
  assert.deepEqual(Object.keys(converted.bookWorld || {}), []);
  assert.ok(converted.searchBook?.list);
  assert.deepEqual(skipped, []);
  assert.ok(warnings.some((warning) => warning.message.includes("不再生成必为空的伪分类")));
});

test("有分类 URL 但发现规则为空时复用搜索列表规则", () => {
  const source = {
    bookSourceName: "图片分类复用",
    bookSourceUrl: "https://comic.example.com",
    bookSourceType: 2,
    exploreUrl: JSON.stringify([{ title: "美图", url: "/gallery?page={{page}}" }]),
    ruleExplore: {},
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: ".masonry-item",
      name: "h5@text",
      bookUrl: "a@href",
      coverUrl: "img@src",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "body", chapterName: '{{"正文"}}', chapterUrl: "" },
    ruleContent: { content: ".post-body@html" },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["图片分类复用"];
  const world = converted.bookWorld["美图"];
  assert.equal(world.responseFormatType, "json");
  assert.equal(world.list, "$.data");
  assert.equal(world.bookName, "name");
  assert.equal(world.detailUrl, "url");
  assert.match(world.requestInfo, /adapter\/books\?plan=/);
  assert.match(converted.chapterList.url, /params\.queryInfo/);
  assert.ok(warnings.some((warning) => warning.message.includes("搜索规则补齐")));
  assert.ok(warnings.some((warning) => warning.message.includes("当前详情页作为章节地址")));
});

test("发现核心字段依赖 Android Java 时逐字段回退搜索规则", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "发现字段回退";
  source.ruleExplore = {
    ...source.ruleExplore,
    name: "@js:return java.getString('.broken-name');",
    bookUrl: "@js:return source.getVariable();",
  };
  const { sources, warnings } = convertLegado(source, { omitNonPortable: true });
  const world = sources["发现字段回退"].bookWorld["玄幻"];
  assert.match(world.bookName, /\/\/dd\/\/h3\/\/a/);
  assert.equal(world.detailUrl, "//dd//h3//a/@href");
  assert.ok(warnings.some((warning) => warning.message.includes("已自动回退到可执行的搜索规则")));
});

test("全局请求头中的阅读 baseUrl 模板固化为源站地址", () => {
  const input = structuredClone(sampleSource);
  input.header = JSON.stringify({ Referer: "{{baseUrl}}", "X-Dropped": "{{unknown}}" });
  const { sources } = convertLegado(input);
  const converted = Object.values(sources)[0];
  assert.equal(converted.httpHeaders.Referer, "https://example.com");
  assert.equal(Object.hasOwn(converted.httpHeaders, "X-Dropped"), false);
  assert.doesNotMatch(JSON.stringify(converted.httpHeaders), /\{\{/);
});

test("HTML 详情独立目录链接通过通用跳转器请求", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "独立目录页";
  source.ruleBookInfo.tocUrl = '//span[text()="章节目录"]/parent::a/@href';
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const request = sources["独立目录页"].chapterList.requestInfo;
  assert.match(request, /convert\.example\/adapter\/chapters\?plan=/);
  assert.match(request, /encodeURIComponent\(u\)/);
});

test("目录跳转在移动模板中优先目录列表而不是点击阅读首章", () => {
  const plan = {
    responseType: "html",
    tocSelector: "//a[contains(normalize-space(.), '点击阅读')]/@href",
  };
  const html = '<div><a href="/c/6367390/">点击阅读</a><a href="/i/540307/">目录列表</a></div>';
  assert.equal(
    bridgeTocUrl(html, "https://mobile.example/b/540307", plan),
    "https://mobile.example/i/540307/",
  );
});

test("在线质量门槛用分类修复坏搜索，仅在没有可用入口时跳过", () => {
  const good = structuredClone(sampleSource);
  good.bookSourceName = "可移植源";
  const bad = structuredClone(sampleSource);
  bad.bookSourceName = "Android 专用源";
  bad.searchUrl = "@js:\nreturn java.ajax(source.getKey());";
  const unusable = structuredClone(bad);
  unusable.bookSourceName = "无入口 Android 专用源";
  unusable.exploreUrl = "";
  unusable.ruleExplore = {};
  const { sources, skipped, warnings } = convertLegado([good, bad, unusable], { omitNonPortable: true });
  assert.ok(sources["可移植源"]);
  assert.ok(sources["Android 专用源"]);
  assert.equal(sources["Android 专用源"].searchBook.actionID, "searchBook");
  assert.equal(sources["无入口 Android 专用源"], undefined);
  assert.deepEqual(skipped.map((item) => item.source), ["无入口 Android 专用源"]);
  assert.ok(warnings.some((warning) => warning.message.includes("分类入口重建搜索动作")));
});

test("在线质量门槛只删除 Android 专用可选字段而保留可执行列表", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "可选字段含 Java";
  source.ruleSearch.author = "@js:return java.getString('.author');";
  source.ruleExplore.author = "@js:return java.getString('.author');";
  const { sources, skipped, warnings } = convertLegado(source, { omitNonPortable: true });
  const converted = sources["可选字段含 Java"];
  assert.ok(converted);
  assert.deepEqual(skipped, []);
  assert.equal(converted.searchBook.author, undefined);
  assert.equal(converted.bookWorld["玄幻"].author, undefined);
  assert.ok(warnings.some((warning) => warning.message.includes("已删除字段并保留可执行的核心动作")));
});

test("列表项字段保持香色支持的双斜线 XPath", () => {
  const source = {
    bookSourceName: "相对 XPath 测试",
    bookSourceUrl: "https://book.example.com",
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/books?page={{page}}",
    ruleSearch: { bookList: "//div[@class='card']", name: "//h2/text()", bookUrl: "//a/@href" },
    ruleExplore: { bookList: "//div[@class='card']", name: "//h2/text()", bookUrl: "//a/@href" },
    ruleBookInfo: { name: "//h1/text()" },
    ruleToc: { chapterList: "//li", chapterName: "//a/text()", chapterUrl: "//a/@href" },
    ruleContent: { content: "//article@html" },
  };
  const { sources } = convertLegado(source);
  const converted = sources["相对 XPath 测试"];
  assert.equal(converted.bookDetail.bookName, "//h1");
  assert.equal(converted.searchBook.list, "//div[@class='card']");
  assert.equal(converted.searchBook.bookName, "//h2");
  assert.equal(converted.searchBook.detailUrl, "//a/@href");
  assert.equal(converted.bookWorld["分类"].detailUrl, "//a/@href");
  assert.equal(converted.chapterList.title, "//a");
  assert.equal(converted.chapterList.url, "//a/@href");
  assert.equal(converted.chapterList.list, "(//li)[self::a[@href] or .//a[@href]]");
});

test("列表项的阅读专用后处理回退为基础选择器", () => {
  const source = {
    bookSourceName: "列表 JS 回退测试",
    bookSourceUrl: "https://book.example.com",
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/books?page={{page}}",
    ruleSearch: { bookList: ".card", name: ".name@text@js:eval(String(source.bookSourceComment));traditionalToSimplified(result)", bookUrl: "a@href" },
    ruleExplore: { bookList: ".card", name: ".name@text@js:eval(String(source.bookSourceComment));traditionalToSimplified(result)", kind: "@js:java.getString('.kind@text')", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".content@html" },
  };
  const { sources, warnings } = convertLegado(source);
  const world = sources["列表 JS 回退测试"].bookWorld["分类"];
  assert.equal(world.bookName, "//*[contains(concat(' ', normalize-space(@class), ' '), ' name ')]");
  assert.equal(world.cat, undefined);
  assert.ok(warnings.some((warning) => warning.message.includes("保留基础选择器")));
  assert.ok(warnings.some((warning) => warning.message.includes("避免香色丢弃整个列表")));
});

test("有声源保留 audio 类型，正文包装为播放 JSON", () => {
  const source = {
    bookSourceName: "示例如声",
    bookSourceUrl: "https://audio.example.com/",
    bookSourceType: 1,
    customOrder: 8,
    searchUrl: "https://audio.example.com/search?q={{key}}&page={{page}}",
    ruleSearch: {
      bookList: ".item",
      name: "a@text",
      bookUrl: "a@href",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: {
      chapterList: ".chapter a",
      chapterName: "text",
      chapterUrl: "href",
    },
    ruleContent: {
      content: "audio@src||.play-btn@data-url",
    },
  };
  const { sources } = convertLegado([source]);
  const converted = sources["示例如声"];
  assert.equal(converted.sourceType, "audio");
  assert.match(converted.chapterContent.content, /audio\/@src|\/\/audio\/@src/);
  assert.match(converted.chapterContent.content, /JSON\.stringify/);
  assert.match(converted.chapterContent.content, /forbidCache/);
  assert.match(converted.chapterContent.content, /encodeURI/);
});

test("有声和视频正文为空时自动使用章节媒体 URL", () => {
  for (const [bookSourceType, expectedType] of [[1, "audio"], [4, "video"]]) {
    const source = {
      bookSourceName: `直链${expectedType}`,
      bookSourceUrl: `https://${expectedType}.example.com`,
      bookSourceType,
      searchUrl: "/search?q={{key}}",
      ruleSearch: { bookList: "$.list[*]", name: "$.name", bookUrl: "$.url" },
      ruleBookInfo: { name: "$.name" },
      ruleToc: { chapterList: "$.items[*]", chapterName: "$.name", chapterUrl: "$.url" },
      ruleContent: {},
    };
    const { sources, warnings } = convertLegado(source);
    const converted = sources[`直链${expectedType}`];
    assert.equal(converted.sourceType, expectedType);
    assert.match(converted.chapterContent.content, /params\.queryInfo/);
    assert.match(converted.chapterContent.content, /forbidCache/);
    assert.ok(warnings.some((warning) => warning.message.includes("章节 URL 作为播放地址")));
    assert.ok(!warnings.some((warning) => warning.message === "缺少正文规则"));
  }
});

test("正文仅返回 baseUrl 时直接使用章节媒体 URL", () => {
  const source = {
    bookSourceName: "章节直链正文",
    bookSourceUrl: "https://audio.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.items", name: "$.name", bookUrl: "$.url" },
    ruleToc: {
      chapterList: "$.tracks",
      chapterName: "title",
      chapterUrl: "playUrl64||playUrl32",
    },
    ruleContent: { content: "@js:baseUrl" },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["章节直链正文"];
  assert.match(converted.chapterContent.requestInfo, /adapter\/direct-media/);
  assert.doesNotMatch(converted.chapterContent.content, /baseUrl/);
  assert.doesNotMatch(converted.chapterContent.content, /encodeURI/);
});

test("正文脚本包装 baseUrl 并调用阅读端副作用时仍使用章节媒体 URL", () => {
  const source = {
    bookSourceName: "包装章节直链正文",
    bookSourceUrl: "https://video.example",
    bookSourceType: 4,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.items", name: "$.name", bookUrl: "$.url" },
    ruleToc: {
      chapterList: "$.episodes",
      chapterName: "title",
      chapterUrl: "videoUrl",
    },
    ruleContent: {
      content: "@js:(function(){ var url=String(baseUrl||''); if(url){ try{java.startBrowser(url,'');}catch(e){} } return url; })()",
    },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["包装章节直链正文"];
  assert.match(converted.chapterContent.requestInfo, /adapter\/direct-media/);
  assert.doesNotMatch(converted.chapterContent.requestInfo, /adapter\/media\?/);
});

test("JSONPath 递归条件目录由通用桥接筛选器保留", () => {
  const source = {
    bookSourceName: "递归筛选听书",
    bookSourceUrl: "https://filter.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.items[*]", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: { name: "$.name", tocUrl: "{{baseUrl}}" },
    ruleToc: {
      chapterList: "$..[?(@.kind=='sound'||@.kind=='note')]",
      chapterName: "label",
      chapterUrl: "stream",
    },
    ruleContent: {},
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const action = sources["递归筛选听书"].chapterList;
  assert.equal(sources["递归筛选听书"].chapterContent.responseFormatType, "json");
  assert.match(sources["递归筛选听书"].chapterContent.requestInfo, /adapter\/direct-media/);
  const plan = decodeBridgePlan(String(action.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.responseType, "json");
  assert.match(plan.list, /^@json-filter:recursive:/);
  const page = executeBridgePlan(JSON.stringify({
    groups: [{ children: [
      { kind: "sound", label: "第一集", stream: "/1.mp3" },
      { kind: "note", label: "说明", stream: "/note.txt" },
      { kind: "image", label: "封面", stream: "/cover.jpg" },
    ] }],
  }), "https://filter.example/api/album/1", plan, { limit: 10 });
  assert.deepEqual(page.data.map((item) => item.title), ["第一集", "说明"]);
  assert.deepEqual(page.data.map((item) => item.url), [
    "https://filter.example/1.mp3",
    "https://filter.example/note.txt",
  ]);
});

test("JSON && 目录合并数组并静态拼接章节 URL", () => {
  const source = {
    bookSourceName: "组合目录听书",
    bookSourceUrl: "https://audio.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.items", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: { name: "$.name" },
    ruleToc: {
      chapterList: "$.data.music&&$.data.episodes",
      chapterName: "$.name",
      chapterUrl: "$.id@js:'https://audio.example/play?id='+result",
    },
    ruleContent: { content: "$.data.file@js:'https://cdn.example/'+result" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["组合目录听书"];
  const plan = decodeBridgePlan(String(converted.chapterList.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.match(plan.list, /^@json-union:/);
  const output = executeBridgePlan(JSON.stringify({ data: {
    music: [{ name: "音乐一", id: 11 }],
    episodes: [{ name: "剧集二", id: 22 }],
  } }), "https://audio.example/album/1", plan, { limit: 10 });
  assert.deepEqual(output.data, [
    { title: "音乐一", url: "https://audio.example/play?id=11" },
    { title: "剧集二", url: "https://audio.example/play?id=22" },
  ]);
  const mediaPlan = JSON.parse(Buffer.from(
    String(converted.chapterContent.requestInfo).match(/plan=([^&]+)/)[1],
    "base64url",
  ).toString("utf8"));
  assert.equal(mediaPlan.resultPrefix, "https://cdn.example/");
});

test("JSON %% 列表按索引交错并忽略空候选", () => {
  const action = {
    host: "https://video.example",
    responseFormatType: "json",
    list: convertRule("$.items%%$.ranking[*].work", { responseType: "json" }),
    bookName: "title",
    detailUrl: "https://video.example/api/works/{{$.id}}",
  };
  const plan = compileBookBridgePlan(action);
  assert.match(plan.list, /^@json-interleave:/);

  const direct = executeBridgePlan(JSON.stringify({
    items: [{ id: "a", title: "作品 A" }, { id: "b", title: "作品 B" }],
  }), "https://video.example/api/works", plan, { limit: 10 });
  assert.deepEqual(direct.data.map((item) => item.name), ["作品 A", "作品 B"]);

  const mixed = executeBridgePlan(JSON.stringify({
    items: [{ id: "a", title: "作品 A" }, { id: "b", title: "作品 B" }],
    ranking: [
      { work: { id: "r1", title: "排行一" } },
      { work: { id: "r2", title: "排行二" } },
    ],
  }), "https://video.example/api/works", plan, { limit: 10 });
  assert.deepEqual(mixed.data.map((item) => item.name), ["作品 A", "排行一", "作品 B", "排行二"]);
});

test("详情 JSON 字段构造目录 URL 并保留章节标题模板", () => {
  const source = {
    bookSourceName: "JSON 视频目录",
    bookSourceUrl: "https://video.example",
    bookSourceType: 4,
    exploreUrl: "分类::https://video.example/api/works?page={{page}}",
    ruleExplore: {
      bookList: "$.items",
      name: "$.title",
      bookUrl: "https://video.example/api/works/{{$.id}}",
    },
    ruleBookInfo: {
      name: "$.title",
      tocUrl: "@js:'/api/works/' + JSON.parse(result).id + '/episodes'",
    },
    ruleToc: {
      chapterList: "$.items",
      chapterName: "@js:'第' + result.no + '集'",
      chapterUrl: "https://video.example/play/{{$.id}}",
    },
    ruleContent: { content: "$.play_url" },
  };
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
  }).sources["JSON 视频目录"];
  assert.match(converted.chapterList.requestInfo, /var marker = "\\\/api\\\/works\\\/"|var marker = "\/api\/works\/"/);
  assert.match(converted.chapterList.requestInfo, /encodeURIComponent\(id\)/);
  assert.doesNotMatch(converted.chapterList.requestInfo, /JSON\.parse\(result\)/);

  const plan = decodeBridgePlan(String(converted.chapterList.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.fields.title.selector, "no");
  assert.equal(plan.fields.title.matchTemplate.prefix, "第");
  assert.equal(plan.fields.title.matchTemplate.suffix, "集");
  const chapters = executeBridgePlan(JSON.stringify({
    items: [{ no: 1, id: "episode-1" }],
  }), "https://video.example/api/works/work-1/episodes", plan, { limit: 10 });
  assert.equal(chapters.data[0].title, "第1集");
});

test("递归 JSON 专辑列表与 split ID URL 静态转换", () => {
  const action = {
    host: "https://catalog.example",
    responseFormatType: "json",
    list: convertRule("$..albums.*", { responseType: "json" }),
    bookName: "title",
    detailUrl: "link||@js:\nreturn ('https://api.example/album/' + result.split('/')[2] + '/1/200');",
  };
  const plan = compileBookBridgePlan(action);
  const output = executeBridgePlan(JSON.stringify({ data: { page: { albums: [{
    title: "专辑一",
    link: "/channel/7788",
  }] } } }), "https://catalog.example/list", plan, { limit: 10 });
  assert.deepEqual(output.data, [{
    name: "专辑一",
    url: "https://api.example/album/7788/1/200",
  }]);
});

test("整页单本列表使用文档标题与当前响应 URL", () => {
  const source = {
    bookSourceName: "整页合辑",
    bookSourceUrl: "https://music.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "html", name: "title@text##搜索结果.*", bookUrl: "{{baseUrl}}" },
    ruleToc: { chapterList: ".tracks li", chapterName: "a@text", chapterUrl: "a@href" },
    ruleContent: { content: "audio@src" },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["整页合辑"];
  const plan = decodeBridgePlan(String(converted.searchBook.requestInfo).match(/plan=([^&]+)/)[1]);
  const output = executeBridgePlan(
    "<html><head><title>热门搜索结果列表</title></head><body></body></html>",
    "https://music.example/search?q=hot",
    plan,
    { limit: 2 },
  );
  assert.deepEqual(output.data, [{ name: "热门", url: "https://music.example/search?q=hot" }]);
});

test("JSON 数组 map 字段别名静态还原为声明式列表", () => {
  const source = {
    bookSourceName: "映射列表",
    bookSourceUrl: "https://mapped.example",
    bookSourceType: 1,
    searchUrl: "https://api.mapped.example/find/{{key}}?page={{page}}",
    ruleSearch: {
      bookList: `<js>
        let payload = JSON.parse(src);
        payload.records.map(entry => ({
          label: entry.displayTitle,
          target: "https://api.mapped.example/album/" + entry.albumCode,
          artwork: entry.imageLink,
          maker: entry.ownerName
        }))
      </js>`,
      name: "label",
      bookUrl: "target",
      coverUrl: "artwork",
      author: "maker",
    },
    ruleBookInfo: { name: "$.displayTitle" },
    ruleToc: { chapterList: "$.tracks[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: {},
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const action = sources["映射列表"].searchBook;
  const plan = decodeBridgePlan(String(action.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.responseType, "json");
  assert.equal(plan.list, "records");
  const output = executeBridgePlan(JSON.stringify({ records: [{
    displayTitle: "示例专辑",
    albumCode: "A-17",
    imageLink: "https://img.example/a.jpg",
    ownerName: "作者",
  }] }), "https://api.mapped.example/find/x", plan, { limit: 3 });
  assert.deepEqual(output.data[0], {
    name: "示例专辑",
    url: "https://api.mapped.example/album/A-17",
    author: "作者",
    cover: "https://img.example/a.jpg",
  });
});

test("详情 URL 正则改写目录 API 且目录 map 别名保持原字段", () => {
  const source = {
    bookSourceName: "正则目录",
    bookSourceUrl: "https://listen.example",
    bookSourceType: 1,
    searchUrl: "/search/{{key}}",
    ruleSearch: { bookList: "$.items[*]", name: "$.title", bookUrl: "$.detail" },
    ruleBookInfo: {
      name: "title",
      tocUrl: "{{baseUrl}}##[\\S\\s]*/album/(\\d+)##https://api.listen.example/tracks/$1",
    },
    ruleToc: {
      chapterList: `$..[?(@.nodeType=='stream'||@.nodeType=='note')]
        @js:
        JSON.parse(result).filter(row => row.nodeType === 'stream')
          .map(row => ({ label: row.caption, target: row.streamLocation }))`,
      chapterName: "label",
      chapterUrl: "target",
    },
    ruleContent: {},
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const action = sources["正则目录"].chapterList;
  const plan = decodeBridgePlan(String(action.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.responseType, "json");
  assert.match(plan.list, /nodeType:stream$/);
  assert.equal(plan.fields.title.selector, "caption");
  assert.equal(plan.fields.url.selector, "streamLocation");
  const request = new Function("config", "params", "result", action.requestInfo.replace(/^@js:\s*/, ""));
  const url = request(
    { host: "https://listen.example" },
    { pageIndex: 1, queryInfo: { detailUrl: "https://listen.example/album/417" } },
    "https://listen.example/album/417",
  );
  assert.equal(new URL(url).searchParams.get("url"), "https://api.listen.example/tracks/417");
});

test("RSS XML 列表保留 link 文本作为详情 URL", () => {
  const plan = compileBookBridgePlan({
    host: "https://feed.example",
    responseFormatType: "html",
    list: "//channel//item",
    bookName: "//title",
    detailUrl: "//link",
  });
  const output = executeBridgePlan(`<?xml version="1.0"?>
    <rss><channel><item><title>第一张专辑</title>
    <link>https://feed.example/album/1</link></item></channel></rss>`,
  "https://feed.example/index.xml", plan, { limit: 3 });
  assert.deepEqual(output.data, [{
    name: "第一张专辑",
    url: "https://feed.example/album/1",
  }]);
});

test("页面脚本声明的 JSON 数组可作为通用媒体目录", () => {
  assert.equal(
    convertRule("@embedded-json-array:playlist", { responseType: "embedded-json" }),
    "@embedded-json-array:playlist",
  );
  const plan = compileChapterBridgePlan({
    host: "https://embedded.example",
    responseFormatType: "embedded-json",
    list: "@embedded-json-array:playlist",
    title: "caption",
    url: "streamUrl",
  });
  const output = executeBridgePlan(`<script>
    const playlist = [{"caption":"第一集","streamUrl":"/media/1.m4a"},
      {"caption":"第二集","streamUrl":"https://cdn.example/2.m4a"}];
  </script>`, "https://embedded.example/album/1", plan, { limit: 5 });
  assert.deepEqual(output.data.map((item) => item.url), [
    "https://embedded.example/media/1.m4a",
    "https://cdn.example/2.m4a",
  ]);
});

test("状态缓存单曲源转换为搜索项直链与单章节动作", () => {
  const source = {
    bookSourceName: "状态单曲",
    bookSourceUrl: "https://music.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "$.data[*]",
      name: "title",
      bookUrl: "/metadata?id={{$.id}}",
      coverUrl: "cover",
    },
    ruleBookInfo: {},
    ruleToc: {
      chapterList: "@js:[java.get('currentRow')]",
      chapterName: "title",
      chapterUrl: "streamUrl",
    },
    ruleContent: {},
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["状态单曲"];
  const plan = decodeBridgePlan(String(converted.searchBook.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.fields.url.selector, "streamUrl");
  assert.match(converted.chapterList.requestInfo, /adapter\/single-chapter/);
  assert.match(converted.chapterContent.requestInfo, /adapter\/direct-media/);
});

test("媒体目录缺少章节 URL 时使用详情页单章节入口", () => {
  const source = {
    bookSourceName: "详情单曲",
    bookSourceUrl: "https://song.example",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.items", name: "$.name", bookUrl: "$.detail" },
    ruleToc: { chapterList: "$.data", chapterName: "$.name", chapterUrl: "-" },
    ruleContent: { content: "$.data.trackUrl" },
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["详情单曲"];
  assert.match(converted.chapterList.requestInfo, /adapter\/single-chapter/);
  assert.equal(converted.chapterList.moreKeys.maxPage, 1);
});

test("依赖书名上下文的媒体章节标题在桥接中使用稳定标题", () => {
  const plan = compileChapterBridgePlan({
    host: "https://single-page.example",
    responseFormatType: "html",
    list: "//main",
    title: "@js: return params.queryInfo.bookName;",
    url: ".//audio/@src",
  });
  const output = executeBridgePlan(
    '<main><audio src="/media/episode.mp3"></audio></main>',
    "https://single-page.example/post/1",
    plan,
    { limit: 2 },
  );
  assert.equal(output.data[0].title, "播放");
  assert.equal(output.data[0].url, "https://single-page.example/media/episode.mp3");
});

test("JSON API tocUrl 编译为 getBookMenu 式目录请求与播放 urlTemplate", () => {
  const source = {
    bookSourceName: "听书目录",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "/ajax/search?keyWord={{key}}&pageNum={{page}}",
    ruleSearch: { bookList: "$.list[*]", name: "$.name", bookUrl: "$.id" },
    ruleBookInfo: {
      name: "$.name",
      tocUrl: "https://audio.example/ajax/getBookMenu?bookId={{$.id}}&pageNum=1&pageSize=50&sortType=0",
    },
    ruleToc: {
      chapterList: "$.list[*]",
      chapterName: "$.name",
      chapterUrl: "https://audio.example/ajax/getListenPath?entityId={{baseUrl.match(/bookId=(\\d+)/)[1]}}&section={{$.section}}&id={{$.id}},{\"headers\":{\"cookie\":\"token=abc\"}}",
    },
    ruleContent: { content: "@js:return JSON.parse(src).data.path;" },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["听书目录"];
  assert.match(converted.chapterList.requestInfo, /getBookMenu/);
  assert.match(converted.chapterList.nextPageUrl, /pageNum|pageIndex|page/);
  // Bridged nextPageUrl must stay on /adapter/chapters so list:"$.data" still matches.
  assert.match(converted.chapterList.nextPageUrl, /adapter\/chapters\?plan=/);
  assert.match(converted.chapterList.requestInfo, /adapter\/chapters\?plan=/);
  assert.equal(converted.chapterList.list, "$.data");
  assert.equal(converted.chapterList.moreKeys.pageSize, 50);
  assert.equal(converted.chapterList.moreKeys.maxPage, 500);
  assert.equal(converted.httpHeaders.cookie || converted.httpHeaders.Cookie, "token=abc");
  assert.ok(warnings.some((warning) => /JSON API tocUrl/.test(warning.message)));
  const detailPlan = decodeBridgePlan(converted.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1]);
  assert.match(detailPlan.latestChapter.urlTemplate, /pageNum=__PAGE__/);
  assert.equal(detailPlan.latestChapter.list, "list");
  assert.equal(detailPlan.latestChapter.title, "name");
  assert.equal(detailPlan.latestChapter.values.value1, "id");
  assert.match(converted.chapterContent.content, /config\.httpHeaders/);
  assert.doesNotMatch(converted.chapterContent.content, /\/media\?url=/);
  const plan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1]);
  assert.match(plan.fields.url.urlTemplate, /getListenPath/);
  assert.deepEqual(
    executeBridgePlan(
      JSON.stringify({ list: [{ name: "第1集", id: 9, section: 1 }] }),
      "https://audio.example/ajax/getBookMenu?bookId=42&pageNum=1&pageSize=50&sortType=0",
      plan,
    ),
    {
      data: [{
        title: "第1集",
        url: "https://audio.example/ajax/getListenPath?entityId=42&section=1&id=9",
      }],
      hasMore: false,
      offset: 0,
      pageSize: 100,
    },
  );
  // Prefer entityId/bookId over bare section `id=` on listen URLs.
  assert.match(converted.chapterList.requestInfo, /bookId \|\| q\.book_id \|\| q\.albumId/);
  assert.match(converted.chapterList.requestInfo, /itemId \|\| q\.item_id/);
  assert.match(converted.chapterList.requestInfo, /seed = q\.detailUrl \|\| q\.url \|\| q\.chapterUrl/);
});

test("嵌套 JSON 字段目录 URL 从详情路径恢复实体 ID", () => {
  const source = {
    bookSourceName: "嵌套字段目录",
    bookSourceUrl: "https://stream.example",
    bookSourceType: 4,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.models", name: "username", bookUrl: "/models/{{$.id}}" },
    ruleBookInfo: {
      name: "{{$.user.profile.name}}",
      tocUrl: "https://stream.example/broadcasts/{{$.user.profile.id}}?view=public",
    },
    ruleToc: { chapterList: "$..item", chapterName: "status", chapterUrl: "streamUrl" },
    ruleContent: {},
  };
  const converted = convertLegado(source, { imageProxyBase: "https://convert.example" }).sources["嵌套字段目录"];
  const request = new Function("config", "params", "result", converted.chapterList.requestInfo.replace(/^@js:\s*/, ""));
  const adapterUrl = request(
    { host: "https://stream.example" },
    { pageIndex: 1, queryInfo: { detailUrl: "https://stream.example/models/172878937/cam?mode=public" } },
    "https://stream.example/models/172878937/cam?mode=public",
  );
  assert.equal(
    new URL(adapterUrl).searchParams.get("url"),
    "https://stream.example/broadcasts/172878937?view=public",
  );
});

test("依赖 Android API 的媒体正文通过在线通用提取器转换", () => {
  const source = {
    bookSourceName: "媒体提取器",
    bookSourceUrl: "https://media.example.com",
    bookSourceType: 4,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: ".name@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".episode", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: '@js:java.getString("iframe@src")' },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["媒体提取器"];
  assert.equal(converted.sourceType, "video");
  assert.match(converted.chapterContent.requestInfo, /convert\.example\/adapter\/media\?kind=video/);
  assert.match(converted.chapterContent.content, /payload\.url/);
});

test("媒体适配正文不会追加阅读文本 replaceRegex 脚本", () => {
  const source = {
    bookSourceName: "媒体替换隔离",
    bookSourceUrl: "https://media.example.com",
    bookSourceType: 4,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: ".name@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".episode", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: '@js:java.getString("iframe@src")',
      replaceRegex: "##{{book.durChapterTitle}}##",
    },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const content = sources["媒体替换隔离"].chapterContent.content;

  assert.equal((content.match(/\|\|\s*@js:/gi) || []).length, 0);
  assert.doesNotMatch(content, /book\.durChapterTitle/);
  assert.match(content, /payload\.url/);
});

test("依赖阅读 baseUrl 的媒体脚本交给通用服务端提取器", () => {
  const source = {
    bookSourceName: "媒体上下文隔离",
    bookSourceUrl: "https://media.example.com",
    bookSourceType: 4,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: ".name@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".episode", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "@js:return baseUrl + '/play.mp4';" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const chapterContent = sources["媒体上下文隔离"].chapterContent;

  assert.match(chapterContent.requestInfo, /\/adapter\/media\?kind=video/);
  assert.doesNotMatch(chapterContent.content, /\bbaseUrl\b/);
  assert.match(chapterContent.content, /payload\.url/);
});

test("纯 JavaScript 字段映射阅读 src/baseUrl 到香色运行时上下文", () => {
  const converted = convertRule(
    "@js:return src.match(/token=(\\w+)/)[1] + '@' + baseUrl;",
    { responseType: "html" },
  );

  assert.doesNotMatch(converted, /\bsrc\b/);
  assert.doesNotMatch(converted, /\bbaseUrl\b/);
  assert.match(converted, /result\.match/);
  assert.match(converted, /params\.responseUrl/);
  assert.equal(hasUnsupportedLegadoRuntime(converted), false);
});

test("站点根地址模板映射为香色 host", () => {
  const host = convertRequest("{{host}}/search?q={{key}}").requestInfo;
  const current = convertRequest("{{getCurrentUrl()}}/search?q={{key}}").requestInfo;
  const connected = convertRequest("{{java.connect(source.getKey()).raw().request().url()}}/search?q={{key}}").requestInfo;

  for (const requestInfo of [host, current, connected]) {
    assert.match(requestInfo, /config\.host/);
    assert.doesNotMatch(requestInfo, /\{\{|getCurrentUrl|java\.connect/);
    assert.equal(hasUnsupportedLegadoRuntime(requestInfo), false);
  }
});

test("函数参数中的 key/page 不会被误写为对象属性", () => {
  const converted = convertRequest("@js:return qmSearchUrl.call(this, key, page);").requestInfo;

  assert.match(converted, /qmSearchUrl\.call\(this, params\.keyWord, params\.pageIndex\)/);
  assert.doesNotMatch(converted, /key:\s*params|page:\s*params/);
});

test("对象属性值和纯表达式请求会生成合法返回值", () => {
  const objectValue = convertRequest("@js:return JSON.stringify({index: page, keyword: key});").requestInfo;
  const expression = convertRequest('@js:"https://api.example/search," + JSON.stringify({method:"POST",body:"q=" + key})').requestInfo;

  assert.match(objectValue, /index:\s*params\.pageIndex/);
  assert.doesNotMatch(objectValue, /index:\s*page:/);
  assert.match(expression, /return\s*\(/);
  assert.equal(hasUnsupportedLegadoRuntime(expression), false);
});

test("仅在内层函数 return 的 result 赋值表达式会补顶层返回值", () => {
  const rule = convertRule("@js:result=(function(){var d=result;return d.id;})()", {
    responseType: "json",
  });
  assert.match(rule, /^@js:\s*return\s*\(\(function/);
  assert.equal(new Function("config", "params", "result", rule.replace(/^@js:\s*/, ""))(
    {},
    {},
    { id: "detail-1" },
  ), "detail-1");
});

test("多语句 JavaScript 的末尾赋值和数组表达式会补顶层返回值", () => {
  const assignment = convertRule("@js:var data=JSON.parse(result); result=data.content;", {
    responseType: "json",
  });
  assert.equal(hasUnsupportedLegadoRuntime(assignment), false);
  assert.equal(new Function("config", "params", "result", assignment.replace(/^@js:\s*/, ""))(
    {},
    {},
    '{"content":"正文"}',
  ), "正文");

  const array = convertRule("@js:var title='第一集'; [JSON.stringify({name:title,url:'/play'})];", {
    responseType: "json",
  });
  assert.equal(hasUnsupportedLegadoRuntime(array), false);
  assert.deepEqual(JSON.parse(new Function("config", "params", "result", array.replace(/^@js:\s*/, ""))(
    {},
    {},
    "",
  )[0]), { name: "第一集", url: "/play" });

  assert.equal(hasUnsupportedLegadoRuntime('@js:return String(result).replace("<js>java.ajax(source.key)</js>", "");'), false);
  assert.equal(hasUnsupportedLegadoRuntime('@js:return java.ajax(source.key);'), true);
});

test("JSON 影视分隔字符串目录转换为声明式章节列表", () => {
  const source = {
    bookSourceName: "分隔目录视频",
    bookSourceUrl: "https://video.example",
    bookSourceType: 4,
    searchUrl: "/api?v={{key}}",
    ruleSearch: { bookList: "$.list", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: { name: "$.list[0].name" },
    ruleToc: {
      chapterList: `@js:
var data = JSON.parse(src);
var vod = data.list[0];
var playUrl = vod.vod_play_url || '';
var lines = playUrl.split('$$$');
var selected = lines.length > 1 ? lines[1] : lines[0];
var eps = selected.split('#');
var list = [];
for (var i = 0; i < eps.length; i++) {
  var idx = eps[i].indexOf('$');
  if (idx > 0) list.push({text: eps[i].substring(0, idx), href: eps[i].substring(idx + 1)});
}
list`,
      chapterName: "text",
      chapterUrl: "href",
    },
    ruleContent: { content: "@js:baseUrl" },
  };
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
  }).sources["分隔目录视频"];
  const plan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([^&]+)/)[1]);
  assert.match(plan.list, /^@json-media-pairs:/);
  const output = executeBridgePlan(JSON.stringify({ list: [{
    vod_play_url: "标清$https://cdn.example/a.mp4$$$第1集$https://cdn.example/1.m3u8#第2集$https://cdn.example/2.m3u8",
  }] }), "https://video.example/detail/1", plan, { limit: 10 });
  assert.deepEqual(output.data, [
    { title: "第1集", url: "https://cdn.example/1.m3u8" },
    { title: "第2集", url: "https://cdn.example/2.m3u8" },
  ]);
});

test("HTML 列表项 href 正则脚本回退为声明式链接字段", () => {
  const plan = compileBookBridgePlan({
    host: "https://video.example",
    responseFormatType: "html",
    list: convertRule("article.card"),
    bookName: convertRule("h3@text"),
    detailUrl: convertRule(`@js:(function(){
      var html=String(result||'');
      var m=html.match(/href="([^"]*series\\/details\\/[^"]+)"/);
      return m?m[1]:'';
    })()`),
  });
  assert.equal(plan.fields.url.selector, ".//a[@href]/@href");
  const output = executeBridgePlan(`
    <article class="card"><h3>短剧一</h3><a href="/series/details/1">播放</a></article>
  `, "https://video.example/", plan, { limit: 10 });
  assert.equal(output.data[0].url, "https://video.example/series/details/1");
});

test("JSON 数组 for 循环生成的媒体目录静态转换为章节规则", () => {
  const source = {
    bookSourceName: "循环媒体目录",
    bookSourceUrl: "https://video.example",
    bookSourceType: 4,
    searchUrl: "/api/search?q={{key}}",
    ruleSearch: { bookList: "$.data.items", name: "$.title", bookUrl: "$.url" },
    ruleBookInfo: { name: "$.data.title" },
    ruleToc: {
      chapterList: `@js:result=(function(){
        var d=(typeof result==='string')?JSON.parse(result):result;
        var data=d.data||d;
        var out=[];
        for(var i=0;i<data.episodes.length;i++){
          var e=data.episodes[i];
          out.push({title:e.title||('第'+(i+1)+'集'),url:'https://video.example/media?path='+encodeURIComponent(e.videoUrl||'')});
        }
        return out;
      })()`,
      chapterName: "title",
      chapterUrl: "url",
    },
    ruleContent: { content: "@js:baseUrl" },
  };
  const converted = convertLegado(source, {
    imageProxyBase: "https://convert.example",
  }).sources["循环媒体目录"];
  const plan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([^&]+)/)[1]);
  assert.equal(plan.list, "data/episodes||episodes");
  const output = executeBridgePlan(JSON.stringify({ data: { episodes: [
    { title: "第一集", videoUrl: "a/1.m3u8" },
  ] } }), "https://video.example/detail/1", plan, { limit: 10 });
  assert.deepEqual(output.data, [{
    title: "第一集",
    url: "https://video.example/media?path=a%2F1.m3u8",
  }]);
});

test("source.getKey POST 模板和 @js 静态 URL 包装还原为声明式请求", () => {
  const sourceHost = convertRequest('{{source.getKey()}}/search,{"method":"POST","body":"q={{key}}&page={{page}}"}').requestInfo;
  const wrapped = convertRequest('@js:https://api.example/search,{"method":"POST","body":"q={{key}}"}').requestInfo;

  for (const requestInfo of [sourceHost, wrapped]) {
    assert.match(requestInfo, /return\s+\{/);
    assert.equal(hasUnsupportedLegadoRuntime(requestInfo), false);
  }
  assert.match(sourceHost, /config\.host/);
});

test("内嵌 Base64 正文段转换为香色纯 JavaScript 解码器", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "Base64 正文";
  source.ruleContent.content = `<js>
var blocks = result.match(/PHA\\+[A-Za-z0-9+\\/]+={0,2}/g);
blocks.map(function (item) { return java.base64Decode(item); }).join('\\n');
</js>`;
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const content = sources["Base64 正文"].chapterContent.content;

  assert.match(content, /\batob\b/);
  assert.match(content, /decodeURIComponent/);
  assert.doesNotMatch(content, /\bjava\./);
  assert.equal(hasUnsupportedLegadoRuntime(content), false);
});

test("静态 Java DOM 脚本通过通用桥接器转换目录和正文", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "Java DOM 桥接";
  source.ruleToc = {
    chapterList: "@js:var doc=org.jsoup.Jsoup.parse(result);return doc.select('ol.chapters li');",
    chapterName: "a@text",
    chapterUrl: "a@href",
  };
  source.ruleContent.content = "@js:var doc=org.jsoup.Jsoup.parse(result);var el=doc.select('#chapter-content').first();return el.html();";

  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["Java DOM 桥接"];
  const chapterPlan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1]);
  const textPlan = decodeBridgePlan(converted.chapterContent.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1]);

  assert.match(chapterPlan.list, /chapters/);
  assert.match(textPlan.fields.content.selector, /chapter-content/);
  assert.equal(hasUnsupportedLegadoRuntime(converted.chapterContent.content), false);
  assert.equal(validateXiangseSource(converted).ok, true);
});

test("缺少章节 URL 的单页内容使用当前详情页", () => {
  const source = structuredClone(sampleSource);
  source.bookSourceName = "同页单章节";
  source.ruleToc = { chapterList: "article", chapterName: "h1@text" };

  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["同页单章节"];
  const plan = decodeBridgePlan(converted.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1]);

  assert.equal(plan.fields.url.currentUrl, true);
  assert.equal(validateXiangseSource(converted).ok, true);
});

test("单字段章节标题表达式可由目录桥接器提取", () => {
  const plan = compileChapterBridgePlan({
    host: "https://example.com",
    responseFormatType: "json",
    list: "$.items",
    title: "@js:return '第' + result.no + '集';",
    url: "$.url",
  });

  assert.equal(plan.fields.title.selector, "no");
});

test("JSON 音视频正文通过通用提取器兼容上游字段改名", () => {
  const source = {
    bookSourceName: "JSON 有声",
    bookSourceUrl: "https://audio.example.com",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.list[*]", name: "$.name", bookUrl: "$.url" },
    ruleBookInfo: { name: "$.name" },
    ruleToc: { chapterList: "$.episodes[*]", chapterName: "$.name", chapterUrl: "$.apiUrl" },
    ruleContent: { content: "$.info.sound.soundurl_64" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["JSON 有声"];
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/media\?kind=audio/);
  assert.match(converted.chapterContent.content, /payload\.url/);
});

test("在线质量门槛跳过未知 imageDecode 漫画", () => {
  const source = {
    bookSourceName: "花屏漫画",
    bookSourceUrl: "https://comic.example.com/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/list?page={{page}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleExplore: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "img@src", imageDecode: "JavaImporter(); unknownScramble(result);" },
  };
  const { sources, skipped, skippedBuckets: buckets } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  assert.equal(sources["花屏漫画"], undefined);
  assert.ok(skipped.some((item) => /未知 imageDecode/.test(item.reason)));
  assert.equal(buckets.imageDecode, 1);
});

test("在线质量门槛：识别了解码器但缺少代理时跳过", () => {
  const source = {
    bookSourceName: "缺代理漫画",
    bookSourceUrl: "https://comic.example.com/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/list?page={{page}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleExplore: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "img@src",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0123456789abcdef0123456789abcdef'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
  };
  const { sources, skipped } = convertLegado(source, { omitNonPortable: true });
  assert.equal(sources["缺代理漫画"], undefined);
  assert.ok(skipped.some((item) => /缺少图片解码代理/.test(item.reason)));
});

test("在线质量门槛跳过未适配的登录分流 Get 源", () => {
  const source = {
    bookSourceName: "分流小说",
    bookSourceUrl: "https://novel.example.com/",
    bookSourceType: 0,
    loginUrl: "https://novel.example.com/login",
    searchUrl: "{{Get('url')}}/search?q={{key}}&page={{page}}",
    exploreUrl: "分类::{{Get('url')}}/list?page={{page}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleExplore: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href##(.*)##$1/?shunt={{Get('shunt')}}" },
    ruleContent: { content: "#content@html" },
  };
  const { sources, skipped, skippedBuckets: buckets } = convertLegado(source, { omitNonPortable: true });
  assert.equal(sources["分流小说"], undefined);
  assert.ok(skipped.some((item) => /登录\/分流变量 Get/.test(item.reason)));
  assert.equal(buckets.login, 1);
});

test("在线质量门槛保留 sourceRegex 有声源并走媒体适配", () => {
  const source = {
    bookSourceName: "拦截有声",
    bookSourceUrl: "https://audio.example.com/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    exploreUrl: "分类::/list?page={{page}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleExplore: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "audio@src", sourceRegex: ".*\\.mp3.*" },
  };
  const { sources, skipped, warnings } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  assert.equal(skipped.length, 0);
  const converted = sources["拦截有声"];
  assert.ok(converted);
  assert.equal(converted.sourceType, "audio");
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/media\?kind=audio/);
  assert.match(converted.chapterContent.content, /config\.httpHeaders/);
  assert.match(converted.chapterContent.content, /payload\.httpHeaders/);
  assert.match(converted.chapterContent.content, /baseHeaders/);
  assert.doesNotMatch(converted.chapterContent.content, /\/media\?url=/);
  assert.ok(warnings.some((warning) => /sourceRegex/.test(warning.message)));
});

test("有声媒体 requestInfo 优先 result，避免 queryInfo 残留详情页；player 合并 httpHeaders", () => {
  const source = {
    bookSourceName: "残留详情有声",
    bookSourceUrl: "https://audio.example.com/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: `[name="_c"]@content@js:
var body=baseUrl.replace(/.+\\\\/book\\\\/(\\\\d+)-(\\\\d+)/,"bookId=$1&page=$2");
var url="/nlinka,";
var options={ method:"post", headers:JSON.stringify({ xt:result, Referer:baseUrl }), body:body };
JSON.parse(java.ajax(url+JSON.stringify(options))).url`,
      mediaResolution: {
        extract: [{ name: "xt", source: "meta", key: "_c" }],
        request: {
          url: "{{origin}}/nlinka",
          method: "POST",
          headers: { xt: "{{xt}}", Referer: "{{chapterUrl}}" },
          body: "xt={{xt}}",
        },
        response: { properties: ["url"] },
      },
    },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["残留详情有声"];
  assert.ok(converted);
  const requestJs = String(converted.chapterContent.requestInfo).replace(/^@js:\s*/i, "");
  const build = new Function("config", "params", "result", requestJs);
  const detail = "https://audio.example.com/book/42";
  const chapter = "https://audio.example.com/book/42-7";
  const leftover = build(
    { host: "https://audio.example.com", httpHeaders: null },
    { queryInfo: { detailUrl: detail, url: detail }, pageIndex: 1 },
    chapter,
  );
  assert.match(leftover, /url=https%3A%2F%2Faudio\.example\.com%2Fbook%2F42-7$/);
  assert.doesNotMatch(leftover, /url=https%3A%2F%2Faudio\.example\.com%2Fbook%2F42$/);

  const contentRule = String(converted.chapterContent.content);
  const { script } = (() => {
    const match = contentRule.match(/\|\|\s*@js:/i);
    return {
      script: match ? contentRule.slice(match.index + match[0].length) : contentRule.replace(/^@js:\s*/i, ""),
    };
  })();
  const contentFn = new Function("config", "params", "result", script);
  const player = JSON.parse(contentFn(
    { host: "https://audio.example.com", httpHeaders: { "User-Agent": "UA" } },
    { queryInfo: { detailUrl: detail, chapterUrl: chapter }, responseUrl: "https://convert.example/adapter/media" },
    { url: "https://cdn.example/a.mp3", httpHeaders: { Referer: chapter } },
  ));
  assert.equal(player.url, "https://cdn.example/a.mp3");
  assert.equal(player.forbidCache, true);
  // Source headers must be preserved; adapter Referer overlays/merges on top.
  assert.deepEqual(player.httpHeaders, { "User-Agent": "UA", Referer: chapter });
  assert.notEqual(player.httpHeaders, null);

  const playerFromUrl = JSON.parse(contentFn(
    { host: "https://audio.example.com", httpHeaders: { cookie: "a=1" } },
    { queryInfo: { detailUrl: detail, chapterUrl: chapter } },
    "https://cdn.example/b.mp3",
  ));
  assert.equal(playerFromUrl.url, "https://cdn.example/b.mp3");
  assert.equal(playerFromUrl.httpHeaders.cookie, "a=1");
  assert.equal(playerFromUrl.httpHeaders.Referer, chapter);
});

test("声明式媒体代理按 hosts 和 pathPrefix 改写 CDN", () => {
  const source = {
    bookSourceName: "媒体代理",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "/search/{{key}}",
    ruleSearch: { bookList: "a", name: "text", bookUrl: "href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "a", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "audio@src",
      mediaResolution: {
        extract: [{ name: "xt", source: "meta", key: "_c" }],
        request: { url: "{{origin}}/glink", method: "POST", body: "x={{xt}}" },
        response: { properties: ["url"] },
      },
    },
    read2xsgg: {
      mediaProxy: { hosts: ["cdn.example"], pathPrefix: "/media-cdn" },
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["媒体代理"];
  assert.ok(converted);
  assert.match(converted.chapterContent.requestInfo, /adapter\/media/);
  assert.doesNotMatch(converted.chapterContent.requestInfo, /webView:\s*""/);
  assert.match(converted.chapterContent.content, /media-cdn/);
  assert.doesNotMatch(converted.chapterContent.content, /\/media\?url=/);
  // HTML 目录服务端切片翻页：必须带 nextPageUrl，否则香色只拉第 1 页（常见 100 章）。
  assert.match(converted.chapterList.requestInfo, /adapter\/chapters/);
  assert.match(converted.chapterList.nextPageUrl, /adapter\/chapters/);
  assert.match(converted.chapterList.nextPageUrl, /slice=1/);
  assert.ok(converted.chapterList.moreKeys?.maxPage >= 2);
  assert.ok(warnings.some((item) => /媒体解析计划|media/i.test(String(item.message || ""))));

  const contentRule = String(converted.chapterContent.content);
  const script = contentRule.replace(/^@js:\s*/i, "");
  const contentFn = new Function("config", "params", "result", script);
  const chapter = "https://audio.example/book/14917-1";
  const player = JSON.parse(contentFn(
    { host: "https://audio.example", httpHeaders: { "User-Agent": "UA" } },
    { queryInfo: { detailUrl: "https://audio.example/book/14917", chapterUrl: chapter } },
    { url: "https://cdn.example/signed/a.mp3", httpHeaders: { Referer: chapter } },
  ));
  assert.match(player.url, /^https:\/\/convert\.example\/media-cdn\/signed\/a\.mp3\?v=\d+$/);
  assert.equal(player.httpHeaders.Referer, chapter);
  assert.equal(player.forbidCache, true);
});

test("显式 forceWebViewMedia 时注入源声明的 webViewMediaJs", () => {
  const source = {
    bookSourceName: "声明式 WebView",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "/search/{{key}}",
    ruleSearch: { bookList: "a", name: "text", bookUrl: "href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "audio@src" },
    read2xsgg: { forceWebViewMedia: true, webViewMediaJs: "document.title = 'ready';" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["声明式 WebView"];
  assert.match(converted.chapterContent.requestInfo, /webView:\s*""/);
  assert.match(converted.chapterContent.requestInfo, /webViewJs:/);
  assert.match(converted.chapterContent.requestInfo, /document\.title/);
});

test("forceWebViewMedia 播放 JSON 带上章节 Referer", () => {
  const source = {
    bookSourceName: "WebView Referer",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "audio@src" },
    read2xsgg: { forceWebViewMedia: true },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://convert.example" });
  const converted = sources["WebView Referer"];
  const contentRule = String(converted.chapterContent.content);
  const match = contentRule.match(/\|\|\s*@js:/i);
  const script = match ? contentRule.slice(match.index + match[0].length) : contentRule.replace(/^@js:\s*/i, "");
  const contentFn = new Function("config", "params", "result", script);
  const chapter = "https://audio.example/book/1-2";
  const player = JSON.parse(contentFn(
    { host: "https://audio.example", httpHeaders: { "User-Agent": "UA" } },
    { queryInfo: { detailUrl: "https://audio.example/book/1", chapterUrl: chapter } },
    "https://cdn.example/play.mp3",
  ));
  assert.equal(player.url, "https://cdn.example/play.mp3");
  assert.equal(player.httpHeaders.Referer, chapter);
  assert.equal(player.httpHeaders["User-Agent"], "UA");
});

test("可识别多步媒体规则编入 resolution；WebView 拦截源给出重新转换警告", () => {
  const inlinePlayer = compileMediaResolutionFromRule(`<js>
function player(type, id){
  const url = "https://media.example/play,";
  const options = {
    body: \`type=\${type}&id=\${id}\`,
    headers:{"Content-Type":"application/x-www-form-urlencoded","Referer":"https://media.example"},
    method: "POST"
  };
  return java.ajax(url + JSON.stringify(options));
}
JSON.parse(eval(result.match(/token.*?;(player.*?);/)[1])).url
</js>`);
  assert.equal(inlinePlayer.request.url, "https://media.example/play");
  assert.equal(inlinePlayer.request.body, "type={{type}}&id={{id}}");
  assert.equal(inlinePlayer.extract[0].source, "html");

  const twoStep = {
    bookSourceName: "两步有声",
    bookSourceUrl: "https://media.example/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: `[name="_token"]@content@js:
var body=baseUrl.replace(/.+\\\\/item\\\\/(\\\\d+)-(\\\\d+)/,"id=$1&page=$2");
var url="/api/play,";
var headers={ "X-Token":result, Referer:baseUrl };
var options={ method:"post", headers:JSON.stringify(headers), body:body };
JSON.parse(java.ajax(url+JSON.stringify(options))).playUrl`,
    },
  };
  const convertedTwoStep = convertLegado(twoStep, { imageProxyBase: "https://convert.example" });
  const twoStepSource = convertedTwoStep.sources["两步有声"];
  assert.ok(twoStepSource);
  assert.match(twoStepSource.chapterContent.requestInfo, /\/adapter\/media\?kind=audio&plan=/);
  const planMatch = String(twoStepSource.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(planMatch);
  const planJson = JSON.parse(Buffer.from(planMatch[1], "base64url").toString("utf8"));
  assert.equal(planJson.resolution?.request?.url, "{{origin}}/api/play");
  assert.ok(convertedTwoStep.warnings.some((warning) => /多步媒体流程/.test(warning.message)));

  const webViewOnly = {
    bookSourceName: "拦截有声不可移植",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: {
      chapterList: ".chapter a",
      chapterName: "text",
      chapterUrl: "tag.a@href@js:result+',{webView:true}'",
    },
    ruleContent: { content: "<js>result</js>", sourceRegex: ".*\\.(mp3|m4a).*" },
  };
  const convertedWebView = convertLegado(webViewOnly, { imageProxyBase: "https://convert.example" });
  assert.ok(convertedWebView.sources["拦截有声不可移植"]);
  assert.ok(convertedWebView.warnings.some((warning) => /重新转换/.test(warning.message)));
  const emptyPlanMatch = String(convertedWebView.sources["拦截有声不可移植"].chapterContent.requestInfo)
    .match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(emptyPlanMatch);
  const emptyPlan = JSON.parse(Buffer.from(emptyPlanMatch[1], "base64url").toString("utf8"));
  assert.equal(emptyPlan.resolution, undefined);

  const dynamicPlayer = {
    ...webViewOnly,
    bookSourceName: "动态播放器有声",
    ruleContent: { content: "audio@src" },
  };
  const convertedDynamic = convertLegado(dynamicPlayer, { imageProxyBase: "https://convert.example" });
  assert.match(
    convertedDynamic.sources["动态播放器有声"].chapterContent.requestInfo,
    /\/adapter\/media\?kind=audio&plan=/,
  );

  const forcedWebView = {
    ...twoStep,
    bookSourceName: "强制 WebView 有声",
    read2xsgg: { forceWebViewMedia: true },
  };
  const forced = convertLegado(forcedWebView, { imageProxyBase: "https://convert.example" });
  const forcedSource = forced.sources["强制 WebView 有声"];
  assert.match(forcedSource.chapterContent.requestInfo, /webView:\s*""/);
  assert.match(forcedSource.chapterContent.requestInfo, /webViewJsDelay/);
  assert.match(forcedSource.chapterContent.content, /audio\/@src|video\/@src/);
  assert.match(forcedSource.chapterContent.content, /chapterUrl/);
  assert.match(forcedSource.chapterContent.content, /headers\.Referer/);
  assert.doesNotMatch(forcedSource.chapterContent.requestInfo, /adapter\/media/);
});

test("CSS 负索引 [-n] 转为 last()-based position，不再生成非法 @-n", () => {
  assert.equal(
    convertRule(".panel[-2]@.grid@.item"),
    "(.//*[contains(concat(' ', normalize-space(@class), ' '), ' panel ')])[last() - 1]//*[contains(concat(' ', normalize-space(@class), ' '), ' grid ')]//*[contains(concat(' ', normalize-space(@class), ' '), ' item ')]",
  );
  assert.equal(convertRule("li[0]"), "(.//li)[1]");
});

test("JSON API 字段与 {$.id} URL 模板不再被误判成 HTML XPath", () => {
  const rules = {
    author: "authorName",
    bookList: "data||data.items",
    bookUrl: "/pc/book/{$.bookId}/catalog",
    coverUrl: "bookIconUrl@js:result || ''",
    name: "bookName",
  };
  assert.equal(inferResponseType(rules), "json");
  assert.equal(convertRule(rules.bookList, { responseType: "json" }), "data||data/items");
  assert.match(convertRule(rules.bookUrl, { responseType: "json" }), /result\.bookId/);
  assert.equal(convertRule(rules.name, { responseType: "json" }), "bookName");
});

test("桥接分类 URL 会替换 %@pageIndex，避免适配器把占位符当成坏编码", () => {
  const source = {
    bookSourceName: "分页搜索入口",
    bookSourceUrl: "https://novel.example.com",
    searchUrl: "/so/{{key}}/{{page}}",
    ruleSearch: {
      bookList: ".item",
      name: "a@text",
      bookUrl: "a@href",
      checkKeyWord: "测试",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "#content@html" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const world = Object.values(sources["分页搜索入口"].bookWorld)[0];
  assert.match(world.requestInfo, /%@pageIndex/);
  assert.match(world.requestInfo, /encodeURIComponent\(u\)/);
  assert.match(world.requestInfo, /params\.pageIndex/);
  // Upstream page token stays in the `u = "..."` template and is replaced at
  // runtime; the adapter url= suffix itself must not keep a literal %@pageIndex.
  assert.doesNotMatch(world.requestInfo, /&url=(?:(?!\)\.replace)[\s\S])*%@pageIndex/);
});

test("空 URL 的不可移植 POST 搜索会被跳过", () => {
  const source = {
    bookSourceName: "空地址搜索",
    bookSourceUrl: "https://m.example.com",
    searchUrl: '{{cookie.removeCookie(source.getKey()); org.jsoup.Jsoup.parse(java.ajax(source.key)).select("form").attr("action")}},{"body":"searchkey={{key}}","method":"POST"}',
    ruleSearch: { bookList: ".bookbox", name: "a@text", bookUrl: "a@href", checkKeyWord: "剑来" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "#content@html" },
  };
  const { sources, skipped } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  assert.equal(sources["空地址搜索"], undefined);
  assert.ok(skipped.some((item) => /有效 URL|请求地址为空/.test(item.reason)));
});

test("JSON 章节 @js 标题/URL 模板会编译进桥接计划", () => {
  const source = {
    bookSourceName: "JSON 目录模板",
    bookSourceUrl: "https://api.example.com",
    exploreUrl: "榜单::/rank?page={{page}}",
    ruleExplore: {
      bookList: "data.items",
      name: "bookName",
      bookUrl: "/book/{$.bookId}/catalog",
    },
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "data.items", name: "bookName", bookUrl: "/book/{$.id}/catalog" },
    ruleBookInfo: { name: "$.name" },
    ruleToc: {
      chapterList: "data.data[?(@.volume == false)]",
      chapterName: "{$.free}{$.name}@js:result.replace('false','').replace('true','')",
      chapterUrl: "/chapter/{$.id}",
    },
    ruleContent: { content: "data.content" },
  };
  const { sources } = convertLegado(source, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const toc = sources["JSON 目录模板"].chapterList;
  assert.equal(toc.list, "$.data");
  assert.equal(toc.title, "title");
  assert.equal(toc.url, "url");
  const plan = decodeBridgePlan(String(toc.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.list, "data/data");
  assert.equal(plan.fields.title.selector, "name");
  assert.equal(plan.fields.url.selector, "id");
  assert.equal(plan.fields.url.matchTemplate.prefix, "/chapter/");
});

test("静态 @js 封面与发现页封面在搜索入口分类中保留", () => {
  const staticCover = {
    bookSourceName: "静态封面源",
    bookSourceUrl: "https://cover.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
      checkKeyWord: "测试",
      coverUrl: "@js:'https://cdn.example.com/nocover.jpg'",
    },
    ruleBookInfo: { name: "h1@text", coverUrl: "div.imgbox@tag.img@src" },
    ruleToc: { chapterList: "class.list@tag.a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "id.content@text" },
  };
  const { sources: staticSources } = convertLegado(staticCover, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const world = Object.values(staticSources["静态封面源"].bookWorld)[0];
  assert.equal(world.cover, "cover");
  const plan = decodeBridgePlan(String(world.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.equal(plan.fields.cover.constant, "https://cdn.example.com/nocover.jpg");

  const exploreCover = {
    bookSourceName: "发现封面源",
    bookSourceUrl: "https://explore-cover.example.com",
    searchUrl: "/search?q={{key}}",
    ruleSearch: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
      checkKeyWord: "测试",
    },
    ruleExplore: {
      bookList: "class.item@tag.li",
      name: "tag.a@text",
      bookUrl: "tag.a@href",
      coverUrl: "img@src",
    },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "class.list@tag.a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "id.content@text" },
  };
  const { sources: exploreSources } = convertLegado(exploreCover, {
    omitNonPortable: true,
    imageProxyBase: "https://convert.example",
  });
  const exploreWorld = Object.values(exploreSources["发现封面源"].bookWorld)[0];
  const explorePlan = decodeBridgePlan(String(exploreWorld.requestInfo).match(/plan=([^&]+)/)[1]);
  assert.match(explorePlan.fields.cover.selector, /img\/@src/);
});

test("纯文本请求头与截断引号 JSON 请求头可解析", () => {
  const plain = {
    bookSourceName: "纯文本UA",
    bookSourceUrl: "https://novel.example/",
    searchUrl: "/search?q={{key}}",
    header: "User-Agent: Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36\nReferer: https://novel.example/",
    ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
    ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: "#content@html" },
  };
  const truncated = {
    bookSourceName: "截断引号头",
    bookSourceUrl: "https://comic.example/",
    bookSourceType: 0,
    searchUrl: "/search?key={{key}}",
    header: '{  "User-Agent": "ComicUA/1.0", "Referer": "https://comic.example/}',
    ruleSearch: {
      bookList: "$.info[*]",
      name: "$.name",
      bookUrl: "$.id",
      coverUrl: "@js:result.cover_pic + ',{\"headers\":{\"Referer\":\"https://comic.example/\"}}'",
    },
    ruleToc: { chapterList: "$.data[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: { content: "$.content" },
  };

  const plainConverted = convertLegado(plain).sources["纯文本UA"];
  assert.equal(plainConverted.httpHeaders["User-Agent"], "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36");
  assert.equal(plainConverted.httpHeaders.Referer, "https://novel.example/");

  const { sources, warnings } = convertLegado(truncated);
  const converted = sources["截断引号头"];
  assert.equal(converted.httpHeaders["User-Agent"], "ComicUA/1.0");
  assert.equal(converted.httpHeaders.Referer, "https://comic.example/");
  assert.equal(converted.searchBook.cover, "cover_pic");
  assert.doesNotMatch(String(converted.searchBook.cover), /headers/);
  assert.ok(warnings.some((warning) => /封面规则中的阅读 headers 附加段/.test(warning.message)));
  assert.ok(!warnings.some((warning) => /请求配置不是有效 JSON/.test(warning.message)));
});

test("根级 JSONPath 递归下降由通用桥接器保留", () => {
  assert.equal(convertRule("@json:$..data[*]", { responseType: "json" }), "@json-recursive:data:values");
  assert.equal(convertRule("$..content", { responseType: "json" }), "@json-recursive:content");
  const warns = [];
  convertRule("@json:$..data[*]", { responseType: "json", warn: (message) => warns.push(message) });
  assert.ok(warns.some((message) => /根级递归下降/.test(message)));
  convertRule("$.payload..items[*]", { responseType: "json", warn: (message) => warns.push(message) });
  assert.ok(warns.some((message) => /递归下降/.test(message)));
});

test("公开合集常见语法：相对 XPath、~= 交替、##$## 追加、@js 请求头与 replaceRegex", () => {
  assert.equal(convertRule(".//span[@class='title']/text()"), ".//span[@class='title']/text()");
  assert.equal(convertRule(".//a/@href"), ".//a/@href");
  assert.equal(convertRule("text()"), "text()");
  assert.equal(convertRule("NA"), "");
  assert.equal(
    convertRule("[property~=category|status|update_time]@content"),
    "//*[(contains(@property, 'category') or contains(@property, 'status') or contains(@property, 'update_time'))]/@content",
  );
  assert.match(convertRule("{{baseUrl}}##$##?page=1"), /\?page=1/);
  assert.doesNotMatch(convertRule("{{baseUrl}}##$##?page=1"), /##\$##/);
  assert.match(convertRule("href##$##?page=1"), /\+ "\?page=1"/);
  assert.equal(
    convertRule('img@src##(.*)##$1,{"headers":{"Referer":"$1"}}###'),
    '//img/@src||@js:\nreturn String(result).replace(new RegExp("(.*)", "g"), "$1");',
  );

  const source = {
    bookSourceName: "合集语法样本",
    bookSourceUrl: "https://www.gutenberg.org/",
    searchUrl: "https://www.gutenberg.org/ebooks/search/?query={{key}}",
    header: `@js:\nJSON.stringify({\n  'User-Agent': "Mozilla/5.0",\n  'Referer': "https://www.gutenberg.org/"\n})`,
    ruleSearch: {
      bookList: "//li[@class='booklink']",
      name: ".//span[@class='title']/text()",
      bookUrl: ".//a/@href",
      kind: "[property~=category|status|update_time]@content",
    },
    ruleBookInfo: {
      init: '@put:{n:"[property$=book_name]@content",a:"[property$=author]@content"}',
      name: "@get:{n}",
      author: "@get:{a}",
    },
    ruleToc: {
      chapterList: ".directoryArea p a",
      chapterName: "text()",
      chapterUrl: "{{baseUrl}}##$##?page=1",
      nextTocUrl: "option@value",
    },
    ruleContent: {
      content: "#chaptercontent@html",
      replaceRegex: "##\\s*({{ book.durChapterTitle }}|作者：.*)\\s*",
    },
  };
  const { sources, warnings } = convertLegado(source);
  const converted = sources["合集语法样本"];
  assert.equal(converted.httpHeaders["User-Agent"], "Mozilla/5.0");
  assert.equal(converted.httpHeaders.Referer, "https://www.gutenberg.org/");
  assert.equal(converted.searchBook.list, "//li[@class='booklink']");
  assert.match(converted.searchBook.bookName, /\.\/\/span\[@class='title'\]/);
  assert.equal(converted.searchBook.detailUrl, ".//a/@href");
  assert.match(converted.searchBook.cat, /contains\(@property, 'category'\) or contains\(@property, 'status'\)/);
  assert.match(converted.bookDetail.bookName, /book_name/);
  assert.match(converted.chapterList.title, /text\(\)/);
  assert.match(converted.chapterList.url, /\?page=1/);
  assert.doesNotMatch(converted.chapterList.url, /##\$##/);
  assert.equal(converted.chapterList.nextPageUrl, "//option/@value");
  assert.match(converted.chapterContent.content, /queryInfo\.chapterTitle/);
  assert.doesNotMatch(converted.chapterContent.content, /\{\{\s*book\.durChapterTitle/);
  assert.doesNotMatch(converted.chapterContent.content, /new RegExp\("##/);
  assert.ok(!warnings.some((warning) => /请求配置不是有效 JSON/.test(warning.message)));
});
