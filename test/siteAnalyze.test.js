import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
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
  parseRequestDescriptor,
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
import { dynamicComicApiImages } from "../src/siteAnalyze/dynamicComic.js";
import { createAppServer } from "../src/server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

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

test("detectKind 将单个明确播放器归入对应媒体类型", () => {
  assert.equal(detectKind('<audio src="/play"></audio>').kind, "audio");
  assert.equal(detectKind('<video src="/play"></video>').kind, "video");
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

test("discoverNovel 对带封面的单本书目继续验详情、章节和正文", async () => {
  const host = "https://single-book-list.example";
  const home = `<html><body><ul class="book-list">
    <li><a href="/book/only.html"><img src="/covers/only.jpg">唯一书目</a></li>
  </ul></body></html>`;
  const detail = `<html><body><h1>唯一书目</h1><div class="chapters">
    <a href="/book/only/chapter/1">第一章 开始</a>
    <a href="/book/only/chapter/2">第二章 继续</a>
  </div></body></html>`;
  const chapter = `<html><body><article>${"这是可完整验证的正文内容。".repeat(30)}</article></body></html>`;
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (path === "/book/only.html") return Buffer.from(detail);
    if (/^\/book\/only\/chapter\/\d+$/.test(path)) return Buffer.from(chapter);
    if (path === "/covers/only.jpg") return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    return Buffer.from("");
  };
  const discovery = await discoverNovel(`${host}/`, { download });
  assert.ok(discovery);
  assert.equal(discovery.bookCount, 1);
  assert.equal(discovery.chapterCount, 2);

  const source = novelDiscoveryToXiangse(discovery, { sourceName: "单本书目" });
  const report = await runXbsPipeline(source, {
    fetchImpl: downloadAsFetch(download),
    timeoutMs: 2_000,
  });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.listCount, 1);
  assert.ok(report.steps.chapterList.listCount >= 2);
  assert.ok(report.steps.chapterContent.itemCount > 0);
});

test("discoverNovel 不把单个普通导航链接作为书籍列表", async () => {
  const diagnostics = [];
  const discovery = await discoverNovel("https://single-navigation.example/", {
    homeHtml: '<html><body><nav><a href="/directory">全部小说</a></nav></body></html>',
    download: async () => Buffer.from(""),
    diagnostics,
  });
  assert.equal(discovery, null);
  assert.ok(diagnostics.some((item) => item.includes("书籍链接不足")));
});

test("discoverNovel 在短路径重复导航旁优先使用完整封面书目并通过动作链", async () => {
  const host = "https://short-path-books.example";
  const home = `<html><head><title>短路径书目</title></head><body>
    <nav><a href="/archive">站点导航甲</a><a href="/archive">站点导航乙</a></nav>
    <ul class="book-list">
      <li><a href="/book-a"><img src="/covers/a.jpg">作品甲</a></li>
      <li><a href="/book-b"><img src="/covers/b.jpg">作品乙</a></li>
      <li><a href="/book-c"><img src="/covers/c.jpg">作品丙</a></li>
      <li><a href="/book-d"><img src="/covers/d.jpg">作品丁</a></li>
    </ul>
  </body></html>`;
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (/^\/book-[a-d]$/.test(path)) {
      return Buffer.from(`<html><body><h1>作品详情</h1>
        <a href="${path}/chapter/1">第一章 开始</a>
        <a href="${path}/chapter/2">第二章 继续</a>
      </body></html>`);
    }
    if (/^\/book-[a-d]\/chapter\/\d+$/.test(path)) {
      return Buffer.from(`<article>${"这是完整的章节正文。".repeat(30)}</article>`);
    }
    return Buffer.from("");
  };

  const discovery = await discoverNovel(`${host}/`, { download });
  assert.ok(discovery);
  assert.equal(discovery.bookCount, 4);
  assert.equal(discovery.detailSampleUrl, `${host}/book-a`);

  const source = novelDiscoveryToXiangse(discovery, { sourceName: "短路径书目" });
  const report = await runXbsPipeline(source, {
    fetchImpl: downloadAsFetch(download),
    timeoutMs: 2_000,
  });
  assert.equal(report.ok, true, report.error);
  assert.ok(report.steps.bookWorld.listCount >= 4);
  assert.ok(report.steps.chapterList.listCount >= 2);
  assert.ok(report.steps.chapterContent.itemCount > 0);
});

test("discoverNovel 优先把无扩展名作品 slug 作为详情而非章节 HTML", async () => {
  const home = `<html><head><title>作品全集</title></head><body>
    <nav>
      <a href="/series-volume-1">作品卷一</a>
      <a href="/series-volume-2">作品卷二</a>
      <a href="/series-volume-3">作品卷三</a>
    </nav>
    <main>
      <a href="/series-chapter-01.html">第一章 开始</a>
      <a href="/series-chapter-02.html">第二章 继续</a>
      <a href="/series-chapter-03.html">第三章 尾声</a>
      <a href="/series-chapter-04.html">第四章 番外</a>
    </main>
  </body></html>`;
  const detail = `<html><body><h1>作品第一卷</h1><div class="chapters">
    <a href="/series-chapter-01.html">第一章 开始</a>
    <a href="/series-chapter-02.html">第二章 继续</a>
    <a href="/series-chapter-03.html">第三章 尾声</a>
  </div></body></html>`;
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (/^\/series-volume-\d+$/.test(path)) return Buffer.from(detail);
    return Buffer.from(`<article>${"有效正文。".repeat(50)}</article>`);
  };

  const diagnostics = [];
  const discovery = await discoverNovel("https://slug-novel.example/", { download, diagnostics });

  assert.ok(discovery, diagnostics.join("; "));
  assert.equal(discovery.detailSampleUrl, "https://slug-novel.example/series-volume-1");
  assert.equal(discovery.chapterCount, 3);
});

test("discoverNovel 识别多级书籍 URL 并跳过作者导航", async () => {
  const home = `<!doctype html><html><body>
    <nav><a href="/zuozhe/one/">作者一</a><a href="/zuozhe/two/">作者二</a></nav>
    <section class="books">
      <a href="/yanqing/21_b/book-a.html">书籍甲</a>
      <a href="/yanqing/21_b/book-b.html">书籍乙</a>
      <a href="/yanqing/21_b/book-c.html">书籍丙</a>
      <a href="/yanqing/21_b/book-d.html">书籍丁</a>
    </section>
  </body></html>`;
  const detail = `<!doctype html><html><body><h1>书籍甲</h1>
    <a href="/yanqing/21_b/book-a/1.html">第一章</a>
    <a href="/yanqing/21_b/book-a/2.html">第二章</a>
  </body></html>`;
  const chapter = `<!doctype html><html><body><article>${"多级路径正文。".repeat(30)}</article></body></html>`;
  const download = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return Buffer.from(home);
    if (/\/yanqing\/21_b\/book-[a-d]\.html$/.test(path)) return Buffer.from(detail);
    if (/\/yanqing\/21_b\/book-a\/[12]\.html$/.test(path)) return Buffer.from(chapter);
    throw new Error(`fixture missing: ${url}`);
  };

  const discovery = await discoverNovel("https://nested-path.example/", { download });
  assert.ok(discovery);
  assert.match(discovery.detailSampleUrl, /\/yanqing\/21_b\/book-a\.html$/);
  assert.match(discovery.chapterSampleUrl, /\/book-a\/[12]\.html$/);
});

test("discoverNovel 识别编号分页形式的小说章节", async () => {
  const home = `<a href="/category/21_b/book-a.html">书籍甲</a>
    <a href="/category/21_b/book-b.html">书籍乙</a>
    <a href="/category/21_b/book-c.html">书籍丙</a>`;
  const detail = `<h1>书籍甲</h1>
    <a href="/category/21_b/book-a_2.html">第1页</a>
    <a href="/category/21_b/book-a_3.html">第2页</a>`;
  const chapter = `<article>${"编号分页正文。".repeat(35)}</article>`;
  const download = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/") return Buffer.from(home);
    if (/\/category\/21_b\/book-[abc]\.html$/.test(path)) return Buffer.from(detail);
    if (/\/category\/21_b\/book-a_[23]\.html$/.test(path)) return Buffer.from(chapter);
    throw new Error(`fixture missing: ${url}`);
  };

  const discovery = await discoverNovel("https://paged-detail.example/", { download });
  assert.ok(discovery);
  assert.match(discovery.chapterSampleUrl, /book-a_[23]\.html$/);
  assert.equal(discovery.chapterCount, 2);
});

test("discoverComic 从 HTML fixture 发现漫画结构", async () => {
  const discovery = await discoverComic("https://comic.example/", { download: fixtureDownload });
  assert.ok(discovery);
  assert.equal(discovery.kind, "comic");
  assert.ok(discovery.imageCount >= 3);
  assert.match(discovery.contentSelector, /urls/);
});

test("discoverComic 识别查询参数声明的章节跳转链接", async () => {
  const host = "https://comic-query.example";
  const pages = new Map([
    [`${host}/`, [
      '<a href="/comic/alpha"><img src="/alpha.jpg">甲漫画</a>',
      '<a href="/comic/beta"><img src="/beta.jpg">乙漫画</a>',
    ].join("")],
    [`${host}/comic/alpha`, [
      '<h1>甲漫画</h1>',
      '<a href="/user/page_direct?comic_id=alpha&section_slot=0&chapter_slot=0">第1话</a>',
      '<a href="/user/page_direct?comic_id=alpha&section_slot=0&chapter_slot=1">第2话</a>',
    ].join("")],
    [`${host}/user/page_direct?comic_id=alpha&section_slot=0&chapter_slot=1`,
      '<img src="/pages/1.jpg"><img src="/pages/2.jpg">'],
  ]);
  const download = async (url) => Buffer.from(pages.get(String(url)) || "");

  const discovery = await discoverComic(`${host}/`, { download });

  assert.ok(discovery);
  assert.equal(discovery.chapterCount, 2);
  assert.match(discovery.chapterSampleUrl, /chapter_slot=1/);
});

