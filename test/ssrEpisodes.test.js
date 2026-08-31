import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSsrEpisodePlan,
  discoverSsrEpisodePlan,
  encodeSsrEpisodePlan,
  extractSsrEpisodeCatalog,
  ssrEpisodePageUrl,
} from "../src/siteAnalyze/ssrEpisodes.js";

const detailUrl = "https://audio.example/channels/42";
const detailHtml = `<!doctype html><html><body>
<a href="/programs/p1">第一集</a><a href="/programs/p2">第二集</a>
<script>window.__initStores={"channel":{"id":"42","version":"v1234","programCount":4,"programs":[{"programId":"p1","title":"第一集"},{"programId":"p2","title":"第二集"}]}};</script>
<script src="/assets/catalog.js"></script>
</body></html>`;

const apiPage = (page) => JSON.stringify({
  total: 4,
  programs: page === 1
    ? [{ programId: "p1", title: "第一集" }, { programId: "p2", title: "第二集" }]
    : [{ programId: "p3", title: "第三集" }, { programId: "p4", title: "第四集" }],
});

test("通用 SSR 节目识别只在连续两页目录不重复时生成分页计划", async () => {
  const calls = [];
  const script = 'var api="https://webapi.example";return api.concat("/api/mobile/channels/").concat(channelId,"/programs?version=").concat(version,"&page_index=").concat(page);';
  const download = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/assets/catalog.js")) return Buffer.from(script);
    const page = Number(new URL(url).searchParams.get("page_index"));
    return Buffer.from(apiPage(page));
  };

  const catalog = extractSsrEpisodeCatalog(detailHtml, detailUrl);
  assert.equal(catalog.entityId, "42");
  assert.equal(catalog.version, "v1234");
  assert.equal(catalog.total, 4);
  assert.deepEqual(catalog.rows.map((row) => row.id), ["p1", "p2"]);

  const plan = await discoverSsrEpisodePlan(detailHtml, detailUrl, { download });
  assert.ok(plan);
  assert.equal(plan.pageSize, 2);
  assert.equal(plan.total, 4);
  assert.match(ssrEpisodePageUrl(plan, catalog, 2), /page_index=2$/);
  assert.ok(calls.some((url) => /page_index=1$/.test(url)));
  assert.ok(calls.some((url) => /page_index=2$/.test(url)));

  const encoded = encodeSsrEpisodePlan(plan);
  const decoded = decodeSsrEpisodePlan(encoded);
  assert.deepEqual(decoded, {
    version: 1,
    apiTemplate: plan.apiTemplate,
    pageSize: 2,
    total: 4,
  });
  assert.ok(!Buffer.from(encoded, "base64url").toString("utf8").includes("sampleRows"));
});

test("通用 SSR 节目识别拒绝返回重复当前页的伪分页 API", async () => {
  const script = 'var api="https://webapi.example";return api.concat("/api/mobile/channels/").concat(channelId,"/programs?version=").concat(version,"&page_index=").concat(page);';
  const plan = await discoverSsrEpisodePlan(detailHtml, detailUrl, {
    download: async (url) => String(url).endsWith(".js") ? Buffer.from(script) : Buffer.from(apiPage(1)),
  });
  assert.equal(plan, null);
});
