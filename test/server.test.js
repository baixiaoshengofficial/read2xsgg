import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Jimp, JimpMime } from "jimp";
import { createAppServer, decodeXbs, jmMirrorCandidates, mwwzCategoryEntries, normalizeEmbeddedSourceUrl, serverConfig, sourceUrlCandidates } from "../src/index.js";

const source = {
  bookSourceName: "在线示例",
  bookSourceUrl: "https://example.com",
  searchUrl: "/search?q={{key}}&page={{page}}",
  ruleSearch: {
    bookList: ".book-list > li",
    name: "h3 > a",
    author: ".author",
    bookUrl: "h3 > a@href",
  },
  ruleBookInfo: { name: "h1", intro: ".intro" },
  ruleToc: { chapterList: "#list dd", chapterName: "a", chapterUrl: "a@href" },
  ruleContent: { content: "#content" },
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("手拼阅读源地址可还原为完整 URL", () => {
  assert.equal(
    normalizeEmbeddedSourceUrl("www.yckceo.com/yuedu/shuyuans/json/id/1193.json.xbs"),
    "https://www.yckceo.com/yuedu/shuyuans/json/id/1193.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("https/www.yckceo.com/a.json.xbs"),
    "https://www.yckceo.com/a.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("https://www.yckceo.com/a.json.xbs"),
    "https://www.yckceo.com/a.json",
  );
  assert.equal(
    normalizeEmbeddedSourceUrl("http%3A%2F%2F127.0.0.1%3A9%2Fa.json"),
    "http://127.0.0.1:9/a.json",
  );
});

test("yckceo 复数接口解析失败时可回退到直接 JSON 接口", () => {
  assert.deepEqual(
    sourceUrlCandidates("https://www.yckceo.com/yuedu/shuyuans/json/id/6444.json"),
    [
      "https://www.yckceo.com/yuedu/shuyuans/json/id/6444.json",
      "https://www.yckceo.com/yuedu/shuyuan/json/id/6444.json",
    ],
  );
  assert.deepEqual(sourceUrlCandidates("https://example.com/source.json"), ["https://example.com/source.json"]);
});

test("在线 URL 接口输出 XBS、JSON、缓存标识和健康状态", async (context) => {
  const upstreamRequests = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(source));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: true, cacheTtlMs: 60_000 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const health = await fetch(`${appBase}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const sourceUrl = `${upstreamBase}/source.json?token=abc`;
  const xbsResponse = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(sourceUrl)}`);
  assert.equal(xbsResponse.status, 200);
  assert.equal(xbsResponse.headers.get("content-type"), "application/octet-stream");
  assert.equal(xbsResponse.headers.get("x-converted-count"), "1");
  const etag = xbsResponse.headers.get("etag");
  assert.ok(etag);
  const converted = JSON.parse(decodeXbs(Buffer.from(await xbsResponse.arrayBuffer())).toString("utf8"));
  assert.equal(converted["在线示例"].sourceName, "在线示例");

  const pathSourceUrl = `${upstreamBase}/source.json?token=path`;
  const pathResponse = await fetch(`${appBase}/url/${encodeURIComponent(pathSourceUrl)}.xbs`);
  assert.equal(pathResponse.status, 200);
  assert.ok(pathResponse.url.endsWith(".xbs"));
  assert.equal(upstreamRequests.at(-1), "/source.json?token=path");
  assert.equal(
    JSON.parse(decodeXbs(Buffer.from(await pathResponse.arrayBuffer())).toString("utf8"))["在线示例"].sourceName,
    "在线示例",
  );

  // /xbs/{host}{path}.xbs — 去掉 https:// 后直接拼接
  const upstreamUrl = new URL(`${upstreamBase}/source.json`);
  const easyResponse = await fetch(`${appBase}/xbs/${upstreamUrl.host}${upstreamUrl.pathname}.xbs`);
  assert.equal(easyResponse.status, 200);
  assert.equal(upstreamRequests.at(-1), "/source.json");
  assert.equal(
    JSON.parse(decodeXbs(Buffer.from(await easyResponse.arrayBuffer())).toString("utf8"))["在线示例"].sourceName,
    "在线示例",
  );

  // /x.xbs?u=完整地址 — 路径带 .xbs，查询参数通常无需编码
  const shortQuery = await fetch(`${appBase}/x.xbs?u=${upstreamBase}/source.json?token=short`);
  assert.equal(shortQuery.status, 200);
  assert.equal(upstreamRequests.at(-1), "/source.json?token=short");

  const notModified = await fetch(`${appBase}/convert?url=${encodeURIComponent(sourceUrl)}`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(notModified.status, 304);

  const jsonResponse = await fetch(`${appBase}/j/${upstreamUrl.host}${upstreamUrl.pathname}`);
  assert.equal(jsonResponse.status, 200);
  const debug = await jsonResponse.json();
  assert.equal(debug.sources["在线示例"].sourceName, "在线示例");
  assert.ok(Array.isArray(debug.warnings));
});

test("在线抓取默认禁止访问本机和内网地址", async (context) => {
  const app = createAppServer({ config: { ...serverConfig({}), allowPrivateNetworks: false } });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/convert?url=${encodeURIComponent("http://127.0.0.1/source.json")}`);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /内网地址/);
});

test("图片代理地址从本次 HTTPS 转换请求自动推导", async (context) => {
  const encryptedComicSource = {
    ...source,
    bookSourceName: "加密漫画",
    bookSourceType: 2,
    ruleContent: {
      content: "@js:JSON.parse(src).data.images.map(x => `<img src=\"${x.url}\">`).join('\\n');",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0B6666A0-BB59-1381-B746-a0E4C9AC'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
  };
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(encryptedComicSource));
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({ config: { ...serverConfig({}), allowPrivateNetworks: true } });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(`${upstreamBase}/source.json`)}`, {
    headers: { "X-Forwarded-Host": "xs.example.com", "X-Forwarded-Proto": "https" },
  });
  assert.equal(response.status, 200);
  const converted = JSON.parse(decodeXbs(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.match(converted["加密漫画"].chapterContent.content, /https:\/\/xs\.example\.com\/image\/mwwz-aes\?url=/);
});

test("在线转换会发现并写入可用的漫蛙镜像", async (context) => {
  const mwwzSource = {
    ...source,
    bookSourceName: "漫蛙镜像测试",
    bookSourceUrl: "https://www.mwwz.cc",
    bookSourceType: 2,
    loginUrl: "const url = 'https://www.manwake.cc/';",
    ruleContent: {
      content: "@js:JSON.parse(src).data.images.map(x => `<img src=\"${x.url}\">`).join('\\n');",
      imageDecode: "var iv = result.slice(0, 16); var key = java.strToBytes('0B6666A0-BB59-1381-B746-a0E4C9AC'); var cipher = java.createSymmetricCrypto(\"AES/CBC/PKCS5Padding\", key, iv); return cipher.decrypt(result.slice(16));",
    },
    ruleExplore: {
      bookList: "$.data.list[*]", name: "$.title", author: "$.author", intro: "$.intro",
      kind: "$.tags", bookUrl: "{{Url()}}/api/comic/{{$.url##[^\\d]}}", coverUrl: "$.pic",
    },
  };
  let upstreamBase = "";
  const upstream = createServer((request, response) => {
    if (request.url === "/release") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<div class="btnBox"><a href="${upstreamBase}/mirror">可用镜像</a></div>`);
      return;
    }
    if (request.url?.startsWith("/api/search")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { list: [] } }));
      return;
    }
    if (request.url === "/cate") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<div class="tag-container"><a data-value="" href="/cate">全部</a><a data-value="热血" href="/cate/hotblooded">热血</a></div>');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(mwwzSource));
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: true, mwwzDiscoveryUrl: `${upstreamBase}/release` },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(`${upstreamBase}/source.json`)}`);
  assert.equal(response.status, 200);
  const converted = JSON.parse(decodeXbs(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  const mirror = converted["漫蛙镜像测试"];
  assert.equal(mirror.sourceUrl, upstreamBase);
  assert.deepEqual(mirror.httpHeaders, {
    "User-Agent": "Mozilla/5.0 (Linux; Android 9) Mobile Safari/537.36",
    Referer: `${upstreamBase}/`,
  });
  assert.deepEqual(Object.keys(mirror.bookWorld), ["全部", "热血"]);
  assert.equal(mirror.bookWorld["热血"].list, "data/list");
  assert.match(mirror.bookWorld["热血"].requestInfo, /config\.host/);
  assert.match(mirror.bookWorld["热血"].requestInfo, /JSON\.parse/);
  assert.match(mirror.bookWorld["热血"].requestInfo, /params\.pageIndex/);
  assert.match(mirror.bookWorld["热血"].requestInfo, /"Content-Type":"application\/json"/);
  assert.equal(mirror.bookWorld["热血"].moreKeys.pageSize, 10);
});

test("漫蛙分类页只提取可调用的漫画标签", () => {
  const entries = mwwzCategoryEntries(`
    <a data-value="1" href="javascript:void(0)">不应出现</a>
    <a href="/cate" data-value="">全部</a>
    <a href="/cate/hotblooded" data-value="热血">热血 &amp; 冒险</a>
    <a href="/cate/hotblooded" data-value="热血">重复</a>
  `);
  assert.deepEqual(entries, [
    { title: "全部", path: "/cate", tag: "" },
    { title: "热血 & 冒险", path: "/cate/hotblooded", tag: "热血" },
  ]);
});

test("禁漫在线转换固化可用镜像和动态分类", async (context) => {
  let upstreamBase = "";
  const jmSource = {
    bookSourceName: "禁漫在线测试",
    bookSourceUrl: "https://jmcomicqa.cc",
    bookSourceType: 2,
    loginUrl: "defaultIntlLinks = ['https://blocked.example'];",
    exploreUrl: `@js:var categories = [["全部", "albums?o={key}&page="], ["短篇", "albums/short?o={key}&page=<,{{page}}>"]];`,
    searchUrl: "{{Get('url')}}/search/photos?search_query={{key}}&page={{page}}",
    ruleSearch: {
      bookList: ".list-col||.list-item",
      name: ".video-title@text",
      bookUrl: "tag.a.0@href",
      coverUrl: "img@data-original||img@src",
    },
    ruleExplore: [],
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: ".reading", chapterName: "text", chapterUrl: "href" },
    ruleContent: {
      content: ".thumb-overlay-albums@img@data-original",
      imageDecode: "var bookId=1; var imgId=2; var img=BitmapFactory.decodeByteArray(result,0,result.length); var canvas=new Canvas(img); photos;",
    },
  };
  const upstream = createServer((request, response) => {
    if (request.url === "/release") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<div class="international"><span>${upstreamBase}</span></div>`);
      return;
    }
    if (request.url?.startsWith("/albums?")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<div class="list-col"><a href="/album/1"><div class="video-title">漫画一</div></a></div>');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([jmSource]));
  });
  upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: true, jmDiscoveryUrl: `${upstreamBase}/release` },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const response = await fetch(`${appBase}/convert.xbs?url=${encodeURIComponent(`${upstreamBase}/source.json`)}`);
  assert.equal(response.status, 200);
  const converted = JSON.parse(decodeXbs(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  const jm = converted["禁漫在线测试"];
  assert.equal(jm.sourceUrl, upstreamBase);
  assert.equal(jm.httpHeaders.Referer, `${upstreamBase}/`);
  assert.deepEqual(Object.keys(jm.bookWorld), ["全部", "短篇"]);
  assert.equal(jm.bookWorld["全部"].moreKeys.pageSize, 80);
  assert.match(jm.bookWorld["全部"].requestInfo, /albums\?o=mr&page=/);
  assert.match(jm.bookWorld["全部"].list, /list-col/);
  assert.match(jm.chapterList.requestInfo, /config\.host/);
  assert.doesNotMatch(jm.chapterList.list, /java\.|book\.type/);
  assert.match(jm.chapterList.url, /config\.host/);
  assert.doesNotMatch(jm.chapterList.url, /shunt|Get\(/);
});

test("禁漫镜像候选兼容发布页无协议域名和源内备用地址", () => {
  assert.deepEqual(jmMirrorCandidates(
    '<div><span>jm.example.com</span><span>https://jm2.example.com/path</span></div>',
    "https://release.example.com/",
    "const fallback = 'https://jm3.example.com/path';",
  ), ["https://jm.example.com", "https://jm2.example.com", "https://jm3.example.com"]);
});

test("DNS 代理兼容开关不会放行直接填写的保留网段 IP", async (context) => {
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: false, allowDnsProxyNetworks: true },
  });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/convert?url=${encodeURIComponent("http://198.18.0.1/source.json")}`);
  assert.equal(response.status, 403);
});

test("图片代理直通普通图片，并可解开已注册的 AES 图片", async (context) => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from("0B6666A0-BB59-1381-B746-a0E4C9AC"), iv);
  const encrypted = Buffer.concat([iv, cipher.update(plain), cipher.final()]);
  const originalPixels = Buffer.alloc(10 * 4);
  for (let row = 0; row < 10; row += 1) originalPixels.writeUInt32BE(((row + 1) << 24) | 0x0000ff, row * 4);
  // bookId 230000 uses the fixed 10-tile rule, so every one-pixel row is reversed.
  const scrambledPixels = Buffer.alloc(originalPixels.length);
  for (let row = 0; row < 10; row += 1) {
    originalPixels.copy(scrambledPixels, row * 4, (9 - row) * 4, (10 - row) * 4);
  }
  const scrambled = await Jimp.fromBitmap({ data: scrambledPixels, width: 1, height: 10 }).getBuffer(JimpMime.png);
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(request.url === "/encrypted" ? encrypted : request.url?.startsWith("/photos/") ? scrambled : plain);
  });
  const upstreamBase = await listen(upstream);
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: true, maxImageBytes: 1024 },
  });
  const appBase = await listen(app);
  context.after(async () => {
    await close(app);
    await close(upstream);
  });

  const direct = await fetch(`${appBase}/image?url=${encodeURIComponent(`${upstreamBase}/plain`)}`);
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("content-type"), "image/jpeg");
  assert.equal(direct.headers.get("x-image-decoder"), "passthrough");
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), plain);

  const decoded = await fetch(`${appBase}/image/mwwz-aes?url=${encodeURIComponent(`${upstreamBase}/encrypted`)}`);
  assert.equal(decoded.status, 200);
  assert.equal(decoded.headers.get("content-type"), "image/jpeg");
  assert.equal(decoded.headers.get("x-image-decoder"), "mwwz-aes");
  assert.deepEqual(Buffer.from(await decoded.arrayBuffer()), plain);

  const jm = await fetch(`${appBase}/image/jm-scramble?url=${encodeURIComponent(`${upstreamBase}/photos/230000/1.jpg`)}`);
  assert.equal(jm.status, 200);
  assert.equal(jm.headers.get("content-type"), "image/png");
  assert.equal(jm.headers.get("x-image-decoder"), "jm-scramble");
  const restored = await Jimp.read(Buffer.from(await jm.arrayBuffer()));
  assert.deepEqual(Buffer.from(restored.bitmap.data), originalPixels);
});
