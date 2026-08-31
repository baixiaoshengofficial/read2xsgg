import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import {
  detectKind,
  detectKinds,
  discoverNovel,
  discoverComic,
  discoverMedia,
  novelDiscoveryToXiangse,
  comicDiscoveryToXiangse,
  mediaDiscoveryToXiangse,
  analyzeSite,
  validateXiangseSource,
  runXbsPipeline,
  runXbsChapterContent,
  downloadAsFetch,
  repairChapterFromBook,
  repairDetailFromBook,
  discoverContentRule,
  repairContentFromChapter,
  repairBooksFromRequests,
  repairChaptersFromBookJson,
  compileBookBridgePlan,
  compileChapterBridgePlan,
  compileDetailBridgePlan,
  decodeBridgePlan,
  executeBridgePlan,
} from "../src/index.js";
import { applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
import {
  verifyConvertedSource,
  resolveBookTargetRequest,
  resolveBookTargetRequests,
  resolveBookTargetUrl,
  resolveBookTargetUrls,
  resolveChapterListUrls,
  extractBookIdFromUrl,
  usableComicContentReport,
  usableComicPageUrl,
  bookElementReport,
  chapterUrlLooksLikeBookSibling,
  usableChapterRow,
} from "../src/verifySource.js";
import { skippedBuckets } from "../src/converter.js";
import { bridgeTocUrl, encodeBridgePlan } from "../src/bridgePlan.js";
import {
  bookNameSelector,
  chapterAnchorSelectorFromLinks,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  stableAnchorSelectorFromLinks,
} from "../src/siteAnalyze/domUtil.js";
import { discoverSpaMedia } from "../src/siteAnalyze/spaMedia.js";

const novelHome = `<!doctype html><html><head><title>示例小说网</title>
<meta charset="utf-8">
</head><body>
<form action="/search.php" method="get" class="search-form">
  <input type="text" name="searchkey" placeholder="搜索书名">
  <button type="submit">搜索</button>
</form>
<ul class="list">
  <li><img src="/cover/1.jpg" alt=""><a href="/book/1.html">第一本书</a></li>
  <li><img src="/cover/2.jpg" alt=""><a href="/book/2.html">第二本书</a></li>
  <li><img src="/cover/3.jpg" alt=""><a href="/book/3.html">第三本书</a></li>
  <li><img src="/cover/4.jpg" alt=""><a href="/book/4.html">第四本书</a></li>
</ul>
</body></html>`;

const novelDetail = `<!doctype html><html><head>
<meta property="og:image" content="/cover/1.jpg">
</head><body>
<div class="imgbox"><img src="/cover/1.jpg" alt="封面"></div>
<h1>第一本书</h1>
<div class="chapter-list">
  <a href="/chapter/1.html">第一章</a>
  <a href="/chapter/2.html">第二章</a>
  <a href="/chapter/3.html">第三章</a>
</div>
</body></html>`;

const novelChapter = `<!doctype html><html><body>
<div id="content"><p>${"正文内容。".repeat(40)}</p></div>
</body></html>`;

const comicHome = `<!doctype html><html><head><title>示例漫画网</title></head><body>
<p>漫画 comic manga 阅读</p>
<form action="/comic/search" method="get">
  <input name="q" placeholder="搜索漫画">
</form>
<ul class="comic-list">
  <li><img data-src="/cover/c1.jpg" alt=""><a href="/comic/1.html">漫画甲</a></li>
  <li><img data-src="/cover/c2.jpg" alt=""><a href="/comic/2.html">漫画乙</a></li>
  <li><img data-src="/cover/c3.jpg" alt=""><a href="/comic/3.html">漫画丙</a></li>
  <li><img data-src="/cover/c4.jpg" alt=""><a href="/comic/4.html">漫画丁</a></li>
</ul>
</body></html>`;

const comicDetail = `<!doctype html><html><body>
<div class="cover"><img src="/cover/c1.jpg" alt="封面"></div>
<h1>漫画甲</h1>
<div class="chapter-list">
  <a href="/comic/1/1.html">第1话</a>
  <a href="/comic/1/2.html">第2话</a>
  <a href="/comic/1/3.html">第3话</a>
</div>
</body></html>`;

const comicChapter = `<!doctype html><html><body>
${'<img src="/img/1.jpg">'.repeat(8)}
</body></html>`;

const audioHome = `<!doctype html><html><head><title>示例听书网</title></head><body>
<p>听书 有声</p>
<ul class="audio-list">
  <li><a href="/audio/1.html">有声甲</a></li>
  <li><a href="/audio/2.html">有声乙</a></li>
  <li><a href="/audio/3.html">有声丙</a></li>
  <li><a href="/audio/4.html">有声丁</a></li>
</ul>
</body></html>`;

const audioDetail = `<!doctype html><html><body>
<h1>有声甲</h1>
<div class="chapter-list">
  <a href="/audio/1/1.mp3">第1集</a>
  <a href="/audio/1/2.mp3">第2集</a>
  <a href="/audio/1/3.mp3">第3集</a>
</div>
</body></html>`;

const mixedHome = `<!doctype html><html><head><title>综合站点</title></head><body>
<p>小说 漫画 comic 听书 有声</p>
<form action="/search.php" method="get"><input name="searchkey" placeholder="搜索"></form>
<ul class="list">
  <li><img src="/cover/1.jpg" alt=""><a href="/book/1.html">第一本书</a></li>
  <li><img src="/cover/2.jpg" alt=""><a href="/book/2.html">第二本书</a></li>
  <li><img src="/cover/3.jpg" alt=""><a href="/book/3.html">第三本书</a></li>
  <li><img src="/cover/4.jpg" alt=""><a href="/book/4.html">第四本书</a></li>
</ul>
<ul class="comic-list">
  <li><img data-src="/cover/c1.jpg" alt=""><a href="/comic/1.html">漫画甲</a></li>
  <li><img data-src="/cover/c2.jpg" alt=""><a href="/comic/2.html">漫画乙</a></li>
  <li><img data-src="/cover/c3.jpg" alt=""><a href="/comic/3.html">漫画丙</a></li>
  <li><img data-src="/cover/c4.jpg" alt=""><a href="/comic/4.html">漫画丁</a></li>
</ul>
<ul class="audio-list">
  <li><a href="/audio/1.html">有声甲</a></li>
  <li><a href="/audio/2.html">有声乙</a></li>
  <li><a href="/audio/3.html">有声丙</a></li>
  <li><a href="/audio/4.html">有声丁</a></li>
</ul>
</body></html>`;

function fixtureDownload(url) {
  const href = String(url);
  if (/\.(?:jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(href)) {
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  }
  if (/\/comic\/\d+\/\d+\.html/.test(href)) return Buffer.from(comicChapter);
  if (/\/comic\/\d+\.html/.test(href)) return Buffer.from(comicDetail);
  if (/\/comic\/search/.test(href)) return Buffer.from(comicHome);
  if (/\/search\.php/.test(href)) return Buffer.from(novelHome);
  if (/\/audio\/\d+\/\d+\.mp3/.test(href)) return Buffer.from("ID3fakeaudio");
  if (/\/audio\/\d+\.html/.test(href)) return Buffer.from(audioDetail);
  if (/\/book\/1\.html/.test(href)) return Buffer.from(novelDetail);
  if (/\/chapter\//.test(href)) return Buffer.from(novelChapter);
  if (/mixed\.example/.test(href)) return Buffer.from(mixedHome);
  if (/comic\.example/.test(href)) return Buffer.from(comicHome);
  if (/audio\.example/.test(href)) return Buffer.from(audioHome);
  return Buffer.from(novelHome);
}

test("detectKind 识别小说站信号", () => {
  const kind = detectKind(novelHome, "https://novel.example/");
  assert.equal(kind.kind, "text");
  assert.ok(kind.confidence > 0.2);
});

test("detectKind 识别漫画站信号", () => {
  const html = `<html><body>${'<img src="a.jpg">'.repeat(30)}<p>漫画章节图片</p></body></html>`;
  assert.equal(detectKind(html).kind, "comic");
});

test("detectKind 从视频作品路径和文字识别视频站", () => {
  const html = Array.from({ length: 4 }, (_, index) => (
    `<a href="/video/${index + 1}.html"><img src="/covers/${index + 1}.jpg">视频作品${index + 1}</a>`
  )).join("");
  assert.equal(detectKind(html, "https://media.example/").kind, "video");
});

test("detectKinds 混合站可同时命中多种类型", () => {
  const kinds = detectKinds(mixedHome, "https://mixed.example/");
  const set = new Set(kinds.map((item) => item.kind));
  assert.ok(set.has("text"));
  assert.ok(set.has("comic"));
  assert.ok(set.has("audio"));
});

test("链接聚类把根目录动态数字 HTML 归为同一种列表路径", () => {
  const html = '<a href="/10001.html">书一</a><a href="/10002.html">书二</a><a href="/10003.html">书三</a>';
  const document = loadDocument(html, "https://root-books.example/");
  const anchors = pageAnchors(document, "https://root-books.example/", "https://root-books.example");
  assert.equal(scoreLinkCluster(anchors, "https://root-books.example/").length, 3);
});

test("列表 XPath 保留容器与多层嵌套条目之间的后代轴", () => {
  const html = [
    '<div class="container"><ul>',
    '<li><p><a href="/1">书一</a></p></li>',
    '<li><p><a href="/2">书二</a></p></li>',
    '<li><p><a href="/3">书三</a></p></li>',
    "</ul></div>",
  ].join("");
  const document = loadDocument(html, "https://nested-books.example/");
  const links = [...document.querySelectorAll("p > a")];
  const selector = listSelectorFromLinks(links, document);
  const result = document.evaluate(
    selector,
    document,
    null,
    document.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );

  assert.match(selector, /\/\/p$/);
  assert.equal(result.snapshotLength, 3);
});

test("DOM 识站忽略脚本中的伪标签但保留页面列表", () => {
  const html = [
    '<script>const fake = "<a href=\'/fake/1\'>伪书籍</a>";</script>',
    '<style>.book { color: red; }</style>',
    '<div class="books"><a href="/book/1">真实书籍</a></div>',
  ].join("");
  const document = loadDocument(html, "https://books.example/");
  const anchors = pageAnchors(document, "https://books.example/", "https://books.example");
  assert.deepEqual(anchors.map((item) => item.text), ["真实书籍"]);
  assert.equal(loadDocument("<style>broken {</style", "https://books.example/").querySelector("style"), null);
});

test("正文识别选择高文本密度且低链接密度的语义容器", () => {
  const body = "这是章节正文内容。".repeat(30);
  const html = `<nav>${'<a href="/menu">目录链接</a>'.repeat(20)}</nav><div class="chapter-content"><p>${body}</p></div>`;
  assert.match(
    discoverContentRule(html, "https://novel.example/read/1"),
    /chapter-content/,
  );
});

test("discoverNovel 从 HTML fixture 发现列表/目录/正文", async () => {
  const discovery = await discoverNovel("https://novel.example/", { download: fixtureDownload });
  assert.ok(discovery);
  assert.match(discovery.listSelector, /list|a/i);
  assert.ok(discovery.chapterListSelector);
  assert.equal(discovery.contentSelector, "//*[@id='content']");
  assert.match(discovery.listCoverSelector, /img\/@/);
  assert.match(discovery.detailCoverSelector, /og:image|imgbox|cover/);
  assert.match(discovery.searchRequestInfo, /searchkey=%@keyWord|params\.keyWord/);
  assert.ok(discovery.bookCount >= 3);
  assert.ok(discovery.chapterCount >= 2);
});

test("discoverComic 从 HTML fixture 发现漫画结构", async () => {
  const discovery = await discoverComic("https://comic.example/", { download: fixtureDownload });
  assert.ok(discovery);
  assert.equal(discovery.kind, "comic");
  assert.ok(discovery.imageCount >= 3);
  assert.match(discovery.contentSelector, /urls/);
});

test("discoverNovel 识别并验证分类列表下一页模板", async () => {
  const page1 = `<!doctype html><html><head><title>分页小说</title></head><body>
  <ul class="list">
    <li><a href="/book/1.html">第一页书一</a></li>
    <li><a href="/book/2.html">第一页书二</a></li>
    <li><a href="/book/3.html">第一页书三</a></li>
  </ul>
  <a class="next" href="/page/2/">下一页</a>
  </body></html>`;
  const page2 = `<!doctype html><html><head><title>分页小说</title></head><body>
  <ul class="list">
    <li><a href="/book/21.html">第二页书一</a></li>
    <li><a href="/book/22.html">第二页书二</a></li>
    <li><a href="/book/23.html">第二页书三</a></li>
  </ul>
  </body></html>`;
  const detail = (title, id) => `<!doctype html><html><body>
  <h1>${title}</h1>
  <div class="chapter-list"><a href="/chapter/${id}.html">第一章</a><a href="/chapter/${id + 1}.html">第二章</a></div>
  </body></html>`;
  const chapter = `<!doctype html><html><body><div id="content">${"分页正文。".repeat(40)}</div></body></html>`;
  const download = async (url) => {
    const href = String(url);
    if (/\/page\/2\/?$/.test(href)) return Buffer.from(page2);
    if (/\/book\/1\.html/.test(href)) return Buffer.from(detail("第一页书一", 1));
    if (/\/book\/21\.html/.test(href)) return Buffer.from(detail("第二页书一", 21));
    if (/\/chapter\/(?:1|21)\.html/.test(href)) return Buffer.from(chapter);
    return Buffer.from(page1);
  };

  const discovery = await discoverNovel("https://paged-novel.example/", { download });
  assert.ok(discovery);
  assert.equal(discovery.listUrl, "https://paged-novel.example/page/%@pageIndex/");
  assert.equal(discovery.listPageSize, 3);
  const source = novelDiscoveryToXiangse(discovery, { sourceName: "分页小说" });
  assert.equal(source.bookWorld["站点首页"].moreKeys.pageSize, 3);
  const report = await runXbsPipeline(source, {
    fetchImpl: downloadAsFetch(download),
    pageIndex: 2,
  });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.bookName, "第二页书一");
  assert.match(report.steps.bookWorld.requestUrl, /\/page\/2\/?$/);
});

test("discoverComic 识别并验证漫画分类下一页模板", async () => {
  const page1 = `<!doctype html><html><head><title>分页漫画</title></head><body>
  <p>漫画 comic manga</p>
  <ul class="comic-list">
    <li><img src="/c1.jpg"><a href="/comic/1.html">漫画一</a></li>
    <li><img src="/c2.jpg"><a href="/comic/2.html">漫画二</a></li>
    <li><img src="/c3.jpg"><a href="/comic/3.html">漫画三</a></li>
  </ul>
  <a rel="next" href="/list?page=2">Next</a>
  </body></html>`;
  const page2 = `<!doctype html><html><head><title>分页漫画</title></head><body>
  <p>漫画 comic manga</p>
  <ul class="comic-list">
    <li><img src="/c21.jpg"><a href="/comic/21.html">漫画二一</a></li>
    <li><img src="/c22.jpg"><a href="/comic/22.html">漫画二二</a></li>
    <li><img src="/c23.jpg"><a href="/comic/23.html">漫画二三</a></li>
  </ul>
  </body></html>`;
  const detail = (title, id) => `<!doctype html><html><body>
  <h1>${title}</h1>
  <div class="chapter-list"><a href="/comic/${id}/1.html">第1话</a><a href="/comic/${id}/2.html">第2话</a></div>
  </body></html>`;
  const chapter = `<!doctype html><html><body>${'<img src="/img/page.jpg">'.repeat(5)}</body></html>`;
  const download = async (url) => {
    const href = String(url);
    if (/\/list\?page=2$/.test(href)) return Buffer.from(page2);
    if (/\/comic\/1\.html/.test(href)) return Buffer.from(detail("漫画一", 1));
    if (/\/comic\/21\.html/.test(href)) return Buffer.from(detail("漫画二一", 21));
    if (/\/comic\/(?:1|21)\/1\.html/.test(href)) return Buffer.from(chapter);
    if (/\.(?:jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(href)) return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    return Buffer.from(page1);
  };

  const discovery = await discoverComic("https://paged-comic.example/", { download });
  assert.ok(discovery);
  assert.equal(discovery.listUrl, "https://paged-comic.example/list?page=%@pageIndex");
  const source = comicDiscoveryToXiangse(discovery, { sourceName: "分页漫画" });
  const report = await runXbsPipeline(source, {
    fetchImpl: downloadAsFetch(download),
    pageIndex: 2,
    fetchMedia: false,
  });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.bookName, "漫画二一");
  assert.match(report.steps.bookWorld.requestUrl, /\/list\?page=2$/);
});

test("discoverNovel 拒绝实际内容重复的下一页模板", async () => {
  const page = `<!doctype html><html><head><title>重复分页小说</title></head><body>
  <ul class="list">
    <li><a href="/book/1.html">重复书一</a></li>
    <li><a href="/book/2.html">重复书二</a></li>
    <li><a href="/book/3.html">重复书三</a></li>
  </ul>
  <a class="next" href="/page/2/">下一页</a>
  </body></html>`;
  const detail = `<!doctype html><html><body>
  <h1>重复书一</h1>
  <div class="chapter-list"><a href="/chapter/1.html">第一章</a><a href="/chapter/2.html">第二章</a></div>
  </body></html>`;
  const chapter = `<!doctype html><html><body><div id="content">${"重复正文。".repeat(40)}</div></body></html>`;
  const download = async (url) => {
    const href = String(url);
    if (/\/book\/1\.html/.test(href)) return Buffer.from(detail);
    if (/\/chapter\/1\.html/.test(href)) return Buffer.from(chapter);
    return Buffer.from(page);
  };

  const discovery = await discoverNovel("https://repeat-page.example/", { download });
  assert.ok(discovery);
  assert.equal(discovery.listUrl, "https://repeat-page.example/");
  assert.equal(discovery.listPageSize, 20);
});

test("discoverMedia 从 HTML fixture 发现听书结构", async () => {
  const discovery = await discoverMedia("https://audio.example/", "audio", { download: fixtureDownload });
  assert.ok(discovery);
  assert.equal(discovery.kind, "audio");
  assert.ok(discovery.chapterCount >= 2);
});

test("discoverMedia 排除媒体作者归档并选择带封面的作品详情", async () => {
  const host = "https://video-cards.example";
  const home = [
    '<article><a href="/video/1.html"><img src="/cover/1.jpg">视频作品一</a><a href="/video/author/a">作者甲</a></article>',
    '<article><a href="/video/2.html"><img src="/cover/2.jpg">视频作品二</a><a href="/video/author/b">作者乙</a></article>',
  ].join("");
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (/^\/video\/\d+\.html$/.test(path)) {
      return Buffer.from(`<h1>视频作品</h1><video src="${host}/media/play.m3u8"></video>`);
    }
    throw new Error(`fixture missing: ${url}`);
  };
  const discovery = await discoverMedia(`${host}/`, "video", {
    download,
    adapterBase: "https://convert.example",
  });
  assert.ok(discovery);
  assert.match(discovery.detailSampleUrl, /\/video\/\d+\.html$/);
  assert.doesNotMatch(discovery.detailSampleUrl, /\/author\//);
  assert.equal(discovery.chapterCount, 1);
});

test("discoverMedia 通用识别重复内容卡、单节目媒体和列表分页", async () => {
  const home = (page) => `<!doctype html><html><head><title>有声站</title></head><body>
    <p>听书 有声 音频</p>
    <article class="post post-list"><h2><a rel="bookmark" href="/work/${page}1">作品${page}1</a></h2></article>
    <article class="post post-list"><h2><a rel="bookmark" href="/work/${page}2">作品${page}2</a></h2></article>
    ${page === 1 ? '<a rel="next" href="/page/2/">下一页</a>' : ""}
  </body></html>`;
  const detail = '<html><body><h1>作品11</h1><audio><source src="https://cdn.example/11.mp3"></audio></body></html>';
  const download = async (url) => {
    if (String(url).includes("/page/2/")) return Buffer.from(home(2));
    if (String(url).includes("/work/")) return Buffer.from(detail);
    return Buffer.from(home(1));
  };
  const discovery = await discoverMedia("https://card-audio.example/", "audio", {
    download,
    adapterBase: "https://converter.example",
  });
  assert.ok(discovery);
  assert.match(discovery.listSelector, /article/);
  assert.match(discovery.listRequestInfo, /page\/%@pageIndex/);
  assert.match(discovery.chapterRequestInfo, /adapter\/single-chapter/);
  assert.equal(discovery.chapterListSelector, "$.data");
  assert.match(discovery.contentRequestInfo, /adapter\/media/);
  const source = mediaDiscoveryToXiangse(discovery, { sourceName: "单节目音频" });
  const detailValues = executeBridgePlan(
    detail,
    "https://card-audio.example/work/11",
    compileDetailBridgePlan(source.bookDetail),
  );
  assert.equal(detailValues.lastChapterTitle, "播放");
});

test("discoverMedia 从混合首页选择最大的稳定节目卡组", async () => {
  const home = `<!doctype html><html><head><title>混合有声首页</title></head><body>
    <p>听书 有声 音频</p>
    <a class="catitem" href="/categories/1">小说</a>
    <a class="catitem" href="/categories/2">历史</a>
    <a class="rank-item" href="/channels/99">排行榜节目</a>
    ${Array.from({ length: 5 }, (_, index) => `<a class="list-item" href="/vchannels/${index + 1}"><span class="title">节目${index + 1}</span></a>`).join("")}
  </body></html>`;
  const detail = `<!doctype html><html><body><h1>节目1</h1>
    ${Array.from({ length: 4 }, (_, index) => `<a href="/vchannels/1/programs/${index + 10}">正文标题${String.fromCharCode(65 + index)}</a>`).join("")}
  </body></html>`;
  const program = '<html><body><script>window.player={"audioUrl":"https://cdn.example/episode.mp3"}</script></body></html>';
  const discovery = await discoverMedia("https://mixed-audio.example/", "audio", {
    homeHtml: home,
    adapterBase: "https://converter.example",
    download: async (url) => Buffer.from(String(url).includes("/programs/") ? program
      : String(url).includes("/vchannels/") ? detail : home),
  });
  assert.match(discovery.listSelector, /list-item/);
  assert.match(discovery.detailUrlSelector, /\/\/@href/);
  assert.equal(discovery.bookCount, 5);
  assert.match(discovery.detailSampleUrl, /\/vchannels\/1$/);
  assert.equal(discovery.chapterCount, 4);
  assert.match(discovery.chapterSampleUrl, /\/programs\//);
});

test("discoverMedia 将详情页分隔媒体列表转换为真实章节目录", async () => {
  const home = '<html><body><p>听书 音频</p><article><h2><a href="/work/1">合集一</a></h2></article><article><h2><a href="/work/2">合集二</a></h2></article></body></html>';
  const detail = '<html><body><h1>合集一</h1><div data-title="第一集|第二集" data-address="https://cdn.example/1.mp3|https://cdn.example/2.mp3"></div></body></html>';
  const discovery = await discoverMedia("https://playlist.example/", "audio", {
    homeHtml: home,
    adapterBase: "https://converter.example",
    download: async (url) => Buffer.from(String(url).includes("/work/") ? detail : home),
  });
  assert.ok(discovery);
  assert.equal(discovery.chapterCount, 2);
  assert.match(discovery.chapterRequestInfo, /adapter\/media-playlist/);
  assert.equal(discovery.chapterListSelector, "$.data");
  assert.equal(discovery.chapterSampleUrl, "https://cdn.example/1.mp3");
  const source = mediaDiscoveryToXiangse(discovery, { sourceName: "分隔媒体" });
  assert.ok(source.bookDetail.lastChapterTitle);
  const detailValues = executeBridgePlan(
    detail,
    "https://playlist.example/work/1",
    compileDetailBridgePlan(source.bookDetail),
  );
  assert.equal(detailValues.lastChapterTitle, "第二集");
});

test("媒体识站正文不会二次编码已转义的非 ASCII 播放地址", async () => {
  const home = '<html><body><p>听书 音频</p><article><h2><a href="/work/1">合集一</a></h2></article><article><h2><a href="/work/2">合集二</a></h2></article></body></html>';
  const detail = '<html><body><h1>合集一</h1><audio src="https://cdn.example/%E4%B8%AD%E6%96%87.mp3"></audio></body></html>';
  const discovery = await discoverMedia("https://encoded-audio.example/", "audio", {
    homeHtml: home,
    adapterBase: "https://converter.example",
    download: async (url) => Buffer.from(String(url).includes("/work/") ? detail : home),
  });
  const source = mediaDiscoveryToXiangse(discovery, { sourceName: "编码音频" });
  const chapterUrl = "https://cdn.example/%E4%B8%AD%E6%96%87.mp3";
  const report = await runXbsChapterContent(source, {
    chapterUrl,
    detailUrl: "https://encoded-audio.example/work/1",
  }, {
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/adapter/media?")) {
        const requestUrl = new URL(url);
        const mediaUrl = requestUrl.searchParams.get("url");
        assert.equal(requestUrl.searchParams.get("referer"), "https://encoded-audio.example/work/1");
        return new Response(JSON.stringify({
          url: mediaUrl,
          httpHeaders: { Referer: requestUrl.searchParams.get("referer") },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(String(url), chapterUrl);
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers.Referer, "https://encoded-audio.example/work/1");
      return new Response(null, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "1024" },
      });
    },
  });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.firstUrl, chapterUrl);
  assert.equal(report.httpHeaders.Referer, "https://encoded-audio.example/work/1");
});

test("discoverMedia 从 SSR 内容卡生成路径式搜索和动态播放解析", async () => {
  const home = `<!doctype html><html><head><title>节目搜索</title></head><body>
    <p>音频 节目</p><input class="search-bar" placeholder="搜索" value="小说">
    <a class="list-item" href="/channels/1/programs/11"><div class="title">节目甲</div></a>
    <a class="list-item" href="/channels/2/programs/22"><div class="title">节目乙</div></a>
  </body></html>`;
  const detail = '<html><body><h1>节目甲</h1><script>window.data={"audioUrl":"https://audio.example/redirect/11"}</script></body></html>';
  const download = async (url) => Buffer.from(String(url).includes("/programs/") ? detail : home);
  const discovery = await discoverMedia(
    "https://ssr-audio.example/search/all/%E5%B0%8F%E8%AF%B4/",
    "audio",
    { download, homeHtml: home, adapterBase: "https://converter.example" },
  );
  assert.ok(discovery);
  assert.match(discovery.listSelector, /list-item/);
  assert.match(discovery.searchRequestInfo, /search\/all\/%@keyWord/);
  assert.match(discovery.chapterRequestInfo, /single-chapter/);
  assert.match(discovery.contentRequestInfo, /adapter\/media/);
});

test("discoverSpaMedia 通用识别 SPA JSON 目录、分页、详情与音频", async () => {
  const home = `<!doctype html><html><head><title>SPA Audio</title>
  <script src="/assets/app.js"></script></head><body>听书 有声 音频</body></html>`;
  const script = `const loadFeed=async(e,t,n)=>await client.get(e,"/api/topic/home",{performanceId:JSON.stringify(t),channelClassId:n,deviceId:(0,make.id)()});loadFeed(apiBase,{pageNo:1,moduleNum:0},90013);`;
  const page = (index) => ({
    code: 0,
    data: {
      modules: [{
        cards: Array.from({ length: 3 }, (_, offset) => ({
          episodeId: `${index}${offset + 1}`,
          name: `第${index}页节目${offset + 1}`,
          imageUrl: `https://cdn.spa.example/cover/${index}${offset + 1}.jpg`,
          anchorName: `主播${offset + 1}`,
        })),
      }],
    },
  });
  const detail = {
    code: 0,
    data: {
      userVoice: {
        btnTitle: "打开应用播放",
        userInfo: { name: "主播1" },
        voiceInfo: {
          episodeId: "11",
          name: "第1页节目1",
          imageUrl: "https://cdn.spa.example/cover/11.jpg",
          categoryName: "广播剧",
        },
        voicePlayProperty: { trackUrl: "https://cdn.spa.example/audio/11.mp3" },
      },
    },
  };
  const download = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/assets/app.js") return Buffer.from(script);
    if (parsed.pathname === "/api/topic/home") {
      const performance = JSON.parse(parsed.searchParams.get("performanceId"));
      return Buffer.from(JSON.stringify(page(performance.pageNo)));
    }
    if (parsed.pathname === "/api/detail/11") return Buffer.from(JSON.stringify(detail));
    throw new Error(`unexpected URL: ${parsed}`);
  };
  const repairPlan = encodeBridgePlan({
    version: 1,
    kind: "books",
    host: "https://spa.example",
    responseType: "json",
    list: "items",
    fields: {
      name: { selector: "name" },
      url: {
        selector: "episodeId",
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix: "https://spa.example/api/detail/",
          suffix: "",
        },
      },
    },
  });
  const repairSource = {
    sourceName: "SPA Audio",
    sourceType: "audio",
    bookWorld: {
      推荐: { requestInfo: `https://converter.example/adapter/books?plan=${repairPlan}&url=https%3A%2F%2Fspa.example%2Flegacy` },
    },
  };

  const diagnostics = [];
  const discovery = await discoverSpaMedia("https://spa.example/", "audio", {
    download,
    homeHtml: home,
    homeResponseUrl: "https://spa.example/",
    adapterBase: "https://converter.example",
    repairSource,
    diagnostics,
  });
  assert.ok(discovery, diagnostics.join("; "));
  assert.equal(discovery.bookCount, 3);
  assert.equal(discovery.mediaSampleUrl, "https://cdn.spa.example/audio/11.mp3");
  const action = discovery.source.bookWorld["站点推荐"];
  const actionUrl = new Function("config", "params", "result", action.requestInfo.slice(4))(
    {},
    { pageIndex: 2 },
    "",
  );
  const adapterUrl = new URL(actionUrl);
  const upstream = new URL(adapterUrl.searchParams.get("url"));
  assert.equal(JSON.parse(upstream.searchParams.get("performanceId")).pageNo, 2);
  const listPlan = decodeBridgePlan(adapterUrl.searchParams.get("plan"));
  assert.equal(listPlan.list, "@json-recursive:cards");
  const bridged = executeBridgePlan(Buffer.from(JSON.stringify(page(2))), upstream.toString(), listPlan);
  assert.equal(bridged.data[0].name, "第2页节目1");
  assert.equal(bridged.data[0].cover, "https://cdn.spa.example/cover/21.jpg");
  const detailToken = discovery.source.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1];
  const bridgedDetail = executeBridgePlan(
    Buffer.from(JSON.stringify(detail)),
    "https://spa.example/api/detail/11",
    decodeBridgePlan(detailToken),
  );
  assert.equal(bridgedDetail.name, "第1页节目1");
  assert.equal(bridgedDetail.author, "主播1");
  assert.equal(bridgedDetail.cat, "广播剧");
});