test("discoverComic 识别同路径阅读参数并过滤章节页装饰图", async () => {
  const host = "https://comic-query-reader.example";
  const pages = new Map([
    [`${host}/`, [
      '<a href="/plugin.php?id=reader&a=bofang&kuid=1"><img src="/cover-1.jpg">甲漫画</a>',
      '<a href="/plugin.php?id=reader&a=bofang&kuid=2"><img src="/cover-2.jpg">乙漫画</a>',
    ].join("")],
    [`${host}/plugin.php?id=reader&a=bofang&kuid=1`, [
      '<h1>甲漫画</h1>',
      '<a href="/plugin.php?id=reader&a=read&kuid=1&zjid=10">第1话</a>',
      '<a href="/plugin.php?id=reader&a=read&kuid=1&zjid=11">艺术设定集</a>',
    ].join("")],
    [`${host}/plugin.php?id=reader&a=read&kuid=1&zjid=11`, [
      '<img src="/assets/logo.png"><img src="/assets/loading.gif">',
      "<script>const pages = ['/pages/1.webp', '/pages/2.webp', '/pages/3.webp'];</script>",
    ].join("")],
  ]);
  const discovery = await discoverComic(`${host}/`, {
    download: async (url) => Buffer.from(pages.get(String(url)) || ""),
    adapterBase: "https://converter.example",
  });

  assert.ok(discovery);
  assert.equal(discovery.chapterCount, 2);
  assert.equal(discovery.contentResponseFormatType, "json");
  assert.ok(discovery.imageCount >= 3);
  assert.match(discovery.chapterSampleUrl, /a=read/);
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

test("discoverMedia 区分 voddetail 与 vodplay，并解码播放器地址", async () => {
  const host = "https://route-media.example";
  const videoUrl = "https://cdn.example/video/episode-1.m3u8?token=abc";
  const encoded = Buffer.from(encodeURIComponent(videoUrl), "utf8").toString("base64");
  const home = `<html><body><p>影视 视频 播放</p>
    <a class="vod-item" href="/voddetail/1.html">节目甲</a>
    <a class="vod-item" href="/voddetail/2.html">节目乙</a>
  </body></html>`;
  const detail = `<html><body><h1>节目甲</h1>
    <a href="/vodplay/1-1-1.html">第1集</a>
    <a href="/vodplay/1-1-2.html">第2集</a>
  </body></html>`;
  const chapter = `<html><body><script>var player_aaaa={"url":"${encoded}"};</script></body></html>`;
  const discovery = await discoverMedia(`${host}/`, "video", {
    download: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/") return Buffer.from(home);
      if (path === "/voddetail/1.html") return Buffer.from(detail);
      if (path.startsWith("/vodplay/")) return Buffer.from(chapter);
      throw new Error(`fixture missing: ${url}`);
    },
    adapterBase: "https://converter.example",
  });
  assert.ok(discovery);
  assert.equal(discovery.detailSampleUrl, `${host}/voddetail/1.html`);
  assert.equal(discovery.chapterCount, 2);
  assert.equal(discovery.chapterSampleUrl, `${host}/vodplay/1-1-2.html`);
  assert.equal(discovery.mediaSampleUrl, videoUrl);
});

test("discoverMedia 通用识别重复内容卡、单节目媒体和列表分页", async () => {
  const home = (page) => `<!doctype html><html><head><title>有声站</title></head><body>
    <p>听书 有声 音频</p>
    <nav><a href="/category/history">历史</a><a href="/category/fantasy">玄幻</a></nav>
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
  assert.match(discovery.categoryFilters, /历史::https:\/\/card-audio\.example\/category\/history\/page\/%@pageIndex/);
  assert.match(discovery.chapterRequestInfo, /adapter\/single-chapter/);
  assert.equal(discovery.chapterListSelector, "$.data");
  assert.match(discovery.contentRequestInfo, /adapter\/media/);
  const source = mediaDiscoveryToXiangse(discovery, { sourceName: "单节目音频" });
  assert.match(source.bookWorld.分类.moreKeys.requestFilters, /玄幻::/);
  assert.match(source.bookWorld.分类.requestInfo, /params\.pageIndex/);
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

test("discoverSpaMedia 识别不带 api 前缀的通用影视目录接口", async () => {
  const home = `<!doctype html><html><head><title>SPA video</title>
  <script src="/assets/player.js"></script></head><body>影视剧集</body></html>`;
  const script = `const loadMovies=async(e,t,n)=>await client.get(e,"/vod/list",{pagination:JSON.stringify(t),videoClassId:n});loadMovies(apiBase,{pageNo:1,moduleNum:0},90013);`;
  const page = (index) => ({
    data: {
      records: Array.from({ length: 3 }, (_, offset) => ({
        movieId: `${index}${offset + 1}`,
        title: `第${index}页影片${offset + 1}`,
        poster: `https://cdn.spa-video.example/cover/${index}${offset + 1}.jpg`,
      })),
    },
  });
  const detail = {
    data: {
      movieDetail: {
        movieId: "11",
        title: "影片甲",
        poster: "https://cdn.spa-video.example/cover/11.jpg",
        categoryName: "剧情",
        playInfo: { videoUrl: "https://cdn.spa-video.example/video/11.m3u8" },
      },
    },
  };
  const download = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/assets/player.js") return Buffer.from(script);
    if (parsed.pathname === "/vod/list") {
      const query = JSON.parse(parsed.searchParams.get("pagination"));
      return Buffer.from(JSON.stringify(page(query.pageNo)));
    }
    if (parsed.pathname === "/api/detail/11") return Buffer.from(JSON.stringify(detail));
    throw new Error("unexpected fixture request");
  };
  const repairPlan = encodeBridgePlan({
    version: 1,
    kind: "books",
    host: "https://spa-video.example",
    responseType: "json",
    list: "records",
    fields: {
      name: { selector: "title" },
      url: {
        selector: "movieId",
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix: "https://spa-video.example/api/detail/",
          suffix: "",
        },
      },
    },
  });
  const repairSource = {
    sourceName: "SPA video",
    sourceType: "video",
    bookWorld: {
      推荐: { requestInfo: `https://converter.example/adapter/books?plan=${repairPlan}&url=https%3A%2F%2Fspa-video.example%2Flegacy` },
    },
  };

  const diagnostics = [];
  const discovery = await discoverSpaMedia("https://spa-video.example/", "video", {
    download,
    homeHtml: home,
    homeResponseUrl: "https://spa-video.example/",
    adapterBase: "https://converter.example",
    repairSource,
    diagnostics,
  });

  assert.ok(discovery, diagnostics.join("; "));
  assert.equal(discovery.source.sourceType, "video");
  assert.equal(discovery.bookCount, 3);
  assert.equal(discovery.mediaSampleUrl, "https://cdn.spa-video.example/video/11.m3u8");
  const validation = validateXiangseSource(discovery.source);
  assert.equal(validation.ok, true, validation.errors.join("; "));
});

test("discoverSpaMedia 从 fetch 静态 GET 和列表详情链接识别无预置详情模板的影视源", async () => {
  const home = `<!doctype html><html><head><script src="/assets/app.js"></script></head>
  <body>影视剧集</body></html>`;
  const script = `fetch("/vod/list?page=1");`;
  const listPage = (page) => ({
    data: {
      records: Array.from({ length: 2 }, (_, index) => {
        const id = `${page}${index + 1}`;
        return { movieId: id, title: `影片${id}`, detailUrl: `/vod/detail/${id}` };
      }),
    },
  });
  const detail = {
    data: {
      movieDetail: {
        movieId: "11",
        title: "影片11",
        categoryName: "剧情",
        mediaUrl: "https://cdn.spa-direct.example/video/11.m3u8",
      },
    },
  };
  const download = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/assets/app.js") return Buffer.from(script);
    if (parsed.pathname === "/vod/list") {
      return Buffer.from(JSON.stringify(listPage(Number(parsed.searchParams.get("page")) || 1)));
    }
    if (/^\/vod\/detail\//.test(parsed.pathname)) return Buffer.from(JSON.stringify(detail));
    throw new Error("unexpected fixture request");
  };
  const diagnostics = [];
  const discovery = await discoverSpaMedia("https://spa-direct.example/", "video", {
    download,
    homeHtml: home,
    homeResponseUrl: "https://spa-direct.example/",
    adapterBase: "https://converter.example",
    repairSource: { sourceName: "SPA direct", sourceType: "video" },
    diagnostics,
  });

  assert.ok(discovery, diagnostics.join("; "));
  assert.equal(discovery.source.sourceType, "video");
  assert.equal(discovery.bookCount, 2);
  assert.equal(discovery.mediaSampleUrl, "https://cdn.spa-direct.example/video/11.m3u8");
  const validation = validateXiangseSource(discovery.source);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  const detailToken = discovery.source.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const bridgedDetail = executeBridgePlan(
    Buffer.from(JSON.stringify(detail)),
    "https://spa-direct.example/vod/detail/11",
    decodeBridgePlan(detailToken),
  );
  assert.equal(bridgedDetail.name, "影片11");
  const chapterToken = discovery.source.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const bridgedChapters = executeBridgePlan(
    Buffer.from(JSON.stringify(detail)),
    "https://spa-direct.example/vod/detail/11",
    decodeBridgePlan(chapterToken),
  );
  assert.equal(bridgedChapters.data[0].title, "影片11");
  assert.equal(bridgedChapters.data[0].url, "https://cdn.spa-direct.example/video/11.m3u8");
});

