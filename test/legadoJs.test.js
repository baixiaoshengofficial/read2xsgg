import assert from "node:assert/strict";
import test from "node:test";
import { convertRequest, convertRule, hasUnsupportedLegadoRuntime, inferResponseType, rewriteLegadoJavaScript } from "../src/index.js";

function evaluateRewrittenScript(script, result = "") {
  const rewritten = rewriteLegadoJavaScript(`@js:\n${script}`);
  const body = rewritten.replace(/^@js:\s*/i, "");
  return {
    rewritten,
    value: new Function("config", "params", "result", body)(
      { host: "https://example.test" },
      { keyWord: "你好", pageIndex: 2, responseUrl: "https://example.test/chapter" },
      result,
    ),
  };
}

test("常用阅读 Java 编解码和时间 API 可在香色脚本中执行", () => {
  const cases = [
    ["java.md5Encode(\"abc\")", "900150983cd24fb0d6963f7d28e17f72"],
    ["java.base64Encode(\"你好\")", "5L2g5aW9"],
    ["java.base64Decode(\"5L2g5aW9\")", "你好"],
    ["java.hexDecodeToString(\"e4bda0e5a5bd\")", "你好"],
    ["java.timeFormatUTC(1704067200000, \"yyyy-MM-dd HH:mm\")", "2024-01-01 00:00"],
  ];
  for (const [expression, expected] of cases) {
    const { value, rewritten } = evaluateRewrittenScript(`return ${expression};`);
    assert.equal(value, expected, rewritten);
  }
});

test("内嵌 jsoup、规则取值和脚本状态可执行", () => {
  const html = '<div class="card"><a href="/a">一</a></div><div class="card"><a href="/b">二</a></div>';
  const jsoup = evaluateRewrittenScript(
    'var doc = org.jsoup.Jsoup.parse(result); return doc.select(".card a").first().attr("href");',
    html,
  );
  assert.equal(jsoup.value, "/a", jsoup.rewritten);

  assert.equal(evaluateRewrittenScript('return java.getString(".card@text");', html).value, "一");
  assert.equal(
    evaluateRewrittenScript('return java.getString("$.data.name");', JSON.stringify({ data: { name: "ok" } })).value,
    "ok",
  );
  assert.equal(evaluateRewrittenScript('java.put("state", "ok"); return java.get("state");').value, "ok");
});

