/**
 * 按 docs/xiangse/香色闺阁书源规则.md §七 验收：
 * chapterList.requestInfo 的 result = 书籍详情页 URL，脚本应把它改写成目录页，再解析出章节与正文。
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

function evalChapterListRequestInfo(script, detailPageUrl) {
  const body = String(script).replace(/^@js:\s*/i, "");
  // eslint-disable-next-line no-new-func
  const out = new Function(
    "params",
    "result",
    "config",
    body,
  )(
    { queryInfo: {} },
    detailPageUrl, // §七：result = 书籍详情页 URL
    { host: "https://www.alicesw.com", httpHeaders: UA },
  );
  if (typeof out === "string") return out;
  if (out && typeof out === "object") return out.url || "";
  return "";
}

function extractChaptersFromMulu(html) {
  const block = html.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

test("live: §七 result=详情URL → 目录页 → 章节+正文", async (t) => {
  let sourceRes;
  try {
    sourceRes = await fetch("https://www.yckceo.com/yuedu/shuyuan/json/id/7585.json", { headers: UA });
  } catch (error) {
    t.skip(`无法访问外网: ${error.message}`);
    return;
  }
  if (!sourceRes.ok) {
    t.skip(`拉取 7585 失败: HTTP ${sourceRes.status}`);
    return;
  }

  const { sources } = convertLegado(await sourceRes.json());
  const src = sources["爱丽丝书屋"] || Object.values(sources)[0];
  assert.ok(src);
  assert.equal(src.chapterList.title, "//a/text()");
  assert.equal(src.chapterList.url, "//a/@href");
  assert.doesNotMatch(src.searchBook.detailUrl, /other\/chapters/);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch, "搜索结果取不到书籍链接");
  const detailUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;
  assert.match(detailUrl, /\/novel\/\d+/);

  // 严格按文档：只把详情 URL 当 result 传入
  const catalogUrl = evalChapterListRequestInfo(src.chapterList.requestInfo, detailUrl);
  assert.match(catalogUrl, /\/other\/chapters\/id\/\d+\.html/, `§七改写失败: ${catalogUrl}`);

  const detailHtml = await fetchText(detailUrl);
  assert.equal(extractChaptersFromMulu(detailHtml).length, 0, "详情页无 mulu_list，必须改写到目录页");

  const tocHtml = await fetchText(catalogUrl);
  const chapters = extractChaptersFromMulu(tocHtml).filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(chapters.length > 0, `目录页章节为空: ${catalogUrl}`);

  const chapterUrl = new URL(chapters[0].url, "https://www.alicesw.com").href;
  const contentHtml = await fetchText(chapterUrl);
  const contentBlock = contentHtml.match(/class="[^"]*read-content[^"]*"[\s\S]*?<\/div>/i);
  assert.ok(contentBlock, "找不到 read-content");
  const paras = [...contentBlock[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  assert.ok(paras.length > 0 && paras.join("").length > 50, "正文为空");

  console.log(JSON.stringify({
    detailUrl,
    catalogUrl,
    chapters: chapters.length,
    first: chapters[0].title.slice(0, 40),
    contentChars: paras.join("").length,
  }));
});
