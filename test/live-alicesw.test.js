/**
 * 端到端实测：7585/alicesw 转换规则在真实页面上必须能取出「有标题+有章节链」的目录，以及正文。
 * 用标准 XPath（list 相对子字段按 .// 重写）严格验收——旧规则 /text() + //@href 在此会 0 章。
 * 需要外网；不过不推送。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function xpathExtractChapters(html, listXp, titleXp, urlXp, { remapRelative = true } = {}) {
  const py = `
import sys, json
from lxml import html as lh
doc = lh.fromstring(sys.stdin.buffer.read())
list_xp = ${JSON.stringify(listXp)}
title_xp = ${JSON.stringify(titleXp)}
url_xp = ${JSON.stringify(urlXp)}
remap = ${remapRelative ? "True" : "False"}

def child_expr(expr):
    if not remap:
        return expr
    if expr.startswith("//"):
        return "." + expr
    if expr.startswith("/"):
        return "." + expr
    return expr

def as_text(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if hasattr(v, "text_content"):
        return v.text_content().strip()
    return str(v).strip()

items = []
for node in doc.xpath(list_xp):
    titles = node.xpath(child_expr(title_xp))
    hrefs = node.xpath(child_expr(url_xp))
    title = as_text(titles[0]) if titles else ""
    href = hrefs[0] if hrefs and isinstance(hrefs[0], str) else (str(hrefs[0]) if hrefs else "")
    items.append({"title": title, "url": href})
print(json.dumps(items, ensure_ascii=False))
`;
  const ran = spawnSync("python3", ["-c", py], {
    input: html,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(ran.status, 0, `xpath extract failed: ${ran.stderr}`);
  return JSON.parse(ran.stdout);
}

test("live: 7585 目录必须能解析出带标题的章节，正文非空", async () => {
  const sourceRes = await fetch("https://www.yckceo.com/yuedu/shuyuan/json/id/7585.json", { headers: UA });
  assert.equal(sourceRes.ok, true, "无法拉取 7585 阅读源");
  const { sources } = convertLegado(await sourceRes.json());
  const src = sources["爱丽丝书屋"] || Object.values(sources)[0];
  assert.ok(src);

  // 规则形态：list=li，title/url=a —— 禁止旧的 list=a + /text() + //@href
  assert.match(src.chapterList.list, /mulu_list.*\/\/li$|mulu_list'\)\]\/\/li$/);
  assert.match(src.chapterList.title, /\/\/a\/text\(\)/);
  assert.match(src.chapterList.url, /\/\/a\/@href/);
  assert.doesNotMatch(src.chapterList.url, /\/\/@href/);
  assert.equal(src.chapterList.title, "//a/text()");
  assert.match(src.chapterList.requestInfo, /detailUrl/);

  const searchUrl = String(src.searchBook.requestInfo).replace("%@keyWord", encodeURIComponent("赘婿"));
  const searchHtml = await fetchText(searchUrl);
  const hrefMatch = searchHtml.match(/list-group-item[\s\S]{0,800}?<h5[^>]*>\s*<a[^>]+href="([^"]+)"/i);
  assert.ok(hrefMatch, "搜索结果取不到书籍链接");
  const detailUrl = new URL(hrefMatch[1], "https://www.alicesw.com").href;

  // 用 detailUrl；故意不传首章 url
  const catalogUrl = evalRequestInfo(src.chapterList.requestInfo, { detailUrl, url: "" });
  assert.match(catalogUrl, /\/other\/chapters\/id\/\d+\.html/, `目录 URL 失败: ${catalogUrl}`);

  const tocHtml = await fetchText(catalogUrl);
  const chapters = xpathExtractChapters(
    tocHtml,
    src.chapterList.list,
    src.chapterList.title,
    src.chapterList.url,
  );
  const good = chapters.filter((c) => c.title && /\/book\//.test(c.url));
  assert.ok(good.length > 0, `目录解析失败: total=${chapters.length} sample=${JSON.stringify(chapters.slice(0, 2))}`);

  // 旧规则在「不做相对改写的标准 XPath」下必须取不到可用章节（防回归）
  const oldBroken = xpathExtractChapters(
    tocHtml,
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' mulu_list ')]//li//a",
    "/text()",
    "//@href",
    { remapRelative: false },
  );
  const oldGood = oldBroken.filter((c) => c.title && /\/book\//.test(c.url));
  assert.equal(oldGood.length, 0, `旧规则不应能解析出章节；sample=${JSON.stringify(oldBroken.slice(0, 2))}`);

  const chapterUrl = new URL(good[0].url, "https://www.alicesw.com").href;
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
      chapters: good.length,
      first: { title: good[0].title.slice(0, 40), url: good[0].url },
      contentChars: paras.join("").length,
      oldRuleGood: oldGood.length,
    }),
  );
});
