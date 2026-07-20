import assert from "node:assert/strict";
import test from "node:test";
import { convertRequest, convertRule, hasUnsupportedLegadoRuntime, inferResponseType, rewriteLegadoJavaScript } from "../src/index.js";

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
