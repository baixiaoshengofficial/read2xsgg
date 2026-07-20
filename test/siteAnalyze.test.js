import assert from "node:assert/strict";
import test from "node:test";
import {
  detectKind,
  detectKinds,
  discoverNovel,
  discoverComic,
  discoverMedia,
  novelDiscoveryToXiangse,
  analyzeSite,
  validateXiangseSource,
  runXbsPipeline,
  downloadAsFetch,
} from "../src/index.js";
import { applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
import { verifyConvertedSource } from "../src/verifySource.js";
import { skippedBuckets } from "../src/converter.js";
import { encodeBridgePlan } from "../src/bridgePlan.js";

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

test("detectKinds 混合站可同时命中多种类型", () => {
  const kinds = detectKinds(mixedHome, "https://mixed.example/");
  const set = new Set(kinds.map((item) => item.kind));
  assert.ok(set.has("text"));
  assert.ok(set.has("comic"));
  assert.ok(set.has("audio"));
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

test("discoverMedia 从 HTML fixture 发现听书结构", async () => {
  const discovery = await discoverMedia("https://audio.example/", "audio", { download: fixtureDownload });
  assert.ok(discovery);
  assert.equal(discovery.kind, "audio");
  assert.ok(discovery.chapterCount >= 2);
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

test("analyzeSite 对小说 fixture 返回成功源", async () => {
  const result = await analyzeSite("https://novel.example/", { download: fixtureDownload });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "text");
  assert.ok(result.source.chapterContent.content);
  assert.match(result.warning.message, /fallback:site-analyze/);
  assert.equal(Object.keys(result.sources).length, 1);
});

test("analyzeSite 对漫画 fixture 生成漫画源", async () => {
  const result = await analyzeSite("https://comic.example/", { download: fixtureDownload });
  assert.equal(result.ok, true);
  assert.ok(result.kinds.includes("comic"));
  const comic = Object.values(result.sources).find((item) => item.sourceType === "comic");
  assert.ok(comic);
  assert.match(comic.chapterContent.content, /urls/);
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
  assert.ok(types.has("audio"));
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

test("抽测失败后 pipeline 可回退识站", async () => {
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
    { download: fixtureDownload, enabled: true, analyzeFallback: true },
  );
  assert.ok(gated.sources["过时源"]);
  assert.equal(gated.fallbackCount, 1);
  assert.match(gated.sources["过时源"].chapterContent.content, /content/);
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

test("verify budget 到期后保留未抽测源", async () => {
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
    chapterList: {
      actionID: "chapterList",
      host: "https://novel.example",
      responseFormatType: "html",
      requestInfo: "%@result",
      list: "//a",
      title: ".",
      url: "./@href",
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
  assert.equal(Object.keys(gated.sources).length + gated.skipped.length, 6);
  assert.equal(Object.keys(gated.sources).length, gated.unverifiedCount);
});
