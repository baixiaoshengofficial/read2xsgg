import assert from "node:assert/strict";
import test from "node:test";
import {
  inferAjaxArrayExplore,
  materializeAjaxArrayExplore,
} from "../src/siteAnalyze/dynamicExplore.js";
import { materializeDynamicCatalogSource } from "../src/siteAnalyze/dynamicCatalog.js";

function arrayExploreSource() {
  return {
    bookSourceName: "array-backed explore",
    bookSourceUrl: "https://catalog.example",
    bookSourceType: 2,
    header: JSON.stringify({ "X-Requested-With": "reader.client" }),
    exploreUrl: `@js:
      var endpoint = source.bookSourceUrl + "/api/categories";
      var records = JSON.parse(java.ajax(endpoint));
      var output = [];
      function push(title, url) { output.push({ title: title, url: url }); }
      for (var i = 0; i < records.length; i++) {
        var item = records[i];
        var title = item.name + " (" + item.count + ")";
        var url = "/browse?category=" + encodeURIComponent(item.id);
        push(title, url);
      }
      JSON.stringify(output);`,
  };
}

test("array-backed dynamic explore is inferred without executing source JavaScript", () => {
  delete globalThis.__dynamicExploreExecuted;
  const source = arrayExploreSource();
  source.exploreUrl = source.exploreUrl.replace(
    /^@js:/,
    "@js:globalThis.__dynamicExploreExecuted = true;\n",
  );

  const inferred = inferAjaxArrayExplore(source);

  assert.equal(inferred.endpoint, "https://catalog.example/api/categories");
  assert.deepEqual(inferred.arrayPath, []);
  assert.equal(inferred.loop.collectionName, "records");
  assert.equal(inferred.loop.rowName, "item");
  assert.equal(inferred.headers["X-Requested-With"], "reader.client");
  assert.equal(globalThis.__dynamicExploreExecuted, undefined);
});

test("array-backed explore safely maps response rows into category URL entries", async () => {
  const calls = [];
  const result = await materializeAjaxArrayExplore(arrayExploreSource(), {
    download: async (url, headers) => {
      calls.push({ url, headers });
      return Buffer.from(JSON.stringify([
        { id: 3, name: "悬疑", count: 12 },
        { id: "x y", name: "奇幻", count: 7 },
      ]));
    },
  });

  assert.equal(result.materialized, true);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.entries, [
    { title: "悬疑 (12)", url: "https://catalog.example/browse?category=3", group: "" },
    { title: "奇幻 (7)", url: "https://catalog.example/browse?category=x%20y", group: "" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["X-Requested-With"], "reader.client");
});

test("nested JSON collection aliases are resolved as data paths, not site-specific rules", async () => {
  const source = {
    bookSourceName: "nested array explore",
    bookSourceUrl: "https://comic.example",
    exploreUrl: `@js:
      var api = source.bookSourceUrl + "/taxonomy";
      var data = JSON.parse(java.ajax(api)).data;
      var categories = data.groups[0].children || [];
      var list = [];
      function push(title, url) { list.push({ title: title, url: url }); }
      for (let index = 0; index < categories.length; index++) {
        const category = categories[index];
        push(category.label, "/list/" + category.key + "?page=1");
      }
      JSON.stringify(list);`,
  };
  const inferred = inferAjaxArrayExplore(source);
  assert.equal(inferred.endpoint, "https://comic.example/taxonomy");
  assert.deepEqual(inferred.arrayPath, ["data", "groups", 0, "children"]);

  const materialized = await materializeDynamicCatalogSource(source, {
    download: async () => Buffer.from(JSON.stringify({
      data: { groups: [{ children: [{ label: "日漫", key: "a1" }] }] },
    })),
  });
  assert.equal(materialized.dynamicExplore, true);
  assert.deepEqual(materialized.source.exploreUrl, [
    { title: "日漫", url: "https://comic.example/list/a1?page=1", group: "" },
  ]);
});

test("array-backed explore supports forEach callbacks and property-path collections", async () => {
  const source = {
    bookSourceName: "callback array explore",
    bookSourceUrl: "https://audio.example",
    exploreUrl: `@js:
      var response = JSON.parse(java.ajax("/api/tags"));
      var tags = response.data.tags || [];
      var output = [];
      function push(title, url) { output.push({ title: title, url: url }); }
      tags.forEach((tag) => {
        var title = tag.name + " (" + tag.count + ")";
        push(title, "/tag/" + encodeURIComponent(tag.id));
      });
      JSON.stringify(output);`,
  };
  const inferred = inferAjaxArrayExplore(source);
  assert.deepEqual(inferred.arrayPath, ["data", "tags"]);
  assert.equal(inferred.loop.rowName, "tag");

  const result = await materializeAjaxArrayExplore(source, {
    download: async (url) => {
      assert.equal(url, "https://audio.example/api/tags");
      return Buffer.from(JSON.stringify({
        data: { tags: [{ id: "lo fi", name: "Lo-Fi", count: 8 }] },
      }));
    },
  });
  assert.deepEqual(result.entries, [
    { title: "Lo-Fi (8)", url: "https://audio.example/tag/lo%20fi", group: "" },
  ]);
});

test("unbounded or non-declarative scripts are not inferred as array catalogs", () => {
  const source = arrayExploreSource();
  source.exploreUrl = "@js: eval(source.loginUrl); while (true) {} JSON.stringify([]);";
  assert.equal(inferAjaxArrayExplore(source), null);
});
