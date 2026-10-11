import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  compileQdDetailPlan,
  compileSearchBridgePlan,
  decodeSearchPlan,
  encodeSearchPlan,
  executeSearchPlan,
} from "../src/searchPlan.js";

function response(text, url, headers = {}) {
  const buffer = Buffer.from(text);
  Object.defineProperty(buffer, "httpHeaders", { value: { "content-type": "text/html", ...headers } });
  Object.defineProperty(buffer, "read2xsggResponseUrl", { value: url });
  return buffer;
}

test("搜索表单计划发现 action 并继承 Cookie/令牌", async () => {
  const plan = compileSearchBridgePlan(`@js:
var url = source.getKey();
var html = java.ajax(url);
var action = org.jsoup.Jsoup.parse(html).select('form[name=search]').attr('action');
var token = html.match(/name="_token" value="([^"]+)"/)[1];
var body = "_token=" + token + "&keyword=" + key;
url + action + "," + JSON.stringify({body: body, method: "post"});`, {
    host: "https://example.test",
  });
  assert.equal(plan.kind, "form");
  const calls = [];
  const output = await executeSearchPlan(plan, {
    keyWord: "洪荒 龙族",
    pageIndex: 1,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response('<form name="search" action="/search"><input name="_token" value="csrf-1"></form>', url, { "set-cookie": ["sid=abc; Path=/"] })
        : response("<div class=book>result</div>", url);
    },
  });
  assert.equal(output.toString(), "<div class=book>result</div>");
  assert.equal(calls[1].url, "https://example.test/search");
  assert.match(calls[1].options.body, /_token=csrf-1/);
  assert.match(calls[1].options.body, /keyword=%E6%B4%AA%E8%8D%92%20%E9%BE%99%E6%97%8F/);
  assert.equal(calls[1].headers.Cookie, "sid=abc");
});

test("搜索静态 POST 计划保留关键字并可编码往返", async () => {
  const plan = compileSearchBridgePlan(`https://example.test/search,{
    "body":"show=title&keyboard={{key}}&classid=0",
    "method":"POST"
  }`, { host: "https://example.test" });
  assert.equal(plan.kind, "static");
  let called;
  await executeSearchPlan(plan, {
    keyWord: "abc",
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response("ok", url);
    },
  });
  assert.equal(called.url, "https://example.test/search");
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.body, "show=title&keyboard=abc&classid=0");
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("搜索动态地址计划提取正则发现的隐藏字段", async () => {
  const plan = compileSearchBridgePlan(`<js>
url = source.getVariable()!=""?source.getVariable():source.key;
surl = url+"search";
header = {
  "headers": {"Referer":surl},
  "method": "POST",
  "body": "kw={{key}}&_token="+java.ajax(url).match(/=\\"_token\\" value=\\"(.*?)"/)[1]
}
surl+","+JSON.stringify(header)
</js>`, { host: "https://example.test" });
  assert.equal(plan.kind, "redirect");
  assert.equal(plan.request.bodyTemplate, "kw={{keyWord}}&_token={{_token}}");
  const calls = [];
  await executeSearchPlan(plan, {
    keyWord: "abc",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response('<input type="hidden" name="_token" value="csrf-2">', url, { "set-cookie": ["sid=def; Path=/"] })
        : response("ok", url);
    },
  });
  assert.equal(calls[1].url, "https://example.test/search");
  assert.equal(calls[1].options.body, "kw=abc&_token=csrf-2");
  assert.equal(calls[1].headers.Referer, "https://example.test");
  assert.equal(calls[1].headers.Cookie, "sid=def");
});

