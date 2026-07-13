/**
 * 验收链路（对齐书源规则）：
 * 1) 搜索 href 经 detailUrl |@js: 变成目录页
 * 2) chapterList.requestInfo 为 %@result → 请求同一目录页
 * 3) list=li + title/url=a 能解析出章节，正文非空
 * 4) XBS 往返后规则仍在
 */
import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado, decodeXbs, encodeXbs } from "../src/index.js";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

async function fetchText(url) {
  const response = await fetch(url, { headers: UA, redirect: "follow" });
  assert.equal(response.ok, true, `HTTP ${response.status} for ${url}`);
  return response.text();
}

function runFieldJs(rule, result) {
  const js = String(rule).split(/\|@js:/).slice(1).join("|@js:");
  assert.ok(js, "缺少 |@js: 后处理");
  // eslint-disable-next-line no-new-func
  return new Function("result", "config", "params", js)(
    result,
    { host: "https://www.alicesw.com" },
    {},
  );
}

function extractChaptersFromMulu(html) {
  const block = html.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

test("live: 搜索→目录落地 + %@result → 章节+正文 + XBS完好", async (t) => {
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
  assert.equal(src.chapterList.requestInfo, "%@result");
  assert.match(src.searchBook.detailUrl, /\|@js:/);

  const xbs = encodeXbs(sources);
  const round = JSON.parse(decodeXbs(xbs).toString("utf8"));
  assert.equal(round["爱丽丝书屋"].chapterList.requestInfo, "%@result");
  assert.equal(round["爱丽丝书屋"].chapterList.list, src.chapterList.list);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch);
  assert.match(hrefMatch[1], /\/novel\/\d+/);

  const catalogUrl = runFieldJs(src.searchBook.detailUrl, hrefMatch[1]);
  assert.match(String(catalogUrl), /\/other\/chapters\/id\/\d+\.html/);

  // %@result ⇒ 目录页
  const tocHtml = await fetchText(catalogUrl);
  const chapters = extractChaptersFromMulu(tocHtml).filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(chapters.length > 0, `目录无章节: ${catalogUrl}`);

  const novelUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;
  assert.equal(extractChaptersFromMulu(await fetchText(novelUrl)).length, 0);

  const contentHtml = await fetchText(new URL(chapters[0].url, "https://www.alicesw.com").href);
  const contentBlock = contentHtml.match(/class="[^"]*read-content[^"]*"[\s\S]*?<\/div>/i);
  const paras = [...contentBlock[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  assert.ok(paras.join("").length > 50);

  console.log(JSON.stringify({
    catalogUrl,
    chapterListRequestInfo: src.chapterList.requestInfo,
    chapters: chapters.length,
    first: chapters[0].title.slice(0, 40),
    contentChars: paras.join("").length,
  }));
});
