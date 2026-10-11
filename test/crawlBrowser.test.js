import assert from "node:assert/strict";
import test from "node:test";
import { renderSitePage } from "../src/siteAnalyze/crawlTools.js";

// Opt-in browser integration, with fixture responses only (no external sites).
test("真实 Chromium 渲染动态 DOM、观察 JSON 接口并拦截内网和写请求", { skip: process.env.RUN_CRAWL_BROWSER !== "1" }, async () => {
  const requests = [];
  const root = "https://example.test/";
  const result = await renderSitePage({
    url: root,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    authorizeNetwork: async (value) => new URL(value).origin === root.slice(0, -1),
    download: async (url, headers, options) => {
      requests.push(url);
      assert.deepEqual(headers, {});
      assert.equal(options.method, "GET");
      let body;
      let type;
      if (url === root) {
        body = '<main id="app"></main><script src="/app.js"></script>';
        type = "text/html; charset=utf-8";
      } else if (url === `${root}app.js`) {
        body = `document.cookie = "secret=do-not-forward";
          fetch('/api/catalog', {headers: {Authorization: 'Bearer do-not-forward'}}).then(r => r.json()).then(data => {
            document.getElementById('app').innerHTML = '<a href="/book/1">' + data.title + '</a>';
          });
          fetch('http://127.0.0.1/private').catch(() => {});
          fetch('/write', {method: 'POST', body: 'do-not-send'}).catch(() => {});`;
        type = "application/javascript";
      } else {
        assert.equal(url, `${root}api/catalog`);
        body = '{"title":"Rendered audiobook","audio":"/episode.mp3"}';
        type = "application/json";
      }
      return Object.assign(Buffer.from(body), { httpHeaders: { "content-type": type } });
    },
  });
  assert.match(result.html, /Rendered audiobook/);
  assert.equal(result.network.length, 1);
  assert.match(result.network[0].body, /episode.mp3/);
  assert.deepEqual(requests.sort(), [root, `${root}app.js`, `${root}api/catalog`].sort());
});
