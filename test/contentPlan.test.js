import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { Jimp, JimpMime } from "jimp";
import {
  compileContentBridgePlan,
  compileDownloadTextPlan,
  decodeContentPlan,
  encodeContentPlan,
  executeContentPlan,
  createQdContentPlan,
} from "../src/contentPlan.js";
import { qdDeviceId } from "../src/qdCrypto.js";

function response(text, url, contentType = "text/html", extraHeaders = {}) {
  const buffer = Buffer.from(text);
  Object.defineProperty(buffer, "httpHeaders", { value: { "content-type": contentType, ...extraHeaders } });
  Object.defineProperty(buffer, "read2xsggResponseUrl", { value: url });
  return buffer;
}

test("QD 正文按签名请求解密免费章节，并读取配置声明的 VIP 地址", async () => {
  const jsLib = [
    "const encryptKeys = { headers: {",
    "  QDSign: { key: \"123456789012345678901234\", iv: \"01234567\" },",
    "  QDInfo: { key: \"abcdefghijklmnopqrstuvwx\", iv: String.fromCharCode(0,0,0,0,0,0,0,0) }",
    "} };",
    "function dContentQD(cid, body) {",
    "  let sha1 = \"0\" + aid + cid + \"salt987\";",
    "  let key0 = java.HMacBase64(sha1, \"HMAC-SHA1\", aid).slice(0,-4);",
    "  let key1 = java.base64Decode(\"BjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Ng==\");",
    "  let key3 = java.hexDecodeToByteArray(\"6c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c\" + key2);",
    "  java.createSymmetricCrypto(\"DESede/CBC/PKCS5Padding\", key, iv);",
    "}",
    "let url = \"https://api.example/argus/api/\" + path;",
  ].join("\n");
  const contentRule = [
    "<js>",
    "if (info.isVip) java.ajax(\"https://mirror.example/api/content1.php?bookId=\" + bookId + \"&chapterId=\" + cid);",
    "QDSign(\"v2/bookcontent/safegetcontent\", [\"bookId=\" + bookId, \"chapterId=\" + cid], \"\", true);",
    "dContentQD(cid, body)",
    "</js>",
  ].join("\n");
  const plan = createQdContentPlan({
    host: "https://source.example",
    jsLib,
    contentRule,
  });
  assert.equal(plan.kind, "qd-json-content");
  const chapter = { bookId: "42", cid: "c1", isVip: false };
  const value = "data:chapterId;base64," + Buffer.from(JSON.stringify(chapter)).toString("base64");
  const aid = qdDeviceId(plan.host);
  const key0 = createHmac("sha1", aid).update("0" + aid + chapter.cid + plan.qd.salt).digest("base64").slice(0, -4);
  const key1Text = Buffer.from(plan.qd.key1, "base64").toString("utf8");
  const key2 = createHash("md5").update(key1Text + key0 + aid, "utf8").digest("hex");
  const key = createHash("md5").update(Buffer.from(plan.qd.key3Prefix + key2, "hex")).digest("base64");
  const encrypt = (input, secret) => {
    const cipher = createCipheriv("des-ede3-cbc", Buffer.from(secret, "utf8"), Buffer.alloc(8));
    return Buffer.concat([cipher.update(input), cipher.final()]);
  };
  const body = Buffer.from(JSON.stringify({
    Content: "第一行\r\n第二行",
    Blocks: [{ Sort: 2, Type: "image", Url: "https://cdn.example/illustration.jpg" }],
  }));
  const ciphertext = encrypt(encrypt(body, key0), key);
  const packet = Buffer.concat([Buffer.alloc(8, 1), ciphertext, Buffer.alloc(16, 2)]);
  const calls = [];
  const content = await executeContentPlan(decodeContentPlan(encodeContentPlan(plan)), {
    value,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return packet;
    },
  });
  assert.equal(calls[0].url, "https://api.example/argus/api/v2/bookcontent/safegetcontent?bookId=42&chapterId=c1");
  assert.equal(calls[0].headers.QDSign.length % 4, 0);
  assert.equal(calls[0].headers.QDInfo.length % 4, 0);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(content, "第一行\n第二行\n<img src=\"https://cdn.example/illustration.jpg\">\n");

  const vipValue = "data:chapterId;base64," + Buffer.from(JSON.stringify({ ...chapter, isVip: true })).toString("base64");
  const vipContent = await executeContentPlan(plan, {
    value: vipValue,
    download: async (url, headers, options) => {
      assert.equal(url, "https://mirror.example/api/content1.php?bookId=42&chapterId=c1");
      assert.equal(options.method, "GET");
      return response(JSON.stringify({ content: "VIP 正文" }), url, "application/json");
    },
  });
  assert.equal(vipContent, "VIP 正文");
});

