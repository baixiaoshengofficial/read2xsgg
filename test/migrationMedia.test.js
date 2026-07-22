import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  clearCatalogPlanCache,
  compileMediaExtractionPlan,
  convertLegado,
  decodeCatalogPlan,
  encodeCatalogPlan,
  executeCatalogPlan,
  executeMediaResolution,
  mediaPlanHasResolution,
  mediaPlanIsLegacyHrefOnly,
  mediaRuleNeedsPortabilityWarning,
  MEDIA_PORTABILITY_WARNING,
  MEDIA_RECONVERSION_DIAGNOSTIC,
  pageMediaUrls,
  resolveChapterMediaUrls,
} from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lrtsFixture = JSON.parse(
  readFileSync(path.join(ROOT, "sources/migrations/lrts.legado.json"), "utf8"),
);
const lianTingFixture = JSON.parse(
  readFileSync(path.join(ROOT, "sources/migrations/lian-ting.legado.json"), "utf8"),
);

test("通用 idList catalogPlan：首页缓存 ids，次页切片请求", async () => {
  clearCatalogPlanCache();
  const plan = {
    version: 1,
    kind: "idList",
    origin: "https://catalog.example",
    pageSize: 20,
    headers: { "X-Demo": "1" },
    first: {
      url: "{{origin}}/list?entityId={{entityId}}&dsize={{pageSize}}",
      idsProperty: "bookIds",
      itemsProperty: "books",
    },
    next: {
      url: "{{origin}}/list?bookIds={{idsJson}}",
      itemsProperty: "books",
    },
    item: {
      id: "id",
      name: "name",
      detailUrl: "{{origin}}/book/{{id}}",
      author: "author",
    },
  };
  assert.deepEqual(decodeCatalogPlan(encodeCatalogPlan(plan)), {
    ...plan,
    headers: { "X-Demo": "1" },
  });

  const calls = [];
  const download = async (url, headers = {}) => {
    calls.push({ url, headers });
    if (String(url).includes("entityId=11")) {
      return Buffer.from(JSON.stringify({
        bookIds: Array.from({ length: 40 }, (_, i) => i + 1),
        books: [{ id: 1, name: "第一页", author: "A" }],
      }));
    }
    return Buffer.from(JSON.stringify({
      books: [{ id: 21, name: "第二页", author: "B" }],
    }));
  };

  const first = await executeCatalogPlan(plan, {
    entityId: "11",
    pageIndex: 1,
    pageSize: 20,
    download,
  });
  assert.equal(first.data[0].name, "第一页");
  assert.equal(first.data[0].url, "https://catalog.example/book/1");
  assert.equal(first.hasMore, true);
  assert.equal(calls[0].headers["X-Demo"], "1");

  const second = await executeCatalogPlan(plan, {
    entityId: "11",
    pageIndex: 2,
    pageSize: 20,
    download,
  });
  assert.equal(second.data[0].name, "第二页");
  assert.match(calls[1].url, /bookIds=%5B/);
});

test("LRTS 迁移 fixture：分类菜单与播放 JSON 走通用计划，无域名分支", async () => {
  clearCatalogPlanCache();
  const { sources, warnings } = convertLegado(lrtsFixture, {
    imageProxyBase: "https://convert.example",
  });
  const converted = sources["懒人听书（优+++）"];
  assert.ok(converted);
  assert.ok(Object.keys(converted.bookWorld || {}).length >= 1);
  const worldBlob = JSON.stringify(converted.bookWorld);
  assert.match(worldBlob, /\/adapter\/catalog\?/);
  assert.doesNotMatch(worldBlob, /\/adapter\/lrts-books/);
  assert.equal(converted.searchBook.moreKeys.pageSize, 15);
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/media\?/);
  assert.match(converted.chapterContent.requestInfo, /queryInfo/);
  assert.doesNotMatch(converted.chapterContent.requestInfo, /^%@result$/);

  const planMatch = converted.chapterContent.requestInfo.match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(planMatch);
  const mediaPlan = JSON.parse(Buffer.from(planMatch[1], "base64url").toString("utf8"));
  assert.ok(mediaPlan.properties.includes("path"));

  const listenJson = JSON.stringify({
    apiStatus: 0,
    data: { path: "https://cdn.example/audio/chapter1.m4a?vkey=1" },
  });
  assert.deepEqual(
    pageMediaUrls(listenJson, "https://audio.example/ajax/listen?entityId=1&section=1", mediaPlan),
    ["https://cdn.example/audio/chapter1.m4a?vkey=1"],
  );

  // Fixture catalogPlan executes through the generic idList executor (parity
  // with former /adapter/lrts-books paging), without any host branch.
  const fixturePlan = lrtsFixture.read2xsgg.catalogPlan;
  const calls = [];
  const download = async (url) => {
    calls.push(String(url));
    if (String(url).includes("pageNum=1") && !String(url).includes("bookIds=")) {
      return Buffer.from(JSON.stringify({
        bookIds: Array.from({ length: 25 }, (_, i) => 101 + i),
        books: [{ id: 101, name: "首页书", author: "A", desc: "d", cover: "c", tags: ["t"], sections: 9 }],
      }));
    }
    return Buffer.from(JSON.stringify({
      books: [{ id: 121, name: "次页书", author: "B" }],
    }));
  };
  const first = await executeCatalogPlan(fixturePlan, {
    entityId: "11",
    pageIndex: 1,
    pageSize: 20,
    download,
  });
  assert.equal(first.data[0].name, "首页书");
  assert.match(first.data[0].url, /bookId=101/);
  assert.equal(first.hasMore, true);
  const second = await executeCatalogPlan(fixturePlan, {
    entityId: "11",
    pageIndex: 2,
    pageSize: 20,
    download,
  });
  assert.equal(second.data[0].name, "次页书");
  assert.ok(calls.some((url) => /bookIds=%5B/.test(url)));

  assert.ok(warnings.some((item) => /catalog 适配器|idList/.test(String(item.message || ""))));
});