test("discoverSpaMedia 解析 Axios baseURL、分类参数与模板详情接口", async () => {
  const home = '<link rel="modulepreload" href="/assets/prefetch.js"><script src="/assets/app.js"></script>';
  const script = [
    'import("./views/videoDetail.js");',
    'const client=axios.create({baseURL:"/api/v1",withCredentials:true});',
    'const api={getCategories(){return client.get("/categories",{params:{type:"video"}})},',
    'getVideosByCategory(e,p=1,n=20){return client.get("/videos",{params:{categoryId:e,page:p,size:n}})},',
    'getVideoById(e){return client.get(`/videos/${e}`)}};',
  ].join("");
  const categories = {
    data: [
      { id: 7, name: "剧集", type: "video", enabled: true },
      { id: 8, name: "电影", type: "video", enabled: true },
    ],
  };
  const page = (number) => ({
    data: {
      items: Array.from({ length: 2 }, (_, index) => ({
        id: `${number}${index + 1}`,
        title: `影片${number}${index + 1}`,
        coverUrl: `https://cdn.spa-api.example/cover/${number}${index + 1}.jpg`,
      })),
      page: number,
    },
  });
  const detail = {
    data: {
      videoInfo: {
        id: 11,
        title: "影片11",
        categoryName: "剧集",
        videoUrl: "jpd/2026/file.m3u8",
      },
    },
  };
  const calls = [];
  const download = async (url) => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.pathname}?${[...parsed.searchParams.keys()].sort().join(",")}`);
    if (parsed.pathname === "/assets/app.js") return Buffer.from(script);
    if (parsed.pathname === "/assets/prefetch.js") return Buffer.from("export const prefetched=true;");
    if (parsed.pathname === "/assets/views/videoDetail.js") {
      return Buffer.from('import {toPlayableUrl} from "../videoPlayback.js"; export {toPlayableUrl};');
    }
    if (parsed.pathname === "/assets/videoPlayback.js") {
      return Buffer.from('export const toPlayableUrl=(value)=>`/api/v1/m3u8/proxy?path=${encodeURIComponent(value)}`;');
    }
    if (parsed.pathname === "/api/v1/categories") return Buffer.from(JSON.stringify(categories));
    if (parsed.pathname === "/api/v1/videos" && parsed.searchParams.get("categoryId") === "7") {
      return Buffer.from(JSON.stringify(page(Number(parsed.searchParams.get("page")) || 1)));
    }
    if (parsed.pathname === "/api/v1/videos/11") return Buffer.from(JSON.stringify(detail));
    throw new Error("unexpected fixture request");
  };
  const diagnostics = [];
  const discovery = await discoverSpaMedia("https://spa-api.example/", "video", {
    download,
    homeHtml: home,
    adapterBase: "https://converter.example",
    repairSource: { sourceName: "SPA API", sourceType: "video" },
    diagnostics,
  });

  assert.ok(discovery, diagnostics.join("; "));
  assert.deepEqual(Object.keys(discovery.source.bookWorld), ["剧集", "电影"]);
  assert.ok(calls.includes("/assets/prefetch.js?"));
  assert.ok(calls.includes("/assets/views/videoDetail.js?"));
  assert.ok(calls.includes("/assets/videoPlayback.js?"));
  assert.ok(calls.includes("/api/v1/categories?type"));
  assert.ok(calls.includes("/api/v1/videos?categoryId,page,size"));
  assert.ok(discovery.source.bookWorld["剧集"].requestInfo.includes("/adapter/books"));
  const categoryRequestInfo = discovery.source.bookWorld["剧集"].requestInfo;
  const categoryAdapterUrl = new Function("config", "params", "result", categoryRequestInfo.slice(4))(
    {},
    { pageIndex: 2 },
    "",
  );
  assert.match(
    new URL(categoryAdapterUrl).searchParams.get("url"),
    /\/api\/v1\/videos\?page=2&size=20&categoryId=7/,
  );
  const categoryPlanToken = categoryRequestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const resolvedTarget = resolveBookTargetRequest(
    discovery.source,
    discovery.source.bookWorld["剧集"],
    { plan: decodeBridgePlan(categoryPlanToken), requestInfo: categoryRequestInfo },
    { pageIndex: 2 },
  );
  const resolvedUrl = new URL(resolvedTarget.url);
  assert.equal(resolvedUrl.pathname, "/api/v1/videos");
  assert.equal(resolvedUrl.searchParams.get("page"), "2");
  assert.equal(resolvedUrl.searchParams.get("categoryId"), "7");
  const detailToken = discovery.source.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const bridgedDetail = executeBridgePlan(
    Buffer.from(JSON.stringify(detail)),
    "https://spa-api.example/api/v1/videos/11",
    decodeBridgePlan(detailToken),
  );
  assert.equal(bridgedDetail.name, "影片11");
  const chapterToken = discovery.source.chapterList.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const bridgedChapters = executeBridgePlan(
    Buffer.from(JSON.stringify(detail)),
    "https://spa-api.example/api/v1/videos/11",
    decodeBridgePlan(chapterToken),
  );
  assert.deepEqual(bridgedChapters.data, [{
    title: "影片11",
    url: "https://spa-api.example/api/v1/m3u8/proxy?path=jpd%2F2026%2Ffile.m3u8",
  }]);
  const absoluteMediaDetail = {
    data: {
      videoInfo: {
        id: 11,
        title: "影片11",
        videoUrl: "https://cdn.spa-api.example/video/11.m3u8?token=sample",
      },
    },
  };
  const absoluteMediaChapters = executeBridgePlan(
    Buffer.from(JSON.stringify(absoluteMediaDetail)),
    "https://spa-api.example/api/v1/videos/11",
    decodeBridgePlan(chapterToken),
  );
  assert.equal(
    absoluteMediaChapters.data[0].url,
    "https://spa-api.example/api/v1/m3u8/proxy?path=video%2F11.m3u8%3Ftoken%3Dsample",
  );
  const validation = validateXiangseSource(discovery.source);
  assert.equal(validation.ok, true, validation.errors.join("; "));
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
  assert.match(result.warning.message, /site-analyze/);
  assert.equal(Object.keys(result.sources).length, 1);
});

test("analyzeSite 从同源书库入口继续发现文本列表并跑通正文链", async () => {
  const host = "https://portal-novel.example";
  const requested = [];
  const landing = '<html><body><nav><a href="/library">小说书库</a></nav></body></html>';
  const listing = `<html><body><ul class="books">
    <li><a href="/book/1.html">第一本书</a></li>
    <li><a href="/book/2.html">第二本书</a></li>
    <li><a href="/book/3.html">第三本书</a></li>
  </ul></body></html>`;
  const detail = `<html><body><h1>第一本书</h1><div class="chapter-list">
    <a href="/chapter/1.html">第一章</a><a href="/chapter/2.html">第二章</a>
  </div></body></html>`;
  const content = `<html><body><article id="content"><p>${"正文段落。".repeat(40)}</p></article></body></html>`;
  const result = await analyzeSite(`${host}/`, {
    sourceName: "同源目录文本",
    preferKind: "text",
    download: async (url) => {
      const parsed = new URL(String(url));
      requested.push(parsed.pathname);
      if (parsed.pathname === "/") return Buffer.from(landing);
      if (parsed.pathname === "/library") return Buffer.from(listing);
      if (/^\/book\/\d+\.html$/.test(parsed.pathname)) return Buffer.from(detail);
      if (/^\/chapter\/\d+\.html$/.test(parsed.pathname)) return Buffer.from(content);
      throw new Error(`fixture missing: ${parsed.pathname}`);
    },
  });

  assert.equal(result.ok, true, result.reason);
  assert.ok(requested.includes("/library"), "应继续探测同源书库页");
  assert.equal(result.source.sourceType, "text");
  assert.equal(result.runtimeReports[result.source.sourceName].ok, true);
  assert.ok(result.runtimeReports[result.source.sourceName].steps.chapterContent.itemCount > 0);
});

test("阅读源修复先验声明类型，不让无关影视发现拖住文本候选", async () => {
  const host = "https://preferred-kind.example";
  const requested = [];
  const home = novelHome.replace(
    "</body>",
    '<p>影视 视频</p><a href="/voddetail/1.html">节目甲</a><a href="/voddetail/2.html">节目乙</a></body>',
  );
  const result = await analyzeSite(`${host}/`, {
    download: async (url) => {
      const parsed = new URL(String(url));
      requested.push(parsed.pathname);
      if (parsed.pathname === "/") return Buffer.from(home);
      if (/^\/book\/\d+\.html$/.test(parsed.pathname)) return Buffer.from(novelDetail);
      if (/^\/chapter\/\d+\.html$/.test(parsed.pathname)) return Buffer.from(novelChapter);
      if (/^\/voddetail\/\d+\.html$/.test(parsed.pathname)) {
        throw new Error("unrelated video detail should not be probed");
      }
      throw new Error(`fixture missing: ${parsed.pathname}`);
    },
    sourceName: "混合门户文本规则修复",
    preferKind: "text",
    validateRuntime: false,
  });

  assert.equal(result.ok, true, result.reason);
  assert.ok(result.detectedKinds.includes("text"));
  assert.ok(result.detectedKinds.includes("video"));
  assert.equal(result.source.sourceType, "text");
  assert.equal(requested.some((path) => path.startsWith("/voddetail/")), false);
});

test("analyzeSite 按声明类型探测没有媒体关键词的影视首页", async () => {
  const host = "https://declared-video.example";
  const home = [
    '<article><h2><a href="/voddetail/1.html">节目甲</a></h2></article>',
    '<article><h2><a href="/voddetail/2.html">节目乙</a></h2></article>',
  ].join("");
  const detail = '<html><body><h1>节目甲</h1><video src="https://cdn.example/episode.m3u8"></video></body></html>';
  const requested = [];
  const result = await analyzeSite(`${host}/`, {
    download: async (url) => {
      requested.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path === "/") return Buffer.from(home);
      if (/^\/voddetail\/\d+\.html$/.test(path)) return Buffer.from(detail);
      throw new Error(`fixture missing: ${url}`);
    },
    sourceName: "声明影视源",
    preferKind: "video",
    adapterBase: "https://convert.example",
    validateRuntime: false,
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.detectedKinds, []);
  assert.deepEqual(result.kinds, ["video"]);
  assert.equal(result.source.sourceType, "video");
  assert.ok(requested.some((url) => /\/voddetail\/1\.html$/.test(url)));
  assert.match(result.source.chapterList.requestInfo, /adapter\/single-chapter/);
});

test("analyzeSite 后续识站轮次轮换到前四个以外的声明入口", async () => {
  const requested = [];
  const seedRequests = Array.from({ length: 7 }, (_, index) => ({
    url: `https://seeds.example/catalog-${index + 1}`,
  }));
  const download = async (url) => {
    requested.push(new URL(url).pathname);
    return Buffer.from("<html><body><p>未声明内容</p></body></html>");
  };

  const result = await analyzeSite("https://seeds.example/", {
    download,
    seedRequests,
    attempt: 1,
  });

  assert.equal(result.ok, false);
  assert.ok(requested.includes("/catalog-5"));
  assert.ok(requested.includes("/catalog-7"));
  assert.equal(requested.includes("/catalog-2"), false);
});

test("analyzeSite 在重复入口批次上于网络请求前停止", async () => {
  const seen = new Set();
  const fingerprints = [];
  let downloads = 0;
  const options = {
    download: async () => {
      downloads += 1;
      return Buffer.from("<html><body>unclassified portal</body></html>");
    },
    onProbeBatch: (fingerprint) => {
      fingerprints.push(fingerprint);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    },
  };

  const first = await analyzeSite("https://repeat-batch.example/", options);
  const firstDownloadCount = downloads;
  const second = await analyzeSite("https://repeat-batch.example/", { ...options, attempt: 1 });

  assert.equal(first.ok, false);
  assert.equal(first.repeatedEvidence, undefined);
  assert.equal(second.repeatedEvidence, true);
  assert.equal(second.probeBatchFingerprint, first.probeBatchFingerprint);
  assert.equal(fingerprints.length, 2);
  assert.equal(downloads, firstDownloadCount, "重复批次不应再次访问站点");
});

