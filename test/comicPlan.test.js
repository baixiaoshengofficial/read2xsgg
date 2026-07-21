import assert from "node:assert/strict";
import test from "node:test";
import {
  comicPageUrls,
  compileComicExtractionPlan,
  decodeComicExtractionPlan,
  encodeComicExtractionPlan,
  pageImageUrls,
} from "../src/index.js";

test("JSON 漫画分页元数据会生成同端点的后续页", () => {
  const payload = JSON.stringify({
    data: {
      images: [{ url: "/comic/001.webp" }],
      pagination: { current_page: 1, page_size: 25, total: 207, total_pages: 9 },
    },
  });
  assert.deepEqual(comicPageUrls(payload, "https://api.example/images/7?quality=high&page=1"), [
    "https://api.example/images/7?quality=high&page=2",
    "https://api.example/images/7?quality=high&page=3",
    "https://api.example/images/7?quality=high&page=4",
    "https://api.example/images/7?quality=high&page=5",
    "https://api.example/images/7?quality=high&page=6",
    "https://api.example/images/7?quality=high&page=7",
    "https://api.example/images/7?quality=high&page=8",
    "https://api.example/images/7?quality=high&page=9",
  ]);
  assert.deepEqual(comicPageUrls(payload, "https://api.example/images/7"), []);
});

test("漫画正文规则编译为安全的字段和属性提示", () => {
  const plan = compileComicExtractionPlan(`
    $.data.pages[*].pageSrc
    item.imageUrl
    {{@class.reader@tag.img@data-original}}
    node.getAttribute("data-file")
    @js:process.exit(1)
  `, { Referer: "https://comic.example/", Host: "evil.example", "X-Test": "a\r\nb" });
  assert.deepEqual(plan, {
    version: 1,
    properties: ["pageSrc", "imageUrl"],
    attributes: ["data-original", "data-file"],
    headers: { Referer: "https://comic.example/", "X-Test": "a b" },
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

test("已按阅读顺序排列的图片不会被文件名误重排", () => {
  const html = `
    <img src="https://cdn.example/ch/id99_page_01.jpg">
    <img src="https://cdn.example/ch/id99_page_02.jpg">
    <img src="https://cdn.example/ch/id99_page_10.jpg">
  `;
  assert.deepEqual(pageImageUrls(html, "https://comic.example/chapter/1"), [
    "https://cdn.example/ch/id99_page_01.jpg",
    "https://cdn.example/ch/id99_page_02.jpg",
    "https://cdn.example/ch/id99_page_10.jpg",
  ]);
});

test("JSON 图片数组按 page/index 字段排序，而不是对象出现顺序", () => {
  const payload = JSON.stringify({
    data: {
      images: [
        { index: 3, url: "/comic/003.webp" },
        { index: 1, url: "/comic/001.webp" },
        { index: 2, url: "/comic/002.webp" },
      ],
    },
  });
  assert.deepEqual(pageImageUrls(payload, "https://api.example/chapter/1"), [
    "https://api.example/comic/001.webp",
    "https://api.example/comic/002.webp",
    "https://api.example/comic/003.webp",
  ]);
});

test("封面 url 不会插入到 images 数组正文序列前面", () => {
  const payload = JSON.stringify({
    cover: { url: "https://cdn.example/cover.jpg" },
    data: {
      images: [
        { url: "https://cdn.example/pages/001.jpg" },
        { url: "https://cdn.example/pages/002.jpg" },
        { url: "https://cdn.example/pages/003.jpg" },
      ],
    },
  });
  assert.deepEqual(pageImageUrls(payload, "https://api.example/chapter/1"), [
    "https://cdn.example/pages/001.jpg",
    "https://cdn.example/pages/002.jpg",
    "https://cdn.example/pages/003.jpg",
  ]);
});
