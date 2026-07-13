/**
 * 端到端实测：7585/alicesw 转换规则在真实页面上必须能取出「有标题+有章节链」的目录，以及正文。
 * 不依赖 lxml（CI 无 Python 包）；用 DOM 结构的稳定正则验收。
 * 需要外网；若离线环境拉不到源则跳过。
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

function evalRequestInfo(script, { detailUrl = "", url = "", result = "" } = {}) {
  const body = String(script).replace(/^@js:\s*/i, "");
  // eslint-disable-next-line no-new-func
  const out = new Function(
    "params",
    "result",
    "config",
    body,
  )({ queryInfo: { detailUrl, url } }, result, { host: "https://www.alicesw.com", httpHeaders: UA });
  if (typeof out === "string") return out;
  if (out && typeof out === "object") return out.url || "";
  return "";
}

/** 从 mulu_list 的 li>a 抽出章节（对应转换后的 list=//li + title=//a/text() + url=//a/@href） */
function extractChaptersFromMulu(html) {
  const block = html.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

test("live: 7585 目录必须能解析出带标题的章节，正文非空", async (t) => {
  let sourceRes;
  try {
    sourceRes = await fetch("https://www.yckceo.com/yuedu/shuyuan/json/id/7585.json", { headers: UA });
  } catch (error) {
    t.skip(`无法访问外网拉取阅读源: ${error.message}`);
    return;
  }
  if (!sourceRes.ok) {
    t.skip(`拉取 7585 失败: HTTP ${sourceRes.status}`);
    return;
  }

  const { sources } = convertLegado(await sourceRes.json());
  const src = sources["爱丽丝书屋"] || Object.values(sources)[0];
  assert.ok(src);

  // 规则形态：list=li，title/url=a —— 禁止旧的 list=a + /text() + //@href
  assert.match(src.chapterList.list, /\/\/li$/);
  assert.equal(src.chapterList.title, "//a/text()");
  assert.equal(src.chapterList.url, "//a/@href");
  assert.match(src.chapterList.requestInfo, /detailUrl/);
  assert.match(src.chapterList.requestInfo, /"url"/);
  assert.match(src.chapterContent.content, /\|@js:/);
  assert.doesNotMatch(src.chapterContent.content, /\|\|@js:/);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch, "搜索结果取不到书籍链接");
  const detailUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;

  const catalogUrl = evalRequestInfo(src.chapterList.requestInfo, { detailUrl, url: "" });
  assert.match(catalogUrl, /\/other\/chapters\/id\/\d+\.html/, `目录 URL 失败: ${catalogUrl}`);

  const tocHtml = await fetchText(catalogUrl);
  const chapters = extractChaptersFromMulu(tocHtml).filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(chapters.length > 0, `目录解析失败 sample=${JSON.stringify(extractChaptersFromMulu(tocHtml).slice(0, 2))}`);

  const chapterUrl = new URL(chapters[0].url, "https://www.alicesw.com").href;
  const contentHtml = await fetchText(chapterUrl);
  const contentBlock = contentHtml.match(/class="[^"]*read-content[^"]*"[\s\S]*?<\/div>/i);
  assert.ok(contentBlock, "找不到 read-content");
  const paras = [...contentBlock[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  assert.ok(paras.length > 0 && paras.join("").length > 50, "正文为空或过短");

  console.log(
    JSON.stringify({
      detailUrl,
      catalogUrl,
      chapters: chapters.length,
      first: { title: chapters[0].title.slice(0, 40), url: chapters[0].url },
      contentChars: paras.join("").length,
    }),
  );
});