test("analyzeSite 汇总所有探测中的 HTTP 响应证据", async () => {
  const result = await analyzeSite("https://responding-origin.example/", {
    download: async () => {
      throw new Error("下载阅读源失败：上游返回 HTTP 403");
    },
    seedRequests: [{ url: "https://responding-origin.example/catalog" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.originResponded, true);
  assert.ok(result.httpResponseStatuses.includes(403));
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
  assert.equal(discovery.detailUrlSelector, "//@href");
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

test("analyzeSite 将阅读源级请求头继承到首页、分类和后续动作", async () => {
  const requests = [];
  const download = async (url, headers = {}, options = {}) => {
    requests.push({ url, headers, options });
    return fixtureDownload(url);
  };
  const result = await analyzeSite("https://novel.example/", {
    download,
    repairSource: {
      header: JSON.stringify({
        "User-Agent": "SourceUA/1.0",
        Referer: "https://novel.example/",
      }),
    },
    seedRequests: [{
      url: "https://novel.example/category",
      headers: { "X-Seed": "yes", "User-Agent": "SeedUA/1.0" },
      options: {},
    }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const home = requests.find((item) => new URL(item.url).pathname === "/");
  const category = requests.find((item) => new URL(item.url).pathname === "/category");
  assert.equal(home.headers["User-Agent"], "SourceUA/1.0");
  assert.equal(home.headers.Referer, "https://novel.example/");
  assert.equal(category.headers["User-Agent"], "SeedUA/1.0");
  assert.equal(category.headers["X-Seed"], "yes");
  assert.equal(category.headers.Referer, "https://novel.example/");
});

test("analyzeSite 不合并 URL 相同但请求头不同的声明入口", async () => {
  const requestedHeaders = [];
  const result = await analyzeSite("https://header-seeds.example/", {
    preferKind: "text",
    validateRuntime: false,
    download: async (url, headers = {}) => {
      if (new URL(String(url)).pathname === "/catalog") {
        requestedHeaders.push(headers["X-Catalog"]);
      }
      return fixtureDownload(url);
    },
    seedRequests: [
      { url: "https://header-seeds.example/catalog", headers: { "X-Catalog": "first" } },
      { url: "https://header-seeds.example/catalog", headers: { "X-Catalog": "second" } },
    ],
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(requestedHeaders, ["first", "second"]);
});

test("analyzeSite 并发探测首页和独立分类种子", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const download = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fixtureDownload(url);
    } finally {
      inFlight -= 1;
    }
  };
  const result = await analyzeSite("https://novel.example/", {
    download,
    seedUrls: [
      "https://novel.example/category-a",
      "https://novel.example/category-b",
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(maxInFlight >= 2, `expected parallel seed probes, got ${maxInFlight}`);
});

test("analyzeSite 对漫画 fixture 生成漫画源", async () => {
  const result = await analyzeSite("https://comic.example/", { download: fixtureDownload });
  assert.equal(result.ok, true);
  assert.ok(result.kinds.includes("comic"));
  const comic = Object.values(result.sources).find((item) => item.sourceType === "comic");
  assert.ok(comic);
  assert.match(comic.chapterContent.content, /urls/);
});

test("analyzeSite 漫画正文只命中页面图标时通用修复并重新验证", async () => {
  const host = "https://comic-ui.example";
  const home = `<p>漫画 comic manga 阅读</p><ul>${[1, 2, 3, 4].map((id) => (
    `<li><img src="/cover/${id}.jpg"><a href="/comic/${id}.html">漫画${id}</a></li>`
  )).join("")}</ul>`;
  const detail = `<h1>漫画1</h1>
    <a href="/comic/1/1.html">第1话</a><a href="/comic/1/2.html">第2话</a>`;
  const chapter = `<img src="/static/home_icon_his.png">
    <img class="page" src="/pages/1.jpg"><img class="page" src="/pages/2.jpg">`;
  const download = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (/\.(?:jpg|png)$/.test(pathname)) return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    if (pathname === "/") return Buffer.from(home);
    if (/^\/comic\/\d+\.html$/.test(pathname)) return Buffer.from(detail);
    if (/^\/comic\/\d+\/\d+\.html$/.test(pathname)) return Buffer.from(chapter);
    throw new Error(`fixture missing: ${url}`);
  };
  let repairs = 0;
  const result = await analyzeSite(`${host}/`, {
    download,
    sourceName: "页面图标漫画",
    contentRepair: async (source) => {
      repairs += 1;
      return {
        ...source,
        chapterContent: {
          ...source.chapterContent,
          requestInfo: "%@result",
          content: "//img[contains(concat(' ', normalize-space(@class), ' '), ' page ')]/@src||@js:return JSON.stringify({urls:result,httpHeaders:{}});",
        },
      };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.skippedKinds));
  assert.equal(repairs, 1);
  assert.match(result.source.chapterContent.content, /normalize-space\(@class\)/);
  assert.equal(result.runtimeReports["页面图标漫画"].steps.chapterContent.firstUrl, "/pages/1.jpg");
  assert.equal(usableComicContentReport(
    result.runtimeReports["页面图标漫画"].steps.chapterContent,
  ), true);
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

test("discoverComic 过滤阅读按钮并从短章节候选中选择可用正文", async () => {
  const host = "https://comic-short-chapter.example";
  const home = '<a href="/manga/first"><img src="/covers/1.jpg">第一本漫画</a>'
    + '<a href="/manga/second"><img src="/covers/2.jpg">第二本漫画</a>';
  const detail = `<h1>第一本漫画</h1><div class="chapters">
    <a href="/read/0">阅读</a><a href="/read/1">第1话</a>
    <a href="/read/2">第2话</a><a href="/read/3?chapter=3">艺术设定集</a></div>`;
  const download = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/") return Buffer.from(home);
    if (path.startsWith("/manga/")) return Buffer.from(detail);
    if (path === "/read/1" || path === "/read/2") return Buffer.from('<img src="/pages/one.jpg">');
    if (path === "/read/3") return Buffer.from('<img src="/pages/1.jpg"><img src="/pages/2.jpg">');
    throw new Error(`fixture missing: ${url}`);
  };

  const discovery = await discoverComic(`${host}/`, { download });
  assert.ok(discovery);
  assert.equal(discovery.chapterCount, 3);
  assert.equal(discovery.chapterSampleUrl, `${host}/read/3?chapter=3`);
  assert.equal(discovery.imageCount, 2);
  assert.match(discovery.chapterListSelector, /chapters|read/);
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

test("resolveChapterListUrls 能从纯 adapter/chapters 返回脚本提取上游详情地址", () => {
  const requestInfo = [
    "@js:",
    'return ("https://convert.example/adapter/chapters?plan=abc&page=%@pageIndex&url=") + encodeURIComponent(result);',
  ].join("\n");
  assert.deepEqual(
    resolveChapterListUrls(requestInfo, "https://novel.example/book/42").slice(0, 2),
    [
      "https://convert.example/adapter/chapters?plan=abc&page=1&url=https%3A%2F%2Fnovel.example%2Fbook%2F42",
      "https://novel.example/book/42",
    ],
  );
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

test("resolveBookTargetUrl 提取 IIFE 内部请求和局部变量", () => {
  const requestInfo = [
    "@js:",
    "var vars = {};",
    "var api = vars.url || 'https://api.example/vod/';",
    "var access = api.indexOf('/art/') !== -1 ? 'list' : 'videolist';",
    "return (api + '?ac=' + access + '&wd=' + encodeURIComponent(params.keyWord) + '&pg=' + params.pageIndex);",
  ].join("\n");
  assert.equal(
    resolveBookTargetUrl(
      { host: "https://api.example", requestInfo },
      { plan: { host: "https://api.example" }, requestInfo },
      { keyWord: "视频", pageIndex: 2 },
    ),
    "https://api.example/vod/?ac=videolist&wd=%E8%A7%86%E9%A2%91&pg=2",
  );
});

test("resolveBookTargetRequest 解析返回 URL 与 JSON.stringify 组成的 Legado 请求", () => {
  const requestInfo = [
    "@js:",
    'return ("https://api.example/search," + JSON.stringify({"method":"POST","body":("app=demo&keyword=" + String(params.keyWord) + "&page=" + String(params.pageIndex-1))}));',
  ].join("\n");
  const action = {
    host: "https://api.example",
    requestInfo,
    responseFormatType: "json",
    list: "data",
    bookName: "title",
    detailUrl: "url",
  };
  const target = resolveBookTargetRequest(
    { sourceUrl: "https://api.example" },
    action,
    { plan: { host: "https://api.example" }, requestInfo },
    { keyWord: "测试", pageIndex: 3 },
  );
  assert.equal(target.url, "https://api.example/search");
  assert.equal(target.options.method, "POST");
  assert.equal(target.options.body, "app=demo&keyword=测试&page=2");
});

test("请求描述符保留编码 URL 中的 POST body", () => {
  const descriptor = parseRequestDescriptor(
    "https://api.example/detail,%7B%22method%22:%22POST%22,%22body%22:%22book_id%3D42%22%7D",
  );
  assert.deepEqual(descriptor, {
    url: "https://api.example/detail",
    headers: {},
    options: { method: "POST", body: "book_id=42", followPostRedirects: true },
  });
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

test("resolveBookTargetRequest 解析局部变量组成的内联 JSON POST 参数", () => {
  const requestInfo = [
    "@js:",
    "var query = params.keyWord;",
    "var offset = (params.pageIndex - 1) * 20;",
    "var limit = 20;",
    "var tab_type = 2;",
    'var url = "https://api.example/search";',
    'return {url:url,POST:true,httpParams:{query:query,offset:offset,limit:limit,tab_type:tab_type},httpHeaders:{"Content-Type":"application/json; charset=utf-8"}};',
  ].join("\n");
  const action = {
    host: "https://api.example",
    requestInfo,
    responseFormatType: "json",
    list: "data/groups/books",
    bookName: "name",
    detailUrl: "url",
  };
  const target = resolveBookTargetRequest(
    { sourceUrl: "https://api.example" },
    action,
    { plan: { host: "https://api.example" }, requestInfo },
    { keyWord: "测试", pageIndex: 3 },
  );
  assert.equal(target.url, "https://api.example/search");
  assert.equal(target.options.method, "POST");
  assert.deepEqual(JSON.parse(target.options.body), {
    query: "测试",
    offset: 40,
    limit: 20,
    tab_type: 2,
  });
  assert.equal(target.headers["Content-Type"], "application/json; charset=utf-8");
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

test("识站种子不向分类注入默认关键词，媒体搜索按源类型选词", () => {
  const host = "https://probe.example";
  const browse = {
    actionID: "bookWorld",
    host,
    responseFormatType: "json",
    requestInfo: "/catalog?kind=all&key=%@keyWord&page=%@pageIndex",
    list: "$.items[*]",
    bookName: "$.name",
    detailUrl: "$.url",
  };
  const search = {
    actionID: "searchBook",
    host,
    responseFormatType: "json",
    requestInfo: "/search?q=%@keyWord&page=%@pageIndex",
    list: "$.items[*]",
    bookName: "$.name",
    detailUrl: "$.url",
  };
  const requests = resolveBookTargetRequests({
    sourceUrl: host,
    sourceType: "video",
    bookWorld: { 分类: browse },
    searchBook: search,
  });
  assert.equal(requests[0].section, "bookWorld");
  assert.match(requests[0].url, /\/catalog\?kind=all&key=&page=1$/);
  assert.equal(requests[1].section, "searchBook");
  assert.match(requests[1].url, /\/search\?q=%E8%A7%86%E9%A2%91&page=1$/);
  assert.deepEqual(resolveBookTargetUrls({
    sourceUrl: host,
    sourceType: "video",
    bookWorld: { 分类: browse },
    searchBook: search,
  }), [requests[0].url, requests[1].url]);
});

test("音视频搜索识站默认关键词尊重类型，明示关键词优先", () => {
  const host = "https://typed-search.example";
  const expected = new Map([
    ["text", "小说"],
    ["comic", "漫画"],
    ["audio", "广播剧"],
    ["video", "视频"],
  ]);
  for (const [sourceType, keyword] of expected) {
    const source = {
      sourceUrl: host,
      sourceType,
      searchBook: {
        actionID: "searchBook",
        host,
        responseFormatType: "json",
        requestInfo: "/search?q=%@keyWord&page=%@pageIndex",
        list: "$.items[*]",
        bookName: "$.name",
        detailUrl: "$.url",
      },
    };
    assert.equal(
      resolveBookTargetRequests(source)[0].url,
      `${host}/search?q=${encodeURIComponent(keyword)}&page=1`,
    );
  }
  const explicit = {
    sourceUrl: host,
    sourceType: "audio",
    searchBook: {
      actionID: "searchBook",
      host,
      _verifyKeyWord: "自定义试听",
      responseFormatType: "json",
      requestInfo: "/search?q=%@keyWord&page=%@pageIndex",
      list: "$.items[*]",
      bookName: "$.name",
      detailUrl: "$.url",
    },
  };
  assert.match(resolveBookTargetRequests(explicit)[0].url, /q=%E8%87%AA%E5%AE%9A%E4%B9%89%E8%AF%95%E5%90%AC/);
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

test("verifyConvertedSource 对正文传输 502 进行有限重试", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "正文瞬时 502" },
  );
  const [worldName, worldAction] = Object.entries(source.bookWorld)[0];
  source.bookWorld = { [worldName]: worldAction };
  delete source.searchBook;
  let transientFailures = 0;
  const result = await verifyConvertedSource(source, {
    download: async (url) => {
      if (transientFailures < 3) {
        transientFailures += 1;
        throw new Error("HTTP 502");
      }
      return fixtureDownload(url);
    },
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.retryRecovered, true);
  assert.equal(result.retryCount, 3);
  assert.equal(transientFailures, 3);
});

test("单个章节接口返回 502 时仍继续整站识站并验收可用候选", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://broken-entry.example/", { download: fixtureDownload }),
    { sourceName: "单入口 502" },
  );
  const candidate = novelDiscoveryToXiangse(
    await discoverNovel("https://recovered-entry.example/", { download: fixtureDownload }),
    { sourceName: "识站候选" },
  );
  const download = async (url, headers = {}, options = {}) => {
    const target = new URL(String(url));
    if (target.hostname === "broken-entry.example" && /(?:chapter|read|content)/i.test(target.pathname)) {
      throw new Error("下载阅读源失败：上游返回 HTTP 502");
    }
    return fixtureDownload(url, headers, options);
  };
  let recognitionAttempts = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download,
    concurrency: 1,
    timeoutMs: 500,
    sourceTimeoutMs: 8_000,
    runtimeFallbackTimeoutMs: 1_000,
    sourceBudgetMs: 12_000,
    analyzeTimeoutMs: 1_000,
    recognitionAttempts: 1,
    repairBooks: async () => null,
    repairContent: async () => null,
    repairChapter: async () => null,
    repairDetail: async () => null,
    repairJsonChapter: async () => null,
    analyze: async () => {
      recognitionAttempts += 1;
      return { ok: true, sources: { [candidate.sourceName]: candidate } };
    },
  });

  assert.equal(recognitionAttempts, 1, JSON.stringify(result.skipped));
  assert.ok(result.sources[source.sourceName], JSON.stringify(result.skipped));
  assert.equal(result.skipped.length, 0);
});

test("同一轮识站没有新增探测证据时不重复执行", async () => {
  const host = "https://no-repeat-analyze.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(`${host}/`, { download: fixtureDownload }),
    { sourceName: "不重复识站" },
  );
  const listAction = structuredClone(Object.values(source.bookWorld)[0]);
  source.bookWorld = {
    分类: { ...listAction, requestInfo: `${host}/empty-list`, list: "//.missing" },
  };
  delete source.searchBook;
  let calls = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => (
      String(url).endsWith("/empty-list")
        ? Buffer.from("<html><body>empty</body></html>")
        : fixtureDownload(url, headers, options)
    ),
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 3_000,
    analyzeTimeoutMs: 500,
    recognitionAttempts: 1,
    repairBooks: async () => null,
    repairChapter: async () => null,
    repairContent: async () => null,
    repairDetail: async () => null,
    repairJsonChapter: async () => null,
    analyze: async () => {
      calls += 1;
      return {
        ok: true,
        sources: { "无关类型候选": { ...source, sourceType: "comic" } },
        detectedKinds: ["text"],
        skippedKinds: [{ kind: "text", reason: "当前入口未生成文本候选" }],
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.sources[source.sourceName], undefined);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].recognitionAttempts, 1);
});

test("识站批次单轮超时后允许重试相同批次并验收候选", async () => {
  const host = "https://timeout-retry.example";
  const candidate = novelDiscoveryToXiangse(
    await discoverNovel(`${host}/`, { download: fixtureDownload }),
    { sourceName: "超时后恢复候选" },
  );
  const source = structuredClone(candidate);
  const [worldName, worldAction] = Object.entries(source.bookWorld)[0];
  source.bookWorld = {
    [worldName]: { ...worldAction, requestInfo: `${host}/empty-list`, list: "//.missing" },
  };
  delete source.searchBook;
  let analyzeCalls = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => (
      String(url).endsWith("/empty-list")
        ? Buffer.from("<html><body>empty</body></html>")
        : fixtureDownload(url, headers, options)
    ),
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 3_000,
    analyzeTimeoutMs: 20,
    recognitionAttempts: 3,
    requireBookWorld: true,
    repairBooks: null,
    repairChapter: null,
    repairContent: null,
    repairDetail: null,
    repairJsonChapter: null,
    analyze: async (_site, options) => {
      analyzeCalls += 1;
      assert.equal(options.onProbeBatch("same-probe-batch"), true);
      if (analyzeCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ok: false, reason: "analyze-failed: 通用识站超时", probeBatchFingerprint: "same-probe-batch" };
      }
      return {
        ok: true,
        sources: { [candidate.sourceName]: candidate },
        probeBatchFingerprint: "same-probe-batch",
      };
    },
  });

  assert.equal(analyzeCalls, 2);
  assert.ok(result.sources[source.sourceName]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.fallbackCount, 1);
});

test("同一识站入口批次连续超时后只重试一次并停止空转", async () => {
  const host = "https://timeout-repeat-limit.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(`${host}/`, { download: fixtureDownload }),
    { sourceName: "重复超时批次" },
  );
  const [worldName, worldAction] = Object.entries(source.bookWorld)[0];
  source.bookWorld = {
    [worldName]: { ...worldAction, requestInfo: `${host}/empty-list`, list: "//.missing" },
  };
  delete source.searchBook;
  let analyzeCalls = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => (
      String(url).endsWith("/empty-list")
        ? Buffer.from("<html><body>empty</body></html>")
        : fixtureDownload(url, headers, options)
    ),
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 5_000,
    analyzeTimeoutMs: 100,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    requireBookWorld: true,
    repairBooks: null,
    repairChapter: null,
    repairContent: null,
    repairDetail: null,
    repairJsonChapter: null,
    analyze: async (_site, options) => {
      const accepted = options.onProbeBatch("same-timeout-batch");
      if (!accepted) {
        return {
          ok: false,
          repeatedEvidence: true,
          reason: "analyze-failed: 当前识站入口批次与已探测批次相同，停止重复请求",
          probeBatchFingerprint: "same-timeout-batch",
        };
      }
      analyzeCalls += 1;
      return {
        ok: false,
        reason: "analyze-failed: 通用识站超时",
        probeBatchFingerprint: "same-timeout-batch",
      };
    },
  });

  assert.equal(analyzeCalls, 2, "相同批次只允许一次瞬时超时重试");
  assert.equal(result.sources[source.sourceName], undefined);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /入口批次与已探测批次相同/);
  assert.doesNotMatch(result.skipped[0].reason, /dead-origin/);
});

test("WebUI 识站在相同入口批次上停止空转且不标记为死站", async () => {
  const host = "https://pipeline-repeat-batch.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(`${host}/`, { download: fixtureDownload }),
    { sourceName: "重复探测批次" },
  );
  const listAction = structuredClone(Object.values(source.bookWorld)[0]);
  source.bookWorld = {
    分类: { ...listAction, requestInfo: `${host}/empty-list`, list: "//.missing" },
  };
  delete source.searchBook;
  let rootProbes = 0;
  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/") {
        rootProbes += 1;
        return Buffer.from("<html><body>unclassified portal</body></html>");
      }
      if (path === "/empty-list") return Buffer.from("<html><body>empty</body></html>");
      return fixtureDownload(url, headers, options);
    },
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 3_000,
    analyzeTimeoutMs: 500,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    repairBooks: null,
    repairChapter: null,
    repairContent: null,
    repairDetail: null,
    repairJsonChapter: null,
  });

  assert.equal(result.sources[source.sourceName], undefined);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].recognitionAttempts, 2);
  assert.match(result.skipped[0].reason, /入口批次与已探测批次相同/);
  assert.doesNotMatch(result.skipped[0].reason, /dead-origin/);
  assert.equal(rootProbes, 1, "第二轮重复入口应在请求前短路");
});

