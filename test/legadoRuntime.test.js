import assert from "node:assert/strict";
import { test } from "node:test";
import { convertRule } from "../src/selectors.js";
import { injectRuntimeHelpers, RUNTIME_HELPERS } from "../src/legadoRuntime.js";
import { rewriteLegadoJavaScript, hasUnsupportedLegadoRuntime } from "../src/legadoJs.js";

/** 在 Node 里实例化全部助手，模拟香色 @js: 的纯 JS 运行时。 */
function createRuntime() {
  const source = Object.values(RUNTIME_HELPERS).join("\n");
  const body = [
    source,
    "return {",
    "  md5: __xsMd5,",
    "  base64Encode: __xsBase64Encode,",
    "  base64Decode: __xsBase64Decode,",
    "  base64Bytes: __xsBase64Bytes,",
    "  hexDecode: __xsHexDecode,",
    "  hexBytes: __xsHexBytes,",
    "  strToBytes: __xsStrToBytes,",
    "  bytesToStr: __xsBytesToStr,",
    "  timeFormat: __xsTimeFormat,",
    "  timeFormatUTC: __xsTimeFormatUTC,",
    "  jsoup: __xsJsoup,",
    "  jsonPath: __xsJsonPath,",
    "  ruleString: __xsRuleString,",
    "  state: __xsState,",
    "};",
  ].join("\n");
  return new Function(body)();
}

const runtime = createRuntime();

