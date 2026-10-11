import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import {
  compileChapterCatalogPlan,
  decodeChapterCatalogPlan,
  encodeChapterCatalogPlan,
  executeChapterCatalogPlan,
} from "../src/chapterPlan.js";

function response(text, url, contentType = "application/json") {
  const buffer = Buffer.from(text);
  Object.defineProperty(buffer, "httpHeaders", { value: { "content-type": contentType } });
  Object.defineProperty(buffer, "read2xsggResponseUrl", { value: url });
  return buffer;
}

test("章节目录计划把详情 URL 提取为 POST JSON 目录并生成章节 URL", async () => {
  const rules = {
    chapterList: String.raw`@js:
var bid = baseUrl.match(/read\/(\d+)/)[1];
var resp = java.post(source.getKey()+"/novel/clist/", "bid="+bid, {});
var json = JSON.parse(resp.body()).data;
for(var i=json.length - 1; i >= 0; i--){
  if(json[i].ctype === "1"){ json.splice(i, 1); continue; }
  page = json[i]["ordernum"];
  json[i]["url"] = source.getKey() + "/read/" + bid + "/p" + page + ".html";
}
json;`,
    chapterName: "title",
    chapterUrl: "url",
  };
  const plan = compileChapterCatalogPlan(rules, { host: "https://example.test" });
  assert.equal(plan.kind, "json-chapters");
  const calls = [];
  const output = await executeChapterCatalogPlan(plan, {
    sourceUrl: "https://example.test/read/42",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return response(JSON.stringify({ data: [
        { title: "卷首", ctype: "1", ordernum: 0 },
        { title: "第一章", ctype: "0", ordernum: 1 },
      ] }), url);
    },
  });
  assert.equal(calls[0].url, "https://example.test/novel/clist/");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "bid=42");
  assert.deepEqual(output.data, [{ title: "第一章", url: "https://example.test/read/42/p1.html" }]);
});

test("章节目录计划解码 data Base64 参数并生成不请求站点的 data 章节地址", async () => {
  const chapterScript = [
    "<js>",
    'bid = java.base64Decode(baseUrl.split(",")[1]);',
    "result = java.ajax(buildRequest(`${backend}/69/catalog?book_id=${bid}`));",
    "JSON.parse(result).list.reduce((arr, item) => {",
    "  title = item.chaptername;",
    '  url = item.articleid + "/" + item.chapterid;',
    '  arr.push(JSON.stringify({ title, url: `data:;base64,${java.base64Encode(url)},{"type":"chapter"}` }));',
    "  return arr;",
    "}, []);",
    "</js>",
  ].join("\n");
  const rules = {
    chapterList: chapterScript,
    chapterName: "$.title",
    chapterUrl: "$.url",
  };
  const plan = compileChapterCatalogPlan(rules, {
    host: "https://books.example",
    jsLib: 'const backend = "https://api.example";',
  });
  assert.equal(plan.input, "value");
  const value = `data:;base64,${Buffer.from("77").toString("base64")},{"type":"book"}`;
  let requested = "";
  const output = await executeChapterCatalogPlan(plan, {
    value,
    download: async (url) => {
      requested = url;
      return response(JSON.stringify({ list: [{ chaptername: "第一节", articleid: "a", chapterid: "b" }] }), url);
    },
  });
  assert.equal(requested, "https://api.example/69/catalog?book_id=77");
  assert.equal(output.data[0].title, "第一节");
  assert.equal(output.data[0].url, `data:;base64,${Buffer.from("a/b").toString("base64")},{"type":"chapter"}`);
  assert.deepEqual(decodeChapterCatalogPlan(encodeChapterCatalogPlan(plan)), plan);
});

test("加密分组章节目录计划解密分组并保留章节状态", async () => {
  const rules = {
    chapterList: `<js>
let bookid = java.hexDecodeToString(result);
let url = URL("/chapter/list", { book_id: bookid });
let response = decrypt(java.ajax(url)).data;
response.chapter_list_group.map(group => group.chapter_list.map(chapter => chapter));
</js>`,
  };
  const jsLib = `
let secretKey = "catalog-secret-key";
let config = { BASEURL: "https://api.example" };
`;
  const plan = compileChapterCatalogPlan(rules, { host: "https://api.example", jsLib });
  assert.equal(plan.kind, "encrypted-json-chapters");
  const key = createHash("sha256").update("catalog-secret-key").digest();
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ data: {
      division_list: [{ division_id: 1, division_name: "第一卷" }],
      chapter_list_group: [{ division_id: 1, chapter_list: [{ chapter_id: "c1", chapter_title: "第一章", is_paid: "1", auth_access: "0" }] }],
    } })),
    cipher.final(),
  ]).toString("base64");
  const value = `data:;base64,${Buffer.from("book-1").toString("base64")},{"type":"text"}`;
  const output = await executeChapterCatalogPlan(plan, {
    value,
    download: async (url) => response(JSON.stringify({ data: encrypted }), url),
  });
  assert.equal(output.data[0].title, "第一卷 · 第一章");
  assert.equal(output.data[0].isVip, true);
  assert.deepEqual(decodeChapterCatalogPlan(encodeChapterCatalogPlan(plan)), plan);
});