test("HTTP 4xx 响应不会误判为 dead-origin，并继续识站到单源预算", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://unreachable-origin.example/", { download: fixtureDownload }),
    { sourceName: "整站不可达" },
  );
  delete source.searchBook;
  let recognitionAttempts = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async () => Buffer.from("<html><body>empty</body></html>"),
    concurrency: 1,
    timeoutMs: 500,
    sourceTimeoutMs: 2_000,
    sourceBudgetMs: 500,
    analyzeTimeoutMs: 100,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    repairBooks: async () => null,
    analyze: async () => {
      recognitionAttempts += 1;
      return {
        ok: false,
        reason: "analyze-failed: 首页及声明分类均不可访问（HTTP 403）",
        originResponded: true,
        httpResponseStatuses: [403],
      };
    },
  });

  assert.ok(recognitionAttempts >= 2);
  assert.equal(result.sources[source.sourceName], undefined);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /rules-stale: source-timeout/);
  assert.doesNotMatch(result.skipped[0].reason, /dead-origin/);
  assert.equal(result.skipped[0].recognitionAttempts, recognitionAttempts);
});

test("首页和声明入口返回 5xx 时继续识站直到单源预算到期", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://transient-origin.example/", { download: fixtureDownload }),
    { sourceName: "临时 5xx" },
  );
  delete source.searchBook;
  let recognitionAttempts = 0;

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async () => Buffer.from("<html><body>empty</body></html>"),
    concurrency: 1,
    timeoutMs: 100,
    sourceTimeoutMs: 2_000,
    sourceBudgetMs: 500,
    analyzeTimeoutMs: 100,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    repairBooks: async () => null,
    analyze: async () => {
      recognitionAttempts += 1;
      return { ok: false, reason: "analyze-failed: 首页及声明分类均不可访问（上游返回 HTTP 502）" };
    },
  });

  assert.ok(recognitionAttempts >= 2, `recognition attempts: ${recognitionAttempts}`);
  assert.equal(result.sources[source.sourceName], undefined);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /rules-stale: source-timeout/);
  assert.doesNotMatch(result.skipped[0].reason, /dead-origin/);
  assert.equal(result.skipped[0].recognitionAttempts, recognitionAttempts);
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

test("旧规则候选扫描阶段预算耗尽后继续通用识站", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "候选扫描限时" },
  );
  source.chapterContent.content = "//*[@id='missing-content']";
  let chapterRequests = 0;
  let fallbackAborted = false;
  let analyzeAttempts = 0;
  const download = async (url, headers = {}, options = {}) => {
    if (/\/chapter\//.test(String(url)) && ++chapterRequests > 1) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Buffer.from(novelChapter)), 5_000);
        options.signal?.addEventListener("abort", () => {
          fallbackAborted = true;
          clearTimeout(timer);
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      });
    }
    return fixtureDownload(url, headers, options);
  };

  const gated = await applyVerifyAndAnalyzeFallback(
    { [source.sourceName]: source },
    {
      download,
      concurrency: 1,
      timeoutMs: 1_000,
      sourceTimeoutMs: 2_000,
      runtimeFallbackTimeoutMs: 30,
      sourceBudgetMs: 2_000,
      analyzeTimeoutMs: 500,
      recognitionAttempts: 1,
      repairBooks: async () => null,
      repairContent: async () => null,
      analyze: async () => {
        analyzeAttempts += 1;
        return { ok: false, reason: "analyze-failed: fixture" };
      },
    },
  );

  assert.equal(fallbackAborted, true);
  assert.equal(analyzeAttempts, 1);
  assert.equal(gated.sources[source.sourceName], undefined);
  assert.equal(gated.skipped.length, 1);
  assert.match(gated.skipped[0].reason, /analyze-failed/);
  assert.doesNotMatch(gated.skipped[0].reason, /source-timeout/);
  assert.equal(gated.skipped[0].stage, "analyze");
});

test("同一源的重复验链共享运行时回退预算", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "共享回退预算" },
  );
  source.chapterContent.content = "//*[@id='missing-content']";
  const runtimeFallbackBudget = { remainingMs: 40 };
  let delayNextChapter = false;
  let fallbackAbortObserved = false;
  let runtimeFallbackCount = 0;
  const download = async (url, headers = {}, options = {}) => {
    if (delayNextChapter && /\/chapter\//.test(String(url))) {
      delayNextChapter = false;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Buffer.from(novelChapter)), 5_000);
        options.signal?.addEventListener("abort", () => {
          fallbackAbortObserved = true;
          clearTimeout(timer);
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      });
    }
    return fixtureDownload(url, headers, options);
  };
  const options = {
    download,
    timeoutMs: 1_000,
    sourceTimeoutMs: 5_000,
    runtimeFallbackTimeoutMs: 40,
    runtimeFallbackBudget,
    retryEmptyList: false,
    onStage(stage) {
      if (stage === "xbs-runtime-fallback") {
        runtimeFallbackCount += 1;
        delayNextChapter = true;
      }
    },
  };

  const first = await verifyConvertedSource(source, options);
  assert.equal(first.ok, false);
  assert.equal(fallbackAbortObserved, true);
  assert.equal(runtimeFallbackCount, 1);
  assert.equal(runtimeFallbackBudget.remainingMs, 0);

  const second = await verifyConvertedSource(source, options);
  assert.equal(second.ok, false);
  assert.equal(runtimeFallbackCount, 1, "已耗尽的单源运行时预算不可在重验时重置");
});