test("搜索参数排序 MD5 与请求头签名编译为通用 GET", async () => {
  const rule = `@js:
const sign_key = "search-secret";
const action = "/api/search?";
const headers = { "app-version": "1", "platform": "android" };
var params = { "page": page, "wd": key, "gender": "0" };
params.sign = java.md5Encode(Object.keys(params).sort().reduce((pre, n) => pre + n + "=" + params[n], "") + sign_key);
headers["sign"] = java.md5Encode(Object.keys(headers).sort().reduce((pre, n) => pre + n + "=" + headers[n], "") + sign_key);
action + urlEncode(params);`;
  const plan = compileSearchBridgePlan(rule, { host: "https://example.test" });
  assert.equal(plan.kind, "signed");
  let called;
  await executeSearchPlan(plan, {
    keyWord: "关键字",
    pageIndex: 3,
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response("ok", url);
    },
  });
  const parsed = new URL(called.url);
  assert.equal(parsed.searchParams.get("wd"), "关键字");
  assert.equal(parsed.searchParams.get("page"), "3");
  assert.match(parsed.searchParams.get("sign"), /^[a-f0-9]{32}$/);
  assert.match(called.headers.sign, /^[a-f0-9]{32}$/);
  assert.equal(called.options.method, "GET");
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("搜索最新地址引导计划先解析镜像再请求 HTML 列表", async () => {
  const rule = [
    "@js:",
    'var html = java.ajax("https://landing.example/mirrors");',
    'var soUrl = "https://mirror.example";',
    "var postUrl = " + String.fromCharCode(96) + String.fromCharCode(36) + "{soUrl}/search" + String.fromCharCode(96) + ";",
    'postUrl+"?query={{key}}&page={{page}}"',
  ].join("\n");
  const plan = compileSearchBridgePlan(rule, { host: "https://source.example" });
  assert.equal(plan.kind, "bootstrap");
  const calls = [];
  const output = await executeSearchPlan(plan, {
    keyWord: "abc",
    pageIndex: 2,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response('<a href="https://mirror.example">https://mirror.example</a>', url)
        : response("<div>results</div>", url);
    },
  });
  assert.equal(calls[0].url, "https://landing.example/mirrors");
  assert.equal(calls[1].url, "https://mirror.example/search?query=abc&page=2");
  assert.equal(output.toString(), "<div>results</div>");
});

test("搜索直连计划提交静态表单并跟随 POST 跳转", async () => {
  const rule = [
    "@js:",
    'let base="https://source.example/e/search/";',
    'let url=base+"index.php";',
    'let body="show=title&keyboard="+key+"&tbname=download";',
    "url",
  ].join("\n");
  const plan = compileSearchBridgePlan(rule, { host: "https://source.example" });
  assert.equal(plan.kind, "direct");
  let called;
  await executeSearchPlan(plan, {
    keyWord: "abc",
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response("results", url);
    },
  });
  assert.equal(called.url, "https://source.example/e/search/index.php");
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.body, "show=title&keyboard=abc&tbname=download");
});