test("novelDiscoveryToXiangse 生成可导入的最小香色源", async () => {
  const discovery = await discoverNovel("https://novel.example/", { download: fixtureDownload });
  const source = novelDiscoveryToXiangse(discovery, { sourceName: "识站示例" });
  assert.equal(source.sourceName, "识站示例");
  assert.equal(source.sourceType, "text");
  assert.equal(source.sourceUrl, "https://novel.example");
  assert.equal(source.miniAppVersion, "2.56.1");
  assert.ok(source.bookWorld["站点首页"].list);
  assert.match(source.bookWorld["站点首页"].cover, /img\/@/);
  assert.match(source.bookDetail.cover, /og:image|imgbox|cover/);
  assert.match(source.searchBook.requestInfo, /searchkey=%@keyWord|params\.keyWord/);
  assert.ok(source.chapterList.list);
  assert.match(source.chapterContent.content, /\/\/\*\[@id='content'\]/);
  assert.match(source.chapterContent.content, /\|\|@js:/);
  assert.match(source.chapterContent.content, /replace\(\/<\[\^>\]\+>/);
  const structural = validateXiangseSource(source);
  assert.equal(structural.ok, true, structural.errors.join("; "));
});

test("小说正文后处理会去掉 HTML 标签并保留换行", async () => {
  const { withNovelHtmlStripped } = await import("../src/siteAnalyze/toXiangse.js");
  const rule = withNovelHtmlStripped("//*[@id='content']");
  const script = rule.split(/\|\|\s*@js:/i, 2)[1];
  const html = "<div><p>第一段</p><br/><p>第二段&nbsp;<b>加粗</b></p><script>x()</script></div>";
  const text = new Function("config", "params", "result", script)({}, {}, html);
  assert.equal(text.includes("<"), false);
  assert.equal(text.includes(">"), false);
  assert.match(text, /第一段/);
  assert.match(text, /第二段\s+加粗/);
  assert.doesNotMatch(text, /x\(\)/);
});

test("识站产物通过香色结构校验与动作链（分类→正文）", async () => {
  const result = await analyzeSite("https://mixed.example/", {
    download: fixtureDownload,
    sourceName: "综合站",
  });
  assert.equal(result.ok, true, result.reason);
  assert.ok(Object.keys(result.sources).length >= 2);
  for (const [name, source] of Object.entries(result.sources)) {
    const structural = validateXiangseSource(source);
    assert.equal(structural.ok, true, `${name}: ${structural.errors.join("; ")}`);
    const report = result.runtimeReports?.[name]
      || await runXbsPipeline(source, {
        fetchImpl: downloadAsFetch(fixtureDownload),
        fetchMedia: source.sourceType !== "text",
      });
    assert.equal(report.ok, true, `${name}: ${report.error}`);
    assert.ok(report.steps.bookWorld.listCount >= 1, `${name} 分类列表为空`);
    assert.ok(report.steps.bookDetail?.requestUrl, `${name} 缺少详情请求`);
    assert.ok(report.steps.chapterList.listCount >= 1, `${name} 章节为空`);
    assert.ok(report.steps.chapterContent.itemCount > 0, `${name} 正文为空`);
  }
});

test("香色动作链在 XPath 空字符串后继续尝试回退候选", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "XPath 回退" },
  );
  source.bookWorld.站点首页.bookName = "normalize-space(//*[@id='missing'])||normalize-space(/html/body/*)";
  const report = await runXbsPipeline(source, {
    fetchImpl: downloadAsFetch(fixtureDownload),
  });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.bookName, "第一本书");
});

test("analyzeSite 对小说 fixture 返回成功源", async () => {
  const result = await analyzeSite("https://novel.example/", { download: fixtureDownload });
  assert.equal(result.ok, true, result.detail || result.reason);
  assert.equal(result.kind, "text");
  assert.ok(result.source.chapterContent.content);
  assert.match(result.warning.message, /fallback:site-analyze/);
  assert.equal(Object.keys(result.sources).length, 1);
});

test("analyzeSite 在首页瞬时网络失败后重试并完成动作链", async () => {
  let homeAttempts = 0;
  const download = async (url, headers, options) => {
    if (new URL(url).pathname === "/") {
      homeAttempts += 1;
      if (homeAttempts === 1) {
        const error = new Error("下载阅读源超时 12000ms");
        error.code = "ETIMEDOUT";
        throw error;
      }
    }
    return fixtureDownload(url, headers, options);
  };
  const result = await analyzeSite("https://novel.example/", { download });

  assert.equal(result.ok, true, result.reason);
  assert.ok(homeAttempts >= 2);
  assert.ok(result.runtimeReports[Object.keys(result.sources)[0]].ok);
});

test("analyzeSite 将非标准 HTTP 5xx 作为瞬时种子故障重试", async () => {
  let homeAttempts = 0;
  const download = async (url, headers, options) => {
    if (new URL(url).pathname === "/" && ++homeAttempts === 1) {
      throw new Error("下载失败：HTTP 567");
    }
    return fixtureDownload(url, headers, options);
  };
  const result = await analyzeSite("https://novel.example/", { download });

  assert.equal(result.ok, true, result.reason);
  assert.ok(homeAttempts >= 2);
});

test("analyzeSite 在声明 HTTPS 失败时使用同主机 HTTP 页面识站", async () => {
  const calls = [];
  const download = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://protocol-fallback.example")) throw new Error("TLS unavailable");
    return fixtureDownload(String(url).replace("protocol-fallback.example", "novel.example"));
  };
  const analyzed = await analyzeSite("https://protocol-fallback.example", {
    download,
    sourceName: "协议回退",
    preferKind: "text",
  });
  assert.equal(analyzed.ok, true, analyzed.reason);
  assert.equal(analyzed.source.sourceUrl, "http://protocol-fallback.example");
  assert.ok(calls.includes("https://protocol-fallback.example/"));
  assert.ok(calls.includes("http://protocol-fallback.example/"));
});

test("analyzeSite 使用稳定链接路径跨越动态容器类名", async () => {
  let homeRequest = 0;
  const download = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/") {
      homeRequest += 1;
      return Buffer.from(novelHome.replace('class="list"', `class="list-${homeRequest}"`));
    }
    if (parsed.pathname.startsWith("/book/")) return Buffer.from(novelDetail);
    if (parsed.pathname.startsWith("/chapter/")) return Buffer.from(novelChapter);
    throw new Error(`fixture missing: ${url}`);
  };
  const result = await analyzeSite("https://novel.example/", { download });
  assert.equal(result.ok, true, result.reason);
  const source = Object.values(result.sources)[0];
  assert.match(source.bookWorld.站点首页.list, /contains\(@href, '\/book\/'\)/);
  assert.match(source.bookWorld.站点首页.list, /normalize-space\(\.\) != ''/);
  assert.match(source.chapterList.list, /contains\(@href, '\/chapter\/'\)/);
});

