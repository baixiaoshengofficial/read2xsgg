import test from "node:test";
import assert from "node:assert/strict";
import { compileChapterBridgePlan, executeBridgePlan } from "../src/bridgePlan.js";
import { compileContextualChapterUrl } from "../src/chapterUrlPlan.js";
import { executeXbsJavaScriptRule } from "../src/xbsRuntime.js";

test("复杂章节 URL 脚本通过有限目录上下文编译并按香色规则运行", () => {
  const rule = [
    "@js:",
    'var cid = java.getString("$.cid");',
    "var raw = java.ajax(baseUrl);",
    "var menu = JSON.parse(String(raw));",
    'source.setVariable(JSON.stringify({last:cid}));',
    "var state = JSON.parse(source.getVariable());",
    'return menu.data.chapterUrl + "?id=" + cid + "&sig=" + java.md5Encode(signature(menu.data.token + state.last));',
  ].join("\n");
  const jsLib = [
    'var alphabet = "abc";',
    "function signature(value) { var output = \"\"; for (var i = 0; i < value.length; i++) output += alphabet.charAt(i % alphabet.length); return output; }",
  ].join("\n");
  const compiled = compileContextualChapterUrl(rule, jsLib);
  assert.ok(compiled);
  assert.deepEqual(compiled.itemPaths, ["cid"]);
  assert.deepEqual(compiled.contextPaths, ["data/chapterUrl", "data/token"]);

  const plan = compileChapterBridgePlan({
    host: "https://example.test",
    responseFormatType: "json",
    list: "data/chapters",
    title: "title",
    url: "outerHtml",
  }, { contextualRows: compiled });
  const responseUrl = "https://example.test/book/catalog";
  const result = executeBridgePlan(JSON.stringify({
    data: {
      chapters: [{ cid: "c-42", title: "第一章", discarded: "not projected" }],
      chapterUrl: "https://example.test/api/chapter",
      token: "metadata-token",
      unrelated: "not projected",
    },
  }), responseUrl, plan);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].title, "第一章");
  assert.equal(result.data[0].url, "");
  assert.deepEqual(result.data[0].__read2xsggItem, { cid: "c-42" });
  assert.deepEqual(result.data[0].__read2xsggContext.payload, {
    data: {
      chapterUrl: "https://example.test/api/chapter",
      token: "metadata-token",
    },
  });
  assert.equal(result.data[0].__read2xsggContext.requestUrl, responseUrl);

  result.data[0].url = executeXbsJavaScriptRule(compiled.rule, {
    config: { host: "https://example.test" },
    params: {
      responseUrl,
      queryInfo: { detailUrl: "https://example.test/book" },
    },
    result: result.data[0],
  });
  assert.match(result.data[0].url, /^https:\/\/example\.test\/api\/chapter\?id=c-42&sig=[a-f0-9]{32}$/);
  assert.equal(result.data[0].__read2xsggContext.state, JSON.stringify({ last: "c-42" }));
});

test("复杂章节 URL 规则拒绝不受限运行时能力", () => {
  assert.equal(compileContextualChapterUrl(
    '@js:var data = JSON.parse(String(java.ajax(baseUrl))); return java.getString("$.cid");',
    "function signature(value) { return process.env.SECRET; }",
  ), null);
  assert.equal(compileContextualChapterUrl(
    '@js:var data = JSON.parse(String(java.ajax(baseUrl))); return java.connect(baseUrl);',
  ), null);
});
