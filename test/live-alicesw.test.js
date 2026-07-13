/**
 * 端到端实测：7585/alicesw 转换规则对真实页面能否取出搜索→目录→正文。
 * 需要外网；推送前必过。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado } from "../src/index.js";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

async function fetchText(url) {
  const response = await fetch(url, { headers: UA, redirect: "follow" });
  assert.equal(response.ok, true, `HTTP ${response.status} for ${url}`);
  return response.text();
}

function evalJsRequestInfo(script, { result = "", url = "", tocUrl = "" } = {}) {
  const body = String(script).replace(/^@js:\s*/i, "");
  // eslint-disable-next-line no-new-func
  return new Function("params", "result", body)({ queryInfo: { url, tocUrl } }, result);
}

function absolutizeChapterUrl(script, href) {
  if (!script.includes("@js:")) return new URL(href, "https://www.alicesw.com").href;
  const js = script.split(/\|?@js:/).slice(1).join("@js:");
  // eslint-disable-next-line no-new-func
  return new Function("result", js)(href);
}

test("live: 7585 alicesw 搜索→目录→正文能取出内容", async () => {
  const sourceRes = await fetch("https://www.yckceo.com/yuedu/shuyuan/json/id/7585.json", { headers: UA });
  assert.equal(sourceRes.ok, true, "无法拉取 7585 阅读源");
  const { sources } = convertLegado(await sourceRes.json());
  const src = sources["爱丽丝书屋"] || Object.values(sources)[0];
  assert.ok(src, "转换结果为空");
  assert.match(src.chapterList.requestInfo, /other\/chapters\/id/);
  assert.match(src.bookDetail.tocUrl, /\/\/a\[contains/);
  assert.match(src.chapterContent.content, /\|@js:/);
  assert.doesNotMatch(src.chapterContent.content, /\|\|@js:/);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  assert.match(searchHtml, /list-group-item/, `搜索无 list-group-item: ${searchUrl}`);

  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch, "搜索结果取不到书籍链接");
  const detailUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;

  // 故意不传 tocUrl，验证不依赖透传字段
  const catalogUrl = evalJsRequestInfo(src.chapterList.requestInfo, { url: detailUrl, tocUrl: "" });
  assert.match(String(catalogUrl), /\/other\/chapters\/id\/\d+\.html/, `目录 URL 推导失败: ${catalogUrl}`);

  const tocHtml = await fetchText(catalogUrl);
  assert.match(tocHtml, /mulu_list/, "目录页没有 mulu_list");

  const listBlock = tocHtml.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  assert.ok(listBlock, "找不到 mulu_list 列表块");
  const chapters = [...listBlock[1].matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
  assert.ok(chapters.length > 0, "目录列表为空");

  const chapterUrl = absolutizeChapterUrl(src.chapterList.url, chapters[0].href);
  assert.match(chapterUrl, /^https:\/\/www\.alicesw\.com\/book\//);

  const contentHtml = await fetchText(chapterUrl);
  assert.match(contentHtml, /read-content/, "正文页没有 read-content");
  const contentBlock = contentHtml.match(/class="[^"]*read-content[^"]*"[\s\S]*?<\/div>/i);
  assert.ok(contentBlock, "找不到 read-content 块");
  const paras = [...contentBlock[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  assert.ok(paras.length > 0, "正文段落为空");
  assert.ok(paras.join("").length > 50, `正文过短: ${paras.join("").slice(0, 80)}`);

  console.log(
    JSON.stringify({
      detailUrl,
      catalogUrl,
      chapters: chapters.length,
      firstChapter: chapters[0].title.slice(0, 40),
      contentParas: paras.length,
      contentChars: paras.join("").length,
    }),
  );
});