test("verifyConvertedSource 在前八章正文为空时继续验到第九章", async () => {
  const host = "https://chapter-budget.example";
  const source = {
    sourceName: "后续章节回退",
    sourceUrl: host,
    sourceType: "text",
    bookWorld: {
      分类: {
        host,
        responseFormatType: "json",
        requestInfo: "/books",
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
      },
    },
    bookDetail: { host, responseFormatType: "json", requestInfo: "%@result", bookName: "name" },
    chapterList: {
      host,
      responseFormatType: "json",
      requestInfo: "%@result",
      list: "$.chapters",
      title: "title",
      url: "url",
    },
    chapterContent: {
      host,
      responseFormatType: "html",
      requestInfo: "%@result",
      content: "//article",
    },
  };
  const download = async (url) => {
    const pathname = new URL(url).pathname;
    const body = pathname === "/books"
      ? { data: [{ name: "测试作品", url: `${host}/book/1` }] }
      : pathname === "/book/1"
        ? {
          name: "测试作品",
          chapters: [
            { title: "目录标题", url: "" },
            ...Array.from({ length: 8 }, (_, index) => ({
              title: `第${index + 1}章 暂无正文`,
              url: `${host}/chapter/${index + 1}`,
            })),
            { title: "第九章 正文", url: `${host}/chapter/9` },
          ],
        }
        : pathname === "/chapter/9"
          ? "<article>第九章的正文内容。</article>"
          : "<aside>本章暂无正文</aside>";
    return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  };

  const result = await verifyConvertedSource(source, {
    download,
    timeoutMs: 1_000,
    sourceTimeoutMs: 5_000,
  });
  assert.equal(result.ok, true, result.detail || result.reason);
  assert.equal(result.chapterTitle, "第九章 正文");
  assert.equal(result.candidateFallback, 10);
});