test("文件源下载地址链按声明式选择器逐跳读取最终文本", async () => {
  const plan = compileDownloadTextPlan(
    `text.进入下载@href\n<js>java.ajax(result)</js>\ntext.TXT下载@href`,
    { host: "https://example.test" },
  );
  assert.equal(plan.kind, "download-text");
  assert.equal(plan.steps.length, 2);
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/book/1",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      if (calls.length === 1) return response('<a href="/download/1">进入下载</a>', url);
      if (calls.length === 2) return response('<a href="/book.txt">TXT下载</a>', url);
      return response("第一章\n正文", url, "text/plain");
    },
  });
  assert.equal(content, "第一章\n正文");
  assert.deepEqual(calls.map((item) => item.url), [
    "https://example.test/book/1",
    "https://example.test/download/1",
    "https://example.test/book.txt",
  ]);
  assert.deepEqual(decodeContentPlan(encodeContentPlan(plan)), plan);
});

test("文件源下载脚本中的正则跳转被限制为声明式捕获", async () => {
  const plan = compileDownloadTextPlan(
    String.raw`<js>var dl=String(result).match(/href="([^"]*softdownfree[^"]*)"/)[1];var h=java.ajax(dl);var u=h.match(/href="(https?:\/\/[^\"]+\.txt)"/)[1];u</js>`,
    { host: "https://example.test" },
  );
  assert.equal(plan.steps.length, 2);
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/book/1",
    download: async (url) => {
      calls.push(url);
      if (calls.length === 1) return response('<a href="/softdownfree/1">下载</a>', url);
      if (calls.length === 2) return response('<a href="https://cdn.example/book.txt">第一章</a>', url);
      return response("正文", url, "text/plain");
    },
  });
  assert.equal(content, "正文");
  assert.deepEqual(calls, [
    "https://example.test/book/1",
    "https://example.test/softdownfree/1",
    "https://cdn.example/book.txt",
  ]);
});

test("正文页暴露 JSONP 地址时转换为通用 JSON 字段桥接", async () => {
  const rule = [
    "@js:",
    "var html = String(result);",
    "var d = html.match(/initTxt\\(\"([^\"]+)\"/);",
    "var u = d[1];",
    "var s = String(java.ajax(u));",
    "var j = s.match(/_txt_call\\((\\{[\\s\\S]*\\})\\)/);",
    "var c = j[1].match(/\"content\"\\s*:\\s*\"([\\s\\S]*?)\"/);",
    "var replace = \"replace\";",
    "c[1];",
  ].join("\n");
  const plan = compileContentBridgePlan(rule, { host: "https://example.test" });
  assert.equal(plan.kind, "html-jsonp");
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/1",
    download: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? response('<script>initTxt("https://cdn.example/1.dat")</script>', url)
        : response('_txt_call({"content":"第一行\\nX","replace":{"X":"第二行"}})', url);
    },
  });
  assert.deepEqual(calls, [
    "https://example.test/read/1",
    "https://cdn.example/1.dat",
  ]);
  assert.equal(content, "第一行\n第二行");
});

test("正文多步 POST 计划提取 HTML 字段并读取 JSON 正文", async () => {
  const rule = `@js:
aid = result.match(/article_id = "(\\d+)";/)[1];
cid = result.match(/chapter_id = "(\\d+)";/)[1];
hash = result.match(/hash = "([A-Za-z0-9]+)"/)[1];
u = source.key + "/chapter";
bd = \`id=\${aid}&cid=\${cid}&hash=\${hash}\`;
return JSON.parse(java.post(u, bd, {}).body()).info.content;`;
  const plan = compileContentBridgePlan(rule, {
    host: "https://example.test",
  });
  assert.equal(plan.kind, "html-post-json");
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/1",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response('article_id = "7"; chapter_id = "8"; hash = "abc";', url)
        : response('{"info":{"content":"正文 <p>内容</p>"}}', url, "application/json");
    },
  });
  assert.equal(content, "正文 内容");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, "id=7&cid=8&hash=abc");
});