test("搜索 AES POST 计划解密列表并复用同一计划请求详情", async () => {
  const tick = String.fromCharCode(96);
  const rule = [
    "time = Math.round(new Date()/1000);",
    'function encode(word){ return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","1234567890abcdef","abcdef1234567890").encryptBase64(word); }',
    `sign = java.md5Encode(${tick}prefix&keyword=\${key}&page=\${page}&time=\${time}${tick}).toString().toUpperCase();`,
    "o = encode(JSON.stringify({product:\"1\",sign:sign,page_num:page,time:time,keyword:key}));",
    "c = JSON.stringify({c:String(o)});",
    "s = {method:\"POST\",body:c};",
    '"https://api.example/search," + JSON.stringify(s);',
  ].join("\n");
  const detail = [
    "time = Math.round(new Date()/1000);",
    'function encode(word){ return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","1234567890abcdef","abcdef1234567890").encryptBase64(word); }',
    `sign = java.md5Encode(${tick}prefix&book_id={{$.book_id}}&time=\${time}${tick}).toString().toUpperCase();`,
    "o = encode(JSON.stringify({product:\"1\",sign:sign,book_id:{{$.book_id}},time:time}));",
    "c = JSON.stringify({c:String(o)});",
    "s = {method:\"POST\",body:c};",
    '"https://api.example/detail," + JSON.stringify(s);',
  ].join("\n");
  const plan = compileSearchBridgePlan(rule, {
    host: "https://source.example",
    detailRule: detail,
  });
  assert.equal(plan.kind, "aes-post-json");
  assert.equal(plan.detail.urlTemplate, "https://api.example/detail");
  const key = Buffer.from("1234567890abcdef");
  const iv = Buffer.from("abcdef1234567890");
  const encrypt = (value) => {
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]).toString("base64");
  };
  const decrypt = (value) => {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(Buffer.from(value, "base64")), decipher.final()]).toString("utf8");
  };
  const calls = [];
  const download = async (url, headers, options) => {
    calls.push({ url, headers, options });
    const body = JSON.parse(options.body);
    const payload = JSON.parse(decrypt(body.c));
    const output = url.endsWith("/detail")
      ? { book: { book_id: payload.book_id, name: "详情" } }
      : { list: [{ book_id: "7", name: "搜索结果" }] };
    return response(JSON.stringify({ data: encrypt(JSON.stringify(output)) }), url, { "content-type": "application/json" });
  };
  const list = await executeSearchPlan(plan, { keyWord: "abc", pageIndex: 2, download });
  assert.deepEqual(JSON.parse(list.toString()).list[0], { book_id: "7", name: "搜索结果" });
  const detailResult = await executeSearchPlan(plan, { value: "7", download });
  assert.deepEqual(JSON.parse(detailResult.toString()).book, { book_id: "7", name: "详情" });
  assert.equal(calls[0].url, "https://api.example/search");
  assert.equal(calls[1].url, "https://api.example/detail");
  assert.equal(JSON.parse(decrypt(JSON.parse(calls[1].options.body).c)).book_id, "7");
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("搜索 WBI 计划先获取导航密钥再生成排序签名", async () => {
  const table = Array.from({ length: 64 }, (_, index) => index).join(",");
  const jsLib = `
const mixinKeyEncTab = [${table}];
function getWbiKeys(){ return JSON.parse(java.ajax("https://api.example/x/web-interface/nav")).data; }
// data.wbi_img is read from the navigation response
`;
  const rule = `@js:
let queryJson = { keyword: key, page: page, page_size: 30, order: '' };
result = 'https://api.example/x/web-interface/wbi/search/all/v2?' + getWbiEnc({keyword:key,page:page,page_size:30,order:''});`;
  const plan = compileSearchBridgePlan(rule, { host: "https://source.example", jsLib });
  assert.equal(plan.kind, "wbi");
  const calls = [];
  const output = await executeSearchPlan(plan, {
    keyWord: "海!盗",
    pageIndex: 3,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response(JSON.stringify({ data: { wbi_img: {
          img_url: "https://i.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
          sub_url: "https://i.example/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png",
        } } }), url, { "content-type": "application/json" })
        : response('{"data":{"result":[]}}', url, { "content-type": "application/json" });
    },
  });
  assert.equal(JSON.parse(output.toString()).data.result.length, 0);
  assert.equal(calls[0].url, "https://api.example/x/web-interface/nav");
  const requested = new URL(calls[1].url);
  assert.equal(requested.searchParams.get("keyword"), "海盗");
  assert.equal(requested.searchParams.get("page"), "3");
  assert.match(requested.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("搜索 JSON 补全计划为结果行生成章节目录地址", async () => {
  const bookListRule = `@js:
var root = JSON.parse(result).root;
var bid = root.bid;
var html = String(java.ajax('https://bootstrap.example/catalog/' + bid));
var scpubKey = html.match(/pubKey":"(\\w+)"/)[1];
var timestamp = ~~(Date.now()/1e3);
var userId = 'u-1';
var sign = java.md5Encode(String(bid) + timestamp + userId + scpubKey);
var params = '&bookId=' + bid + '&user_id=' + userId + '&timestamp=' + timestamp + '&sign=' + sign;
var e = { cata: 'https://content.example/catalog?fixed=1' + params };
Object.assign(root, e);
root;`;
  const plan = compileSearchBridgePlan("/search?q={{key}}&p={{page}}", {
    host: "https://source.example",
    bookListRule,
  });
  assert.equal(plan.kind, "json-enrich");
  const calls = [];
  const output = await executeSearchPlan(plan, {
    keyWord: "书名",
    pageIndex: 2,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response(JSON.stringify({ root: { bid: "7", title: "测试" } }), url, { "content-type": "application/json" })
        : response('{"x":"pubKey":"secret"}', url);
    },
  });
  const row = JSON.parse(output.toString()).data[0];
  assert.equal(row.title, "测试");
  assert.match(row.cata, /^https:\/\/content\.example\/catalog\?fixed=1&bookId=7&user_id=u-1&timestamp=\d+&sign=[a-f0-9]{32}$/);
  assert.equal(calls[0].url, "https://source.example/search?q=%E4%B9%A6%E5%90%8D&p=2");
  assert.equal(calls[1].url, "https://bootstrap.example/catalog/7");
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("QD 签名 JSON 搜索按排序参数生成 3DES 请求头", async () => {
  const jsLib = [
    "const encryptKeys = { headers: {",
    "  QDSign: { key: \"123456789012345678901234\", iv: \"01234567\" },",
    "  QDInfo: { key: \"abcdefghijklmnopqrstuvwx\", iv: String.fromCharCode(0,0,0,0,0,0,0,0) }",
    "} };",
    "let url = \"https://api.example/argus/api/\" + path;",
  ].join("\n");
  const rule = [
    "@js:",
    "QDSign(\"v1/booksearch/searchbooks\", [",
    "  \"keyword=\" + key,",
    "  \"pageIndex=\" + page,",
    "  \"pageSize=20\"",
    "])",
  ].join("\n");
  const plan = compileSearchBridgePlan(rule, { host: "https://source.example", jsLib });
  assert.equal(plan.kind, "qd-sign-json");
  const result = await executeSearchPlan(plan, {
    keyWord: "修仙 传",
    pageIndex: 4,
    download: async (url, headers, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/argus/api/v1/booksearch/searchbooks");
      assert.equal(parsed.searchParams.get("keyword"), "修仙 传");
      assert.equal(parsed.searchParams.get("pageIndex"), "4");
      assert.equal(parsed.searchParams.get("pageSize"), "20");
      assert.equal(headers.QDSign.length % 4, 0);
      assert.equal(headers.QDInfo.length % 4, 0);
      assert.match(headers.tstamp, /^\d+$/);
      assert.equal(options.method, "GET");
      return response('{"Data":{"Items":[]}}', url, { "content-type": "application/json" });
    },
  });
  assert.deepEqual(JSON.parse(result.toString()), { Data: { Items: [] } });
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
});

test("QD 签名详情计划从详情地址提取书籍 ID 并请求详情节点", async () => {
  const jsLib = [
    "const encryptKeys = { headers: {",
    "  QDSign: { key: \"123456789012345678901234\", iv: \"01234567\" },",
    "  QDInfo: { key: \"abcdefghijklmnopqrstuvwx\", iv: String.fromCharCode(0,0,0,0,0,0,0,0) }",
    "} };",
    "let url = \"https://api.example/argus/api/\" + path;",
  ].join("\n");
  const plan = compileQdDetailPlan(
    '@js: java.ajax(QDSign("v2/bookdetail/get", ["bookId=" + bookId])); $.Data',
    { host: "https://source.example", jsLib },
  );
  assert.equal(plan.kind, "qd-sign-json");
  assert.equal(plan.qd.valueMode, "bookId");
  assert.equal(plan.qd.resultPath, "Data");
  assert.deepEqual(decodeSearchPlan(encodeSearchPlan(plan)), plan);
  const body = await executeSearchPlan(plan, {
    value: "https://source.example/book/123456",
    download: async (url, headers) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/argus/api/v2/bookdetail/get");
      assert.equal(parsed.searchParams.get("bookId"), "123456");
      assert.equal(headers.QDSign.length % 4, 0);
      return response('{"Result":0,"Data":{"BookName":"签名详情"}}', url, { "content-type": "application/json" });
    },
  });
  assert.equal(JSON.parse(body.toString()).BookName, "签名详情");
});