test("阅读 JavaScript 字符串模板转换为香色 params/result 表达式", () => {
  const rewritten = rewriteLegadoJavaScript(`
    let url = "/api/models?offset={{(page-1)*60}}";
    let name = "{{$.username}}";
    return "https://media.example/{{$.streamName}}.m3u8";
  `);
  assert.match(rewritten, /params\.pageIndex\s*-\s*1/);
  assert.match(rewritten, /result\.username/);
  assert.match(rewritten, /result\.streamName/);
  assert.doesNotMatch(rewritten, /\{\{/);
  assert.equal(hasUnsupportedLegadoRuntime(rewritten), false);
});

test("动态分类请求中的分页模板可生成香色请求 JavaScript", () => {
  const converted = convertRequest('@js:\nlet url="/api/models?offset={{(page-1)*60}}"; return {url:url,POST:false};');
  assert.match(converted.requestInfo, /params\.pageIndex\s*-\s*1/);
  assert.doesNotMatch(converted.requestInfo, /\{\{/);
});

test("分页三元表达式、关键词编码和源站模板可移植", () => {
  const converted = convertRequest("{{source.bookSourceUrl}}/new/{{page==1?'':'index_'+page+'.html'}}?q={{encodeURIComponent(key)}}");
  assert.match(converted.requestInfo, /config\.host/);
  assert.match(converted.requestInfo, /params\.pageIndex\s*==\s*1/);
  assert.match(converted.requestInfo, /encodeURIComponent\(params\.keyWord\)/);
  assert.doesNotMatch(converted.requestInfo, /\{\{/);
  assert.equal(hasUnsupportedLegadoRuntime(converted.requestInfo), false);
});

test("关键词截断模板 key.length/substring 可移植到香色运行时", () => {
  const converted = convertRequest("/index.php/search?key={{key.length>3?key.substring(0,3):key}}");
  assert.match(converted.requestInfo, /params\.keyWord\.length\s*>\s*3/);
  assert.match(converted.requestInfo, /params\.keyWord\.substring\(0,\s*3\)/);
  assert.doesNotMatch(converted.requestInfo, /\{\{/);
  assert.equal(hasUnsupportedLegadoRuntime(converted.requestInfo), false);
});

test("java.put 身份包装的 page/key 模板可降级为香色运行时参数", () => {
  const pageOnly = convertRequest("/list?page={{java.put(\"page\",page)}}");
  assert.match(pageOnly.requestInfo, /params\.pageIndex/);
  assert.doesNotMatch(pageOnly.requestInfo, /java\.put|\{\{/);

  const keyAndPage = convertRequest(
    "/search?searchkey={{java.put('key',key)}}&page={{java.put('page',page)}}",
  );
  assert.match(keyAndPage.requestInfo, /params\.keyWord/);
  assert.match(keyAndPage.requestInfo, /params\.pageIndex/);
  assert.doesNotMatch(keyAndPage.requestInfo, /java\.put|\{\{/);

  const trailingRef = convertRequest("/q?k={{java.put(\"key\",key);key}}&page={{java.put(\"page\",page);page}}");
  assert.match(trailingRef.requestInfo, /params\.keyWord/);
  assert.match(trailingRef.requestInfo, /params\.pageIndex/);
  assert.doesNotMatch(trailingRef.requestInfo, /java\.put|\{\{/);
});

test("书名运行时模板不会被误转成 HTML 或 JSON 选择器", () => {
  assert.equal(
    convertRule("{{book.name}}"),
    '@js:\nreturn String((params.queryInfo.bookName || params.queryInfo.name || "正文"));',
  );
});

test("顶层 JavaScript 模板直接改写而不会被二次包装成字符串", () => {
  const converted = convertRule('@js:\nif ("{{$.status}}" === "public") result = "{{$.username}}";');
  assert.match(converted, /String\(result\.status\)/);
  assert.match(converted, /String\(result\.username\)/);
  assert.doesNotMatch(converted, /return \("@js:/);
});

test("无法移植的 Android API 仍会被明确识别", () => {
  assert.equal(hasUnsupportedLegadoRuntime('@js:\nreturn java.ajax(source.getKey());'), true);
  assert.equal(hasUnsupportedLegadoRuntime('@js:\nreturn JSON.parse(src).data;'), true);
  assert.equal(hasUnsupportedLegadoRuntime('@js:\nreturn baseUrl + "/2";'), true);
  assert.equal(hasUnsupportedLegadoRuntime('@js:\nlet baseUrl = result.url; return baseUrl + "/2";'), false);
});

test("列表开头的 Android 前处理不会吞掉后续 JSONPath", () => {
  const converted = convertRule("<js>java.put('src', src)</js>\n$.data.list[*]", { responseType: "json" });
  assert.equal(converted, "data/list");
  assert.equal(hasUnsupportedLegadoRuntime(converted), false);
});

test("含结果模板的绝对 URL 字段仍可识别为 JSON 详情", () => {
  assert.equal(inferResponseType({
    name: "{{$.user.name}}",
    coverUrl: "https://img.example/{{$.user.cover}}.webp",
    tocUrl: "https://api.example/items/{{$.user.name}}",
  }), "json");
});

test("阅读 book 隐式全局映射到香色 queryInfo", () => {
  const singleChapter = rewriteLegadoJavaScript('@js:\n[{"name": book.name || "正文", "url": baseUrl}]');
  assert.equal(hasUnsupportedLegadoRuntime(singleChapter), false);
  assert.match(singleChapter, /params\.queryInfo\.bookName/);
  assert.match(singleChapter, /params\.responseUrl/);
  const detailUrl = rewriteLegadoJavaScript('@js:\nreturn book.url;');
  assert.equal(hasUnsupportedLegadoRuntime(detailUrl), false);
  assert.match(detailUrl, /params\.queryInfo\.detailUrl/);
  // 局部声明的 book 变量是普通对象，不得改写；校验器会保守地标记为不可移植
  const localBook = rewriteLegadoJavaScript('@js:\nvar book = JSON.parse(result); return book.name;');
  assert.match(localBook, /var book = JSON\.parse\(result\); return book\.name;/);
  assert.equal(hasUnsupportedLegadoRuntime(localBook), true);
});