test("正文令牌计划只执行当前页派生的同源 GET", async () => {
  const plan = compileContentBridgePlan(`@js:
var m = src.match(/token="([^"]+)"/);
var token = m != null ? m[1] : '';
var next = baseUrl + '?challenge=' + encodeURIComponent(token);
var section = java.ajax(next).match(/<section>([\\s\\S]*?)<\\/section>/i);
return section[1];`, {
    host: "https://example.test",
  });
  assert.equal(plan.kind, "html-challenge");
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/1",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return calls.length === 1
        ? response('token="abc"', url, "text/html", { "set-cookie": ["challenge=one; Path=/"] })
        : calls.length === 2
          ? response('token="next"', url, "text/html", { "set-cookie": ["challenge=two; Path=/"] })
          : response("<section><p>第一段</p><p>第二段</p></section>", url);
    },
  });
  assert.equal(content, "第一段\n第二段");
  assert.equal(calls[1].url, "https://example.test/read/1?challenge=abc");
  assert.equal(calls[1].headers.Cookie, "challenge=one");
  assert.equal(calls[2].headers.Cookie, "challenge=two");
});

test("正文编码 ID 计划不把 data URL 当作上游地址", async () => {
  const plan = compileContentBridgePlan(`@js:
cinfo = java.hexDecodeToString(result).split("/");
bid = cinfo[0];
cid = cinfo[1];
result = java.ajax(\`https://api.example.test/content?book_id=\${bid}&chapter_id=\${cid}\`);
result = JSON.parse(result).data;`, {
    host: "https://example.test",
  });
  assert.equal(plan.kind, "encoded-id-json");
  const encoded = Buffer.from("12/34").toString("hex");
  let requested = "";
  const content = await executeContentPlan(plan, {
    value: `data:;base64,${encoded},{"type":"chapter"}`,
    download: async (url, headers, options) => {
      requested = url;
      return response('{"data":"编码正文"}', url, "application/json");
    },
  });
  assert.equal(content, "编码正文");
  assert.equal(requested, "https://api.example.test/content?book_id=12&chapter_id=34");
  assert.deepEqual(decodeContentPlan(encodeContentPlan(plan)), plan);
});

test("正文 AES 计划编译通用 MD5 分钥规则", async () => {
  const rule = `@js:
function d(a, b) {
  b = java.md5Encode(b);
  var iv = b.substring(0, 16);
  var key = b.substring(16);
  return java.aesBase64DecodeToString(a, key, "AES/CBC/PKCS5Padding", iv);
}
eval(result.match(/(d\("[\\s\\S]+?"\))\)?/)[1]);`;
  const plan = compileContentBridgePlan(rule, { host: "https://example.test" });
  assert.equal(plan.kind, "html-aes");
  const rawKey = "chapter-secret";
  const digest = createHash("md5").update(rawKey).digest("hex");
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(digest.slice(16)), Buffer.from(digest.slice(0, 16)));
  const encoded = Buffer.concat([cipher.update("<p>AES 正文</p>"), cipher.final()]).toString("base64");
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/1",
    download: async (url) => response(`d("${encoded}","${rawKey}")`, url),
  });
  assert.equal(content, "AES 正文");
  assert.deepEqual(decodeContentPlan(encodeContentPlan(plan)), plan);
});

test("正文 AES 计划编译三参数 ZeroPadding 规则", async () => {
  const rule = `@js:
function x(bytes, key, iv) {
  return java.createSymmetricCrypto("AES/CBC/ZeroPadding", java.strToBytes(key), java.base64DecodeToByteArray(iv)).decryptStr(java.base64DecodeToByteArray(bytes));
}
eval(result.match(/(x\("(.*)","(.*)","(.*)"\))/)[1]);`;
  const plan = compileContentBridgePlan(rule, { host: "https://example.test" });
  assert.equal(plan.kind, "html-aes");
  const key = Buffer.from("1234567890abcdef");
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const plain = Buffer.from("ZeroPadding 正文");
  const plaintext = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
  const encoded = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/2",
    download: async (url) => response(`x("${encoded}","1234567890abcdef","${iv.toString("base64")}")`, url),
  });
  assert.equal(content, "ZeroPadding 正文");
});

