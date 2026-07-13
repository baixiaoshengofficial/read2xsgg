import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAppServer, decodeXbs, serverConfig } from "../src/index.js";

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

  const notModified = await fetch(`${appBase}/convert?url=${encodeURIComponent(sourceUrl)}`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(notModified.status, 304);

  const jsonResponse = await fetch(`${appBase}/convert/json?url=${encodeURIComponent(sourceUrl)}`);
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

test("DNS 代理兼容开关不会放行直接填写的保留网段 IP", async (context) => {
  const app = createAppServer({
    config: { ...serverConfig({}), allowPrivateNetworks: false, allowDnsProxyNetworks: true },
  });
  const appBase = await listen(app);
  context.after(() => close(app));

  const response = await fetch(`${appBase}/convert?url=${encodeURIComponent("http://198.18.0.1/source.json")}`);
  assert.equal(response.status, 403);
});