test("verifyConvertedSource 接受可访问且由 WebView 执行媒体脚本的正文", async () => {
  const host = "https://audio.example";
  const source = {
    sourceName: "WebView 媒体验证",
    sourceUrl: host,
    sourceType: "audio",
    bookWorld: {
      分类: {
        actionID: "bookWorld",
        host,
        responseFormatType: "html",
        requestInfo: host + "/list",
        list: "//article",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
    bookDetail: {
      actionID: "bookDetail",
      host,
      responseFormatType: "html",
      requestInfo: "%@result",
      bookName: "//h1",
      author: "//meta[@name='author']/@content",
    },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a[contains(@href, '/episode/') and normalize-space(.) != '']",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "json",
      requestInfo: "@js:\nreturn {url: result, webView: \"\", webViewJs: \"document.querySelector('audio').play()\"};",
      content: "//audio/@src",
    },
  };
  const result = await verifyConvertedSource(source, {
    download: async (url) => {
      if (String(url).endsWith("/list")) {
        return Buffer.from("<article><a href=\"/album/1\">节目一</a></article>");
      }
      if (String(url).endsWith("/album/1")) {
        return Buffer.from("<h1>节目一</h1><meta name=\"author\" content=\"主播\"><a href=\"/episode/1\">第一集</a>");
      }
      if (String(url).endsWith("/episode/1")) {
        return Buffer.from("<html><body><audio class=\"root-audio\"></audio></body></html>");
      }
      throw new Error("unexpected url");
    },
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.content.webView, true);
  assert.equal(result.chapterUrl, "https://audio.example/episode/1");
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

test("verifyConvertedSource 会继续验到第九个分类入口", async () => {
  const host = "https://category-limit.example";
  const categoryAction = (requestInfo) => ({
    actionID: "bookWorld",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  const source = {
    sourceName: "第九分类可用",
    sourceUrl: host,
    sourceType: "text",
    bookWorld: Object.fromEntries([
      ...Array.from({ length: 8 }, (_, index) => [
        `失效分类 ${index + 1}`,
        categoryAction(`${host}/empty-category-${index + 1}`),
      ]),
      ["第九分类", categoryAction(`${host}/available-list`)],
    ]),
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      bookName: "//h1", cover: "//img/@src", author: "//*[@class='author']",
      cat: "//*[@class='cat']", lastChapterTitle: "//*[@class='latest']",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM", requestInfo: "%@result",
      list: "//div[@id='chapters']/a", title: ".", url: "./@href",
      moreKeys: { pageSize: 20, maxPage: 1 },
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", content: "//article",
    },
  };
  const probedCategories = [];
  const download = async (url) => {
    const target = String(url);
    if (/\/empty-category-\d+$/.test(target)) {
      probedCategories.push(target);
      return Buffer.from("<html><body><p>此分类暂无作品</p></body></html>");
    }
    if (target.endsWith("/available-list")) {
      probedCategories.push(target);
      return Buffer.from(`<li><a href="${host}/book/1">可用作品</a></li>`);
    }
    if (target.endsWith("/book/1")) {
      return Buffer.from(`<h1>可用作品</h1><img src="/cover.jpg"><span class="author">作者甲</span><span class="cat">奇幻</span><span class="latest">第二章</span><div id="chapters"><a href="${host}/read/1">第一章</a><a href="${host}/read/2">第二章</a></div>`);
    }
    if (/\/read\/[12]$/.test(target)) {
      return Buffer.from(`<article>${"这是可用作品的正文内容。".repeat(20)}</article>`);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const result = await verifyConvertedSource(source, { download, timeoutMs: 1_000, sourceTimeoutMs: 10_000 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.bookName, "可用作品");
  assert.equal(probedCategories.length, 9);
});

test("verifyConvertedSource 会在分类入口目录为空时继续尝试搜索入口", async () => {
  const host = "https://entry-fallback.example";
  const bookAction = (path, actionID) => ({
    actionID,
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/${path}`,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  const source = {
    sourceName: "入口继续识别",
    sourceUrl: host,
    sourceType: "text",
    bookWorld: { 分类入口: bookAction("category", "bookWorld") },
    searchBook: { ...bookAction("search", "searchBook"), _verifyKeyWord: "可用书" },
    chapterList: {
      actionID: "chapterList",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      list: "//a[contains(@href, '/read/')]",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//article",
    },
  };
  const download = async (url) => {
    const value = String(url);
    if (value.endsWith("/category")) return Buffer.from(`<li><a href="${host}/book/bad">坏入口</a></li>`);
    if (value.endsWith("/search")) return Buffer.from(`<li><a href="${host}/book/good">可用书</a></li>`);
    if (value.endsWith("/book/bad")) return Buffer.from("<h1>坏入口</h1>");
    if (value.endsWith("/book/good")) return Buffer.from(`<h1>可用书</h1><a href="${host}/read/1">第一章</a>`);
    if (value.endsWith("/read/1")) return Buffer.from("<article>这是可用搜索入口的正文。</article>");
    throw new Error(`unexpected ${value}`);
  };

  const result = await verifyConvertedSource(source, { download, timeoutMs: 2_000 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.bookName, "可用书");
  assert.equal(result.chapterTitle, "第一章");

  const strictResult = await verifyConvertedSource(source, {
    download,
    timeoutMs: 2_000,
    retryEmptyList: false,
    requireBookWorld: true,
  });
  assert.equal(strictResult.ok, false, "搜索成功不能掩盖声明的分类入口失效");
  assert.match(strictResult.detail, /分类\/浏览入口未通过完整验证/);

  const searchOnlyResult = await verifyConvertedSource({ ...source, bookWorld: {} }, {
    download,
    timeoutMs: 2_000,
    requireBookWorld: true,
  });
  assert.equal(searchOnlyResult.ok, false, "搜索成功不能替代分类/浏览入口");
  assert.match(searchOnlyResult.detail, /缺少可执行分类\/浏览入口/);
});

test("pipeline 用已验证的搜索列表结构修复失效分类并重新验链", async () => {
  const host = "https://browse-repair.example";
  const action = (path, actionID, list) => ({
    actionID,
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/${path}`,
    list,
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  const source = {
    sourceName: "分类规则可复用搜索结构",
    sourceUrl: host,
    miniAppVersion: "1.0.0",
    sourceType: "text",
    bookWorld: { 分类: action("category", "bookWorld", ".//div[@class='stale']") },
    searchBook: action("search", "searchBook", ".//li"),
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
      list: "//a[contains(@href, '/read/')]",
      title: ".",
      url: "./@href",
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//article",
    },
  };
  let analyzeCalls = 0;
  const download = async (url) => {
    const target = String(url);
    if (target.endsWith("/category") || target.endsWith("/search")) {
      return Buffer.from(`<ul><li><a href="${host}/book/1">可用作品</a></li></ul>`);
    }
    if (target.endsWith("/book/1")) {
      return Buffer.from(`<h1>可用作品</h1><a href="${host}/read/1">第一章</a>`);
    }
    if (target.endsWith("/read/1")) {
      return Buffer.from(`<article>${"这是足够长的正文内容。".repeat(20)}</article>`);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download,
    concurrency: 1,
    timeoutMs: 500,
    sourceTimeoutMs: 3_000,
    runtimeFallbackTimeoutMs: 1_000,
    sourceBudgetMs: 8_000,
    analyzeTimeoutMs: 1_000,
    recognitionAttempts: 1,
    requireBookWorld: true,
    analyze: async () => {
      analyzeCalls += 1;
      return { ok: false, reason: "should not need whole-site recognition" };
    },
  });

  assert.ok(result.sources[source.sourceName], JSON.stringify(result.skipped));
  assert.equal(result.sources[source.sourceName].bookWorld["分类"].list, ".//li");
  assert.equal(analyzeCalls, 0);
  const repairWarning = result.warnings.find((warning) => (
    warning.source === source.sourceName && warning.section === "bookWorld" && warning.field === "list"
  ));
  assert.match(repairWarning?.message || "", /复用实测可用的搜索列表结构/);
});

test("缺少分类入口时不接受搜索成功，持续通用识站生成并验收浏览列表", async () => {
  const host = "https://missing-browse.example";
  const action = (path, actionID) => ({
    actionID,
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo: `${host}/${path}`,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  const source = {
    sourceName: "仅搜索入口",
    sourceUrl: host,
    miniAppVersion: "1.0.0",
    sourceType: "text",
    bookWorld: {},
    searchBook: { ...action("search?q=%@keyWord", "searchBook"), _verifyKeyWord: "测试书" },
    bookDetail: {
      actionID: "bookDetail", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", bookName: "//h1",
    },
    chapterList: {
      actionID: "chapterList", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", list: "//a[contains(@href, '/read/') ]", title: ".", url: "./@href",
      moreKeys: { pageSize: 20, maxPage: 1 },
    },
    chapterContent: {
      actionID: "chapterContent", host, responseFormatType: "html", parserID: "DOM",
      requestInfo: "%@result", content: "//article",
    },
  };
  const candidate = {
    ...source,
    bookWorld: { "实时分类": action("category", "bookWorld") },
  };
  let analyzeCalls = 0;
  const download = async (url) => {
    const target = String(url);
    if (target.endsWith("/category")) return Buffer.from(`<li><a href="${host}/book/1">可用书</a></li>`);
    if (target.endsWith("/book/1")) return Buffer.from(`<h1>可用书</h1><a href="${host}/read/1">第一章</a>`);
    if (target.endsWith("/read/1")) return Buffer.from(`<article>${"有效正文内容。".repeat(24)}</article>`);
    throw new Error(`unexpected request: ${target}`);
  };

  const result = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download,
    concurrency: 1,
    timeoutMs: 500,
    sourceTimeoutMs: 3_000,
    sourceBudgetMs: 8_000,
    runtimeFallbackTimeoutMs: 1_000,
    analyzeTimeoutMs: 1_000,
    recognitionAttempts: 1,
    requireBookWorld: true,
    repairBooks: async () => null,
    analyze: async () => {
      analyzeCalls += 1;
      return { ok: true, sources: { [candidate.sourceName]: candidate } };
    },
  });

  assert.ok(result.sources[source.sourceName], JSON.stringify(result.skipped));
  assert.equal(analyzeCalls, 1);
  assert.equal(result.sources[source.sourceName].bookWorld["实时分类"].actionID, "bookWorld");
});

test("verifyConvertedSource 不把默认搜索词注入分类列表", async () => {
  const host = "https://browse-keyword.example";
  const source = {
    sourceName: "默认分类列表",
    sourceUrl: host,
    sourceType: "text",
    bookWorld: {
      首页: {
        actionID: "bookWorld",
        host,
        responseFormatType: "html",
        parserID: "DOM",
        requestInfo: `${host}/catalog?q=%@keyWord`,
        list: "//li",
        bookName: ".//a",
        detailUrl: ".//a/@href",
      },
    },
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
      list: "//a[contains(@href, '/read/')]",
      title: ".",
      url: "./@href",
      moreKeys: { pageSize: 20, maxPage: 1 },
    },
    chapterContent: {
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: "//article",
    },
  };
  const browseQueries = [];
  const download = async (url) => {
    const target = new URL(String(url));
    if (target.pathname === "/catalog") {
      const query = target.searchParams.get("q") || "";
      browseQueries.push(query);
      if (!query) return Buffer.from("<html><body>分类首页没有书目</body></html>");
      return Buffer.from(`<li><a href="${host}/book/1">默认关键词才会出现的书</a></li>`);
    }
    if (target.pathname === "/book/1") {
      return Buffer.from(`<h1>书名</h1><a href="${host}/read/1">第一章</a>`);
    }
    if (target.pathname === "/read/1") {
      return Buffer.from(`<article>${"这是足够长的章节正文，用于完整动作链测试。".repeat(4)}</article>`);
    }
    throw new Error(`unexpected request: ${target.pathname}`);
  };

  const result = await verifyConvertedSource(source, {
    download,
    timeoutMs: 1_000,
    sourceTimeoutMs: 5_000,
    retryEmptyList: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty-list/);
  assert.deepEqual(browseQueries, [""]);
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

test("pipeline 允许仅被声明尝试但未被页面检测的类型纠正为完整验链通过类型", async () => {
  const textSource = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "实际文本源" },
  );
  const broken = structuredClone(textSource);
  broken.sourceName = "误标影视源";
  broken.sourceType = "video";
  broken.bookWorld = {
    影视: {
      ...Object.values(textSource.bookWorld)[0],
      requestInfo: "https://novel.example/missing",
      list: "//*[@id='missing']",
    },
  };
  const result = await applyVerifyAndAnalyzeFallback({ [broken.sourceName]: broken }, {
    download: fixtureDownload,
    analyze: async () => ({
      ok: true,
      sources: { [textSource.sourceName]: textSource },
      detectedKinds: [],
      skippedKinds: [{ kind: "video", reason: "声明类型探测未生成可用影视链" }],
    }),
  });

  assert.equal(result.sources[broken.sourceName]?.sourceType, "text");
  assert.equal(result.fallbackCount, 1);
  assert.match(result.warnings.find((item) => item.field === "sourceType")?.message || "", /修正为 text/);
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
    chapterContent: {
      content: "$.urls||@js:return 'https://converter.example/image/aes-cbc-prefix-iv-MDEyMzQ1Njc4OWFiY2RlZg?url=';",
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
        assert.equal(source.chapterContent.content, broken.chapterContent.content);
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

test("详情元素修复在超大目录页直接复用目录计划推导末章", async () => {
  const host = "https://large-detail.example";
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
  const chapters = Array.from({ length: 600 }, (_, index) => (
    `<a href="/read/${index + 1}">第${index + 1}章</a>`
  )).join("");
  const html = `<h1>大目录测试</h1><div id="chapters">${chapters}</div>`;
  const repaired = await repairDetailFromBook(source, `${host}/book/1`, ["lastChapterTitle"], {
    adapterBase: "https://converter.example",
    download: async () => Buffer.from(html),
  });
  const token = repaired.bookDetail.requestInfo.match(/plan=([A-Za-z0-9_-]+)/)?.[1];
  const plan = decodeBridgePlan(token);

  assert.equal(plan.fields.lastChapterTitle, undefined);
  assert.equal(plan.latestChapter.mode, "html-toc");
  assert.equal(plan.latestChapter.list, source.chapterList.list);
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

test("漫画正文修复识别页面声明的 $.ajax 分批图片 API", async () => {
  const host = "https://comic-ajax.example";
  const source = {
    sourceType: "comic",
    sourceUrl: host,
    chapterContent: { content: "img@src" },
  };
  const calls = [];
  const download = async (url, _headers = {}, options = {}) => {
    const target = String(url);
    if (target === `${host}/chapter/20/91.html`) {
      const page = Buffer.from([
        "<div class=\"reader\"><img src=\"/loading.gif\"></div>",
        "<script>",
        "const AJAX_URL = '/reader/ajax/images';",
        "const CHAPTER_ID = '91';",
        "const PAGE_SIZE = 2;",
        "function load(start) { $.ajax({ url: AJAX_URL, type: 'POST', dataType: 'json',",
        "data: { chapterId: CHAPTER_ID, start: start, limit: PAGE_SIZE } }); }",
        "</script>",
      ].join(""));
      Object.defineProperty(page, "httpHeaders", {
        value: { "set-cookie": ["reader-session=abc123; Path=/; HttpOnly"] },
      });
      return page;
    }
    if (target === `${host}/reader/ajax/images` && options.method === "POST") {
      assert.match(String(_headers.Cookie || ""), /reader-session=abc123/);
      calls.push(String(options.body));
      return Buffer.from(JSON.stringify({
        cnt: 2,
        data: [
          { file: `${host}/pages/001.webp` },
          { file: `${host}/pages/002.webp` },
        ],
      }));
    }
    throw new Error(`unexpected ${target}`);
  };

  const repaired = await repairContentFromChapter(source, `${host}/chapter/20/91.html`, {
    adapterBase: "https://converter.example",
    download,
  });
  assert.ok(repaired);
  assert.match(repaired.chapterContent.requestInfo, /adapter\/images/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /chapterId=91/);
  assert.match(calls[0], /start=0/);
  assert.match(calls[0], /limit=2/);
});

test("漫画图片 $.ajax 接口没有总数时按短页停止并保留顺序", async () => {
  const host = "https://comic-ajax-pages.example";
  const calls = [];
  const download = async (url, _headers = {}, options = {}) => {
    const target = String(url);
    if (target === `${host}/chapter/91`) {
      return Buffer.from([
        "<script>",
        "const API = '/ajax/read-images'; const ID = '91'; const SIZE = 2;",
        "$.ajax({ url: API, method: 'POST', data: { chapterId: ID, start: 0, limit: SIZE } });",
        "</script>",
      ].join(""));
    }
    if (target === `${host}/ajax/read-images` && options.method === "POST") {
      const start = Number(new URLSearchParams(String(options.body)).get("start") || 0);
      calls.push(start);
      const count = start < 4 ? 2 : 1;
      return Buffer.from(JSON.stringify({
        cnt: count,
        data: Array.from({ length: count }, (_, index) => ({
          file: `${host}/pages/${start + index + 1}.jpg`,
        })),
      }));
    }
    throw new Error(`unexpected ${target}`);
  };

  const result = await dynamicComicApiImages(
    (await download(`${host}/chapter/91`)).toString("utf8"),
    `${host}/chapter/91`,
    { download, maxRequests: 8, concurrency: 1 },
  );
  assert.deepEqual(result.urls, [
    `${host}/pages/1.jpg`,
    `${host}/pages/2.jpg`,
    `${host}/pages/3.jpg`,
    `${host}/pages/4.jpg`,
    `${host}/pages/5.jpg`,
  ]);
  assert.deepEqual(calls, [0, 2, 4]);
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

test("识站候选必须通过抽测，失败后会继续识站直到候选可用", async () => {
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

  let analyzeAttempts = 0;
  const analyzeAttemptIndexes = [];
  const gated = await applyVerifyAndAnalyzeFallback(
    { 过时源: broken },
    {
      download,
      enabled: true,
      analyzeFallback: true,
      recognitionAttempts: 2,
      continueRecognitionUntilTimeout: true,
      sourceTimeoutMs: 2_000,
      sourceBudgetMs: 5_000,
      analyze: async (_host, options = {}) => {
        analyzeAttemptIndexes.push(options.attempt);
        analyzeAttempts += 1;
        return analyzeAttempts < 5
          ? { ok: true, sources: { 坏候选: badCandidate } }
          : { ok: true, sources: { 好候选: goodCandidate } };
      },
    },
  );

  assert.equal(analyzeAttempts, 5);
  assert.deepEqual(analyzeAttemptIndexes, [0, 1, 2, 3, 4]);
  assert.equal(gated.fallbackCount, 1);
  assert.ok(gated.sources["过时源"]);
  assert.equal(gated.sources["过时源"].bookWorld.分类.requestInfo, "https://novel.example/list");
  assert.equal(gated.skipped.length, 0);
});

test("单轮识站超时后继续尝试，不能提前按整站超时跳过", async () => {
  const host = "https://recognition-timeout.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(host, { download: fixtureDownload }),
    { sourceName: "单轮识站超时恢复" },
  );
  const goodSource = structuredClone(source);
  source.bookWorld = {
    分类: {
      ...structuredClone(Object.values(source.bookWorld)[0]),
      requestInfo: `${host}/bad-list`,
      list: "//.missing",
    },
  };
  delete source.searchBook;
  let attempts = 0;
  const gated = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => {
      if (String(url).endsWith("/bad-list")) {
        return Buffer.from("<html><body>no books here</body></html>");
      }
      return fixtureDownload(url, headers, options);
    },
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 1_500,
    analyzeTimeoutMs: 30,
    recognitionAttempts: 1,
    continueRecognitionUntilTimeout: true,
    repairBooks: async () => null,
    repairContent: async () => null,
    repairChapter: async () => null,
    repairDetail: async () => null,
    repairJsonChapter: async () => null,
    analyze: async () => {
      attempts += 1;
      if (attempts === 1) return new Promise(() => {});
      return { ok: true, source: goodSource, sources: { [goodSource.sourceName]: goodSource } };
    },
  });

  assert.equal(attempts, 2);
  assert.ok(gated.sources[source.sourceName]);
  assert.equal(gated.skipped.length, 0);
});

test("当前一组声明入口均无响应时继续轮换未探测入口", async () => {
  const host = "https://rotating-seeds.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(host, { download: fixtureDownload }),
    { sourceName: "入口轮换恢复" },
  );
  const goodSource = structuredClone(source);
  source.bookWorld = {
    分类一: { ...structuredClone(Object.values(source.bookWorld)[0]), requestInfo: `${host}/bad-1` },
    分类二: { ...structuredClone(Object.values(source.bookWorld)[0]), requestInfo: `${host}/bad-2` },
  };
  delete source.searchBook;
  let attempts = 0;
  const gated = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download: async (url, headers = {}, options = {}) => {
      if (/\/bad-[12]$/.test(String(url))) return Buffer.from("<html><body>空列表</body></html>");
      return fixtureDownload(url, headers, options);
    },
    concurrency: 1,
    timeoutMs: 250,
    sourceTimeoutMs: 1_000,
    sourceBudgetMs: 1_500,
    recognitionAttempts: 2,
    continueRecognitionUntilTimeout: true,
    repairBooks: async () => null,
    repairContent: async () => null,
    repairChapter: async () => null,
    repairDetail: async () => null,
    repairJsonChapter: async () => null,
    analyze: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          reason: "analyze-failed: 首页及声明分类均不可访问（HTTP 503）",
          remainingSeedRequests: 1,
        };
      }
      return { ok: true, source: goodSource, sources: { [goodSource.sourceName]: goodSource } };
    },
  });

  assert.equal(attempts, 2);
  assert.ok(gated.sources[source.sourceName]);
  assert.equal(gated.skipped.length, 0);
});

test("整站不可达诊断会区分尚未轮换探测的声明入口", async () => {
  const host = "https://seed-budget.example";
  const seedRequests = Array.from({ length: 6 }, (_, index) => ({
    url: `${host}/category/${index + 1}`,
  }));
  const options = {
    download: async () => { throw new Error("HTTP 404"); },
    timeoutMs: 250,
    seedRequests,
  };
  const first = await analyzeSite(host, { ...options, attempt: 0 });
  const second = await analyzeSite(host, { ...options, attempt: 1 });

  assert.equal(first.ok, false);
  assert.equal(first.remainingSeedRequests, 2);
  assert.equal(second.ok, false);
  assert.equal(second.remainingSeedRequests, 0);
});

test("单次规则验链超时后保留源预算继续通用识站", async () => {
  const host = "https://phase-timeout.example";
  const source = novelDiscoveryToXiangse(
    await discoverNovel(host, { download: fixtureDownload }),
    { sourceName: "阶段超时恢复" },
  );
  const goodSource = structuredClone(source);
  source.bookWorld = {
    分类: {
      ...Object.values(source.bookWorld)[0],
      requestInfo: `${host}/slow-list`,
    },
  };
  delete source.searchBook;

  let slowRequestAborted = false;
  let analyzeAttempts = 0;
  const download = async (url, headers = {}, options = {}) => {
    if (String(url).endsWith("/slow-list")) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Buffer.from("<li>迟到的列表</li>")), 5_000);
        options.signal?.addEventListener("abort", () => {
          slowRequestAborted = true;
          clearTimeout(timer);
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      });
    }
    return fixtureDownload(url, headers, options);
  };

  const gated = await applyVerifyAndAnalyzeFallback(
    { [source.sourceName]: source },
    {
      download,
      concurrency: 1,
      timeoutMs: 100,
      sourceTimeoutMs: 1_000,
      sourceBudgetMs: 800,
      analyzeTimeoutMs: 300,
      recognitionAttempts: 1,
      repairBooks: async () => null,
      analyze: async () => {
        analyzeAttempts += 1;
        return { ok: true, source: goodSource, sources: { [source.sourceName]: goodSource } };
      },
    },
  );

  assert.equal(slowRequestAborted, true);
  assert.equal(analyzeAttempts, 1);
  assert.ok(gated.sources[source.sourceName]);
  assert.equal(gated.skipped.length, 0);
});

test("单个分类请求超时后继续抽测后续分类入口", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "多分类抽测" },
  );
  const action = Object.values(source.bookWorld)[0];
  source.bookWorld = {
    超时分类: { ...structuredClone(action), requestInfo: "https://novel.example/slow-list" },
    空分类: { ...structuredClone(action), requestInfo: "https://novel.example/empty-list" },
    可用分类: { ...structuredClone(action), requestInfo: "https://novel.example/list" },
  };
  delete source.searchBook;
  const requests = [];
  const download = async (url, headers = {}, options = {}) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/slow-list") {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(options.signal.reason || new Error("aborted"));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
    }
    if (path === "/empty-list") return Buffer.from("<html><body>暂时无结果</body></html>");
    return fixtureDownload(url, headers, options);
  };

  const verified = await verifyConvertedSource(source, {
    download,
    timeoutMs: 35,
    sourceTimeoutMs: 2_000,
  });

  assert.equal(verified.ok, true, verified.detail || verified.reason);
  assert.ok(requests.includes("/slow-list"));
  assert.ok(requests.includes("/empty-list"));
  assert.ok(requests.includes("/list"));
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

test("verify budget 到期后跳过未完成验链的源，不发布未验证源", async () => {
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
  assert.equal(gated.unverifiedCount, 0);
  assert.equal(Object.keys(gated.sources).length, 0);
  assert.equal(gated.skipped.length, 6);
});

test("单源验链超时会取消回退下载并快速结算", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "单源超时" },
  );
  const firstWorld = Object.keys(source.bookWorld)[0];
  source.bookWorld[firstWorld].requestInfo = "https://novel.example/slow-list";
  delete source.searchBook;
  let aborted = false;
  const download = async (url, headers, options = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Buffer.from("<html><body>empty</body></html>")), 200);
    options.signal?.addEventListener("abort", () => {
      aborted = true;
      clearTimeout(timer);
      reject(options.signal.reason || new Error("aborted"));
    }, { once: true });
  });
  const started = Date.now();
  const gated = await applyVerifyAndAnalyzeFallback({ 单源超时: source }, {
    download,
    concurrency: 1,
    timeoutMs: 200,
    sourceTimeoutMs: 500,
    sourceBudgetMs: 30,
    analyzeFallback: true,
    analyze: async () => ({ ok: false, reason: "should not run" }),
  });
  assert.ok(Date.now() - started < 180, `source took too long: ${Date.now() - started}ms`);
  assert.equal(aborted, true);
  assert.equal(gated.sources["单源超时"], undefined);
  assert.equal(gated.skipped.length, 1);
  assert.match(gated.skipped[0].reason, /source-timeout/);
  assert.equal(gated.skipped[0].sourceType, "text");
  assert.equal(gated.skipped[0].host, "novel.example");
  assert.equal(gated.skipped[0].stage, "list");
  assert.match(gated.skipped[0].reason, /阶段：list/);
});