test("正文像素密钥 AES 计划完成取钥、v3 解密和段落复原", async () => {
  const rule = `@js:
var m = src.match(/data-crypto="([^"]+)"/);
var cm = src.match(/data-cid="([^"]+)"/);
var cid = cm[1];
var keyUrl = og + '/api/stats/' + encodeURIComponent(cid) + '/favicon.ico';
var bitmap = Packages.android.graphics.BitmapFactory.decodeStream(stream);
var w = bitmap.getWidth(); var h = bitmap.getHeight();
if (w !== 100 || h !== 36) return '';
var rgb0 = bitmap.getPixel(0, 0); var px0r = (rgb0 >> 16) & 0xFF;
if (px0r !== 0xAB) return '';
for (var i = 1; i <= 32; i++) { var px = i % 8; var py = Math.floor(i / 8); var rgb = bitmap.getPixel(px, py); var b = (rgb >> 16) & 0xFF; }
var Cipher = Packages.javax.crypto.Cipher;
var cipher1 = Cipher.getInstance('AES/CBC/PKCS5Padding');
var contentKey = cipher1.doFinal(encryptedKey);
var Mac = Packages.javax.crypto.Mac; var mac = Mac.getInstance('HmacSHA256');
var shuffled = rawText.split('\\x02');
var od = cd.order; var os = cipher2.doFinal(odDB); var or = JSON.parse(os);
var WM = '\\u200B__WM__\\u200B';
for (var i = 0; i < or.length; i++) { ro[or[i]] = shuffled[i]; }
if (p.indexOf('skip-me') >= 0 && p.indexOf('watermark') >= 0) continue;`;
  const plan = compileContentBridgePlan(rule, { host: "https://example.test" });
  assert.equal(plan.kind, "html-image-key-aes");
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const imageData = Buffer.alloc(100 * 36 * 4, 255);
  imageData[0] = 0xab;
  for (let index = 0; index < key.length; index += 1) {
    const sample = index + 1;
    imageData[(Math.floor(sample / 8) * 100 + (sample % 8)) * 4] = key[index];
  }
  const keyImage = await Jimp.fromBitmap({ data: imageData, width: 100, height: 36 }).getBuffer(JimpMime.png);
  const iv = Buffer.alloc(16, 3);
  const contentKey = Buffer.from("content-key-01234567890123456789");
  const encrypt = (value, vector) => {
    const cipher = createCipheriv("aes-256-cbc", key, vector);
    return Buffer.concat([cipher.update(value), cipher.final()]);
  };
  const encryptedKey = encrypt(contentKey, iv);
  const shuffled = Buffer.from("第一段\x02第二段", "utf8");
  const streamKey = createHmac("sha256", key).update(contentKey).digest();
  const xored = Buffer.from(shuffled.map((value, index) => value ^ streamKey[index % streamKey.length]));
  const orderIv = Buffer.alloc(16, 4);
  const orderData = encrypt(Buffer.from("[0,1]"), orderIv).toString("base64");
  const manifest = {
    v: 3,
    iv: iv.toString("base64"),
    payload: Buffer.concat([encryptedKey, xored]).toString("base64"),
    order: { i: orderIv.toString("base64"), d: orderData },
  };
  const calls = [];
  const content = await executeContentPlan(plan, {
    sourceUrl: "https://example.test/read/1",
    download: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? response(`<div id="crypto-content" data-crypto="${JSON.stringify(manifest).replaceAll('"', '&quot;')}" data-cid="c-1"></div>`, url)
        : response(keyImage, url, "image/png");
    },
  });
  assert.equal(content, "第一段\n第二段");
  assert.deepEqual(calls, [
    "https://example.test/read/1",
    "https://example.test/api/stats/c-1/favicon.ico",
  ]);
});

test("正文加密 JSON 计划从 data 章节参数生成请求并解密响应", async () => {
  const jsLib = `
let secretKey = "chapter-secret-key";
let config = { BASEURL: "https://api.example" };
`;
  const rule = `@js:
let { chapterid } = JSON.parse(java.hexDecodeToString(result));
let r1 = decrypt(java.ajax(URL("/chapter/get_chapter_info", { chapter_id: chapterid }))).data.chapter_info;
result = r1.txt_content;`;
  const plan = compileContentBridgePlan(rule, { host: "https://api.example", jsLib });
  assert.equal(plan.kind, "encrypted-json");
  const key = createHash("sha256").update("chapter-secret-key").digest();
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ data: { chapter_info: { txt_content: "加密正文" } } })),
    cipher.final(),
  ]).toString("base64");
  const value = `data:;base64,${Buffer.from(JSON.stringify({ chapterid: "c-1" })).toString("base64")},{"type":"text"}`;
  let called;
  const content = await executeContentPlan(plan, {
    value,
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response(JSON.stringify({ data: encrypted }), url, "application/json");
    },
  });
  assert.equal(content, "加密正文");
  assert.equal(called.url, "https://api.example/chapter/get_chapter_info");
  assert.equal(called.options.method, "POST");
  assert.match(called.options.body, /^secret_content=/);
  assert.deepEqual(decodeContentPlan(encodeContentPlan(plan)), plan);
});