test("小说列表节点本身为链接时详情规则读取当前节点 href", async () => {
  const home = `<html><body><div id="s-tag">
    <a href="/100/index.html">第一本书</a>
    <a href="/200/index.html">第二本书</a>
    <a href="/300/index.html">第三本书</a>
  </div></body></html>`;
  const detail = `<html><body><h1>第一本书</h1>
    <a href="/100/read/1.html">第一章</a>
    <a href="/100/read/2.html">第二章</a>
  </body></html>`;
  const download = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return Buffer.from(home);
    if (/^\/\d+\/index\.html$/.test(path)) return Buffer.from(detail);
    return Buffer.from(`<article>${"有效正文。".repeat(60)}</article>`);
  };
  const discovery = await discoverNovel("https://self-link.example/", { download, maxPages: 2 });

  assert.ok(discovery);
  assert.match(discovery.detailUrlSelector, /\.\/@href/);
  assert.match(discovery.bookNameSelector, /normalize-space\(\.\)/);
});

test("章节语义选择器排除没有 href 的文字占位节点", () => {
  const document = loadDocument(`<html><body>
    <a>第1话</a><a>第2话</a>
    <a href="/read/3">第3话</a><a href="/read/4">第4话</a>
  </body></html>`, "https://chapters.example/book/1");
  const links = pageAnchors(document, "https://chapters.example/book/1", "https://chapters.example")
    .map((item) => item.el);
  const selector = chapterAnchorSelectorFromLinks(
    links,
    document,
    "https://chapters.example/book/1",
  );
  const result = document.evaluate(
    selector,
    document,
    null,
    document.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );

  assert.equal(result.snapshotLength, 2);
  assert.ok([...Array(result.snapshotLength)].every((_, index) => result.snapshotItem(index).hasAttribute("href")));
});

test("章节稳定选择器兼容目录代理绝对化后的 href", () => {
  const relative = loadDocument(`<html><body>
    <a href="/manga/book/1">第1话</a><a href="/manga/book/2">第2话</a>
  </body></html>`, "https://comic.example/catalog");
  const selector = chapterAnchorSelectorFromLinks(
    pageAnchors(relative, "https://comic.example/catalog", "https://comic.example").map((item) => item.el),
    relative,
    "https://comic.example/catalog",
  );
  const absolute = loadDocument(`<html><body>
    <a href="https://comic.example/manga/book/1">第1话</a>
    <a href="https://comic.example/manga/book/2">第2话</a>
  </body></html>`, "https://converter.example/adapter/toc");
  const result = absolute.evaluate(
    selector,
    absolute,
    null,
    absolute.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );

  assert.equal(result.snapshotLength, 2);
});

test("稳定作品选择器识别动态数字首段和固定详情后缀", () => {
  const document = loadDocument(`<html><body>
    <a href="https://numeric-books.example/user/index.html">书架</a>
    <a href="https://numeric-books.example/101/index.html">第一本书</a>
    <a href="/202/index.html">第二本书</a>
    <a href="https://numeric-books.example/303/index.html">第三本书</a>
  </body></html>`, "https://numeric-books.example/");
  const links = pageAnchors(document, "https://numeric-books.example/", "https://numeric-books.example")
    .filter((item) => /\/(?:101|202|303)\/index\.html$/.test(item.href))
    .map((item) => item.el);
  const selector = stableAnchorSelectorFromLinks(links, document, "https://numeric-books.example/");
  const result = document.evaluate(
    selector,
    document,
    null,
    document.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );

  assert.equal(result.snapshotLength, 3);
});

test("桥接器将同站搜索子域的根相对作品链接归一到动作主站", () => {
  const plan = compileBookBridgePlan({
    actionID: "bookWorld",
    host: "https://wiki.example.com",
    responseFormatType: "html",
    list: "//a",
    bookName: "normalize-space(.)",
    detailUrl: "./@href",
  });
  const output = executeBridgePlan(
    '<a href="/wiki/article">真实条目</a>',
    "https://searchwiki.example.com/search?q=test",
    plan,
  );

  assert.equal(output.data[0].url, "https://wiki.example.com/wiki/article");
});

test("书名规则排除作品链接内部的推荐徽标", () => {
  const plan = compileBookBridgePlan({
    actionID: "bookWorld",
    host: "https://books.example",
    responseFormatType: "html",
    list: "//li",
    bookName: bookNameSelector(),
    detailUrl: ".//a/@href",
  });
  const output = executeBridgePlan(
    '<li><a href="/book/1"><span class="badge">推荐</span> 三尺人生</a></li>',
    "https://books.example/",
    plan,
  );

  assert.equal(output.data[0].name, "三尺人生");
});

test("analyzeSite 使用已声明分类 URL 作为通用识站种子", async () => {
  const download = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return Buffer.from("<html><title>壳首页</title><p>小说阅读</p></html>");
    if (path === "/category") return Buffer.from(novelHome);
    if (path.startsWith("/book/")) return Buffer.from(novelDetail);
    if (path.startsWith("/chapter/")) return Buffer.from(novelChapter);
    throw new Error(`fixture missing: ${url}`);
  };
  const result = await analyzeSite("https://novel.example/", {
    download,
    seedUrls: ["https://novel.example/category"],
  });
  assert.equal(result.ok, true, result.reason);
  const source = Object.values(result.sources)[0];
  assert.equal(source.bookWorld.站点首页.requestInfo, "https://novel.example/category");
});

test("analyzeSite 保留已声明 POST 分类请求并重新验证动作链", async () => {
  const requests = [];
  const download = async (url, headers = {}, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed.toString(), headers, options });
    if (parsed.host === "shell.example") throw new Error("首页不可用");
    if (parsed.pathname === "/category") {
      if (options.method !== "POST" || !String(options.body).includes("page=1")) {
        throw new Error("分类接口只接受 POST");
      }
      return Buffer.from(novelHome);
    }
    if (parsed.pathname.startsWith("/book/")) return Buffer.from(novelDetail);
    if (parsed.pathname.startsWith("/chapter/")) return Buffer.from(novelChapter);
    if (parsed.pathname === "/search.php") return Buffer.from(novelHome);
    throw new Error(`fixture missing: ${url}`);
  };
  const requestInfo = [
    "@js:",
    'var url = config.host + "/category";',
    'var hp = {"page": params.pageIndex, "type": "all"};',
    'return {url:url, POST:true, httpParams:hp, httpHeaders:{"Content-Type":"application/x-www-form-urlencoded"}};',
  ].join("\n");
  const result = await analyzeSite("https://shell.example/", {
    download,
    preferKind: "text",
    seedRequests: [{
      url: "https://novel.example/category",
      requestInfo,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      options: { method: "POST", body: "page=1&type=all", followPostRedirects: true },
    }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const source = Object.values(result.sources)[0];
  assert.match(source.bookWorld.站点首页.requestInfo, /^@js:return /);
  assert.match(source.bookWorld.站点首页.requestInfo, /"POST":true/);
  assert.match(source.bookWorld.站点首页.requestInfo, /https:\/\/novel\.example\/category/);
  assert.ok(requests.some((item) => item.options.method === "POST" && item.url.endsWith("/category")));
});

test("analyzeSite 对漫画 fixture 生成漫画源", async () => {
  const result = await analyzeSite("https://comic.example/", { download: fixtureDownload });
  assert.equal(result.ok, true);
  assert.ok(result.kinds.includes("comic"));
  const comic = Object.values(result.sources).find((item) => item.sourceType === "comic");
  assert.ok(comic);
  assert.match(comic.chapterContent.content, /urls/);
});

test("discoverNovel 接受只有一个真实章节的新书", async () => {
  const singleDetail = `<!doctype html><html><body>
    <h1>刚发布的新书</h1>
    <div class="chapter-list"><a href="/chapter/1.html">第一章</a></div>
  </body></html>`;
  const download = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return Buffer.from(novelHome);
    if (path.startsWith("/book/")) return Buffer.from(singleDetail);
    if (path === "/chapter/1.html") return Buffer.from(novelChapter);
    throw new Error(`fixture missing: ${url}`);
  };
  const discovery = await discoverNovel("https://novel.example/", { download });
  assert.ok(discovery);
  assert.equal(discovery.chapterCount, 1);
  assert.equal(discovery.chapterSampleUrl, "https://novel.example/chapter/1.html");
});

test("discoverComic 跟随独立目录页声明的同源动态 HTML 接口", async () => {
  const host = "https://dynamic-comic.example";
  const home = `<a href="/manga/first"><img src="/covers/1.jpg">第一本漫画</a>
    <a href="/manga/second"><img src="/covers/2.jpg">第二本漫画</a>`;
  const detail = `<h1>第一本漫画</h1><a class="catalogue" href="/chapterlist/first">章节目录</a>`;
  const catalogue = `<div id="allchapters" data-mid="42" data-host="${host}"></div>
    <script>const n=document.getElementById("allchapters"),s=n.dataset.mid,e=n.dataset.host;
    fetch(\`${'${e}'}/manga/get?mid=${'${s}'}&mode=all\`).then(r=>r.text());</script>`;
  const chapters = `<div id="allchapterlist">
    <a href="/manga/first/42-1-0">第1话</a><a href="/manga/first/42-2-1">第2话</a>
  </div>`;
  const calls = [];
  const download = async (url) => {
    const target = String(url);
    calls.push(target);
    const path = new URL(target).pathname;
    if (path === "/") return Buffer.from(home);
    if (path === "/manga/first" || path === "/manga/second") return Buffer.from(detail);
    if (path === "/chapterlist/first") return Buffer.from(catalogue);
    if (path === "/manga/get") return Buffer.from(chapters);
    if (/\/manga\/first\/42-\d+-\d+/.test(path)) {
      return Buffer.from('<img src="/pages/1.jpg"><img src="/pages/2.jpg"><img src="/pages/3.jpg">');
    }
    throw new Error(`fixture missing: ${target}`);
  };

  const discovery = await discoverComic(`${host}/`, {
    download,
    adapterBase: "https://convert.example",
  });
  assert.ok(discovery, calls.join("\n"));
  assert.equal(discovery.chapterCount, 2);
  assert.ok(calls.includes(`${host}/manga/get?mid=42&mode=all`));
  assert.match(discovery.chapterRequestInfo, /adapter\/toc\?resolve=html/);
  assert.match(discovery.tocSelector, /catalogue|body/);
});

test("discoverComic 对章节动态 HTML 生成通用图片适配动作", async () => {
  const host = "https://dynamic-pages.example";
  const adapterBase = "https://convert.example";
  const home = `<a href="/manga/first"><img src="/covers/1.jpg">第一本漫画</a>
    <a href="/manga/second"><img src="/covers/2.jpg">第二本漫画</a>`;
  const detail = `<h1>第一本漫画</h1><div class="chapters">
    <a href="/manga/first/1">第1话</a><a href="/manga/first/2">第2话</a></div>`;
  const chapter = `<img src="/recommend/a.jpg"><img src="/recommend/b.jpg">
    <script>const endpoint = "/chapter-pages/1"; fetch(endpoint);</script>`;
  const dynamic = '<img src="/actual/1.jpg"><img src="/actual/2.jpg"><img src="/actual/3.jpg">';
  const calls = [];
  const download = async (url, headers = {}) => {
    const target = String(url);
    calls.push({ target, headers });
    const path = new URL(target).pathname;
    if (path === "/") return Buffer.from(home);
    if (path === "/manga/first" || path === "/manga/second") return Buffer.from(detail);
    if (/\/manga\/first\/\d+/.test(path)) return Buffer.from(chapter);
    if (path === "/chapter-pages/1") return Buffer.from(dynamic);
    throw new Error(`fixture missing: ${target}`);
  };

  const discovery = await discoverComic(`${host}/`, { download, adapterBase });
  assert.ok(discovery);
  assert.equal(discovery.contentResponseFormatType, "json");
  assert.match(discovery.contentRequestInfo, /adapter\/images\?v=2/);
  assert.match(discovery.contentSelector, /proxyUrls/);
  assert.ok(calls.some((item) => item.target === `${host}/chapter-pages/1`
    && /^https:\/\/dynamic-pages\.example\/manga\/first\/[12]$/.test(item.headers.Referer || "")), JSON.stringify(calls));

  const source = comicDiscoveryToXiangse(discovery, { sourceName: "动态正文漫画" });
  assert.equal(source.chapterContent.responseFormatType, "json");
  assert.match(source.chapterContent.requestInfo, /adapter\/images\?v=2/);
});

test("discoverComic 接受打包脚本中的章节图片数组", async () => {
  const host = "https://packed-comic.example";
  const home = `<a href="/manga/first"><img src="/covers/1.jpg">第一本漫画</a>
    <a href="/manga/second"><img src="/covers/2.jpg">第二本漫画</a>`;
  const detail = `<h1>第一本漫画</h1><div class="chapters">
    <a href="/manga/first/1">第1话</a><a href="/manga/first/2">第2话</a></div>`;
  const packed = `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?"":e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)d[e(c)]=k[c]||e(c);k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1;};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p;}("0 1=['2://3.4/5/1.6','2://3.4/5/7.6'];",8,8,'var|pages|https|cdn|example|comic|jpg|second'.split('|'),0,{}))`;
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (path === "/manga/first" || path === "/manga/second") return Buffer.from(detail);
    if (/\/manga\/first\/\d+/.test(path)) return Buffer.from(`<script>${packed}</script>`);
    throw new Error(`fixture missing: ${url}`);
  };

  const discovery = await discoverComic(`${host}/`, { download });
  assert.ok(discovery);
  assert.equal(discovery.imageCount, 2);
});

test("discoverComic 跟随带封面作品链接的主导规范 origin", async () => {
  const homeHost = "https://comic-entry.example";
  const canonical = "https://comic-canonical.example";
  const home = `${Array.from({ length: 5 }, (_, index) => (
    `<a href="${canonical}/comic/${index ? `book-${index}` : "first"}"><img src="/cover/${index + 1}.jpg">第${index + 1}本漫画</a>`
  )).join("")}<a href="https://ads.example/click">广告</a>`;
  const detail = '<div class="chapters"><a href="/comic/first/1">第1话</a><a href="/comic/first/2">第2话</a></div>';
  const calls = [];
  const download = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === `${homeHost}/`) return Buffer.from(home);
    if (target.startsWith(`${canonical}/comic/first`) || target === `${canonical}/comic/second`) {
      if (/\/\d+$/.test(target)) return Buffer.from('<img src="/1.jpg"><img src="/2.jpg">');
      return Buffer.from(detail);
    }
    throw new Error(`fixture missing: ${target}`);
  };
  const discovery = await discoverComic(`${homeHost}/`, { download });
  assert.ok(discovery, calls.join("\n"));
  assert.equal(discovery.detailSampleUrl, `${canonical}/comic/first`);
  assert.equal(discovery.chapterSampleUrl, `${canonical}/comic/first/2`);
  assert.ok(!calls.some((url) => url.startsWith("https://ads.example")));
});

test("discoverComic 跟随大量无封面的主导漫画详情 origin", async () => {
  const entry = "https://comic-entry-links.example";
  const canonical = "https://comic-content-links.example";
  const home = `${Array.from({ length: 9 }, (_, index) => (
    `<a href="${canonical}/index.php/comic/book-${index + 1}">第${index + 1}本漫画</a>`
  )).join("")}<a href="https://ads.example/comic/click">漫画广告</a>`;
  const detail = '<h1>第一本漫画</h1><a href="/index.php/comic/book-1/1">第1话</a><a href="/index.php/comic/book-1/2">第2话</a>';
  const download = async (url) => {
    const target = String(url);
    if (target === `${entry}/`) return Buffer.from(home);
    if (target === `${canonical}/index.php/comic/book-1`) return Buffer.from(detail);
    if (/\/index\.php\/comic\/book-1\/[12]$/.test(target)) {
      return Buffer.from('<img src="/page/1.jpg"><img src="/page/2.jpg">');
    }
    throw new Error(`fixture missing: ${target}`);
  };

  const discovery = await discoverComic(`${entry}/`, { download });

  assert.ok(discovery);
  assert.equal(discovery.host, canonical);
  assert.equal(discovery.bookCount, 9);
  assert.equal(discovery.chapterCount, 2);
  assert.match(discovery.listSelector, /index\.php\/?[^']*comic|index\.php\/comic/);
});

test("书籍元素校验拒绝导航书名、日期分类和与书名重复的分类", () => {
  const base = {
    name: "测试作品",
    url: "https://books.example/book/1",
    cover: "https://books.example/cover/1.jpg",
    author: "测试作者",
    lastChapterTitle: "第十章 结局",
  };
  assert.ok(bookElementReport({ ...base, cat: "2026-08-27" }).missingRecommended.includes("cat"));
  assert.ok(bookElementReport({ ...base, cat: "测试作品" }).missingRecommended.includes("cat"));
  assert.ok(!bookElementReport({ ...base, cat: "历史" }).missingRecommended.includes("cat"));
  assert.ok(bookElementReport({
    ...base,
    cat: "历史",
    lastChapterTitle: "\uE609 返回顶部",
  }).missingRecommended.includes("lastChapterTitle"));
  assert.ok(bookElementReport({
    ...base,
    name: "返回首页",
    cat: "历史",
  }).missingRequired.includes("name"));
  assert.equal(usableChapterRow({
    title: "返回首页",
    url: "https://books.example/",
  }), false);
});

test("章节 URL 校验拒绝无章节语义的书籍详情兄弟节点", () => {
  assert.equal(chapterUrlLooksLikeBookSibling(
    "https://books.example/list/25955.html",
    { title: "另一本作品", url: "https://books.example/list/25986.html" },
  ), true);
  assert.equal(chapterUrlLooksLikeBookSibling(
    "https://books.example/list/25955.html",
    { title: "第六章 继续", url: "https://books.example/list/25986.html" },
  ), false);
  assert.equal(chapterUrlLooksLikeBookSibling(
    "https://books.example/list/25955.html",
    { title: "正文标题", url: "https://books.example/view/4956.html" },
  ), false);
});

test("analyzeSite 漫画识站以首页真实响应 origin 请求详情和章节", async () => {
  const declared = "https://www.redirect-comic.example";
  const canonical = "https://redirect-comic.example";
  const calls = [];
  const download = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === `${declared}/`) {
      const response = Buffer.from(comicHome);
      Object.defineProperty(response, "read2xsggResponseUrl", { value: `${canonical}/` });
      return response;
    }
    return fixtureDownload(target.replace(canonical, "https://comic.example"));
  };

  const result = await analyzeSite(declared, {
    download,
    sourceName: "重定向漫画",
    preferKind: "comic",
  });

  assert.equal(result.ok, true, JSON.stringify(result.skippedKinds));
  assert.equal(result.source.sourceUrl, canonical);
  assert.ok(calls.some((url) => url.startsWith(`${canonical}/comic/`)));
  assert.ok(!calls.some((url) => url.startsWith(`${declared}/comic/`)));
});

