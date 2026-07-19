/**
 * 必须用 iPhone UA 验收（香色客户端真实环境）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado, decodeXbs, encodeXbs } from "../src/index.js";

const IPHONE_UA = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
};

async function fetchText(url) {
  const response = await fetch(url, { headers: IPHONE_UA, redirect: "follow" });
  assert.equal(response.ok, true, `HTTP ${response.status} ${url}`);
  return response.text();
}

function evalChapterListJs(script, detailUrl) {
  const body = String(script).replace(/^@js:\s*/i, "");
  // eslint-disable-next-line no-new-func
  return new Function("params", "result", "config", body)(
    { queryInfo: { detailUrl } },
    detailUrl,
    { host: "https://www.alicesw.com", httpHeaders: IPHONE_UA },
  );
}

function extractChapters(html) {
  // mobile first, then desktop
  const block =
    html.match(/<ul[^>]*class="[^"]*section-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)
    || html.match(/<ul[^>]*class="[^"]*mulu_list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

test("live iPhone UA: 详情有封面/最新章，改写目录后有章节+正文", {
  skip: process.env.RUN_LIVE_TESTS === "1" ? false : "实时上游测试请运行 npm run test:live",
}, async (t) => {
  let sourceRes;
  try {
    sourceRes = await fetch("https://www.yckceo.com/yuedu/shuyuan/json/id/7585.json", { headers: IPHONE_UA });
  } catch (error) {
    t.skip(error.message);
    return;
  }
  if (!sourceRes.ok) {
    t.skip(`HTTP ${sourceRes.status}`);
    return;
  }

  const { sources } = convertLegado(await sourceRes.json());
  const src = sources["爱丽丝书屋"] || Object.values(sources)[0];

  const round = JSON.parse(decodeXbs(encodeXbs(sources)).toString("utf8"));
  assert.ok(round["爱丽丝书屋"].chapterList.list.includes("section-list"));

  const searchHtml = await fetchText(
    String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿")),
  );
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch);
  const detailUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;
  assert.match(detailUrl, /\/novel\/\d+/);

  const detailHtml = await fetchText(detailUrl);
  assert.match(detailHtml, /og:image|321cdn|\.webp/, "详情页应有封面");
  assert.match(detailHtml, /\/book\//, "详情页应有最新章节链接");
  // 手机详情页可能有「最近几章」的 section-list，但完整目录仍在 /other/chapters/
  assert.match(detailHtml, /全部章节|查看所有章节/);

  const catalogUrl = evalChapterListJs(src.chapterList.requestInfo, detailUrl);
  assert.match(String(catalogUrl), /\/other\/chapters\/id\/\d+\.html/);

  const tocHtml = await fetchText(catalogUrl);
  assert.ok(
    /section-list|mulu_list/.test(tocHtml),
    "目录页应有 section-list 或 mulu_list",
  );
  const chapters = extractChapters(tocHtml).filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(chapters.length > 0, `目录解析失败 url=${catalogUrl}`);

  const contentHtml = await fetchText(new URL(chapters[0].url, "https://www.alicesw.com").href);
  assert.match(contentHtml, /read-content/);
  const plain = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(plain.length > 200, `正文过短: ${plain.slice(0, 80)}`);

  console.log(JSON.stringify({
    detailUrl,
    catalogUrl,
    chapters: chapters.length,
    first: chapters[0].title.slice(0, 40),
    contentChars: plain.length,
  }));
});