test("声明式 JSON 目录的 AES-CBC Base64 章节地址由通用计划解码", async () => {
  const plan = compileChapterCatalogPlan({
    chapterList: "$.data.list[*]",
    chapterName: "$.chapterName",
    chapterUrl: String.raw`$.path
@js:java.aesBase64DecodeToString(result,"f041c49714d39908","AES/CBC/PKCS5Padding","0123456789abcdef");`,
  }, { host: "https://api.example" });
  assert.equal(plan.kind, "json-chapters");
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("f041c49714d39908"), Buffer.from("0123456789abcdef"));
  const encodedPath = Buffer.concat([cipher.update("https://cdn.example/chapter/1", "utf8"), cipher.final()]).toString("base64");
  const output = await executeChapterCatalogPlan(plan, {
    sourceUrl: "https://api.example/novel/1/chapters",
    download: async (url) => response(JSON.stringify({ data: { list: [{ chapterName: "第一章", path: encodedPath }] } }), url),
  });
  assert.deepEqual(output.data, [{ title: "第一章", url: "https://cdn.example/chapter/1" }]);
});

test("多请求 JSON 目录按集合 ID 并发展开章节", async () => {
  const plan = compileChapterCatalogPlan({
    chapterList: String.raw`<js>
result = JSON.parse(result)
for (var i = 0; i < result.length; i++) {
  let chapter = JSON.parse(java.ajax("https://api.example/collection?collectionId=" + result[i]["id"].match(/\d+/)[0]))
  result[i].items = chapter
}
for (var i = 0; i < result.length; i++) {
  result[i].id = "https://api.example/chapter/" + result[i].id
}
result = result
</js>`,
    chapterName: "displayName",
    chapterUrl: "id",
    updateTime: "updatedTime",
  }, {
    host: "https://reader.example",
    tocUrl: String.raw`titleId<js>
result = "https://api.example/title?titleId=" + result
</js>`,
  });
  assert.equal(plan.kind, "json-chapters-batch");
  const calls = [];
  const output = await executeChapterCatalogPlan(plan, {
    sourceUrl: "https://reader.example/title/42",
    download: async (url) => {
      calls.push(url);
      if (url.includes("/title?")) return response(JSON.stringify([{ id: "collection-7" }]), url);
      return response(JSON.stringify([{ id: "88", displayName: "第一章", updatedTime: "今天" }]), url);
    },
  });
  assert.deepEqual(calls, [
    "https://api.example/title?titleId=42",
    "https://api.example/collection?collectionId=7",
  ]);
  assert.deepEqual(output.data, [{
    title: "第一章",
    url: "https://api.example/chapter/88",
    updateTime: "今天",
  }]);
});

test("分页 JSON 目录按总页数并发请求并合并章节", async () => {
  const plan = compileChapterCatalogPlan({
    chapterList: String.raw`<js>
function menu(id,page){
  res=java.post("https://api.example/menu",JSON.stringify({"id":id,"page":page,"sort":"asc"}),{})
  return JSON.parse(res.body()).data
}
first=menu(id,1)
all_list=first.list
for(var i=2;i<=first.total_page;i++){ all_list.push.apply(all_list,menu(id,i).list) }
all_list.map((item)=>{ item.url="https://api.example/chapter/"+item.id })
all_list
</js>`,
    chapterName: "title",
    chapterUrl: "url",
  }, { host: "https://reader.example" });
  assert.equal(plan.kind, "json-chapters-pages");
  const calls = [];
  const output = await executeChapterCatalogPlan(plan, {
    sourceUrl: "https://reader.example/novels/42",
    download: async (url, headers, options) => {
      calls.push({ url, body: options.body });
      const page = JSON.parse(options.body).page;
      return response(JSON.stringify({
        data: { total_page: 2, list: [{ id: String(page), title: `第${page}章` }] },
      }), url);
    },
  });
  assert.deepEqual(calls.map((item) => JSON.parse(item.body).page), [1, 2]);
  assert.deepEqual(output.data, [
    { title: "第1章", url: "https://api.example/chapter/1" },
    { title: "第2章", url: "https://api.example/chapter/2" },
  ]);
});

