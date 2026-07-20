import assert from "node:assert/strict";
import test from "node:test";
import { detectKind, discoverNovel, novelDiscoveryToXiangse, analyzeSite } from "../src/siteAnalyze/index.js";
import { applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
import { verifyConvertedSource } from "../src/verifySource.js";
import { skippedBuckets } from "../src/converter.js";
import { encodeBridgePlan } from "../src/bridgePlan.js";

const novelHome = `<!doctype html><html><head><title>示例小说网</title></head><body>
<ul class="list">
  <li><a href="/book/1.html">第一本书</a></li>
  <li><a href="/book/2.html">第二本书</a></li>
  <li><a href="/book/3.html">第三本书</a></li>
  <li><a href="/book/4.html">第四本书</a></li>
</ul>
</body></html>`;

const novelDetail = `<!doctype html><html><body>
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

function fixtureDownload(url) {
  const href = String(url);
  if (/\/book\/1\.html/.test(href)) return Buffer.from(novelDetail);
  if (/\/chapter\//.test(href)) return Buffer.from(novelChapter);
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

test("discoverNovel 从 HTML fixture 发现列表/目录/正文", async () => {
  const discovery = await discoverNovel("https://novel.example/", { download: fixtureDownload });
  assert.ok(discovery);
  assert.match(discovery.listSelector, /list|a/i);
  assert.ok(discovery.chapterListSelector);
  assert.equal(discovery.contentSelector, "//*[@id='content']");
  assert.ok(discovery.bookCount >= 3);
  assert.ok(discovery.chapterCount >= 2);
});

test("novelDiscoveryToXiangse 生成可导入的最小香色源", async () => {
  const discovery = await discoverNovel("https://novel.example/", { download: fixtureDownload });
  const source = novelDiscoveryToXiangse(discovery, { sourceName: "识站示例" });
  assert.equal(source.sourceName, "识站示例");
  assert.equal(source.sourceType, "text");
  assert.ok(source.bookWorld["站点首页"].list);
  assert.ok(source.chapterList.list);
  assert.equal(source.chapterContent.content, "//*[@id='content']");
});

test("analyzeSite 对小说 fixture 返回成功源", async () => {
  const result = await analyzeSite("https://novel.example/", { download: fixtureDownload });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "text");
  assert.ok(result.source.chapterContent.content);
  assert.match(result.warning.message, /fallback:site-analyze/);
});

test("analyzeSite 对漫画信号拒绝生成", async () => {
  const comicHome = `<html><body>${'<img src="c.jpg">'.repeat(40)}<p>漫画阅读</p></body></html>`;
  const result = await analyzeSite("https://comic.example/", {
    download: async () => Buffer.from(comicHome),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /漫画|comic/i);
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