test("详情请求真实超时会中止当前源，不再误吞并继续目录请求", async () => {
  const source = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "详情请求超时" },
  );
  let detailAborted = false;
  let chapterRequests = 0;
  const download = async (url, _headers, options = {}) => {
    if (/\/book\/1\.html(?:$|[?#])/.test(String(url))) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Buffer.from(novelDetail)), 1_000);
        options.signal?.addEventListener("abort", () => {
          detailAborted = true;
          clearTimeout(timer);
          reject(options.signal.reason || new Error("aborted"));
        }, { once: true });
      });
    }
    if (/\/chapter\//.test(String(url))) chapterRequests += 1;
    return fixtureDownload(url);
  };
  const gated = await applyVerifyAndAnalyzeFallback({ [source.sourceName]: source }, {
    download,
    concurrency: 1,
    timeoutMs: 35,
    sourceTimeoutMs: 300,
    sourceBudgetMs: 500,
    analyzeFallback: false,
  });

  assert.equal(detailAborted, true);
  assert.equal(chapterRequests, 0);
  assert.equal(gated.sources[source.sourceName], undefined);
  assert.match(gated.skipped[0].reason, /source-timeout/);
  assert.equal(gated.skipped[0].stage, "detail");
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

test("跨源复用识站结果时按请求头隔离相同 URL 的源", async () => {
  const good = novelDiscoveryToXiangse(
    await discoverNovel("https://novel.example/", { download: fixtureDownload }),
    { sourceName: "请求头隔离" },
  );
  const makeBroken = (name, token) => {
    const source = structuredClone(good);
    source.sourceName = name;
    source.httpHeaders = { Authorization: `Bearer ${token}` };
    source.bookWorld[Object.keys(source.bookWorld)[0]].requestInfo = "https://novel.example/bad-list";
    delete source.searchBook;
    return source;
  };
  const observedTokens = [];
  const gated = await applyVerifyAndAnalyzeFallback({
    "源甲": makeBroken("源甲", "alpha"),
    "源乙": makeBroken("源乙", "beta"),
  }, {
    download: async (url, headers = {}, options = {}) => (
      String(url).endsWith("/bad-list")
        ? Buffer.from("<html><body>需要认证</body></html>")
        : fixtureDownload(url, headers, options)
    ),
    concurrency: 1,
    timeoutMs: 500,
    sourceTimeoutMs: 3_000,
    sourceBudgetMs: 6_000,
    analyzeFallback: true,
    repairBooks: async () => null,
    repairContent: async () => null,
    repairChapter: async () => null,
    repairDetail: async () => null,
    repairJsonChapter: async () => null,
    analyze: async (_host, options) => {
      observedTokens.push(options.repairSource.httpHeaders.Authorization);
      const source = structuredClone(good);
      source.sourceName = options.sourceName;
      return { ok: true, source, sources: { [options.sourceName]: source } };
    },
  });

  assert.deepEqual(observedTokens, ["Bearer alpha", "Bearer beta"]);
  assert.equal(Object.keys(gated.sources).length, 2);
  assert.equal(gated.skipped.length, 0);
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
  assert.match(gated.warnings[0].message, /未启用持续识站/);
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

test("discoverNovel 跟随 og:novel:read_url 目录页并识别卷名章节", async (context) => {
  const home = `<!doctype html><html><head><title>轻小说站</title></head><body>
  <a href="/gocomic" class="nav"><img src="/cover-nav.png" alt="漫画"></a>
  <ul class="rank">
    <li><a href="/novel/101.html">轻小说甲</a></li>
    <li><a href="/novel/102.html">轻小说乙</a></li>
    <li><a href="/novel/103.html">轻小说丙</a></li>
  </ul>
  </body></html>`;
  const detail = `<!doctype html><html><head>
  <meta property="og:novel:book_name" content="轻小说甲">
  <meta property="og:novel:read_url" content="/novel/101/catalog">
  </head><body>
  <h1>轻小说甲</h1>
  <a href="/novel/101/catalog">最后更新·2026-09-01 第二卷 后记</a>
  <a href="/novel/102.html">轻小说乙</a>
  </body></html>`;
  const catalog = `<!doctype html><html><body><ul>
  <li><a href="/novel/101/c1.html"><span class="idx">第一部</span></a></li>
  <li><a href="/novel/101/c2.html"><span class="idx">第二部</span></a></li>
  <li><a href="/novel/101/c3.html"><span class="idx">第三部</span></a></li>
  </ul></body></html>`;
  const chapter = `<!doctype html><html><body><div id="content">${"卷名正文。".repeat(40)}</div></body></html>`;
  const upstream = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://upstream.example").pathname;
    const body = path === "/novel/101/catalog" ? catalog
      : path === "/novel/101.html" ? detail
      : /^\/novel\/101\/c\d+\.html$/.test(path) ? chapter
      : home;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  });
  const upstreamBase = await listen(upstream);
  context.after(() => close(upstream));
  const bridge = createAppServer({ config: { allowPrivateNetworks: true, cacheTtlMs: 0 } });
  const bridgeBase = await listen(bridge);
  context.after(() => close(bridge));

  const discovery = await discoverNovel(`${upstreamBase}/`, {
    download: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
    adapterBase: bridgeBase,
  });
  assert.ok(discovery, JSON.stringify(discovery));
  assert.match(discovery.tocSelector, /og:novel:read_url/);
  assert.ok(discovery.chapterCount >= 2);
  assert.match(discovery.chapterSampleUrl, /\/novel\/101\/c\d+\.html$/);
  assert.match(discovery.chapterRequestInfo || "", /adapter\/toc/);

  const source = novelDiscoveryToXiangse(discovery, { sourceName: "轻小说站" });
  const report = await runXbsPipeline(source, { adapterBase: bridgeBase });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.chapterList.listCount, 3);
  assert.match(report.steps.chapterList.requestUrl, /\/novel\/101\/catalog$/);
  assert.match(report.steps.chapterContent.requestUrl, /\/novel\/101\/c\d+\.html$/);
});