test("analyzeSite 混合站每种类型各出一条", async () => {
  const result = await analyzeSite("https://mixed.example/", {
    download: fixtureDownload,
    sourceName: "综合站",
  });
  assert.equal(result.ok, true);
  const types = new Set(Object.values(result.sources).map((item) => item.sourceType));
  assert.ok(types.has("text"));
  assert.ok(types.has("comic"));
  assert.ok(types.has("audio"), JSON.stringify({ skipped: result.skippedKinds, reports: result.runtimeReports }));
  assert.ok(result.sources["综合站·小说"]);
  assert.ok(result.sources["综合站·漫画"]);
  assert.ok(result.sources["综合站·听书"]);
});

test("analyzeSite 图片堆但无列表结构时跳过漫画", async () => {
  const comicOnlyImages = `<html><body>${'<img src="c.jpg">'.repeat(40)}<p>漫画阅读</p></body></html>`;
  const result = await analyzeSite("https://empty-comic.example/", {
    download: async () => Buffer.from(comicOnlyImages),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /analyze-failed/);
});

test("resolveChapterListUrls 从 JSON API toc @js 解析 getBookMenu", () => {
  assert.equal(extractBookIdFromUrl("https://m.lrts.me/ajax/getBookDetail?bookId=79665832"), "79665832");
  const requestInfo = [
    "@js:",
    "var url = \"https://m.lrts.me/ajax/getBookMenu?bookId=__ID__&pageNum=__PAGE__&pageSize=50&sortType=0\";",
    "url = url.split(\"__ID__\").join(encodeURIComponent(id));",
    "return (\"https://convert.example/adapter/chapters?plan=abc&pageSize=50&url=\") + encodeURIComponent(u);",
  ].join("\n");
  const urls = resolveChapterListUrls(
    requestInfo,
    "https://m.lrts.me/ajax/getBookDetail?bookId=79665832",
  );
  assert.equal(
    urls[0],
    "https://m.lrts.me/ajax/getBookMenu?bookId=79665832&pageNum=1&pageSize=50&sortType=0",
  );
  assert.ok(urls.includes("https://m.lrts.me/ajax/getBookDetail?bookId=79665832"));
});

test("resolveChapterListUrls 执行通用媒体目录适配器包装", () => {
  const detailUrl = "https://audio.example/work/%E4%B8%AD%E6%96%87";
  const requestInfo = [
    "@js:",
    'var q = (params && params.queryInfo) || {};',
    'var u = String(q.detailUrl || q.url || result || "").trim();',
    'return "https://converter.example/adapter/media-playlist?kind=audio&url=" + encodeURIComponent(u);',
  ].join("\n");
  assert.equal(
    resolveChapterListUrls(requestInfo, detailUrl)[0],
    `https://converter.example/adapter/media-playlist?kind=audio&url=${encodeURIComponent(detailUrl)}`,
  );
});

test("verifyConvertedSource 接受通用媒体单章适配器的同详情 URL", async () => {
  const host = "https://single-media.example";
  const detailUrl = `${host}/video/1`;
  const chapterEndpoint = "https://convert.example/adapter/single-chapter?url=";
  const mediaEndpoint = "https://convert.example/adapter/media?kind=video&url=";
  const source = {
    sourceName: "单集视频",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "video",
    bookWorld: {
      视频: {
        actionID: "bookWorld", host, responseFormatType: "html", parserID: "DOM",
        requestInfo: `${host}/list`, list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: `${host}/search?q=%@keyWord`, list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", bookName: "//h1", cover: "//img/@src",
      author: "//*[@class='author']", cat: "//*[@class='cat']", lastChapterTitle: "//*[@class='latest']",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "json", parserID: "DOM",
      requestInfo: [
        "@js:",
        "var q = (params && params.queryInfo) || {};",
        'var u = String(q.detailUrl || q.url || result || "").trim();',
        `return ${JSON.stringify(chapterEndpoint)} + encodeURIComponent(u);`,
      ].join("\n"),
      list: "$.data", title: "title", url: "url", moreKeys: { pageSize: 1, maxPage: 1 },
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "json", parserID: "DOM",
      requestInfo: [
        "@js:",
        'var u = String((params.queryInfo && params.queryInfo.chapterUrl) || result || "");',
        `return ${JSON.stringify(mediaEndpoint)} + encodeURIComponent(u);`,
      ].join("\n"),
      content: "$.url||@js:\nreturn JSON.stringify({url:String(result || \"\"),httpHeaders:{}});",
    },
  };
  const download = async (url) => {
    const target = String(url);
    if (target === `${host}/list` || target.startsWith(`${host}/search`)) {
      return Buffer.from(`<li><a href="${detailUrl}">单集视频</a></li>`);
    }
    if (target === detailUrl) {
      return Buffer.from('<h1>单集视频</h1><img src="https://cdn.example/cover.jpg"><span class="author">演员甲</span><span class="cat">视频</span><span class="latest">播放</span>');
    }
    if (target.startsWith(chapterEndpoint)) {
      return Buffer.from(JSON.stringify({ data: [{ title: "播放", url: detailUrl }] }));
    }
    if (target.startsWith(mediaEndpoint)) {
      return Buffer.from(JSON.stringify({ url: "https://cdn.example/play.m3u8" }));
    }
    if (target === "https://cdn.example/play.m3u8") return Buffer.from("#EXTM3U\n");
    throw new Error(`fixture missing: ${target}`);
  };

  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.chapterUrl, detailUrl);
});

test("resolveChapterListUrls 保留通用目录跳转适配器请求", () => {
  const requestInfo = [
    "@js:",
    "var q = params.queryInfo || {};",
    "var u = String(q.detailUrl || result || '');",
    'return "https://convert.example/adapter/toc?selector=%2F%2Fa%2F%40href&url=" + encodeURIComponent(u);',
  ].join("\n");
  assert.deepEqual(
    resolveChapterListUrls(requestInfo, "https://novel.example/book/42"),
    [
      "https://convert.example/adapter/toc?selector=%2F%2Fa%2F%40href&url=https%3A%2F%2Fnovel.example%2Fbook%2F42",
      "https://novel.example/book/42",
    ],
  );
});

test("通用目录跳转在已进入目录页时不猜测普通导航链接", () => {
  const page = [
    "<a href='/search'>高级搜索</a>",
    "<table id='chapters'><tr><td><a href='/read/1'>第1章</a></td></tr></table>",
  ].join("");
  const plan = {
    responseType: "html",
    tocSelector: "//a[contains(normalize-space(.), '在线阅读')]/@href",
  };

  assert.equal(bridgeTocUrl(page, "https://example.test/book/catalog.html", plan), "");
});

test("resolveChapterListUrls 不替未修复动作隐式改写 API 详情地址", () => {
  const detailUrl = "https://comic.example/api/comic/42";
  assert.deepEqual(resolveChapterListUrls("%@result", detailUrl), [detailUrl]);
  assert.deepEqual(
    resolveChapterListUrls("// read2xsgg: strip-api-path\n%@result", detailUrl),
    ["https://comic.example/comic/42", detailUrl],
  );
});

test("resolveBookTargetUrl 解析转换器生成的 bridge URL 包装脚本", () => {
  const requestInfo = [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var seed = q.url || "";',
    "var u = (function (result) {",
    'let url = "/search/" + params.keyWord + (params.pageIndex === 1 ? "" : ("/" + params.pageIndex));',
    "return {url:url,POST:false};",
    "}).call(this, seed);",
    'if (u && typeof u == "object") u = u.url || "";',
    'return ("https://convert.example/adapter/books?plan=abc&url=") + encodeURIComponent(u);',
  ].join("\n");
  const target = resolveBookTargetUrl(
    { host: "https://books.example", requestInfo },
    { plan: { host: "https://books.example" }, requestInfo },
    { keyWord: "测试", pageIndex: 2 },
  );
  assert.equal(target, "https://books.example/search/%E6%B5%8B%E8%AF%95/2");
});

test("resolveBookTargetUrl 不把 bridge 包装脚本残片误判为 URL", () => {
  const requestInfo = [
    "@js:",
    "var u = unknownSourceRuntime();",
    'return ("https://convert.example/adapter/books?plan=abc&url=") + encodeURIComponent(u);',
  ].join("\n");
  assert.equal(resolveBookTargetUrl(
    { host: "https://books.example", requestInfo },
    { plan: { host: "https://books.example" }, requestInfo },
  ), "");
});

test("resolveBookTargetRequest 安全解析转换器生成的 POST 表单", () => {
  const requestInfo = [
    "@js:",
    'let url = "/search/";',
    'let hp = {"keyword": params.keyWord, "page": params.pageIndex};',
    'return {url:url,POST:true,httpParams:hp,httpHeaders:{"Referer":"https://books.example/"}};',
  ].join("\n");
  const action = {
    host: "https://books.example",
    requestInfo,
    responseFormatType: "html",
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const target = resolveBookTargetRequest(
    { sourceUrl: "https://books.example" },
    action,
    { plan: { host: "https://books.example" }, requestInfo },
    { keyWord: "测试", pageIndex: 2 },
  );
  assert.equal(target.url, "https://books.example/search/");
  assert.equal(target.options.method, "POST");
  assert.equal(target.options.body, "keyword=%E6%B5%8B%E8%AF%95&page=2");
  assert.equal(target.options.followPostRedirects, true);
  assert.equal(target.headers.Referer, "https://books.example/");
  assert.equal(target.headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("resolveBookTargetRequest 按香色 GBK 标记编码 POST 表单", () => {
  const requestInfo = [
    "@js:",
    'let url = "/search/";',
    'let hp = {"keyword": params.keyWord};',
    "return {url:url,POST:true,httpParams:hp};",
  ].join("\n");
  const action = {
    host: "https://books.example",
    requestInfo,
    requestParamsEncode: "2147485234",
    responseFormatType: "html",
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const target = resolveBookTargetRequest(
    { sourceUrl: "https://books.example" },
    action,
    { plan: { host: "https://books.example" }, requestInfo },
    { keyWord: "小说" },
  );
  assert.equal(target.options.body, "keyword=%D0%A1%CB%B5");
});

test("resolveBookTargetUrls 只输出同源可验证分类种子", () => {
  const action = {
    host: "https://books.example",
    responseFormatType: "html",
    requestInfo: "https://books.example/list?page=%@pageIndex",
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  assert.deepEqual(resolveBookTargetUrls({
    sourceUrl: "https://books.example",
    bookWorld: { 分类: action },
  }), ["https://books.example/list?page=1"]);
});

test("verifyConvertedSource 对 JSON API 目录用 getBookMenu 而不是详情页", async () => {
  const chapterPlan = {
    version: 1,
    kind: "chapters",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    tocSelector: "",
    reverse: false,
    fields: {
      title: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: {
        selector: "id",
        replacements: [],
        hostPrefix: false,
        matchTemplate: null,
        urlTemplate: "https://audio.example/ajax/getListenPath?entityId={{base:bookId}}&id={{id}}&section={{section}}",
      },
    },
    headers: {},
  };
  const bookPlan = {
    version: 1,
    kind: "books",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    fields: {
      name: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "url", replacements: [], hostPrefix: false, matchTemplate: null },
      cat: { selector: "cat", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const chapterEncoded = encodeBridgePlan(chapterPlan);
  const bookEncoded = encodeBridgePlan(bookPlan);
  const source = {
    sourceName: "听书",
    host: "https://audio.example",
    sourceType: "audio",
    bookWorld: {
      搜索: {
        actionID: "bookWorld",
        host: "https://audio.example",
        responseFormatType: "json",
        requestInfo: `https://convert.example/adapter/books?plan=${bookEncoded}&url=/search`,
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    bookDetail: {
      actionID: "bookDetail",
      host: "https://audio.example",
      responseFormatType: "json",
      requestInfo: "%@result",
      bookName: "data/bookDetail/name",
      author: "data/bookDetail/author",
      cat: "data/bookDetail/cat",
      lastChapterTitle: "data/bookDetail/latest",
      cover: "data/bookDetail/cover",
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://audio.example",
      responseFormatType: "json",
      requestInfo: [
        "@js:",
        'var url = "https://audio.example/ajax/getBookMenu?bookId=__ID__&pageNum=__PAGE__&pageSize=50";',
        `return ("https://convert.example/adapter/chapters?plan=${chapterEncoded}&pageSize=50&url=") + encodeURIComponent(url);`,
      ].join("\n"),
      list: "$.data",
      title: "title",
      url: "url",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://audio.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      content: '@js: return JSON.stringify({url: params.queryInfo.chapterUrl, httpHeaders: {}});',
    },
  };
  const fetched = [];
  const download = async (url, _headers = {}, options = {}) => {
    fetched.push(url);
    if (String(url).includes("/search")) {
      return Buffer.from(JSON.stringify({
        list: [
          { name: "在线书库", url: "https://audio.example/", cat: "导航" },
          { name: "有声书", url: "https://audio.example/ajax/getBookDetail?bookId=42", cat: "历史" },
        ],
      }));
    }
    if (String(url).includes("getBookMenu")) {
      return Buffer.from(JSON.stringify({
        list: [
          { name: "回顶部", id: 8, section: 0 },
          { name: "第1集", id: 9, section: 1 },
        ],
      }));
    }
    if (String(url).includes("getBookDetail")) {
      return Buffer.from(JSON.stringify({ data: { bookDetail: {
        id: 42,
        name: "有声书",
        author: "播讲者",
        cat: "",
        latest: "第1集",
        cover: "https://audio.example/cover.jpg",
      } } }));
    }
    if (String(url).includes("getListenPath")) {
      const media = Buffer.from(options.method === "HEAD" ? "{}" : "ID3audio");
      media.httpHeaders = {
        "content-type": options.method === "HEAD" ? "application/json" : "audio/mpeg",
      };
      media.read2xsggResponseUrl = String(url);
      return media;
    }
    return Buffer.from("{}");
  };
  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, true);
  assert.match(result.chapterUrl, /getListenPath.*entityId=42/);
  assert.deepEqual(result.bookElements.present, ["name", "url", "cover", "author", "cat", "lastChapterTitle"]);
  assert.deepEqual(result.bookElements.missingRecommended, []);
  assert.equal(result.bookElements.values.author, "播讲者");
  assert.equal(result.bookElements.values.cat, "历史");
  assert.ok(fetched.some((url) => /getBookMenu/.test(url)));
  assert.equal(result.page1Count, 2);
  assert.equal(result.bookName, "有声书");
  assert.equal(result.chapterTitle, "第1集");
});

test("verifyConvertedSource 满页目录会抽测第 2 页翻页", async () => {
  const chapterPlan = {
    version: 1,
    kind: "chapters",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    tocSelector: "",
    reverse: false,
    fields: {
      title: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: {
        selector: "id",
        replacements: [],
        hostPrefix: false,
        matchTemplate: null,
        urlTemplate: "https://audio.example/play?id={{id}}",
      },
    },
    headers: {},
  };
  const bookPlan = {
    version: 1,
    kind: "books",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    fields: {
      name: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "url", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const chapterEncoded = encodeBridgePlan(chapterPlan);
  const bookEncoded = encodeBridgePlan(bookPlan);
  const source = {
    sourceName: "听书分页",
    host: "https://audio.example",
    sourceType: "audio",
    bookWorld: {
      搜索: {
        actionID: "bookWorld",
        host: "https://audio.example",
        responseFormatType: "json",
        requestInfo: `https://convert.example/adapter/books?plan=${bookEncoded}&url=/search`,
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://audio.example",
      responseFormatType: "json",
      requestInfo: [
        "@js:",
        'var url = "https://audio.example/ajax/getBookMenu?bookId=__ID__&pageNum=__PAGE__&pageSize=2";',
        `return ("https://convert.example/adapter/chapters?plan=${chapterEncoded}&pageSize=2&url=") + encodeURIComponent(url);`,
      ].join("\n"),
      list: "$.data",
      title: "title",
      url: "url",
      moreKeys: { pageSize: 2, maxPage: 500 },
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://audio.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      content: '@js: return JSON.stringify({url: params.queryInfo.chapterUrl, httpHeaders: {}});',
    },
  };
  const download = async (url) => {
    if (String(url).includes("/search")) {
      return Buffer.from(JSON.stringify({
        list: [{ name: "有声书", url: "https://audio.example/ajax/getBookDetail?bookId=42" }],
      }));
    }
    if (String(url).includes("pageNum=1")) {
      return Buffer.from(JSON.stringify({
        sections: 4,
        list: [{ name: "第1集", id: 1 }, { name: "第2集", id: 2 }],
      }));
    }
    if (String(url).includes("pageNum=2")) {
      return Buffer.from(JSON.stringify({
        sections: 4,
        list: [{ name: "第3集", id: 3 }, { name: "第4集", id: 4 }],
      }));
    }
    if (String(url).includes("/play?id=")) {
      const media = Buffer.from("ID3audio");
      media.httpHeaders = { "content-type": "audio/mpeg" };
      media.read2xsggResponseUrl = String(url);
      return media;
    }
    return Buffer.from("{}");
  };
  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, true, result.detail || result.reason);
  assert.equal(result.page1Count, 2);
  assert.equal(result.page2Count, 2);
  assert.equal(result.upstreamSections, 4);
});

test("verifyConvertedSource 会校验同一完整目录的本地切片第 2 页", async () => {
  const bookPlan = {
    version: 1,
    kind: "books",
    host: "https://slice.example",
    responseType: "json",
    list: "list",
    fields: {
      name: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "url", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const chapterPlan = {
    version: 1,
    kind: "chapters",
    host: "https://slice.example",
    responseType: "json",
    list: ".",
    tocSelector: "",
    reverse: false,
    fields: {
      title: { selector: "title", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "url", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const source = {
    sourceName: "本地切片目录",
    sourceUrl: "https://slice.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://slice.example",
        responseFormatType: "json",
        requestInfo: `https://convert.example/adapter/books?plan=${encodeBridgePlan(bookPlan)}&url=https://slice.example/list`,
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://slice.example",
      responseFormatType: "json",
      requestInfo: `https://convert.example/adapter/chapters?plan=${encodeBridgePlan(chapterPlan)}&pageSize=2&slice=1&url=%@result`,
      list: "$.data",
      title: "title",
      url: "url",
      moreKeys: { pageSize: 2, maxPage: 100 },
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://slice.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      content: "@js:return result;",
    },
  };
  const download = async (url) => {
    if (String(url).endsWith("/list")) {
      return Buffer.from(JSON.stringify({
        list: [{ name: "测试书", url: "https://slice.example/catalog.json" }],
      }));
    }
    if (String(url).endsWith("/catalog.json")) {
      return Buffer.from(JSON.stringify([
        { title: "第1章", url: "https://slice.example/1.txt" },
        { title: "第2章", url: "https://slice.example/2.txt" },
        { title: "第3章", url: "https://slice.example/3.txt" },
      ]));
    }
    if (String(url).endsWith("/1.txt")) return Buffer.from("可验证的第一章正文。".repeat(20));
    return Buffer.from("{}");
  };

  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.page1Count, 2);
  assert.equal(result.page2Count, 1);
});

test("verifyConvertedSource 拒绝与第 1 页重复的目录第 2 页", async () => {
  const chapterPlan = {
    version: 1,
    kind: "chapters",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    tocSelector: "",
    reverse: false,
    fields: {
      title: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: {
        selector: "id",
        replacements: [],
        hostPrefix: false,
        matchTemplate: null,
        urlTemplate: "https://audio.example/play?id={{id}}",
      },
    },
    headers: {},
  };
  const bookPlan = {
    version: 1,
    kind: "books",
    host: "https://audio.example",
    responseType: "json",
    list: "list",
    fields: {
      name: { selector: "name", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "url", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const source = {
    sourceName: "重复目录分页",
    host: "https://audio.example",
    sourceType: "audio",
    bookWorld: {
      搜索: {
        actionID: "bookWorld",
        host: "https://audio.example",
        responseFormatType: "json",
        requestInfo: `https://convert.example/adapter/books?plan=${encodeBridgePlan(bookPlan)}&url=/search`,
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://audio.example",
      responseFormatType: "json",
      requestInfo: [
        "@js:",
        'var url = "https://audio.example/menu?bookId=__ID__&pageNum=__PAGE__&pageSize=2";',
        `return ("https://convert.example/adapter/chapters?plan=${encodeBridgePlan(chapterPlan)}&pageSize=2&url=") + encodeURIComponent(url);`,
      ].join("\n"),
      list: "$.data",
      title: "title",
      url: "url",
      moreKeys: { pageSize: 2, maxPage: 500 },
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://audio.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      content: '@js: return JSON.stringify({url: params.queryInfo.chapterUrl, httpHeaders: {}});',
    },
  };
  const download = async (url) => {
    if (String(url).includes("/search")) {
      return Buffer.from(JSON.stringify({
        list: [{ name: "有声书", url: "https://audio.example/detail?bookId=42" }],
      }));
    }
    if (String(url).includes("/menu")) {
      return Buffer.from(JSON.stringify({
        list: [{ name: "第1集", id: 1 }, { name: "第2集", id: 2 }],
      }));
    }
    return Buffer.from("{}");
  };
  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "目录第 2 页与第 1 页重复，翻页无效");
});

test("verifyConvertedSource 拒绝与第 1 页重复的书籍列表第 2 页", async () => {
  const host = "https://audio-list.example";
  const source = {
    sourceName: "重复书籍分页",
    sourceUrl: host,
    host,
    sourceType: "audio",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host,
        responseFormatType: "json",
        requestInfo: `${host}/books?page=%@pageIndex`,
        list: "$.list[*]",
        bookName: "$.name",
        detailUrl: "$.url",
        moreKeys: { pageSize: 2 },
      },
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "json",
      requestInfo: "%@result",
      list: "$.list[*]",
      title: "$.name",
      url: "$.url",
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      requestInfo: "%@result",
      content: "//article",
    },
  };
  const books = {
    list: [
      { name: "第一本", url: `${host}/book/1` },
      { name: "第二本", url: `${host}/book/2` },
    ],
  };
  const result = await verifyConvertedSource(source, {
    download: async (url) => String(url).includes("/books?")
      ? Buffer.from(JSON.stringify(books))
      : Buffer.from("{}"),
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rules-stale: empty-list");
  assert.equal(result.detail, "书籍列表第 2 页与第 1 页重复，翻页无效");

  const limited = structuredClone(source);
  limited.bookWorld["分类"].moreKeys.maxPage = 1;
  const accepted = await verifyConvertedSource(limited, {
    download: async (url) => {
      if (String(url).includes("/books?")) return Buffer.from(JSON.stringify(books));
      if (String(url).includes("/book/1")) {
        return Buffer.from(JSON.stringify({ list: [{ name: "第1集", url: `${host}/media/1.mp3` }] }));
      }
      return Buffer.from("<article>https://audio-list.example/media/1.mp3</article>");
    },
    timeoutMs: 2_000,
  });
  assert.equal(accepted.ok, true);
});

test("verifyConvertedSource 在空列表时返回 rules-stale", async () => {
  const plan = {
    version: 1,
    kind: "books",
    host: "https://novel.example",
    responseType: "html",
    list: "//li",
    fields: {
      name: { selector: ".//a", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: ".//a/@href", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const encoded = encodeBridgePlan(plan);
  const source = {
    sourceName: "坏规则",
    host: "https://novel.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "json",
        requestInfo: `https://convert.example/adapter/books?plan=${encoded}&url=/empty`,
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
  };
  const result = await verifyConvertedSource(source, {
    download: async () => Buffer.from("<html><body><p>no books</p></body></html>"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /rules-stale/);
});

test("verifyConvertedSource 对瞬时空列表重试后执行完整链", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "瞬时空列表" },
  );
  delete source.searchBook;
  let firstRequest = true;
  const result = await verifyConvertedSource(source, {
    download: async (url) => {
      if (firstRequest) {
        firstRequest = false;
        return Buffer.from("<html><body>temporary empty</body></html>");
      }
      return fixtureDownload(url);
    },
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.retryRecovered, true);
});

test("verifyConvertedSource 对忽略 AbortSignal 的下载器执行硬超时", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "硬超时" },
  );
  const started = Date.now();
  const result = await verifyConvertedSource(source, {
    download: async () => new Promise(() => {}),
    timeoutMs: 20,
    sourceTimeoutMs: 40,
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /操作超时/);
  assert.ok(Date.now() - started < 500);
});

test("verifyConvertedSource 会过滤章节正文解析为空的源", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "正文失效" },
  );
  source.chapterContent.content = "//*[@id='missing-content']";
  const result = await verifyConvertedSource(source, {
    download: fixtureDownload,
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rules-stale: empty-content");
});

test("verifyConvertedSource 第一本文档失效时验证后续书籍完整链路", async () => {
  const host = "https://candidate.example";
  const source = {
    sourceName: "候选回退",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld", host, responseFormatType: "html", parserID: "DOM", requestInfo: `${host}/list`,
        list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook", host, responseFormatType: "html", parserID: "DOM", requestInfo: `${host}/list`,
      list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1", cover: "//img/@src", author: "//*[@class='author']",
      cat: "//*[@class='cat']", lastChapterTitle: "//*[@class='latest']",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//div[@id='chapters']/a", title: "normalize-space(//a)", url: "//@href", moreKeys: { pageSize: 20 },
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      content: "//article",
    },
  };
  const download = async (url) => {
    if (String(url).endsWith("/list")) {
      return Buffer.from(`<li><a href="${host}/book/deleted">失效书</a></li><li><a href="${host}/book/good">可用书</a></li>`);
    }
    if (String(url).endsWith("/book/deleted")) return Buffer.from("<p>已删除</p>");
    if (String(url).endsWith("/book/good")) {
      return Buffer.from(`<h1>可用书</h1><img src="/cover.jpg"><span class="author">作者甲</span><span class="cat">历史</span><div id="chapters"><a href="${host}/read/1">第一章</a><a href="${host}/read/2">第二章</a></div>`);
    }
    if (/\/read\/[12]$/.test(String(url))) return Buffer.from("<article>这是后续候选书籍的完整正文内容。</article>");
    throw new Error(`unexpected ${url}`);
  };

  const result = await verifyConvertedSource(source, { download });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.candidateFallback, 2);
  assert.equal(result.bookName, "可用书");
  assert.deepEqual(result.bookElements.missingRecommended, []);
  assert.equal(result.bookElements.values.author, "作者甲");
  assert.equal(result.bookElements.values.lastChapterTitle, "第二章");
});

test("抽测失败后 pipeline 可回退识站", async () => {
  const repaired = {
    sourceName: "自动识站",
    sourceUrl: "https://novel.example",
    miniAppVersion: "1.0.0",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        parserID: "DOM",
        requestInfo: "https://novel.example/",
        list: "//li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "https://novel.example/search.php?searchkey=%@keyWord",
      list: "//li",
      bookName: ".//a",
      detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "h1",
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const broken = {
    sourceName: "过时源",
    host: "https://novel.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        requestInfo: "https://novel.example/missing",
        list: "//.nope",
        bookName: ".",
        detailUrl: "./@href",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
  };
  const gated = await applyVerifyAndAnalyzeFallback(
    { 过时源: broken },
    {
      download: fixtureDownload,
      enabled: true,
      analyzeFallback: true,
      analyze: async () => ({ ok: true, sources: { 自动识站: repaired } }),
    },
  );
  assert.ok(gated.sources["过时源"]);
  assert.equal(gated.fallbackCount, 1, JSON.stringify(gated.skipped));
  assert.match(gated.sources["过时源"].chapterContent.content, /content/);
});

test("pipeline 不把已检测但修复失败的漫画降级成文本源", async () => {
  const textSource = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "误识别文本" },
  );
  const broken = structuredClone(textSource);
  broken.sourceName = "失效漫画";
  broken.sourceType = "comic";
  broken.bookWorld = {
    漫画: {
      ...broken.bookWorld[Object.keys(broken.bookWorld)[0]],
      requestInfo: "https://novel.example/missing",
      list: "//*[@id='missing']",
    },
  };
  delete broken.searchBook;

  const result = await applyVerifyAndAnalyzeFallback({ 失效漫画: broken }, {
    download: fixtureDownload,
    analyze: async () => ({
      ok: true,
      sources: { 误识别文本: textSource },
      skippedKinds: [{ kind: "comic", reason: "漫画目录识别失败" }],
    }),
  });

  assert.deepEqual(result.sources, {});
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].message || result.skipped[0].reason || "", /仅有 text/);
});

test("pipeline 对已检测但瞬时缺失的目标类型清缓存重试识站", async () => {
  const comicSource = comicDiscoveryToXiangse(
    await discoverComic("https://comic.example/", { download: fixtureDownload }),
    { sourceName: "重试漫画" },
  );
  comicSource.chapterContent.content = [
    "@js:",
    "return JSON.stringify({urls:[",
    '  "https://comic.example/img/1.jpg",',
    '  "https://comic.example/img/2.jpg"',
    "],httpHeaders:{}});",
  ].join("\n");
  const textSource = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "误识别文本" },
  );
  const broken = structuredClone(comicSource);
  broken.bookWorld = {
    漫画: {
      ...broken.bookWorld[Object.keys(broken.bookWorld)[0]],
      requestInfo: "https://comic.example/missing",
      list: "//*[@id='missing']",
    },
  };
  delete broken.searchBook;
  let attempts = 0;

  const result = await applyVerifyAndAnalyzeFallback({ 重试漫画: broken }, {
    download: fixtureDownload,
    analyzeTimeoutMs: 5_000,
    repairBooks: null,
    repairChapter: null,
    repairContent: null,
    repairDetail: null,
    repairJsonChapter: null,
    analyze: async () => {
      attempts += 1;
      return attempts === 1 ? {
        ok: true,
        sources: { 误识别文本: textSource },
        skippedKinds: [{ kind: "comic", reason: "瞬时响应缺少漫画列表" }],
      } : {
        ok: true,
        sources: { 重试漫画: comicSource },
        skippedKinds: [],
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.sources["重试漫画"]?.sourceType, "comic", JSON.stringify(result.skipped));
  assert.equal(result.fallbackCount, 1);
});

test("pipeline 会继续验证识站内部抽测失败但结构有效的候选", async () => {
  const candidate = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "待复验候选" },
  );
  const broken = structuredClone(candidate);
  broken.bookWorld = {
    分类: {
      ...broken.bookWorld[Object.keys(broken.bookWorld)[0]],
      requestInfo: "https://novel.example/missing",
      list: "//*[@id='missing']",
    },
  };
  delete broken.searchBook;

  const result = await applyVerifyAndAnalyzeFallback({ 待复验候选: broken }, {
    download: fixtureDownload,
    analyze: async () => ({
      ok: true,
      sources: {},
      repairCandidates: { 待复验候选: candidate },
      skippedKinds: [{ kind: "text", reason: "内部抽测瞬时失败" }],
    }),
  });

  assert.equal(result.sources["待复验候选"]?.sourceType, "text");
  assert.equal(result.fallbackCount, 1);
});

test("pipeline 对识站后正文为空的漫画继续通用修复并重新验链", async () => {
  const host = "https://comic-repair-pipeline.example";
  const analyzed = {
    sourceName: "识站漫画",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "comic",
    bookWorld: {
      漫画: {
        actionID: "bookWorld", host, responseFormatType: "html", parserID: "DOM",
        requestInfo: `${host}/list`, list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: `${host}/list?q=%@keyWord`, list: "//li", bookName: ".//a", detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", bookName: "//h1", cover: "//img[@class='cover']/@src",
      author: "//span[@class='author']", cat: "//span[@class='cat']",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", list: "//div[@id='chapters']/a", title: ".", url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", content: "//img[@class='toolbar']/@src",
    },
  };
  const broken = {
    sourceName: "失效漫画",
    sourceUrl: host,
    sourceType: "comic",
    bookWorld: {
      漫画: {
        actionID: "bookWorld", host, responseFormatType: "html", parserID: "DOM",
        requestInfo: `${host}/missing`, list: "//*[@id='missing']", bookName: ".", detailUrl: "./@href",
      },
    },
  };
  const download = async (url) => {
    const target = String(url);
    if (/\/pages\/\d+\.jpg$/.test(target) || target.endsWith("/cover.jpg")) {
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    }
    if (target.endsWith("/api/images")) {
      return Buffer.from(JSON.stringify({
        urls: [`${host}/comic/1/page-1.jpg`, `${host}/comic/1/page-2.jpg`],
      }));
    }
    if (/\/comic\/1\/page-\d+\.jpg$/.test(target)) {
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    }
    if (target.endsWith("/list")) {
      return Buffer.from('<ul><li><a href="/comic/1">测试漫画</a></li></ul>');
    }
    if (target.endsWith("/comic/1")) {
      return Buffer.from([
        '<h1>测试漫画</h1><img class="cover" src="/cover.jpg">',
        '<span class="author">测试作者</span><span class="cat">剧情</span>',
        '<div id="chapters"><a href="/comic/1/11">第1话</a><a href="/comic/1/12">第2话</a></div>',
      ].join(""));
    }
    if (/\/comic\/1\/1[12]$/.test(target)) {
      return Buffer.from([
        '<img class="toolbar" src="/static/history.png">',
        '<img class="page" src="/pages/1.jpg"><img class="page" src="/pages/2.jpg">',
      ].join(""));
    }
    return Buffer.from("");
  };
  let contentRepairs = 0;
  const result = await applyVerifyAndAnalyzeFallback(
    { 失效漫画: broken },
    {
      download,
      adapterBase: "https://converter.example",
      analyze: async () => ({ ok: true, sources: { 识站漫画: analyzed } }),
      repairContent: async (source) => {
        contentRepairs += 1;
        return {
          ...source,
          chapterContent: {
            ...source.chapterContent,
            responseFormatType: "json",
            requestInfo: `${host}/api/images`,
            content: "$.urls",
          },
        };
      },
    },
  );

  assert.equal(contentRepairs, 1, JSON.stringify(result.skipped));
  assert.ok(result.sources["失效漫画"], JSON.stringify(result.skipped));
  assert.equal(result.sources["失效漫画"].chapterContent.content, "$.urls");
});

test("局部目录识别生成可执行的通用章节动作", async () => {
  const source = {
    sourceName: "局部目录修复",
    sourceUrl: "https://novel.example",
    miniAppVersion: "2.56.1",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        parserID: "DOM",
        requestInfo: "https://novel.example/",
        list: "//ul[@class='list']/li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "https://novel.example/search.php?searchkey=%@keyWord",
      list: "//ul[@class='list']/li",
      bookName: ".//a",
      detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//*[@id='missing-catalogue']",
      title: ".//a",
      url: ".//a/@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const requests = [];
  const download = (url) => {
    requests.push(String(url));
    if (/\/book\/1\.html/.test(String(url))) return Buffer.from(novelDetail);
    if (/\/chapter\//.test(String(url))) return Buffer.from(novelChapter);
    return Buffer.from(novelHome);
  };
  const partial = await repairChapterFromBook(source, "https://novel.example/book/1.html", {
    download,
  });
  assert.ok(partial);
  const plan = compileChapterBridgePlan(partial.chapterList);
  const output = executeBridgePlan(
    novelDetail,
    "https://novel.example/book/1.html",
    plan,
    { limit: 10 },
  );
  assert.equal(output.data.length, 3);
  assert.notEqual(partial.chapterList.list, source.chapterList.list);
});

test("目录链接和正文连续失效时逐级通用修复并重新验链", async () => {
  const host = "https://linked-catalog.example";
  const stalePlan = encodeBridgePlan({
    version: 1,
    kind: "chapters",
    host,
    responseType: "html",
    list: "//*[@id='missing']",
    tocSelector: "//a[contains(normalize-space(.), '目录')]/@href",
    fields: {
      title: { selector: ".", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: "./@href", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  });
  const listAction = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/list`,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const source = {
    sourceName: "连续损坏",
    sourceUrl: host,
    sourceType: "text",
    miniAppVersion: "2.56.1",
    bookWorld: { 分类: listAction },
    searchBook: { ...listAction, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: `${host}/adapter/chapters?plan=${stalePlan}&url=%@result`,
      list: "$.data",
      title: "title",
      url: "url",
      moreKeys: { pageSize: 100 },
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      content: "//*[@id='missing-content']",
    },
  };
  const chapterText = "连续修复后的正文。".repeat(30);
  const download = async (url) => {
    const target = String(url);
    if (target.endsWith("/list")) return Buffer.from(`<li><a href="${host}/book/1">测试书</a></li>`);
    if (target.endsWith("/book/1")) return Buffer.from('<a href="/read/1">点击阅读</a><a href="/catalog/1">目录列表</a>');
    if (target.endsWith("/catalog/1")) return Buffer.from('<ul class="mulu_list"><a href="/read/1"><li>第一章</li></a><a href="/read/2"><li>第二章</li></a></ul>');
    if (/\/read\/\d+$/.test(target)) return Buffer.from(`<div class="chapter-content"><p>${chapterText}</p></div>`);
    return Buffer.from("");
  };

  const gated = await applyVerifyAndAnalyzeFallback({ 连续损坏: source }, {
    download,
    analyze: async () => { throw new Error("局部修复成功后不应进入整站识别"); },
  });

  assert.ok(gated.sources["连续损坏"], JSON.stringify(gated.skipped));
  assert.equal(gated.fallbackCount, 1);
  assert.match(gated.sources["连续损坏"].chapterList.requestInfo, /adapter\/chapters\?plan=/);
  assert.match(gated.sources["连续损坏"].chapterContent.content, /chapter-content/);
  assert.ok(gated.warnings.some((item) => /目录和正文均失效/.test(item.message)));
});

test("独立目录页的原生章节动作通过当前服务通用跳转器修复", async () => {
  const host = "https://linked-native.example";
  const source = {
    sourceName: "独立目录原生动作",
    sourceUrl: host,
    sourceType: "text",
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//*[@id='missing']", title: ".", url: "./@href",
    },
  };
  const download = async (url) => {
    if (String(url).endsWith("/book/1")) {
      return Buffer.from('<a href="/read/1">第一章</a><a href="/book/1/MainIndex/">点击阅读</a>');
    }
    if (String(url).endsWith("/book/1/MainIndex/")) {
      return Buffer.from('<div class="chapters"><a href="/read/1">第一章</a><a href="/read/2">第二章</a></div>');
    }
    return Buffer.from("");
  };
  const repaired = await repairChapterFromBook(source, `${host}/book/1`, {
    download,
    adapterBase: "https://convert.example",
  });
  assert.ok(repaired);
  assert.match(repaired.chapterList.requestInfo, /https:\/\/convert\.example\/adapter\/toc/);
  assert.match(repaired.chapterList.list, /chapters|\/read\//);
});

test("目录修复从重定向后的 API 详情恢复同资源 HTML 页面", async () => {
  const oldHost = "https://old-api.example";
  const currentHost = "https://current-site.example";
  const source = {
    sourceName: "API 详情转网页目录",
    sourceUrl: oldHost,
    sourceType: "comic",
    chapterList: {
      actionID: "chapterList",
      host: oldHost,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "$.missing",
      title: "title",
      url: "url",
    },
  };
  const download = async (url) => {
    const target = String(url);
    if (target === `${oldHost}/api/comic/7`) {
      const response = Buffer.from('{"data":{"id":7}}');
      Object.defineProperty(response, "read2xsggResponseUrl", {
        value: `${currentHost}/api/comic/7`,
      });
      return response;
    }
    if (target === `${currentHost}/comic/7`) {
      return Buffer.from('<div id="chapters"><a href="/comic/7/71">第一话</a><a href="/comic/7/72">第二话</a></div>');
    }
    throw new Error("not found");
  };

  const repaired = await repairChapterFromBook(source, `${oldHost}/api/comic/7`, {
    download,
    adapterBase: "https://convert.example",
  });

  assert.ok(repaired);
  assert.equal(repaired.chapterList.host, currentHost);
  assert.equal(repaired.chapterList.responseFormatType, "json");
  assert.match(repaired.chapterList.requestInfo, /adapter\/chapters\?plan=/);
  assert.match(repaired.chapterList.requestInfo, /read2xsgg: strip-api-path/);
  assert.equal(repaired.chapterList.list, "$.data");
});

test("局部 JSON 列表识别重写声明式桥接字段", async () => {
  const stalePlan = {
    version: 1,
    kind: "books",
    host: "https://json-books.example",
    responseType: "json",
    list: "$.missing",
    fields: {
      name: { selector: "oldName" },
      url: { selector: "oldUrl" },
    },
    headers: {},
  };
  const token = encodeBridgePlan(stalePlan);
  const action = {
    actionID: "bookWorld",
    host: "https://json-books.example",
    responseFormatType: "json",
    parserID: "JSONPath",
    requestInfo: `https://convert.example/adapter/books?plan=${token}&url=${encodeURIComponent("https://json-books.example/api/list")}`,
    list: "$.data",
    bookName: "$.name",
    detailUrl: "$.url",
  };
  const source = {
    sourceName: "JSON 字段修复",
    sourceUrl: "https://json-books.example",
    sourceType: "text",
    bookWorld: { 分类: action },
  };
  const body = JSON.stringify({
    payload: {
      items: [
        { book_title: "第一本书", detail_path: "/book/1", cover_url: "/cover/1.jpg" },
        { book_title: "第二本书", detail_path: "/book/2", cover_url: "/cover/2.jpg" },
      ],
    },
  });
  const repaired = await repairBooksFromRequests(source, {
    download: async () => Buffer.from(body),
  });
  assert.ok(repaired);
  const repairedToken = repaired.bookWorld.分类.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(repairedToken);
  const output = executeBridgePlan(body, "https://json-books.example/api/list", plan, { limit: 3 });
  assert.equal(output.data.length, 2);
  assert.equal(output.data[0].name, "第一本书");
  assert.equal(output.data[0].url, "https://json-books.example/book/1");
  assert.equal(output.data[0].cover, "https://json-books.example/cover/1.jpg");
});

test("局部 HTML 列表失效时按详情链接聚类重建书籍元素", async () => {
  const host = "https://html-books.example";
  const action = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/library`,
    list: "//*[@id='removed-list']/li",
    bookName: ".//h3",
    detailUrl: ".//h3/a/@href",
  };
  const source = {
    sourceName: "HTML 列表修复",
    sourceUrl: host,
    sourceType: "text",
    miniAppVersion: "2.56.1",
    bookWorld: { 分类: action },
    searchBook: { ...action, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//*[@id='chapters']/a", title: ".", url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const download = async (url) => {
    const target = String(url);
    if (target.endsWith("/library")) return Buffer.from([
      '<nav><a href="/">首页</a><a href="/login">登录</a></nav>',
      '<section class="shelf">',
      '<article><a href="/book/101"><img src="/cover/101.jpg">第一本书</a></article>',
      '<article><a href="/book/102"><img src="/cover/102.jpg">第二本书</a></article>',
      '</section>',
    ].join(""));
    if (/\/book\/\d+$/.test(target)) {
      return Buffer.from('<div id="chapters"><a href="/read/1">第一章</a><a href="/read/2">第二章</a></div>');
    }
    if (/\/read\/\d+$/.test(target)) return Buffer.from(`<div id="content">${"修复后的正文。".repeat(30)}</div>`);
    return Buffer.from("");
  };

  const gated = await applyVerifyAndAnalyzeFallback({ "HTML 列表修复": source }, {
    download,
    analyze: async () => { throw new Error("局部列表修复成功后不应进入整站识别"); },
  });

  const repaired = gated.sources["HTML 列表修复"];
  assert.ok(repaired, JSON.stringify(gated.skipped));
  assert.match(repaired.bookWorld.分类.list, /\/book\//);
  assert.match(repaired.bookWorld.分类.cover, /img/);
  assert.equal(gated.fallbackCount, 1);
});

test("局部 HTML 列表修复采用响应字符集并收敛到已验证的重定向 origin", async () => {
  const oldHost = "http://old-books.example";
  const currentHost = "https://current-books.example";
  const source = {
    sourceName: "重定向 GBK 列表",
    sourceUrl: oldHost,
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: oldHost,
        responseFormatType: "html",
        parserID: "DOM",
        requestInfo: `${oldHost}/library?page=%@pageIndex`,
        list: "//*[@id='removed']",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
  };
  const html = [
    '<article><a href="/book/101"><img src="/cover/101.jpg">第一本书</a></article>',
    '<article><a href="/book/102"><img src="/cover/102.jpg">第二本书</a></article>',
  ].join("");
  const page = iconv.encode(html, "gbk");
  Object.defineProperty(page, "httpHeaders", { value: { "content-type": "text/html; charset=gbk" } });
  Object.defineProperty(page, "read2xsggResponseUrl", { value: `${currentHost}/library?page=1` });

  const repaired = await repairBooksFromRequests(source, { download: async () => page });
  assert.ok(repaired);
  assert.equal(repaired.bookWorld.分类.host, currentHost);
  assert.match(repaired.bookWorld.分类.requestInfo, new RegExp(`^${currentHost}`));
  assert.doesNotMatch(repaired.bookWorld.分类.requestInfo, /old-books/);
  const output = executeBridgePlan(
    html,
    `${currentHost}/library?page=1`,
    compileBookBridgePlan(repaired.bookWorld.分类),
    { limit: 5 },
  );
  assert.deepEqual(output.data.map((item) => item.name), ["第一本书", "第二本书"]);
});

test("HTML 书籍重识别区分作品目录与数字章节叶节点", async () => {
  const host = "https://directory-comic.example";
  const action = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/list`,
    list: "//*[@id='missing']",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const source = {
    sourceName: "目录型漫画",
    sourceUrl: host,
    sourceType: "comic",
    bookWorld: { 分类: action },
  };
  const html = [
    '<li><a href="/stories/alpha/"><img alt="第一本漫画">第一本漫画</a><a href="/stories/alpha/101.html">第1话</a></li>',
    '<li><a href="/stories/beta/"><img alt="第二本漫画">第二本漫画</a><a href="/stories/beta/202.html">第2话</a></li>',
    '<li><a href="/stories/gamma/"><img alt="第三本漫画">第三本漫画</a><a href="/stories/gamma/303.html">第3话</a></li>',
  ].join("");
  const repaired = await repairBooksFromRequests(source, {
    download: async () => Buffer.from(html),
  });
  assert.ok(repaired);
  const output = executeBridgePlan(
    html,
    `${host}/list`,
    compileBookBridgePlan(repaired.bookWorld.分类),
    { limit: 10 },
  );
  assert.deepEqual(output.data.map((item) => item.name), ["第一本漫画", "第二本漫画", "第三本漫画"]);
  assert.ok(output.data.every((item) => item.url.endsWith("/")));
});

test("HTML 搜索响应回显 %u 编码时重写关键词请求", async () => {
  const host = "https://legacy-search.example";
  const source = {
    sourceName: "旧式关键词编码",
    sourceUrl: host,
    sourceType: "text",
    searchBook: {
      actionID: "searchBook",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: `${host}/search?Key=%@keyWord&page=%@pageIndex`,
      list: "//ul",
      bookName: "//a",
      detailUrl: "//a/@href",
    },
  };
  const repaired = await repairBooksFromRequests(source, {
    download: async () => Buffer.from('<form action="/search?Key=%u5c0f%u8bf4&page=1"><p>请输入关键字</p></form>'),
  });
  assert.ok(repaired);
  assert.match(repaired.searchBook.requestInfo, /escape\(String\(params\.keyWord/);
  const requests = resolveBookTargetRequests(repaired);
  assert.match(requests[0].url, /Key=%u5C0F%u8BF4/);
});

test("局部 JSON 目录识别重写声明式章节桥接字段", async () => {
  const stalePlan = {
    version: 1,
    kind: "chapters",
    host: "https://json-books.example",
    responseType: "json",
    list: "$.missing",
    fields: {
      title: { selector: "oldTitle" },
      url: { selector: "oldUrl" },
    },
    headers: {},
  };
  const token = encodeBridgePlan(stalePlan);
  const source = {
    sourceName: "JSON 目录修复",
    sourceUrl: "https://json-books.example",
    sourceType: "text",
    chapterList: {
      actionID: "chapterList",
      host: "https://json-books.example",
      responseFormatType: "json",
      parserID: "JSONPath",
      requestInfo: `https://convert.example/adapter/chapters?plan=${token}&url=${encodeURIComponent("https://json-books.example/book/1")}`,
      list: "$.data",
      title: "$.title",
      url: "$.url",
    },
  };
  const body = JSON.stringify({
    catalog: {
      sections: [
        { chapter_name: "第一章", chapter_path: "/chapter/1" },
        { chapter_name: "第二章", chapter_path: "/chapter/2" },
      ],
    },
  });
  const repaired = await repairChaptersFromBookJson(source, "https://json-books.example/book/1", {
    download: async () => Buffer.from(body),
  });
  assert.ok(repaired);
  const repairedToken = repaired.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(repairedToken);
  const output = executeBridgePlan(body, "https://json-books.example/book/1", plan, { limit: 3 });
  assert.equal(output.data.length, 2);
  assert.equal(output.data[0].title, "第一章");
  assert.equal(output.data[0].url, "https://json-books.example/chapter/1");
});

test("结构校验失败的源先进入通用识站修复再验链", async () => {
  const download = (url) => (
    /\/book\/\d+\.html/.test(String(url)) ? Buffer.from(novelDetail) : fixtureDownload(url)
  );
  const bookAction = {
    actionID: "bookWorld",
    host: "https://novel.example",
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: "https://novel.example/",
    list: "//*[contains(@class,'list')]/li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const repaired = {
    sourceName: "结构损坏",
    sourceUrl: "https://novel.example",
    miniAppVersion: "1.0.0",
    sourceType: "text",
    bookWorld: { 分类: bookAction },
    searchBook: { ...bookAction, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//*[contains(@class,'chapter-list')]/a",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const broken = structuredClone(repaired);
  broken.sourceUrl = "番茄聚合";
  broken.chapterList.url = "";
  let analyzed = 0;
  const gated = await applyVerifyAndAnalyzeFallback(
    { 结构损坏: broken },
    {
      download,
      repairChapter: null,
      repairJsonChapter: null,
      analyze: async (siteUrl) => {
        analyzed += 1;
        assert.equal(siteUrl, "https://novel.example");
        return { ok: true, sources: { 结构损坏: repaired } };
      },
    },
  );
  assert.equal(analyzed, 1);
  assert.equal(gated.fallbackCount, 1);
  assert.ok(gated.sources["结构损坏"]);
  assert.deepEqual(gated.skipped, []);
});

test("正文结构失败后从真实章节页局部修复并重新验链", async () => {
  const host = "https://content-repair.example";
  const action = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/list`,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const source = {
    sourceName: "正文损坏",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "text",
    bookWorld: { 分类: action },
    searchBook: { ...action, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//*[@id='chapters']/a", title: ".", url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      content: "@js:return java.ajax(result)",
    },
  };
  const chapterText = "可验证的章节正文。".repeat(30);
  const download = async (url) => {
    if (String(url).endsWith("/list")) return Buffer.from(`<li><a href="${host}/book/1">测试书</a></li>`);
    if (String(url).endsWith("/book/1")) return Buffer.from(`<div id="chapters"><a href="${host}/read/1">第一章</a></div>`);
    if (String(url).endsWith("/read/1")) return Buffer.from(`<div class="chapter-content"><p>${chapterText}</p></div>`);
    return Buffer.from("");
  };

  const gated = await applyVerifyAndAnalyzeFallback({ 正文损坏: source }, {
    download,
    analyze: async () => { throw new Error("不应进入整站识别"); },
  });

  assert.equal(gated.fallbackCount, 1);
  assert.ok(gated.sources["正文损坏"]);
  assert.match(gated.sources["正文损坏"].chapterContent.content, /chapter-content/);
  assert.deepEqual(gated.skipped, []);
  assert.ok(await repairContentFromChapter(source, `${host}/read/1`, { download }));
});

test("分类页误作书籍并导致正文为空时从列表开始逐级重识别", async () => {
  const host = "https://misclassified-chain.example";
  const action = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/stale`,
    list: "//a",
    bookName: "normalize-space(.)",
    detailUrl: "./@href",
  };
  const source = {
    sourceName: "动作链错位",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "text",
    bookWorld: { 分类: action },
    searchBook: { ...action, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//a", title: "normalize-space(.)", url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const chapterText = "动作链修复后的真实正文。".repeat(30);
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/stale") return Buffer.from('<a href="/category/all">全部作品</a>');
    if (path === "/category/all") {
      return Buffer.from('<a href="/book/1">第一本书</a><a href="/book/2">第二本书</a>');
    }
    if (path === "/") {
      return Buffer.from([
        '<article><a href="/book/1"><img src="/cover/1.jpg">第一本书</a></article>',
        '<article><a href="/book/2"><img src="/cover/2.jpg">第二本书</a></article>',
      ].join(""));
    }
    if (/^\/book\/\d+$/.test(path)) return Buffer.from('<a href="/read/1">第一章</a>');
    if (path === "/read/1") return Buffer.from(`<div id="content">${chapterText}</div>`);
    return Buffer.from("");
  };

  const gated = await applyVerifyAndAnalyzeFallback({ 动作链错位: source }, {
    download,
    analyze: async () => { throw new Error("列表重识别成功后不应进入整站识别"); },
  });

  const repaired = gated.sources.动作链错位;
  assert.ok(repaired, JSON.stringify(gated.skipped));
  assert.equal(new URL(repaired.bookWorld.分类.requestInfo).origin, host);
  assert.match(repaired.bookWorld.分类.list, /\/book\//);
  assert.equal(gated.fallbackCount, 1);
});

test("详情元素修复通用识别作者、分类、封面和最新章节", async () => {
  const host = "https://detail-elements.example";
  const source = {
    sourceName: "详情元素损坏",
    sourceUrl: host,
    sourceType: "text",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const html = [
    '<meta property="og:image" content="/cover.jpg">',
    '<ul id="BookMarkWindow"><li class="category-list">收藏到以下分类</li></ul>',
    '<ul class="book_info"><li><span class="book_newtitle">测试书</span>',
    '<div class="book_info2"><span>玄幻</span><span>连载中</span></div>',
    '<span class="book_info3">测试作者 / 123万字</span></li></ul>',
    '<a class="update-link" href="#top">返回顶部↑</a>',
    '<a class="latest-chapter" href="/read/99">最新章节 第99章 终章</a>',
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["cover", "author", "cat", "lastChapterTitle"],
    { download: async () => Buffer.from(html) },
  );
  assert.ok(repaired);
  assert.match(repaired.bookDetail.cover, /og:image/);
  assert.ok(repaired.bookDetail.author);
  const detail = executeBridgePlan(
    html,
    `${host}/book/1`,
    compileDetailBridgePlan(repaired.bookDetail),
  );
  assert.equal(detail.author, "测试作者");
  assert.equal(detail.cat, "玄幻");
  assert.equal(detail.lastChapterTitle, "最新章节 第99章 终章");
  assert.ok(repaired.bookDetail.cat);
  assert.ok(repaired.bookDetail.lastChapterTitle);
  assert.doesNotMatch(repaired.bookDetail.cat, /BookMarkWindow/);
});

test("封面校验允许语义目录中的作品图片并过滤界面 Logo", async () => {
  const host = "https://cover-path.example";
  const source = {
    sourceName: "封面目录语义",
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const html = [
    '<meta property="og:image" content="/assets/site-logo.png">',
    '<h1>作品标题</h1>',
    '<div class="cover"><img src="/logo/z/zhanchihongzhitong.jpg"></div>',
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["cover"],
    { download: async () => Buffer.from(html) },
  );
  const detail = executeBridgePlan(
    html,
    `${host}/book/1`,
    compileDetailBridgePlan(repaired.bookDetail),
  );

  assert.equal(detail.cover, `${host}/logo/z/zhanchihongzhitong.jpg`);
});

test("详情元素修复读取 JSON-LD 作者并识别繁体降序最新章节", async () => {
  const host = "https://structured-comic.example";
  const source = {
    sourceName: "结构化漫画详情",
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//a", title: ".", url: "./@href",
    },
  };
  const html = [
    '<script type="application/ld+json">',
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Book",
      name: "測試漫畫",
      author: { "@type": "Person", name: "結構化作者" },
    }),
    "</script>",
    "<h1>測試漫畫</h1>",
    '<nav><a href="/">首頁</a></nav>',
    '<a href="/comic/42/c">第3話</a>',
    '<a href="/comic/42/b">第2話</a>',
    '<a href="/comic/42/a">第1話</a>',
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/comic/42`,
    ["author", "cat", "lastChapterTitle"],
    { download: async () => Buffer.from(html), adapterBase: "https://convert.example" },
  );
  assert.ok(repaired);
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(
    html,
    `${host}/comic/42`,
    decodeBridgePlan(token),
  );
  assert.equal(detail.author, "結構化作者");
  assert.equal(detail.cat, "漫画");
  assert.equal(detail.lastChapterTitle, "第3話");
});

test("详情元素修复在无效作者文本后回退 JSON-LD 并读取标准文章分类", async () => {
  const host = "https://article-wiki.example";
  const source = {
    sourceName: "文章详情",
    sourceUrl: host,
    sourceType: "text",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const html = [
    '<script type="application/ld+json">',
    JSON.stringify({
      "@type": "Article",
      author: { "@type": "Organization", name: "百科编辑部" },
    }),
    "</script>",
    "<h1>社区规则</h1>",
    '<div class="author-promotion">作者福利：点击登录领取</div>',
    '<div id="catlinks"><div id="mw-normal-catlinks" class="mw-normal-catlinks">',
    '<a href="/categories">分类</a><ul><li><a href="/category/community">社区规范</a></li></ul>',
    "</div></div>",
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/wiki/rules`,
    ["author", "cat"],
    { download: async () => Buffer.from(html), adapterBase: "https://convert.example" },
  );
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(html, `${host}/wiki/rules`, decodeBridgePlan(token));

  assert.equal(detail.author, "百科编辑部");
  assert.equal(detail.cat, "社区规范");
});

test("详情元素修复读取 OpenGraph 小说作者与分类", async () => {
  const host = "https://og-novel.example";
  const source = {
    sourceName: "OG 小说",
    sourceUrl: host,
    sourceType: "text",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
    },
  };
  const html = [
    '<meta property="og:novel:author" content="测试作者">',
    '<meta property="og:novel:category" content="悬疑小说">',
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["author", "cat"],
    { download: async () => Buffer.from(html) },
  );
  const detail = executeBridgePlan(
    html,
    `${host}/book/1`,
    compileDetailBridgePlan(repaired.bookDetail),
  );

  assert.equal(detail.author, "测试作者");
  assert.equal(detail.cat, "悬疑小说");
});

test("详情元素修复优先显式分类标签并排除同路径推荐作品", async () => {
  const host = "https://generic-comic.example";
  const html = [
    '<aside><p class="title"><a href="/comic/recommended">错误推荐书名</a></p></aside>',
    '<main class="comicInfo"><p class="title">测试漫画</p>',
    '<p><span class="ib l">作 者：测试作者</span></p>',
    '<p><span class="ib l">类 别：<a href="/category/1">重生</a> <a href="/category/2">少年</a></span></p>',
    '<div class="chapterList">',
    '<a href="/comic/chapter-a.html">第1回 开始</a>',
    '<a href="/comic/chapter-b.html">第2回 继续</a>',
    '<a href="/comic/chapter-c.html">第3回 最新</a>',
    '<a href="/comic/chapter-d.html">第4回 更新</a>',
    '<a href="/comic/chapter-e.html">第5回 完结</a>',
    '</div></main>',
    '<section class="recommend"><a href="/comic/another">另一本推荐作品<span>第99回 推荐角标</span></a></section>',
  ].join("");
  const repaired = await repairDetailFromBook(
    {
      sourceUrl: host,
      sourceType: "comic",
      bookDetail: {
        actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
        bookName: "//*[contains(concat(' ', normalize-space(@class), ' '), ' comicInfo ')]//*[contains(concat(' ', normalize-space(@class), ' '), ' title ')]",
      },
    },
    `${host}/comic/book`,
    ["author", "cat", "lastChapterTitle"],
    { download: async () => Buffer.from(html), adapterBase: "https://convert.example" },
  );
  assert.ok(repaired);
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(html, `${host}/comic/book`, decodeBridgePlan(token));
  assert.equal(detail.author, "测试作者");
  assert.equal(detail.cat, "重生 少年");
  assert.equal(detail.lastChapterTitle, "第5回 完结");
});

test("详情元素修复优先使用页面显式作者而非 JSON-LD 发布者", async () => {
  const host = "https://explicit-author.example";
  const source = {
    sourceName: "显式作者漫画",
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const html = [
    '<script type="application/ld+json">',
    JSON.stringify({
      "@type": "Article",
      author: { "@type": "Person", name: "站点发布者" },
    }),
    "</script>",
    "<h1>测试漫画</h1>",
    '<div class="author-content"><a href="/author/1">原作者</a><a href="/author/2">脚本作者</a></div>',
  ].join("");
  const repaired = await repairDetailFromBook(
    source,
    `${host}/comic/42`,
    ["author"],
    { download: async () => Buffer.from(html) },
  );
  assert.ok(repaired);
  const detail = executeBridgePlan(
    html,
    `${host}/comic/42`,
    compileDetailBridgePlan(repaired.bookDetail),
  );
  assert.match(detail.author, /原作者/);
  assert.doesNotMatch(detail.author, /站点发布者/);
});

test("详情元素修复从显式主播标签和语义节目路径提取稳定值", async () => {
  const host = "https://semantic-detail.example";
  const html = [
    '<section><h1>节目</h1><div class="pods">主播：测试主播</div>',
    '<div class="genre-label">广播剧</div></section>',
    '<a href="/vchannels/1/programs/1">第1集</a>',
    '<a href="/vchannels/1/programs/2">第2集</a>',
    '<a href="/vchannels/9">相关推荐 第99集</a>',
  ].join("");
  const repaired = await repairDetailFromBook(
    { sourceUrl: host, bookDetail: {} },
    `${host}/vchannels/1`,
    ["author", "cat", "lastChapterTitle"],
    { download: async () => Buffer.from(html) },
  );
  const detail = executeBridgePlan(
    html,
    `${host}/vchannels/1`,
    compileDetailBridgePlan(repaired.bookDetail),
  );
  assert.equal(detail.author, "测试主播");
  assert.equal(detail.cat, "广播剧");
  assert.equal(detail.lastChapterTitle, "第2集");
  assert.doesNotMatch(repaired.bookDetail.lastChapterTitle, /\/vchannels\/[^)]*last/);
});

test("详情元素修复从通用视频路径提取最新剧集", async () => {
  const host = "https://video-detail.example";
  const html = [
    '<span id="updateTime">2026-01-14</span>',
    '<a href="/video/24803/499652">第1000集</a>',
    '<a href="/video/24803/498653">第01集</a>',
    '<a href="/video/24803/498654">第02集</a>',
    '<a href="#top">返回顶部↑</a>',
    '<a href="/video/24803/499652">第1000集</a>',
  ].join("");
  const repaired = await repairDetailFromBook(
    {
      sourceUrl: host,
      bookDetail: {
        responseFormatType: "json",
        bookName: "$.name",
      },
    },
    host + "/video/24803",
    ["lastChapterTitle"],
    { download: async () => Buffer.from(html) },
  );
  const detail = executeBridgePlan(
    html,
    host + "/video/24803",
    compileDetailBridgePlan(repaired.bookDetail),
  );
  assert.equal(detail.lastChapterTitle, "第1000集");
  assert.equal(repaired.bookDetail.responseFormatType, "html");
  assert.match(repaired.bookDetail.lastChapterTitle, /\/video\//);
});

test("JSON 详情按字段语义和值形态补全书籍元素", async () => {
  const host = "https://json-detail.example";
  const body = JSON.stringify({
    data: {
      id: 7,
      coverUrl: `${host}/covers/7.jpg`,
      authorName: "测试作者",
      tags: "日漫,冒险",
      cName: "第二话 完",
    },
  });
  const repaired = await repairDetailFromBook(
    {
      sourceUrl: host,
      sourceType: "comic",
      bookDetail: { actionID: "bookDetail", host, requestInfo: "%@result" },
    },
    `${host}/api/comic/7`,
    ["cover", "author", "cat", "lastChapterTitle"],
    { download: async () => Buffer.from(body) },
  );
  const detail = executeBridgePlan(
    body,
    `${host}/api/comic/7`,
    compileDetailBridgePlan(repaired.bookDetail),
  );

  assert.equal(repaired.bookDetail.responseFormatType, "json");
  assert.equal(detail.cover, `${host}/covers/7.jpg`);
  assert.equal(detail.author, "测试作者");
  assert.equal(detail.cat, "日漫,冒险");
  assert.equal(detail.lastChapterTitle, "第二话 完");
  assert.equal(repaired.bookDetail.lastChapterTitle, "data/cName");
});

test("详情重修保留旧桥接计划中经真实页面验证的字段", async () => {
  const host = "https://bridged-detail.example";
  const previousPlan = encodeBridgePlan({
    kind: "detail",
    host,
    responseType: "html",
    fields: {
      author: "//span[@class='writer']",
      cover: "//img[@class='cover']/@src",
    },
  });
  const source = {
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "json",
      requestInfo: `https://converter.example/adapter/detail?plan=${previousPlan}&url=`,
      author: "$.author",
      cover: "$.cover",
    },
  };
  const html = '<span class="writer">原计划作者</span><img class="cover" src="/cover.jpg">';
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["cat"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(html, `${host}/book/1`, decodeBridgePlan(token));

  assert.equal(detail.author, "原计划作者");
  assert.equal(detail.cover, `${host}/cover.jpg`);
  assert.equal(detail.cat, "漫画");
});

test("详情页无章节时使用 HTML 目录桥接补全最新章节", async () => {
  const host = "https://linked-latest.example";
  const source = {
    sourceUrl: host,
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "//h1",
      tocUrl: "//a[contains(normalize-space(.), '章节目录')]/@href",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//*[@id='chapters']/a",
      title: ".",
      url: "./@href",
    },
  };
  const html = '<h1>测试书</h1><a href="/book/1/chapters">章节目录</a><a href="#top">返回顶部↑</a>';
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["lastChapterTitle"],
    {
      adapterBase: "https://converter.example",
      download: async () => Buffer.from(html),
    },
  );
  assert.equal(repaired.bookDetail.responseFormatType, "json");
  assert.equal(repaired.bookDetail.lastChapterTitle, "$.lastChapterTitle");
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  assert.equal(decodeBridgePlan(token).latestChapter.mode, "html-toc");
});

test("详情元素修复为通用音视频单章适配器补全末章规则", async () => {
  const host = "https://single-media.example";
  const source = {
    sourceUrl: host,
    sourceType: "video",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "json", parserID: "DOM",
      requestInfo: "https://converter.example/adapter/single-chapter?url=",
      list: "$.data", title: "title", url: "url",
    },
  };
  const html = "<h1>单节目视频</h1>";
  const repaired = await repairDetailFromBook(source, `${host}/video/1`, ["lastChapterTitle"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(html, `${host}/video/1`, decodeBridgePlan(token));

  assert.equal(repaired.bookDetail.lastChapterTitle, "$.lastChapterTitle");
  assert.equal(detail.lastChapterTitle, "播放");
});

test("详情补全从既有章节适配计划恢复末章目录描述", async () => {
  const host = "https://wrapped-latest.example";
  const chapterPlan = encodeBridgePlan({
    kind: "chapters",
    host,
    responseType: "html",
    tocSelector: "//a[contains(normalize-space(.), '目录')]/@href",
    list: "//*[@id='chapters']/a",
    fields: {
      title: { selector: ".", replacements: [{ pattern: "^(\\d+)$", replacement: "第$1页" }] },
      url: "./@href",
    },
  });
  const source = {
    sourceUrl: host,
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: `https://converter.example/adapter/chapters?plan=${chapterPlan}&url=`,
      list: "$.data",
      title: "title",
      url: "url",
    },
  };
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["lastChapterTitle"],
    {
      adapterBase: "https://converter.example",
      download: async () => Buffer.from('<h1>测试书</h1><a href="/book/1/chapters">章节目录</a>'),
    },
  );
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const latest = decodeBridgePlan(token).latestChapter;
  assert.equal(latest.mode, "html-toc");
  assert.equal(latest.list, "//*[@id='chapters']/a");
  assert.deepEqual(latest.title.replacements, [{ pattern: "^(\\d+)$", replacement: "第$1页" }]);
});

test("详情补全保留动态 HTML 目录的末章解析能力", async () => {
  const host = "https://dynamic-latest.example";
  const oldDetailPlan = encodeBridgePlan({
    kind: "detail",
    host,
    responseType: "html",
    fields: { name: "//h1", tocUrl: "//a[@class='catalog']/@href" },
  });
  const source = {
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "json", parserID: "DOM",
      requestInfo: `https://converter.example/adapter/detail?plan=${oldDetailPlan}&url=`,
      bookName: "$.name", tocUrl: "$.tocUrl",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "https://converter.example/adapter/toc?resolve=html&selector=x&url=",
      list: "//*[@id='chapters']/a", title: ".", url: "./@href",
    },
  };
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["lastChapterTitle"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from('<h1>动态漫画</h1><a class="catalog" href="/chapterlist/1">目录</a>'),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const latest = decodeBridgePlan(token).latestChapter;

  assert.equal(latest.mode, "html-toc");
  assert.equal(latest.dynamicHtml, true);
  assert.equal(latest.tocSelector, "//a[@class='catalog']/@href");
  const plan = decodeBridgePlan(token);
  const detail = executeBridgePlan(
    '<h1>动态漫画</h1><a class="catalog" href="/chapterlist/1">目录</a>',
    `${host}/book/1`,
    plan,
  );
  assert.equal(detail.name, "动态漫画");
  assert.equal(detail.tocUrl, "/chapterlist/1");
});

test("详情分类修复从组合元信息中截取标签值", async () => {
  const host = "https://combined-meta.example";
  const source = {
    sourceUrl: host,
    sourceType: "text",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const html = '<h1>测试书</h1><p class="meta">作者：测试作者 类型：其他小说 字数：31274 人气：0</p>';
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["cat"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const detail = executeBridgePlan(html, `${host}/book/1`, decodeBridgePlan(token));
  assert.equal(detail.cat, "其他小说");
});

test("详情元素修复排除作者重复分类和最新更新占位文字", async () => {
  const host = "https://placeholder-detail.example";
  const source = {
    sourceUrl: host,
    sourceType: "text",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//*[@id='chapters']/a", title: ".", url: "./@href",
    },
  };
  const html = [
    "<h1>测试书</h1>",
    "<span class='author'>席绢</span>",
    "<span class='category'>席绢</span>",
    "<a class='latest' href='/read/latest'>最新更新</a>",
    "<div id='chapters'><a href='/read/1'>第1章</a><a href='/read/2'>第2章 结局</a></div>",
  ].join("");
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["cat", "lastChapterTitle"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(token);

  assert.equal(plan.fields.cat.constant, "小说");
  assert.equal(plan.latestChapter.mode, "html-toc");
  assert.equal(plan.fields.lastChapterTitle, undefined);
});

test("详情元素修复只更新缺失字段并拒绝把书名当作作者", async () => {
  const host = "https://partial-detail.example";
  const source = {
    sourceUrl: host,
    sourceType: "comic",
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1", cat: "//span[@class='genre']",
    },
  };
  const html = [
    "<h1>测试漫画</h1>",
    "<span class='author'>测试漫画</span>",
    "<span class='genre'>都市</span>",
  ].join("");
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["author"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(token);

  assert.equal(plan.fields.author.constant, "原站未标注");
  assert.equal(plan.fields.cat.selector, "//span[@class='genre']");
  assert.equal(repaired.bookDetail.cat, "$.cat");
});

test("JSON 详情元素修复从现有章节桥识别分页末章计划", async () => {
  const host = "https://json-latest.example";
  const chapterPlan = encodeBridgePlan({
    kind: "chapters",
    host,
    responseType: "json",
    list: "list",
    fields: { title: "name", url: "id" },
  });
  const source = {
    sourceUrl: host,
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "data/book/name",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: [
        "@js:",
        `var url = ${JSON.stringify(`${host}/menu?bookId=__ID__&pageNum=__PAGE__&pageSize=2`)};`,
        `return ${JSON.stringify(`https://converter.example/adapter/chapters?plan=${chapterPlan}&url=`)} + encodeURIComponent(url);`,
      ].join("\n"),
      list: "$.data",
      title: "title",
      url: "url",
      moreKeys: { pageSize: 2 },
    },
  };
  const download = async (url) => Buffer.from(String(url).includes("/menu?")
    ? JSON.stringify({ sections: 5, list: [{ id: 1, name: "第1集" }, { id: 2, name: "第2集" }] })
    : JSON.stringify({ data: { book: { id: 7, name: "分页节目" } } }));

  const repaired = await repairDetailFromBook(
    source,
    `${host}/detail?bookId=7`,
    ["lastChapterTitle"],
    { adapterBase: "https://converter.example", download },
  );
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const latest = decodeBridgePlan(token).latestChapter;

  assert.equal(repaired.bookDetail.responseFormatType, "json");
  assert.equal(latest.mode, "template");
  assert.equal(latest.countSource, "menu");
  assert.equal(latest.count, "sections");
  assert.equal(latest.values.entityId, "data/book/id");
});

test("详情没有真实封面时使用请求 BASE_URL 的通用类型封面", async () => {
  const host = "https://no-cover.example";
  const source = {
    sourceUrl: host,
    sourceType: "audio",
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "//h1",
    },
  };
  const repaired = await repairDetailFromBook(
    source,
    `${host}/book/1`,
    ["cover", "cat", "author"],
    {
      adapterBase: "https://converter.example",
      download: async () => Buffer.from("<h1>无封面节目</h1><a class='genre' href='/'>返回首页</a><img class='avatar' src='/avatar.png'>"),
    },
  );
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(token);

  assert.equal(repaired.bookDetail.cover, "$.cover");
  assert.equal(plan.fields.cover.constant, "https://converter.example/adapter/cover?kind=audio");
  assert.equal(plan.fields.cat.constant, "音频");
  assert.equal(plan.fields.author.constant, "原站未标注");
});

test("漫画正文 URL 拒绝界面占位资源、封面复用和统计像素", () => {
  const proxy = (url) => `https://converter.example/image/auto?url=${encodeURIComponent(url)}`;
  assert.equal(usableComicPageUrl(proxy("https://site.example/status/mascot-cry.png")), false);
  assert.equal(usableComicPageUrl(proxy("https://site.example/images/win-cross.png")), false);
  assert.equal(usableComicPageUrl(proxy("https://site.example/media/no_img.gif")), false);
  assert.equal(usableComicPageUrl(proxy("https://cdn.example/mhc/book/cover.webp")), false);
  assert.equal(usableComicPageUrl(proxy("https://cdn.example/static/banquan.jpg")), false);
  assert.equal(usableComicPageUrl(proxy("https://cdn.example/mobile/guide-2.png")), false);
  assert.equal(usableComicPageUrl(proxy("https://manga18fx.com/images/manga18fx.png")), false);
  assert.equal(usableComicPageUrl("https://mc.example/watch/123"), false);
  assert.equal(usableComicPageUrl(proxy("https://cdn.example/")), false);
  assert.equal(
    usableComicPageUrl(proxy("https://cdn.example/cover/1.jpg"), "https://cdn.example/cover/1.jpg"),
    false,
  );
  assert.equal(
    usableComicPageUrl(proxy("https://cdn.example/cover/1.webp"), "https://cdn.example/cover/1.jpg"),
    false,
  );
  assert.equal(usableComicPageUrl(proxy("https://cdn.example/comic/1/001.webp")), true);
  assert.equal(usableComicContentReport({
    itemCount: 1,
    firstUrl: proxy("https://cdn.example/comic/1/page_small.jpg"),
  }), false);
  assert.equal(usableComicContentReport({
    itemCount: 1,
    firstUrl: proxy("https://cdn.example/comic/1/page.jpg"),
  }), true);
});

test("漫画正文局部修复生成请求 BASE_URL 的通用图片适配动作", async () => {
  const source = {
    sourceType: "comic",
    sourceUrl: "https://comic.example",
    chapterContent: {
      content: "@js:return result.images.map(function (item) { return item.imageUrl; });",
      httpHeaders: { Referer: "https://comic.example/" },
    },
  };
  const repaired = await repairContentFromChapter(
    source,
    "https://comic.example/chapter/1",
    {
      adapterBase: "https://converter.example",
      download: async () => Buffer.from(""),
    },
  );

  assert.equal(repaired.chapterContent.responseFormatType, "json");
  assert.match(repaired.chapterContent.requestInfo, /https:\/\/converter\.example\/adapter\/images\?plan=/);
  assert.match(repaired.chapterContent.content, /https:\/\/converter\.example\/image\/auto\?url=/);
  const report = await runXbsChapterContent(repaired, {
    chapterUrl: "https://comic.example/chapter/1",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      urls: ["https://cdn.example/pages/1.jpg"],
      proxyUrls: [
        "https://converter.example/image/auto?url=https%3A%2F%2Fcdn.example%2Fpages%2F1.jpg&referer=https%3A%2F%2Fcomic.example%2Fchapter%2F1",
      ],
    }), { headers: { "Content-Type": "application/json" } }),
    timeoutMs: 1_000,
  });
  assert.equal(report.ok, true, report.error);
  assert.match(report.firstUrl, /&referer=https%3A%2F%2Fcomic\.example/);
});

test("漫画正文修复从同源脚本发现并实测分页图片 API", async () => {
  const host = "https://comic-api.example";
  const source = {
    sourceType: "comic",
    sourceUrl: host,
    chapterContent: {
      content: "$.urls||@js:return JSON.stringify({urls: result});",
    },
  };
  const download = async (url) => {
    const target = String(url);
    if (target === `${host}/comic/7/71`) {
      return Buffer.from('<script src="/assets/chapter-reader.js"></script>');
    }
    if (target === `${host}/assets/chapter-reader.js`) {
      return Buffer.from('$.get(`/api/comic/images/${this.chapterId}?page=${this.page}`);');
    }
    if (target === `${host}/api/comic/images/71?page=1`) {
      return Buffer.from(JSON.stringify({
        data: { images: [{ url: `${host}/pages/71/1.jpg` }, { url: `${host}/pages/71/2.jpg` }] },
      }));
    }
    if (target === `${host}/pages/71/1.jpg`) return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    throw new Error(`unexpected ${target}`);
  };

  const repaired = await repairContentFromChapter(source, `${host}/comic/7/71`, {
    adapterBase: "https://converter.example",
    download,
  });
  const requestUrl = new Function(
    "config",
    "params",
    "result",
    repaired.chapterContent.requestInfo.slice(4),
  )({ host }, { queryInfo: {} }, `${host}/comic/8/99`);
  const adapterUrl = new URL(requestUrl);

  assert.equal(
    adapterUrl.searchParams.get("url"),
    `${host}/api/comic/images/99?page=1`,
  );
  assert.equal(repaired.chapterContent.content, source.chapterContent.content);
});

test("漫画正文修复从页面声明图片源中选择首图实测可用的 API 源", async () => {
  const host = "https://comic-source.example";
  const blocked = "https://blocked-cdn.example";
  const backup = "https://backup-cdn.example";
  const source = {
    sourceType: "comic",
    sourceUrl: host,
    chapterContent: { content: "img@src" },
  };
  const download = async (url) => {
    const target = String(url);
    if (target === `${host}/comic/7/71`) {
      return Buffer.from([
        `<script>window.IMAGE_SOURCES = ${JSON.stringify([{ url: blocked }, { url: backup }])};</script>`,
        '<script src="/assets/reader.js"></script>',
      ].join(""));
    }
    if (target === `${host}/assets/reader.js`) {
      return Buffer.from('$.get(`/api/comic/image/${this.chapterId}?page=${this.page}&page_size=${this.pageSize}&image_source=${encodeURIComponent(currentImageSource)}`);');
    }
    if (target.startsWith(`${host}/api/comic/image/71?`)) {
      const selected = new URL(target).searchParams.get("image_source") || blocked;
      return Buffer.from(JSON.stringify({
        data: { images: [{ url: `${selected}/chapter/71/page-1.jpg` }, { url: `${selected}/chapter/71/page-2.jpg` }] },
      }));
    }
    if (target.startsWith(`${blocked}/`)) throw new Error("CDN challenge");
    if (target === `${backup}/chapter/71/page-1.jpg`) return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    throw new Error(`unexpected ${target}`);
  };

  const repaired = await repairContentFromChapter(source, `${host}/comic/7/71`, {
    adapterBase: "https://converter.example",
    download,
  });
  const requestUrl = new Function(
    "config",
    "params",
    "result",
    repaired.chapterContent.requestInfo.slice(4),
  )({ host }, { queryInfo: {} }, `${host}/comic/8/99`);
  const apiUrl = new URL(new URL(requestUrl).searchParams.get("url"));

  assert.equal(apiUrl.pathname, "/api/comic/image/99");
  assert.equal(apiUrl.searchParams.get("page"), "1");
  assert.equal(apiUrl.searchParams.get("page_size"), "25");
  assert.equal(apiUrl.searchParams.get("image_source"), backup);
});

test("漫画正文修复识别同源脚本声明的表单 POST 分批图片 API", async () => {
  const host = "https://comic-post.example";
  const source = {
    sourceType: "comic",
    sourceUrl: host,
    chapterContent: { content: "img@data-src" },
  };
  const calls = [];
  const download = async (url, _headers = {}, options = {}) => {
    const target = String(url);
    if (target === `${host}/chapter/20/91.html`) {
      return Buffer.from([
        '<figure data-chapter-id="91" data-aid="20" data-pic-index="0"></figure>',
        '<script src="/assets/reader-pics.js"></script>',
      ].join(""));
    }
    if (target === `${host}/assets/reader-pics.js`) {
      return Buffer.from([
        "var BATCH = 5;",
        "function load(chapterId, offset) {",
        "$.post('/api/comic/read/pics', { id: chapterId, aid: getAid(chapterId), offset: offset, limit: BATCH }, done, 'json');",
        "}",
      ].join("\n"));
    }
    if (target === `${host}/api/comic/read/pics` && options.method === "POST") {
      calls.push(String(options.body));
      return Buffer.from(JSON.stringify({
        code: 1,
        data: {
          pic: [{ pic: `${host}/pages/001.jpg` }, { pic: `${host}/pages/002.jpg` }],
          offset: 0,
          limit: 5,
          total: 12,
        },
      }));
    }
    throw new Error(`unexpected ${target}`);
  };

  const repaired = await repairContentFromChapter(source, `${host}/chapter/20/91.html`, {
    adapterBase: "https://converter.example",
    download,
  });
  const requestUrl = new Function(
    "config",
    "params",
    "result",
    repaired.chapterContent.requestInfo.slice(4),
  )({ host }, { queryInfo: {} }, `${host}/chapter/21/99.html`);

  assert.equal(new URL(requestUrl).searchParams.get("url"), `${host}/chapter/21/99.html`);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /id=91/);
  assert.match(calls[0], /aid=20/);
  assert.match(calls[0], /limit=5/);
});

test("pipeline 补全详情元素后重新验证完整动作链", async () => {
  const host = "https://detail-pipeline.example";
  const listAction = {
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/list`,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  };
  const source = {
    sourceName: "详情补全验链",
    sourceUrl: host,
    miniAppVersion: "2.56.1",
    sourceType: "text",
    bookWorld: { 分类: listAction },
    searchBook: { ...listAction, actionID: "searchBook" },
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//*[@id='chapters']/a",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//*[@id='content']",
    },
  };
  const detail = [
    '<meta property="og:image" content="/cover.jpg">',
    '<h1>测试书</h1>',
    '<div class="book-meta"><span class="genre">玄幻</span><span class="author-name">测试作者</span></div>',
    '<div id="chapters"><a class="latest-chapter" href="/read/1">最新章节 第一章</a></div>',
  ].join("");
  const download = async (url) => {
    if (String(url).endsWith("/list")) return Buffer.from(`<li><a href="${host}/book/1">测试书</a></li>`);
    if (String(url).endsWith("/book/1")) return Buffer.from(detail);
    if (String(url).endsWith("/read/1")) return Buffer.from(`<article id="content">${"完整正文。".repeat(40)}</article>`);
    return Buffer.from("");
  };

  const result = await applyVerifyAndAnalyzeFallback({ 详情补全验链: source }, {
    download,
    analyze: async () => { throw new Error("不应进入整站识别"); },
  });

  assert.equal(result.fallbackCount, 1);
  assert.ok(result.sources["详情补全验链"]);
  const verified = await verifyConvertedSource(result.sources["详情补全验链"], { download });
  assert.equal(verified.ok, true, verified.detail);
  assert.deepEqual(verified.bookElements.missingRecommended, []);
});

test("识站修复结果必须通过抽测，失败候选会继续尝试下一个", async () => {
  const action = (requestInfo, list = "//li") => ({
    actionID: "bookWorld",
    host: "https://novel.example",
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo,
    list,
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  const chapterList = {
    actionID: "chapterList",
    host: "https://novel.example",
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: "%@result",
    list: "//a",
    title: ".",
    url: "./@href",
  };
  const chapterContent = {
    actionID: "chapterContent",
    host: "https://novel.example",
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: "%@result",
    content: "//article",
  };
  const sourceBase = {
    sourceName: "过时源",
    sourceUrl: "https://novel.example",
    miniAppVersion: "1.0.0",
    sourceType: "text",
    searchBook: action("https://novel.example/search"),
    bookDetail: {
      actionID: "bookDetail",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      bookName: "h1",
    },
    chapterList,
    chapterContent,
  };
  const broken = {
    ...sourceBase,
    bookWorld: { 分类: action("https://novel.example/bad", "//.missing") },
  };
  const badCandidate = {
    ...sourceBase,
    sourceName: "坏候选",
    bookWorld: { 分类: action("https://novel.example/bad-candidate", "//.missing") },
  };
  const goodCandidate = {
    ...sourceBase,
    sourceName: "好候选",
    bookWorld: { 分类: action("https://novel.example/list") },
  };
  const download = async (url) => {
    if (String(url).includes("/list")) {
      return Buffer.from("<html><body><ul><li><a href='/book/1'>书名</a></li></ul></body></html>");
    }
    if (String(url).includes("/book/1") || String(url).includes("/read/1")) {
      return Buffer.from("<html><body><h1>书名</h1><a href='/read/1'>第一章</a><article>正文</article></body></html>");
    }
    return Buffer.from("<html><body><p>empty</p></body></html>");
  };

  const gated = await applyVerifyAndAnalyzeFallback(
    { 过时源: broken },
    {
      download,
      enabled: true,
      analyzeFallback: true,
      analyze: async () => ({
        ok: true,
        sources: {
          坏候选: badCandidate,
          好候选: goodCandidate,
        },
      }),
    },
  );

  assert.equal(gated.fallbackCount, 1);
  assert.ok(gated.sources["过时源"]);
  assert.equal(gated.sources["过时源"].bookWorld.分类.requestInfo, "https://novel.example/list");
  assert.equal(gated.skipped.length, 0);
});

test("skippedBuckets 识别 rules-stale 与 analyze-failed", () => {
  assert.deepEqual(skippedBuckets([
    { reason: "rules-stale: empty-list" },
    { reason: "analyze-failed: 未能发现结构" },
  ]), {
    "rules-stale": 1,
    "analyze-failed": 1,
  });
});

test("verify budget 到期后保留未抽测源，已确认失败的源会跳过", async () => {
  const plan = {
    version: 1,
    kind: "books",
    host: "https://novel.example",
    responseType: "html",
    list: "//li",
    fields: {
      name: { selector: ".//a", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: ".//a/@href", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const encoded = encodeBridgePlan(plan);
  const makeSource = (name) => ({
    sourceName: name,
    sourceUrl: "https://novel.example",
    miniAppVersion: "1.0.0",
    host: "https://novel.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        requestInfo: `https://convert.example/adapter/books?plan=${encoded}&page=%@pageIndex&pageSize=20&slice=1&url=/list`,
        list: "//li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    searchBook: {
      actionID: "searchBook",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "https://novel.example/search?q=%@keyWord",
      list: "//li",
      bookName: ".//a",
      detailUrl: ".//a/@href",
    },
    bookDetail: {
      actionID: "bookDetail",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://novel.example",
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "article",
    },
  });
  const slowDownload = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return Buffer.from("<html><body><p>no books</p></body></html>");
  };
  const sources = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`源${i}`, makeSource(`源${i}`)]),
  );
  const gated = await applyVerifyAndAnalyzeFallback(sources, {
    download: slowDownload,
    concurrency: 2,
    timeoutMs: 200,
    enabled: true,
    analyzeFallback: false,
    budgetMs: 40,
  });
  assert.ok(gated.unverifiedCount >= 1, `expected unverified, got ${gated.unverifiedCount}`);
  // Budget leftovers are kept; confirmed verify failures are skipped.
  assert.equal(Object.keys(gated.sources).length, gated.unverifiedCount);
  assert.equal(Object.keys(gated.sources).length + gated.skipped.length, 6);
  assert.ok(gated.skipped.length >= 1 || gated.unverifiedCount === 6);
});

test("识站失败时过滤原源", async () => {
  const broken = {
    sourceName: "懒人听书",
    sourceUrl: "https://audio.example",
    host: "https://audio.example",
    sourceType: "audio",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://audio.example",
        responseFormatType: "html",
        requestInfo: "https://audio.example/list",
        list: "//li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://audio.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host: "https://audio.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      content: "audio@src",
    },
  };
  const download = async (url) => {
    if (String(url).includes("/list")) {
      return Buffer.from('<html><body><ul><li><a href="/book/1">有声书</a></li></ul></body></html>');
    }
    // Detail / home: look like audio but no static catalog for 识站 to rebuild.
    return Buffer.from('<html><body><title>听书</title><p>有声</p></body></html>');
  };
  const gated = await applyVerifyAndAnalyzeFallback(
    { 懒人听书: broken },
    { download, enabled: true, analyzeFallback: true, timeoutMs: 1_000, analyzeTimeoutMs: 1_000 },
  );
  assert.equal(gated.sources["懒人听书"], undefined);
  assert.equal(Object.keys(gated.sources).length, 0);
  assert.equal(gated.fallbackCount, 0);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.skipped.length, 1);
  assert.match(gated.warnings[0].message, /已过滤/);
});

test("抽测失败且关闭识站回退时过滤原源", async () => {
  const broken = {
    sourceName: "过时源",
    sourceUrl: "https://novel.example",
    host: "https://novel.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        requestInfo: "https://novel.example/list",
        list: "//.nope",
        bookName: ".",
        detailUrl: "./@href",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
  };
  const gated = await applyVerifyAndAnalyzeFallback(
    { 过时源: broken },
    {
      download: async () => Buffer.from("<html><body><p>empty</p></body></html>"),
      enabled: true,
      analyzeFallback: false,
    },
  );
  assert.equal(Object.keys(gated.sources).length, 0);
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(gated.skipped.length, 1);
  assert.match(gated.warnings[0].message, /未启用识站回退/);
});
test("抽测进度回调包含当前站点名", async () => {
  const plan = {
    version: 1,
    kind: "books",
    host: "https://novel.example",
    responseType: "html",
    list: "//li",
    fields: {
      name: { selector: ".//a", replacements: [], hostPrefix: false, matchTemplate: null },
      url: { selector: ".//a/@href", replacements: [], hostPrefix: false, matchTemplate: null },
    },
    headers: {},
  };
  const encoded = encodeBridgePlan(plan);
  const source = {
    sourceName: "进度站",
    sourceUrl: "https://novel.example",
    sourceType: "text",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host: "https://novel.example",
        responseFormatType: "html",
        requestInfo: `https://convert.example/adapter/books?plan=${encoded}&page=%@pageIndex&pageSize=20&slice=1&url=/list`,
        list: "//li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
    },
  };
  const seen = [];
  const download = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Buffer.from("<html><ul><li><a href='/a'>A</a></li></ul></html>");
  };
  await applyVerifyAndAnalyzeFallback(
    { 进度站: source },
    {
      download,
      concurrency: 1,
      timeoutMs: 200,
      enabled: true,
      analyzeFallback: false,
      onProgress: (progress) => {
        if (progress.current || progress.active?.length) seen.push(progress);
      },
    },
  );
  assert.ok(seen.length >= 1);
  assert.ok(seen.some((item) => String(item.current).includes("进度站")));
  assert.ok(seen.some((item) => String(item.current).includes("novel.example")));
});