test("正文加签 AES 计划提取上下文书籍 ID并解密前缀 IV", async () => {
  const rule = `@js:
const signKey = "sign-secret";
const secretKey = "1234567890abcdef";
var params = { "id": String(java.get("bid")), "chapterId": String(baseUrl.split("/").pop()) };
var iv = Arrays.copyOfRange(raw, 0, 16); var body = Arrays.copyOfRange(raw, 16);
requestUrl = "https://api.example/chapter/content?" + urlEncode(params);
decode(JSON.parse(java.ajax(requestUrl)).data.content);`;
  const plan = compileContentBridgePlan(rule, { host: "https://api.example" });
  assert.equal(plan.kind, "signed-aes-json");
  const iv = Buffer.alloc(16, 9);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("1234567890abcdef"), iv);
  const encrypted = Buffer.concat([iv, cipher.update("签名正文", "utf8"), cipher.final()]).toString("base64");
  let called;
  const content = await executeContentPlan(plan, {
    value: "chapter-7",
    sourceUrl: "https://api.example/book/detail?id=book-9",
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response(JSON.stringify({ data: { content: encrypted } }), url, "application/json");
    },
  });
  const parsed = new URL(called.url);
  assert.equal(parsed.searchParams.get("id"), "book-9");
  assert.equal(parsed.searchParams.get("chapterId"), "chapter-7");
  assert.match(parsed.searchParams.get("sign"), /^[a-f0-9]{32}$/);
  assert.equal(content, "签名正文");
  assert.deepEqual(decodeContentPlan(encodeContentPlan(plan)), plan);
});

test("正文七猫式 data 章节参数生成加签 API 请求", async () => {
  const jsLib = `
var QM_KEY = 'sign-secret';
var QM_AES = '1234567890abcdef';
var QM_KS = 'https://api.example';
function qmContent(bid, cid, agent) {
  var p = {id: bid, chapterId: cid};
  if (agent) p.reader_agent = '1';
  return qmUrl(QM_KS, '/api/v1/chapter/content', p);
}
function qmDecode(content) { return content; }`;
  const rule = `@js:
var seg = String(java.base64DecodeToString(result)).split('/');
var bid = String(java.get('bid'));
var res = JSON.parse(java.ajax(qmContent(bid, seg[0], seg[2] == '1')));
qmDecode(res.data.content);`;
  const plan = compileContentBridgePlan(rule, { host: "https://api.example", jsLib });
  assert.equal(plan.kind, "signed-aes-json");
  const iv = Buffer.alloc(16, 3);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("1234567890abcdef"), iv);
  const encrypted = Buffer.concat([iv, cipher.update("七猫正文", "utf8"), cipher.final()]).toString("base64");
  let requested;
  const value = `data:;base64,${Buffer.from("cid-1/md5/1").toString("base64")},{"type":"qm"}`;
  const content = await executeContentPlan(plan, {
    value,
    sourceUrl: "https://api.example/detail?id=book-1",
    download: async (url) => {
      requested = new URL(url);
      return response(JSON.stringify({ data: { content: encrypted } }), url, "application/json");
    },
  });
  assert.equal(requested.searchParams.get("id"), "book-1");
  assert.equal(requested.searchParams.get("chapterId"), "cid-1");
  assert.equal(requested.searchParams.get("reader_agent"), "1");
  assert.equal(content, "七猫正文");
});

test("正文十六进制 AES POST 路径计划携带详情书籍 ID", async () => {
  const jsLib = `
AES_KEY = '1234567890abcdef'
AES_IV = 'fedcba0987654321'
function buildRequestUrl(cmd, data) { return \`/client/\${cmd},body\`; }`;
  const rule = `@js:
JSON.parse(decrypt(java.ajax(source.bookSourceUrl + buildRequestUrl(1111, {
  bookId: java.get("bid"), chapterId: baseUrl.split("com/")[1]
}))).chapterInfo.content`;
  const plan = compileContentBridgePlan(rule, { host: "https://api.example", jsLib });
  assert.equal(plan.kind, "path-aes-json");
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("1234567890abcdef"), Buffer.from("fedcba0987654321"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ chapterInfo: { content: "路径正文" } }), "utf8"), cipher.final()]).toString("hex");
  let called;
  const content = await executeContentPlan(plan, {
    value: "https://example.com/cid-8",
    sourceUrl: "https://api.example/detail?id=book-8",
    download: async (url, headers, options) => {
      called = { url, headers, options };
      return response(JSON.stringify({ data: encrypted }), url, "application/json");
    },
  });
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.body.length % 32, 0);
  assert.equal(content, "路径正文");
});
