/**
 * 端到端：7585 必须能搜到书、改写到目录页、解析出带标题章节、打开正文。
 * 不依赖 lxml；外网不可用时 skip。
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

function runJs(script, result, params = {}) {
  const body = String(script).replace(/^@js:\s*/i, "");
  // eslint-disable-next-line no-new-func
  return new Function("params", "result", "config", body)(
    params,
    result,
    { host: "https://www.alicesw.com", httpHeaders: UA },
  );
}

function extractFieldJs(rule) {
  const parts = String(rule).split(/\|@js:/);
  return parts.length > 1 ? parts.slice(1).join("|@js:") : "";
}

function extractChaptersFromMulu(html) {
  const block = html.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

test("live: 7585 搜索改写目录后必须能解析章节和正文", async (t) => {
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
  assert.match(src.searchBook.detailUrl, /\|@js:/);
  assert.doesNotMatch(src.chapterList.requestInfo, /\bconst\b|\blet\b/);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch, "搜索结果取不到书籍链接");
  assert.match(hrefMatch[1], /\/novel\/\d+/);

  // 模拟香色：先跑 detailUrl 字段上的 |@js 改写
  const rewritten = runJs(extractFieldJs(src.searchBook.detailUrl), hrefMatch[1]);
  assert.match(String(rewritten), /\/other\/chapters\/id\/\d+\.html/, `搜索链接未改写到目录: ${rewritten}`);

  // chapterList 即使只拿到改写后的 detailUrl，也应仍指向目录
  const catalogUrl = runJs(src.chapterList.requestInfo, rewritten, {
    queryInfo: { detailUrl: rewritten, url: "" },
  });
  assert.equal(catalogUrl, rewritten);

  // 即使客户端没跑搜索改写、只给 novel 详情，chapterList 也必须能推导目录
  const fromNovel = runJs(src.chapterList.requestInfo, "", {
    queryInfo: { detailUrl: new URL(hrefMatch[1], "https://www.alicesw.com").href, url: "" },
  });
  assert.match(String(fromNovel), /\/other\/chapters\/id\/\d+\.html/);

  const tocHtml = await fetchText(catalogUrl);
  const chapters = extractChaptersFromMulu(tocHtml).filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(chapters.length > 0, `目录为空: ${catalogUrl}`);

  // 目录页本身无 mulu 则失败；确认 /novel/ 详情页用同一 list 规则会得到 0（解释为何必须去目录页）
  const detailHtml = await fetchText(new URL(hrefMatch[1], "https://www.alicesw.com").href);
  assert.equal(extractChaptersFromMulu(detailHtml).length, 0, "详情页不应有 mulu_list；否则验收逻辑失效");

  const chapterUrl = new URL(chapters[0].url, "https://www.alicesw.com").href;
  const contentHtml = await fetchText(chapterUrl);
  const contentBlock = contentHtml.match(/class="[^"]*read-content[^"]*"[\s\S]*?<\/div>/i);
  assert.ok(contentBlock, "找不到 read-content");
  const paras = [...contentBlock[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  assert.ok(paras.length > 0 && paras.join("").length > 50, "正文为空");

  console.log(JSON.stringify({
    searchHref: hrefMatch[1],
    rewritten,
    chapters: chapters.length,
    first: chapters[0].title.slice(0, 40),
    contentChars: paras.join("").length,
  }));
});
