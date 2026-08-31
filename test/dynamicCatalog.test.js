import assert from "node:assert/strict";
import test from "node:test";
import { convertLegado } from "../src/converter.js";
import {
  inferDynamicCatalog,
  materializeDynamicCatalogSource,
} from "../src/siteAnalyze/dynamicCatalog.js";

function dynamicSource() {
  return {
    bookSourceName: "通用动态有声源",
    bookSourceUrl: "https://audio.example.test/",
    bookSourceType: 1,
    header: JSON.stringify({ "X-Requested-With": "reader.client", Referer: "https://audio.example.test/" }),
    exploreUrl: `@js:
      var output = [];
      var endpoint = "https://audio.example.test/api/taxonomy";
      function load() { return JSON.parse(java.ajax(endpoint)).payload.groups; }
      load().map($ => {
        push($.label, null, 1, 1);
        var children = $.children;
        children.map($ => {
          title = $.label;
          url = \`@js:
            if (page === 1) {
              url = "/api/catalog?limit=3&category=\${$.key}&page=1";
            } else {
              ids = String(source.get('entryIds')).split(',');
              rows = ids.slice((page - 1) * 3, (page - 1) * 3 + 3);
              url = "/api/catalog?limit=3&category=0&page=0&entryIds=" + JSON.stringify(rows);
            }
          \`;
          push(title, url, 1, 0.25);
        });
      });
      JSON.stringify(output);`,
    searchUrl: "/api/search?q={{key}}&page={{page}}&pageSize=3",
    ruleSearch: {
      bookList: "<js>source.put('entryIds', JSON.parse(result).entryIds);</js>$.results[*]||$.items[*]",
      name: "$.title",
      bookUrl: "https://audio.example.test/api/detail?id={{$.key}}",
      author: "$.speaker",
      coverUrl: "$.artwork",
      intro: "$.summary",
      checkKeyWord: "audio",
    },
    ruleBookInfo: { name: "$.data.title", tocUrl: "$.data.menu" },
    ruleToc: { chapterList: "$.data[*]", chapterName: "$.title", chapterUrl: "$.url" },
    ruleContent: { content: "$.url" },
  };
}

test("动态分类按脚本结构推导，不依赖站点名称或路径", () => {
  const inferred = inferDynamicCatalog(dynamicSource());
  assert.equal(inferred.categoryUrl, "https://audio.example.test/api/taxonomy");
  assert.deepEqual(inferred.categoryPath, ["payload", "groups"]);
  assert.equal(inferred.childField, "children");
  assert.equal(inferred.plan.pageSize, 3);
  assert.equal(inferred.plan.first.idsProperty, "entryIds");
  assert.equal(inferred.plan.first.itemsProperty, "items");
  assert.equal(inferred.plan.item.id, "key");
  assert.equal(inferred.plan.item.name, "title");
  assert.equal(inferred.plan.headers["X-Requested-With"], "reader.client");
});

test("动态分类真实校验首、次页后生成标准化香色分类规则", async () => {
  const calls = [];
  const result = await materializeDynamicCatalogSource(dynamicSource(), {
    download: async (url, headers) => {
      calls.push({ url, headers });
      if (url.endsWith("/api/taxonomy")) {
        return Buffer.from(JSON.stringify({
          payload: { groups: [{ label: "小说", children: [{ label: "悬疑", key: 7 }] }] },
        }));
      }
      if (url.includes("category=7")) {
        return Buffer.from(JSON.stringify({
          entryIds: [1, 2, 3, 4, 5, 6],
          items: [
            { key: 1, title: "第一本", artwork: "/1.jpg" },
            { key: 2, title: "第二本", artwork: "/2.jpg" },
          ],
        }));
      }
      if (url.includes("entryIds=")) {
        return Buffer.from(JSON.stringify({
          items: [{ key: 4, title: "第四本", artwork: "/4.jpg" }],
        }));
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(result.materialized, true);
  assert.equal(result.categoryCount, 1);
  assert.equal(result.page1Count, 2);
  assert.equal(result.page2Count, 1);
  assert.deepEqual(result.source.exploreUrl, [{
    title: "悬疑",
    group: "小说",
    entityId: "7",
    pageSize: 2,
    requestPageSize: 3,
  }]);
  assert.equal(result.source.ruleExplore.bookList, "$.data[*]");
  assert.ok(calls.every((call) => call.headers["X-Requested-With"] === "reader.client"));

  const converted = convertLegado(result.source, { imageProxyBase: "https://converter.example.test" });
  const world = converted.sources["通用动态有声源"].bookWorld["小说·悬疑"];
  assert.equal(converted.sources["通用动态有声源"].sourceType, "audio");
  assert.equal(world.list, "$.data");
  assert.equal(world.bookName, "name");
  assert.equal(world.detailUrl, "url");
  assert.equal(world.cover, "cover");
  assert.equal(world.moreKeys.pageSize, 2);
  assert.match(world.requestInfo, /pageSize=3/);
  assert.match(world.requestInfo, /%@pageIndex/);
});

test("动态分类次页重复时拒绝物化而不是发布错误分页", async () => {
  await assert.rejects(
    () => materializeDynamicCatalogSource(dynamicSource(), {
      download: async (url) => {
        if (url.endsWith("/api/taxonomy")) {
          return Buffer.from(JSON.stringify({
            payload: { groups: [{ label: "小说", children: [{ label: "悬疑", key: 7 }] }] },
          }));
        }
        return Buffer.from(JSON.stringify({
          entryIds: [1, 2, 3, 4, 5, 6],
          items: [{ key: 1, title: "重复书", artwork: "/repeat.jpg" }],
        }));
      },
    }),
    /第 2 页与第 1 页重复/,
  );
});
