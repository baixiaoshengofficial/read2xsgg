import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { convertLegado, runXbsPipeline } from "../src/index.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("香色动作链执行器验证分类、详情、章节和正文", async (context) => {
  const upstream = createServer((request, response) => {
    if (request.url === "/category/12?page=2") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<section class="book"><h2>测试作品</h2><a href="/detail/1">详情</a></section>');
    } else if (request.url === "/detail/1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<h1>测试作品</h1><div id="chapters"><a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a></div>');
    } else if (request.url === "/chapter/1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<article id="content">这是经过完整动作链取得的正文。</article>');
    } else {
      response.writeHead(404);
      response.end("not found");
    }
  });
  const base = await listen(upstream);
  context.after(() => close(upstream));

  const legado = {
    bookSourceName: "运行时测试",
    bookSourceUrl: base,
    searchUrl: "/search?q={{key}}",
    ruleSearch: { checkKeyWord: "测试", bookList: ".book", name: "h2@text", bookUrl: "a@href" },
    exploreUrl: Array.from({ length: 12 }, (_, index) => ({
      title: `分类 ${index + 1}`,
      url: `/category/${index + 1}?page={{page}}`,
    })),
    ruleExplore: { bookList: ".book", name: "h2@text", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1@text" },
    ruleToc: { chapterList: "#chapters a", chapterName: "a@text", chapterUrl: "a@href" },
    ruleContent: { content: "#content@html" },
  };
  const converted = convertLegado(legado, { omitNonPortable: true }).sources["运行时测试"];
  const report = await runXbsPipeline(converted, { filter: "分类 12", pageIndex: 2 });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.steps.bookWorld.listCount, 1);
  assert.match(report.steps.bookWorld.requestUrl, /\/category\/12\?page=2$/);
  assert.equal(report.steps.chapterList.listCount, 2);
  assert.equal(report.steps.chapterContent.itemCount > 0, true);
});