test("__xsMd5 产出与标准 MD5 一致的十六进制摘要", () => {
  assert.equal(runtime.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(runtime.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(runtime.md5("中文测试"), "089b4943ea034acfa445d050c7913e55");
  assert.equal(runtime.md5("hello world 123"), "7f797e9a4e2c3a9b190225d299214ce4");
});

test("__xsBase64 系列 UTF-8 安全并容忍 URL-safe 与无填充输入", () => {
  assert.equal(runtime.base64Decode("5Lit5paH"), "中文");
  assert.equal(runtime.base64Encode("中文"), "5Lit5paH");
  assert.equal(runtime.base64Decode("aGVsbG8gd29ybGQ="), "hello world");
  assert.equal(runtime.base64Decode("aGVsbG8gd29ybGQ"), "hello world");
  // URL-safe 字符与非法 UTF-8 序列不应抛错。
  assert.equal(typeof runtime.base64Decode("aGVsbG8-_w"), "string");
  assert.deepEqual(runtime.base64Bytes("aGVsbG8="), [104, 101, 108, 108, 111]);
  const roundTrip = "混合内容 ABC 123 ～！@";
  assert.equal(runtime.base64Decode(runtime.base64Encode(roundTrip)), roundTrip);
});

test("__xsHexDecode / __xsBytesToStr 处理 UTF-8 多字节", () => {
  assert.equal(runtime.hexDecode("e4b8ade69687"), "中文");
  assert.equal(runtime.hexDecode("31 32 33"), "123");
  assert.deepEqual(runtime.hexBytes("e4b8ad"), [0xe4, 0xb8, 0xad]);
  assert.equal(runtime.bytesToStr(runtime.strToBytes("中文")), "中文");
});

test("__xsTimeFormatUTC 默认 yyyy-MM-dd HH:mm 并支持自定义格式", () => {
  assert.equal(runtime.timeFormatUTC(1700000000, "yyyy-MM-dd HH:mm:ss"), "2023-11-14 22:13:20");
  assert.equal(runtime.timeFormatUTC(1700000000), "2023-11-14 22:13");
  // 本地时区与 UTC 的日期可能相差一天，只断言格式形态。
  assert.match(runtime.timeFormat(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(runtime.timeFormatUTC(0), "");
});

test("__xsJsoup 迷你 DOM 支持常用选择器与取值", () => {
  const doc = runtime.jsoup.parse(
    '<div id="wrap"><p>第一段</p><p class="x">第二段 <b>加粗</b></p></div>'
    + '<div class="panel-readcontent"><p>备用</p></div>',
  );
  const paragraphs = doc.select("#wrap p");
  assert.equal(paragraphs.size(), 2);
  assert.equal(paragraphs.get(0).text(), "第一段");
  assert.equal(paragraphs.get(1).text(), "第二段 加粗");
  assert.equal(paragraphs.get(1).html(), "第二段 <b>加粗</b>");
  assert.equal(doc.select(".panel-readcontent p").first().text(), "备用");
  assert.equal(doc.select("p.x").attr("class"), "x");

  const list = runtime.jsoup.parse('<ul class="list"><li class="item"><a href="/1">A</a></li><li class="item"><a href="/2">B</a></li></ul>');
  assert.equal(list.select("ul.list li.item").last().text(), "B");
  assert.equal(list.select("li > a").size(), 2);
  assert.equal(list.select("li").get(1).select("a").attr("href"), "/2");
  assert.equal(list.select("ul,div").size(), 1);

  const attrDoc = runtime.jsoup.parse('<div><a href="/x/123.html">l</a><img data-src="//c/2.jpg"></div>');
  assert.equal(attrDoc.select('a[href*=123]').size(), 1);
  assert.equal(attrDoc.select('a[href^=/x]').size(), 1);
  assert.equal(attrDoc.select('a[href$=.html]').size(), 1);
  assert.equal(attrDoc.select("img").first().attr("data-src"), "//c/2.jpg");

  // 同一节点重复包装后仍是同一 API（避免裸节点泄漏到调用方）。
  const shared = list.select("li.item");
  assert.equal(shared.get(0).text(), "A");
  assert.equal(list.select(".item").get(0).text(), "A");
  assert.equal(shared.select("a").size(), 2);
});

test("__xsJsonPath 支持 $.a.b[0] 与 [*] 聚合", () => {
  const payload = JSON.stringify({ data: { list: [{ name: "甲" }, { name: "乙" }], total: 2 } });
  assert.equal(runtime.jsonPath(payload, "$.data.total"), "2");
  assert.equal(runtime.jsonPath(payload, "$.data.list[0].name"), "甲");
  assert.equal(runtime.jsonPath(payload, "$.data.list[*].name"), "甲\n乙");
  assert.equal(runtime.jsonPath(payload, "$.data.missing"), "");
  assert.equal(runtime.jsonPath({ direct: true }, "$.direct"), "true");
  assert.equal(runtime.jsonPath("不是 JSON", "$.x"), "");
});

test("__xsRuleString 解析 css@attr 规则并支持 || 回退", () => {
  const html = '<div><h1 class="t">标题</h1><p class="a">作者</p><img src="//c/1.jpg"></div>';
  assert.equal(runtime.ruleString(html, ".t@text"), "标题");
  assert.equal(runtime.ruleString(html, ".missing@text||.a@text"), "作者");
  assert.equal(runtime.ruleString(html, "img@src"), "//c/1.jpg");
  assert.equal(runtime.ruleString(html, ".t@html"), "标题");
  assert.equal(runtime.ruleString(html, ".missing@text"), "");
});

test("injectRuntimeHelpers 按需注入且不污染纯 JS 脚本", () => {
  const plain = "@js:\nreturn String(result).toUpperCase();";
  assert.equal(injectRuntimeHelpers(plain), plain);

  const needs = injectRuntimeHelpers('@js:\nvar d = __xsJsoup.parse(result); return d.select("p").size();');
  assert.match(needs, /function __xsJsoupNode/);
  const evaluated = new Function("config", "params", "result", needs.replace(/^@js:\n/, ""))({}, {}, "<p>1</p><p>2</p>");
  assert.equal(evaluated, 2);

  const state = injectRuntimeHelpers('@js:\n__xsState["k"] = (result);');
  assert.match(state, /var __xsState/);
});

test("rewriteLegadoJavaScript 编译 java.* API 为内嵌助手", () => {
  const rewritten = rewriteLegadoJavaScript(
    "@js:\nvar sign = java.md5Encode(key + java.timeFormatUTC(page*1000));\nvar raw = java.base64Decode(result);\nsign + raw;",
  );
  assert.equal(hasUnsupportedLegadoRuntime(rewritten), false);
  assert.match(rewritten, /function __xsMd5/);
  assert.match(rewritten, /__xsTimeFormatUTC\(params\.pageIndex\s*\*\s*1000\)/);
});

test("rewriteLegadoJavaScript 重命名与运行时参数同名的局部变量", () => {
  const rewritten = rewriteLegadoJavaScript(
    '@js:\nlet config = {};\nlet params = {};\nconfig.host = "https://a.com";\nreturn config.host + String(result);',
  );
  assert.doesNotMatch(rewritten, /\blet config\b/);
  assert.doesNotMatch(rewritten, /\blet params\b/);
  assert.match(rewritten, /__xsLocalConfig/);
  assert.equal(hasUnsupportedLegadoRuntime(rewritten), false);
});

test("result 赋值收尾的脚本补上隐式返回", () => {
  const rewritten = rewriteLegadoJavaScript(
    '@js:if ((String(result.status))=="public"){result=(String(result.username))}else{result=""}',
  );
  assert.equal(hasUnsupportedLegadoRuntime(rewritten), false);
  assert.match(rewritten, /return result;/);
});

test("混合 HTML 字面量与 {{}} 模板的字段编译为 @js 拼接而不是 JSONPath", () => {
  const rule = "<p>{{(t=String(java.getString('$.tag'))).length?'标签：'+t:''}}</p>{{'\\n'}}<p>简介：{{$.summary}}</p>";
  const converted = convertRule(rule, { responseType: "json", warn: () => (m) => {} });
  assert.match(converted, /^@js:\n/);
  assert.match(converted, /"\<p\>" \+ \(function \(\) \{/);
  assert.match(converted, /__xsJsonPath\(result, "\$\.tag"\)/);
  assert.match(converted, /String\(result\.summary\)/);
  assert.doesNotMatch(converted, /java\/getString/);
});

test("模板支持 ##正则 清理后缀和整段 getString 降级", () => {
  const cleanup = convertRule("{{$.serialName##正文卷.|VIP卷.}}", { responseType: "json", warn: () => (m) => {} });
  assert.match(cleanup, /replace\(new RegExp\("正文卷\.\|VIP卷\."/);

  const soleCall = convertRule("@js:java.getString('.kind@text')", { responseType: "json", warn: () => (m) => {} });
  assert.equal(soleCall, "//*[contains(concat(' ', normalize-space(@class), ' '), ' kind ')]/text()");
});

test("jsLib host.call 与登录分流模板回退 config.host", () => {
  assert.equal(convertRule("{{host.call(this)}}/list/{{page}}", { responseType: "json", warn: () => (m) => {} }),
    "@js:\nreturn (String(config.host) + \"/list/\" + String(params.pageIndex));");
  const login = convertRule("{{eval(String(source.loginUrl));GetUL();}}/search.html?q={{key}}", { responseType: "json", warn: () => (m) => {} });
  assert.match(login, /config\.host \+ "\/search\.html\?q=" \+ String\(params\.keyWord\)|config\.host/);
});

test("香色校验器不会误判内嵌助手为阅读运行时语法", () => {
  const rewritten = rewriteLegadoJavaScript(
    "@js:\nvar doc=__xsJsoup.parse(result);\nvar el=doc.select('#chapter-content').first();\nreturn el.html();",
  );
  assert.equal(hasUnsupportedLegadoRuntime(rewritten), false);
  assert.match(rewritten, /function __xsJsoupNode/);
  // 助手源码里不得包含会触发校验的 token。
  for (const [name, source] of Object.entries(RUNTIME_HELPERS)) {
    assert.doesNotMatch(source, /\bjava\.\w|Packages\b|org\.jsoup|<js>|\{\{|\{\$\./, name);
    assert.doesNotMatch(source, /\bsource\.\w/, name);
  }
});