test("QD JSON 目录按卷展开章节并保留付费标记", async () => {
  const jsLib = [
    "const encryptKeys = { headers: {",
    "  QDSign: { key: \"123456789012345678901234\", iv: \"01234567\" },",
    "  QDInfo: { key: \"abcdefghijklmnopqrstuvwx\", iv: String.fromCharCode(0,0,0,0,0,0,0,0) }",
    "} };",
    "let url = \"https://api.example/argus/api/\" + path;",
  ].join("\n");
  const rules = {
    chapterList: [
      "@js:",
      "bookId = java.hexDecodeToString(result);",
      "JSON.parse(java.ajax(QDSign(\"v1/chapterlist/chapterlist\", [\"bookId=\" + bookId]))).Data;",
      "$.Volumes; $.Chapters.slice(1);",
    ].join("\n"),
  };
  const plan = compileChapterCatalogPlan(rules, { host: "https://source.example", jsLib });
  assert.equal(plan.kind, "qd-json-chapters");
  const value = "data:bookId;base64," + Buffer.from("1283").toString("base64");
  const calls = [];
  const result = await executeChapterCatalogPlan(plan, {
    value,
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      return response(JSON.stringify({ Data: {
        Volumes: [
          { VolumeCode: "v1", VolumeName: "第一卷" },
          { VolumeCode: "v2", VolumeName: "第二卷" },
        ],
        Chapters: [
          { N: "目录摘要", C: "intro", Vc: "v1" },
          { N: "第一章", C: "c1", Vc: "v1", V: 0, P: 0, W: 100, T: 1700000000 },
          { N: "第二章", C: "c2", Vc: "v2", V: 1, P: 1, W: 200, T: 1700000001 },
        ],
      } }), url);
    },
  });
  assert.equal(calls[0].url, "https://api.example/argus/api/v1/chapterlist/chapterlist?bookId=1283");
  assert.equal(calls[0].headers.QDSign.length % 4, 0);
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(result.data.map((item) => [item.title, item.isVolume, item.isVip, item.isPay]), [
    ["第一卷", true, false, false],
    ["第一章", false, false, false],
    ["第二卷", true, false, false],
    ["第二章", false, true, true],
  ]);
  const chapter = JSON.parse(Buffer.from(result.data.at(-1).url.split(",")[1], "base64").toString("utf8"));
  assert.deepEqual(chapter, {
    source: "qd",
    cid: "c2",
    isVip: true,
    isPay: true,
    ccid: null,
    cbid: null,
    bookId: "1283",
  });
  assert.deepEqual(decodeChapterCatalogPlan(encodeChapterCatalogPlan(plan)), plan);
});

test("DES ECB 目录计划解密请求并把响应正文封装为 data 章节", async () => {
  const rules = {
    chapterList: String.raw`$.returnObject[0].children||$.returnObject@js:
var account='';
var pwd='';
var wapToken='';
var CryptoJS = CryptoJS;
function encryptByDES(message,key){
  var keyHex=CryptoJS.enc.Utf8.parse(key);
  return CryptoJS.DES.encrypt(message,keyHex,{mode:CryptoJS.mode.ECB,padding:CryptoJS.pad.Pkcs7}).toString();
}
var deskey = wapToken||'web@hzlq';
function getPostUrl(data,type){
  var url='https://api.example/service.do,';
  var md5Key='library_2016@hzlq';
  return url;
}
getPostUrl(data,'qryChapterList');`,
    chapterName: "$.chapterName",
  };
  const requestRule = String.raw`$.resourceId@js:
var data={timeStamp:Date.now(),resourceId:result,pageSize:10000,pageNum:1};
getPostUrl(data,'qryChapterList');`;
  const plan = compileChapterCatalogPlan(rules, {
    host: "https://reader.example",
    requestRule,
    contentRule: "$.returnObject[0].content@js:result",
  });
  assert.equal(plan.kind, "des-json-chapters");
  const calls = [];
  const output = await executeChapterCatalogPlan(plan, {
    value: "https://reader.example/book/42",
    download: async (url, headers, options) => {
      calls.push({ url, headers, options });
      const params = new URLSearchParams(options.body);
      assert.equal(params.get("cmd"), "qryChapterList");
      const envelope = JSON.parse(params.get("value"));
      const decipher = await import("node:crypto").then(({ createDecipheriv }) => (
        createDecipheriv("des-ede3-ecb", Buffer.from("web@hzlq".repeat(3)), null)
      ));
      const request = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8"));
      assert.equal(request.resourceId, "42");
      assert.equal(request.pageSize, 10000);
      return response(JSON.stringify({
        returnObject: [{ children: [{ chapterName: "第一章", content: "正文内容" }] }],
      }), url);
    },
  });
  assert.equal(calls[0].url, "https://api.example/service.do");
  assert.equal(output.data[0].title, "第一章");
  assert.equal(output.data[0].url, `data:;base64,${Buffer.from("正文内容").toString("base64")},{"type":"text"}`);
});