test("恋听迁移 fixture：显式 mediaResolution 可执行；legacy WebView XBS 给可移植诊断", async () => {
  const { sources, warnings } = convertLegado(lianTingFixture, {
    imageProxyBase: "https://convert.example",
  });
  const converted = sources["恋听🎧💜"];
  assert.ok(converted);
  assert.match(converted.chapterContent.requestInfo, /\/adapter\/media\?/);
  const planMatch = converted.chapterContent.requestInfo.match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(planMatch);
  const plan = JSON.parse(Buffer.from(planMatch[1], "base64url").toString("utf8"));
  assert.ok(mediaPlanHasResolution(plan));
  assert.equal(plan.resolution.request.url, "{{origin}}/nlinka");
  assert.equal(plan.resolution.request.method, "POST");
  assert.deepEqual(plan.resolution.response.properties, ["url", "ourl"]);
  assert.ok(warnings.some((item) => /多步媒体流程/.test(String(item.message || ""))));

  const html = `
    <html><head>
      <meta name="_c" content="token-c"/>
      <meta name="_b" content="14917"/>
      <meta name="_cp" content="1"/>
      <meta name="_p" content="0"/>
      <meta name="_l" content="1"/>
    </head></html>
  `;
  const calls = [];
  const urls = await executeMediaResolution(
    html,
    "https://media.example/book/14917-1",
    plan,
    async (url, init = {}) => {
      calls.push({ url, init });
      return Buffer.from(JSON.stringify({
        ourl: "",
        url: "https://cdn.example/a/14917.mp3",
        status: 1,
      }));
    },
  );
  assert.deepEqual(urls, ["https://cdn.example/a/14917.mp3"]);
  assert.equal(calls[0].url, "https://media.example/nlinka");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.xt, "token-c");
  assert.match(String(calls[0].init.body), /bookId=14917/);
  assert.match(String(calls[0].init.body), /page=1/);

  // Published-style legacy XBS (05004abd): WebView + sourceRegex only — converter
  // must diagnose and must not invent a follow-up gateway.
  const legacy = {
    bookSourceName: "恋听-legacy",
    bookSourceUrl: "https://audio.example/",
    bookSourceType: 1,
    searchUrl: "https://audio.example/search/{{key}}",
    ruleSearch: { bookList: "li", name: "a", bookUrl: "a@href" },
    ruleToc: {
      chapterList: "li",
      chapterName: "a",
      chapterUrl: "tag.a@href@js:result+',{webView:true}'",
    },
    ruleContent: { content: "<js>result</js>", sourceRegex: ".*\\.(mp3|m4a).*" },
  };
  const legacyPlan = compileMediaExtractionPlan(
    legacy.ruleContent.content,
    "audio",
    {},
    { sourceRegex: legacy.ruleContent.sourceRegex },
  );
  assert.equal(mediaPlanHasResolution(legacyPlan), false);
  assert.equal(
    mediaRuleNeedsPortabilityWarning(legacy.ruleContent, legacy.ruleToc, legacyPlan),
    true,
  );
  const legacyConverted = convertLegado(legacy, { imageProxyBase: "https://convert.example" });
  assert.ok(legacyConverted.warnings.some((item) => item.message === MEDIA_PORTABILITY_WARNING));
  const legacyInfo = String(legacyConverted.sources["恋听-legacy"].chapterContent.requestInfo);
  const legacyPlanMatch = legacyInfo.match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(legacyPlanMatch);
  const emptyPlan = JSON.parse(Buffer.from(legacyPlanMatch[1], "base64url").toString("utf8"));
  assert.equal(emptyPlan.resolution, undefined);

  // Published library artifact shape: href-only media plan (恋听 8ffae8f8…) needs
  // reconversion; native JSON path extractors (懒人听书 85a2e59d…) stay compatible.
  const publishedHrefOnly = { version: 1, kind: "audio", properties: [], attributes: ["href"], urlHints: [] };
  assert.equal(mediaPlanIsLegacyHrefOnly(publishedHrefOnly), true);
  assert.match(MEDIA_RECONVERSION_DIAGNOSTIC, /重新转换/);
  assert.deepEqual(
    pageMediaUrls(
      `<link rel="alternate" href="https://m.example.com/book/1-1"><iframe src="https://audio.example.com/book/1-1"></iframe>`,
      "https://audio.example.com/book/1-1",
      publishedHrefOnly,
    ),
    [],
  );
  assert.equal(
    mediaPlanIsLegacyHrefOnly({ version: 1, kind: "audio", properties: ["path"], attributes: [], urlHints: [] }),
    false,
  );
});

test("迁移播放解析：直链章节不触发下载；resolution 优先于页面扫描", async () => {
  let loaded = false;
  const direct = await resolveChapterMediaUrls(
    async () => {
      loaded = true;
      return "<html></html>";
    },
    "https://cdn.example/file.mp3",
    { kind: "audio", properties: [], attributes: [], urlHints: [] },
    async () => { throw new Error("should not download"); },
    pageMediaUrls,
  );
  assert.deepEqual(direct, ["https://cdn.example/file.mp3"]);
  assert.equal(loaded, false);
});
