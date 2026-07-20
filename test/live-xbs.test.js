import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAppServer, runXbsPipeline, serverConfig } from "../src/index.js";

const runLive = process.env.RUN_XBS_LIVE === "1";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("live 7584: 转换后的香色动作链取得分类、详情、章节和图片", { skip: !runLive }, async (context) => {
  const app = createAppServer({
    config: { ...serverConfig({}), host: "127.0.0.1", preflightSources: false },
  });
  const appBase = await listen(app);
  context.after(() => close(app));
  const sourceUrl = "https://www.yckceo.com/yuedu/shuyuan/json/id/7584.json";
  const response = await fetch(`${appBase}/convert/json?url=${encodeURIComponent(sourceUrl)}`);
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const payload = JSON.parse(responseText);
  const source = payload.sources["🎨禁漫天堂"];
  assert.ok(source);
  const report = await runXbsPipeline(source, { timeoutMs: 30_000 });
  console.log(JSON.stringify(report));
  assert.equal(report.ok, true, report.error);
  assert.ok(report.steps.bookWorld.listCount > 0);
  assert.ok(report.steps.chapterList.listCount > 0);
  assert.ok(report.steps.chapterContent.itemCount > 0);
  assert.equal(report.steps.media.status, 200);
  assert.match(report.steps.media.contentType, /^image\//);
});
