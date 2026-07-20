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
    "(.//*[contains(concat(' ', normalize-space(@class), ' '), ' book_other ')])[1]//span[1]",
  );
  assert.equal(converted.chapterList.list, "(//*[contains(concat(' ', normalize-space(@class), ' '), ' box_con ')]//dd)[self::a[@href] or .//a[@href]]");
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
  assert.equal(convertRule("id.info@tag.p.0@a@text"), "//*[@id='info']//p[1]//a/text()");
  assert.equal(
    convertRule(".txt-list > li:nth-child(n+2)"),
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' txt-list ')]/li[position() >= 2]",
  );
  assert.equal(convertRule("tbody>tr!0"), "//tbody/tr[position() > 1]");
  assert.equal(convertRule(".l li[0:-1]"), "//*[contains(concat(' ', normalize-space(@class), ' '), ' l ')]//li[position() >= 1 and position() <= last() - 1]");
  assert.equal(convertRule('##<a\\s*href="([^\"]+)"##$1###'), "//a/@href");
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
  assert.equal(converted.chapterList.list, "(//a[contains(@href, '/read/')])[self::a[@href] or .//a[@href]]");
  assert.equal(converted.chapterList.title, ".");
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
  assert.match(post.requestInfo, /"offset":\s*params\.pageIndex\s*-\s*1/);

  const jsonPost = convertRequest('/api/cate,{"method":"POST","body":"{\\"page\\":{\\"page\\":{{page}},\\"pageSize\\":10},\\"tag\\":\\"热血\\"}"}');
  assert.match(jsonPost.requestInfo, /let hp = JSON\.parse\(/);
  assert.match(jsonPost.requestInfo, /params\.pageIndex/);
  assert.match(jsonPost.requestInfo, /POST:true/);
  assert.match(jsonPost.requestInfo, /"Content-Type":\s*"application\/json"/);
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
  assert.match(converted.chapterList.url, /\/\/@href\|\|@js:/);
  assert.doesNotMatch(converted.chapterList.url, /replace\(new RegExp/);
  const chapterUrlScript = converted.chapterList.url.split("||@js:")[1];
  assert.equal(
    new Function("result", "config", chapterUrlScript)("/comic/13827/2101951", converted.chapterList),
    "https://www.mwwz.cc/api/comic/image/2101951?page=1",
  );
  assert.equal(converted.bookDetail.tocUrl, undefined);
  assert.equal(converted.bookDetail.desc, "data/intro");
  assert.equal(converted.chapterContent.responseFormatType, "json");
  assert.match(converted.chapterContent.content, /^data\/images\|@js:/);
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
  assert.match(content, /^data\/images\|@js:/);
  assert.match(content, /https:\/\/convert\.example\.com\/image\/aes-cbc-prefix-iv-[A-Za-z0-9_-]+\?url=/);
  assert.equal(sources["AES 漫画"].chapterContent.requestInfo, "%@result");
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
  assert.match(content, /^urls\|@js:/);
  assert.match(content, /https:\/\/convert\.example\.com\/image\/id-md5-reverse-tiles\?url=/);
  assert.match(content, /encodeURIComponent\(String\(url/);
  assert.doesNotMatch(content, /baseUrl/);
  assert.match(sources["禁漫测试"].chapterContent.requestInfo, /params\.queryInfo/);
  assert.ok(warnings.some((warning) => warning.message.includes("id-md5-reverse-tiles")));
  const chapterList = sources["禁漫测试"].chapterList;
  assert.equal(chapterList.responseFormatType, "html");
  assert.match(sources["禁漫测试"].bookDetail.requestInfo, /params\.queryInfo/);
  assert.match(chapterList.requestInfo, /params\.queryInfo/);
  const requestFunction = new Function("config", "params", "result", chapterList.requestInfo.replace(/^@js:\s*/, ""));
  assert.equal(
    requestFunction({ host: "https://jm.example.com" }, { queryInfo: { detailUrl: "/album/1/中文" } }, "%@result"),
    "https://jm.example.com/album/1/%E4%B8%AD%E6%96%87",
  );
  assert.match(chapterList.list, /btn-toolbar/);
  assert.match(chapterList.list, /reading/);
  assert.match(chapterList.title, /h3\/text/);
  assert.equal(chapterList.url, "//@href");
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

test("禁漫动态发现脚本转换为香色可见的静态分类", () => {
  const source = {
    bookSourceName: "禁漫分类测试",
    bookSourceUrl: "https://jmcomicqa.cc",
    bookSourceType: 2,
    exploreUrl: `@js:
      var categories = [
        ["全部", "albums?o={key}&page="],
        ["单本", "albums/single?o={key}&page=<,{{page}}>"]
      ];
      JSON.stringify(categories);`,
    searchUrl: "{{Get('url')}}/search/photos?search_query={{key}}&page={{page}}",
    ruleSearch: {
      bookList: ".list-col||.list-item",
      name: ".video-title@text",
      author: "@js:java.getString('.author@text');",
      bookUrl: "tag.a.0@href",
      coverUrl: "img@data-original||img@src",
    },
    ruleExplore: [],
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".reading", chapterName: "text", chapterUrl: "href" },
    ruleContent: { content: ".thumb-overlay-albums@img@data-original" },
  };
  const { sources } = convertLegado(source);
  const converted = sources["禁漫分类测试"];

  assert.deepEqual(Object.keys(converted.bookWorld), ["全部", "单本"]);
  assert.match(converted.bookWorld["全部"].requestInfo, /albums\?o=mr&page=/);
  assert.match(converted.bookWorld["全部"].requestInfo, /params\.pageIndex/);
  assert.equal(converted.bookWorld["全部"].moreKeys.pageSize, 80);
  assert.match(converted.bookWorld["全部"].list, /list-col/);
  assert.match(converted.bookWorld["全部"].bookName, /video-title/);
  assert.match(converted.bookWorld["全部"].detailUrl, /match\(\/\\\/album/);
  assert.equal(converted.bookWorld["全部"].author, undefined);
  assert.match(converted.bookDetail.requestInfo, /params\.queryInfo/);
  assert.doesNotMatch(JSON.stringify(converted.bookDetail), /java\.|Packages/);
  assert.doesNotMatch(JSON.stringify(converted.searchBook), /java\.|Packages/);
  assert.match(converted.chapterList.requestInfo, /params\.queryInfo/);
  assert.match(converted.chapterList.list, /btn-toolbar/);
  assert.match(converted.chapterList.list, /reading/);
  assert.doesNotMatch(converted.chapterList.list, /java\.|book\.type/);
  assert.match(converted.chapterList.title, /h3\/text/);
  assert.match(converted.chapterList.title, /\.trim\(\)/);
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
  assert.match(world["分类"].moreKeys.requestFilters, /^分类 1::\/category\/1\?page=%@pageIndex/m);
  assert.match(world["分类"].moreKeys.requestFilters, /分类 12::\/category\/12\?page=%@pageIndex$/m);
  assert.equal(world["分类"].requestInfo, "%@filter");
  assert.doesNotMatch(world["分类"].moreKeys.requestFilters, /^category$/m);
  assert.ok(warnings.some((warning) => warning.message.includes("压缩为香色 requestFilters")));
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
  assert.equal(sources["空分类源"], undefined);
  assert.deepEqual(skipped.map((item) => item.source), ["空分类源"]);
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
  assert.match(world.list, /masonry-item/);
  assert.equal(world.bookName, "//h5");
  assert.equal(world.detailUrl, "//a/@href");
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
  assert.match(request, /convert\.example\/adapter\/toc\?hint=/);
  assert.match(request, /encodeURIComponent\(u\)/);
});

test("在线质量门槛跳过仍含 Android 运行时的伪可用源", () => {
  const good = structuredClone(sampleSource);
  good.bookSourceName = "可移植源";
  const bad = structuredClone(sampleSource);
  bad.bookSourceName = "Android 专用源";
  bad.searchUrl = "@js:\nreturn java.ajax(source.getKey());";
  const { sources, skipped } = convertLegado([good, bad], { omitNonPortable: true });
  assert.ok(sources["可移植源"]);
  assert.equal(sources["Android 专用源"], undefined);
  assert.deepEqual(skipped.map((item) => item.source), ["Android 专用源"]);
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
  assert.equal(converted.bookDetail.bookName, "//h1/text()");
  assert.equal(converted.searchBook.list, "//div[@class='card']");
  assert.equal(converted.searchBook.bookName, "//h2/text()");
  assert.equal(converted.searchBook.detailUrl, "//a/@href");
  assert.equal(converted.bookWorld["分类"].detailUrl, "//a/@href");
  assert.equal(converted.chapterList.title, "//a/text()");
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
  assert.equal(world.bookName, "//*[contains(concat(' ', normalize-space(@class), ' '), ' name ')]/text()");
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
