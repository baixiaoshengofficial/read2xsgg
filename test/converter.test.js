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

  const jsonPost = convertRequest('/api/cate,{"method":"POST","body":"{\\"page\\":{\\"page\\":{{page}},\\"pageSize\\":10},\\"tag\\":\\"热血\\"}"}');
  assert.match(jsonPost.requestInfo, /let hp = JSON\.parse\(/);
  assert.match(jsonPost.requestInfo, /params\.pageIndex/);
  assert.match(jsonPost.requestInfo, /POST:true/);
  assert.match(jsonPost.requestInfo, /"Content-Type":"application\/json"/);
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

test("bookSourceType 映射为香色 sourceType，weight 不为 0", () => {
  const cases = [
    [0, "text"],
    [1, "audio"],
    [2, "comic"],
    [3, "text"],
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

test("漫蛙适配使用 config.host 的 API 详情与 HTML 目录", () => {
  const source = {
    bookSourceName: "漫蛙", bookSourceUrl: "https://www.mwwz.cc", bookSourceType: 2,
    searchUrl: "{{Url()}}/api/search?keyword={{key}}&page={{page}}",
    ruleSearch: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "{{Url()}}/api/comic/{{$.id}}" },
    ruleBookInfo: { init: "$.data", name: "$.title", intro: "@js:source.getVariable(); return result.intro;", tocUrl: "{{Url()}}/comic/{{$.id}}" },
    ruleToc: {
      chapterList: "#chapter-grid-container a", chapterName: "[class$=\"name\"]@text",
      chapterUrl: "href##(\\d+)$##/api/comic/image/$1?page=1###",
    },
    ruleContent: {
      content: "#content",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0B6666A0-BB59-1381-B746-a0E4C9AC'); return java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv);",
    },
    ruleExplore: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "{{Url()}}/api/comic/{{$.url##[^\\d]}}" },
    exploreUrl: [{ title: "热血", url: "{{Get('url')}}/api/cate/hotblooded,{\"method\":\"POST\",\"body\":\"{\\\"page\\\":{\\\"page\\\":{{page}}}}\"}" }],
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://xs.example.com" });
  const converted = sources["漫蛙"];
  assert.match(converted.searchBook.requestInfo, /config\.host/);
  assert.match(converted.searchBook.detailUrl, /config\.host.*api\/comic/);
  assert.match(converted.bookWorld["热血"].detailUrl, /config\.host.*api\/comic/);
  assert.match(converted.chapterList.requestInfo, /config\.host.*\/comic\//);
  assert.match(converted.chapterList.url, /config\.host.*\/api\/comic\/image\//);
  assert.match(converted.chapterList.url, /\/\/@href\|@js:/);
  assert.doesNotMatch(converted.chapterList.url, /\|\|@js:/);
  assert.doesNotMatch(converted.chapterList.url, /replace\(new RegExp/);
  const chapterUrlScript = converted.chapterList.url.split("|@js:")[1];
  assert.equal(
    new Function("result", "config", chapterUrlScript)("/comic/13827/2101951", converted.chapterList),
    "https://www.mwwz.cc/api/comic/image/2101951?page=1",
  );
  assert.equal(converted.bookDetail.tocUrl, undefined);
  assert.equal(converted.bookDetail.desc, "data/intro");
  assert.equal(converted.chapterContent.responseFormatType, "json");
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
  assert.match(multi, /\|@js:/);

  const req = convertRequest(
    "{{Get('url')}}/search/photos?search_query={{key}}&page={{page}}",
    { warn() {} },
  );
  assert.match(req.requestInfo, /config\.host/);
  assert.match(req.requestInfo, /params\.keyWord/);
  assert.match(req.requestInfo, /params\.pageIndex/);
  assert.match(req.requestInfo, /return \{/);
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
  assert.equal(converted.chapterList.requestInfo, "%@result");
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
    bookSourceUrl: "https://www.mwwz.cc/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: "$.data.list[*]", name: "$.title", bookUrl: "$.id" },
    ruleBookInfo: { name: "$.data.title" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "@js:JSON.parse(src).data.images.map(x => `<img src=\"${x.url}\">`).join('\\n');",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0B6666A0-BB59-1381-B746-a0E4C9AC'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example.com/" });
  const content = sources["AES 漫画"].chapterContent.content;
  assert.match(content, /https:\/\/convert\.example\.com\/image\/mwwz-aes\?url=/);
  assert.match(content, /payload\.data/);
  assert.match(content, /JSON\.stringify\(\{urls:/);
  assert.match(content, /encodeURIComponent\(url\)/);
  assert.doesNotMatch(content, /<img src=/);
  assert.doesNotMatch(content, /source\.getVariable|JSON\.parse\(src\)/);
  assert.ok(warnings.some((warning) => warning.message.includes("图片解码代理")));
});

test("禁漫 Canvas 图片规则通过图片代理改写为可移植的图片标签", () => {
  const source = {
    bookSourceName: "禁漫测试",
    bookSourceUrl: "https://jm.example.com/",
    bookSourceType: 2,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".chapter", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: "{{@class.row@tag.img@data-original}}\n@js:var url = baseUrl; result;",
      imageDecode: "var bookId = 1; var imgId = 2; var img = BitmapFactory.decodeByteArray(result, 0, result.length); var canvas = new Canvas(img);",
    },
  };
  const { sources, warnings } = convertLegado(source, { imageProxyBase: "https://convert.example.com" });
  const content = sources["禁漫测试"].chapterContent.content;
  assert.match(content, /https:\/\/convert\.example\.com\/image\/jm-scramble\?url=/);
  assert.match(content, /encodeURIComponent\(url\)/);
  assert.doesNotMatch(content, /baseUrl/);
  assert.ok(warnings.some((warning) => warning.message.includes("jm-scramble")));
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
