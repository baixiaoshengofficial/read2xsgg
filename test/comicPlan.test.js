import assert from "node:assert/strict";
import test from "node:test";
import {
  compileComicExtractionPlan,
  decodeComicExtractionPlan,
  encodeComicExtractionPlan,
  pageImageUrls,
} from "../src/index.js";

test("漫画正文规则编译为安全的字段和属性提示", () => {
  const plan = compileComicExtractionPlan(`
    $.data.pages[*].pageSrc
    item.imageUrl
    {{@class.reader@tag.img@data-original}}
    node.getAttribute("data-file")
    @js:process.exit(1)
  `);
  assert.deepEqual(plan, {
    version: 1,
    properties: ["pageSrc", "imageUrl"],
    attributes: ["data-original", "data-file"],
  });
  assert.deepEqual(decodeComicExtractionPlan(encodeComicExtractionPlan(plan)), plan);
  assert.doesNotMatch(Buffer.from(encodeComicExtractionPlan(plan), "base64url").toString("utf8"), /process\.exit/);
});

test("JSON 漫画正文按原规则字段选择图片序列而非广告 URL", () => {
  const payload = JSON.stringify({
    ads: [{ url: "https://ads.example/1.jpg" }, { url: "https://ads.example/2.jpg" }, { url: "https://ads.example/3.jpg" }],
    data: { pages: [{ pageSrc: "/comic/001.webp" }, { pageSrc: "/comic/002.webp" }] },
  });
  const plan = compileComicExtractionPlan("$.data.pages[*].pageSrc");
  assert.deepEqual(pageImageUrls(payload, "https://api.example/chapter/1", plan), [
    "https://api.example/comic/001.webp",
    "https://api.example/comic/002.webp",
  ]);
});

test("未知图片字段无需站点适配即可从脚本自动发现", () => {
  assert.deepEqual(pageImageUrls(`
    <script>window.chapter={"assetPath":"https://cdn.example/p/1.jpg","assetPath":"https://cdn.example/p/2.jpg"}</script>
  `, "https://comic.example/chapter/1"), [
    "https://cdn.example/p/1.jpg",
    "https://cdn.example/p/2.jpg",
  ]);
});

test("JSON 字符串数组和 CSS 背景图均由规则计划提取", () => {
  const arrayPlan = compileComicExtractionPlan("$.data.imagePaths[*]");
  assert.deepEqual(pageImageUrls(JSON.stringify({ data: { imagePaths: [
    "https://cdn.example/render?id=1",
    "https://cdn.example/render?id=2",
  ] } }), "https://api.example/chapter", arrayPlan), [
    "https://cdn.example/render?id=1",
    "https://cdn.example/render?id=2",
  ]);

  const stylePlan = compileComicExtractionPlan(".reader-page@style@js:result.match(/url/)");
  assert.deepEqual(pageImageUrls(`
    <div class="reader-page" style="background-image:url('/pages/1.webp')"></div>
    <div class="reader-page" style="background-image:url('/pages/2.webp')"></div>
  `, "https://comic.example/chapter/1", stylePlan), [
    "https://comic.example/pages/1.webp",
    "https://comic.example/pages/2.webp",
  ]);
});

test("普通元素的 data-url 不会盖过正文图片序列", () => {
  const html = `
    <button data-url="/chapter/next">下一页</button>
    <div data-url="/album/1">详情</div>
    <img src="https://cdn.example/pages/001.jpg">
    <img src="https://cdn.example/pages/002.jpg">
    <img src="https://cdn.example/pages/003.jpg">
  `;
  assert.deepEqual(pageImageUrls(html, "https://comic.example/chapter/1"), [
    "https://cdn.example/pages/001.jpg",
    "https://cdn.example/pages/002.jpg",
    "https://cdn.example/pages/003.jpg",
  ]);
});

test("JSON-LD 网页 URL 不会盖过正文图片序列", () => {
  const html = `
    <script type="application/ld+json">{"url":"https://comic.example/chapter/1","sameAs":["https://comic.example/"]}</script>
    <img src="https://cdn.example/pages/001.jpg">
    <img src="https://cdn.example/pages/002.jpg">
  `;
  assert.deepEqual(pageImageUrls(html, "https://comic.example/chapter/1"), [
    "https://cdn.example/pages/001.jpg",
    "https://cdn.example/pages/002.jpg",
  ]);
});

test("数字文件名正文序列会纠正封面复用造成的乱序", () => {
  const html = `
    <img src="https://cdn.example/pages/003.jpg">
    <img src="https://cdn.example/pages/001.jpg">
    <img src="https://cdn.example/pages/002.jpg">
    <img src="https://cdn.example/pages/003.jpg">
    <img src="https://cdn.example/pages/004.jpg">
  `;
  assert.deepEqual(pageImageUrls(html, "https://comic.example/chapter/1"), [
    "https://cdn.example/pages/001.jpg",
    "https://cdn.example/pages/002.jpg",
    "https://cdn.example/pages/003.jpg",
    "https://cdn.example/pages/004.jpg",
  ]);
});
