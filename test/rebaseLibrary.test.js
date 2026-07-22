import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAppServer,
  createLibraryStore,
  decodeXbs,
  encodeXbs,
  normalizePublicOrigin,
  rebaseArtifactPair,
  rebaseLibraryArtifact,
  rebaseOriginInText,
  serverConfig,
} from "../src/index.js";

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
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** Synthetic Xiangse-shaped library artifact — no real source names/domains. */
function syntheticSources(bridgeOrigin) {
  const base = String(bridgeOrigin).replace(/\/$/, "");
  return {
    "synthetic-audio": {
      sourceName: "synthetic-audio",
      sourceType: "audio",
      searchBook: {
        requestInfo: `${base}/adapter/books?plan=cGxhbg&url=`,
      },
      chapterContent: {
        requestInfo: `${base}/adapter/media?kind=audio&plan=e30&url=%40%40result`,
        content: [
          "@js:",
          `var endpoint = ${JSON.stringify(`${base}/adapter/media?kind=audio&url=`)};`,
          "return endpoint + encodeURIComponent(result);",
        ].join("\n"),
      },
      // Image proxy URLs on the same public bridge origin must also move.
      coverProxy: `${base}/image/auto?url=${encodeURIComponent("https://cdn.upstream.example/cover.jpg")}`,
      // Upstream / CDN must stay untouched even if host-like strings appear.
      note: "https://cdn.upstream.example/track.m4a",
      encodedBridge: encodeURIComponent(`${base}/adapter/catalog?plan=x`),
    },
  };
}

function artifactBuffers(bridgeOrigin) {
  const json = Buffer.from(`${JSON.stringify(syntheticSources(bridgeOrigin), null, 2)}\n`, "utf8");
  return { json, xbs: encodeXbs(json) };
}

test("normalizePublicOrigin：规范化并拒绝凭据/非 http(s)", () => {
  assert.equal(normalizePublicOrigin("https://bridge.example/path"), "https://bridge.example");
  assert.equal(normalizePublicOrigin("bridge.example"), "https://bridge.example");
  assert.equal(normalizePublicOrigin("http://bridge.example:8080/"), "http://bridge.example:8080");
  assert.throws(() => normalizePublicOrigin("ftp://bridge.example"), /http\/https/);
  assert.throws(() => normalizePublicOrigin("https://user:pass@bridge.example"), /凭据/);
  assert.throws(() => normalizePublicOrigin(""), /缺少/);
});

test("rebaseOriginInText：只替换旧 origin 边界匹配，保留上游 URL", () => {
  const oldOrigin = "https://old-bridge.example";
  const newOrigin = "https://new-bridge.example";
  const text = [
    `${oldOrigin}/adapter/media?url=${encodeURIComponent("https://cdn.upstream.example/a.m4a")}`,
    `prefix ${oldOrigin}.evil.example/adapter`,
    `encoded=${encodeURIComponent(`${oldOrigin}/adapter/books`)}`,
    "https://cdn.upstream.example/keep",
  ].join("\n");

  const { text: out, replacements } = rebaseOriginInText(text, oldOrigin, newOrigin);
  // Plain bridge URL + percent-encoded bridge URL; evil subdomain must not match.
  assert.equal(replacements, 2);
  assert.match(out, new RegExp(`${newOrigin}/adapter/media`));
  assert.match(out, /cdn\.upstream\.example/);
  assert.doesNotMatch(out, new RegExp(`${oldOrigin}/`));
  assert.match(out, new RegExp(`${oldOrigin}\\.evil\\.example`));
  assert.match(out, new RegExp(encodeURIComponent(`${newOrigin}/adapter/books`)));
});

test("rebaseOriginInText：origins 相同为 no-op", () => {
  const origin = "https://bridge.example";
  const { text, replacements, noopReason } = rebaseOriginInText(
    `${origin}/adapter/books`,
    origin,
    `${origin}/`,
  );
  assert.equal(replacements, 0);
  assert.equal(noopReason, "origins-equal");
  assert.equal(text, `${origin}/adapter/books`);
});

test("rebaseArtifactPair：JSON/XBS 一致且上游保留", () => {
  const oldOrigin = "https://old-bridge.example";
  const newOrigin = "https://new-bridge.example";
  const { json, xbs } = artifactBuffers(oldOrigin);

  const result = rebaseArtifactPair({ json, xbs, oldOrigin, newOrigin });
  assert.equal(result.changed, true);
  assert.ok(result.replacements >= 3);

  const sources = JSON.parse(result.json.toString("utf8"));
  const decoded = JSON.parse(decodeXbs(result.xbs).toString("utf8"));
  assert.deepEqual(sources, decoded);
  assert.match(sources["synthetic-audio"].searchBook.requestInfo, new RegExp(`^${newOrigin}/adapter/`));
  assert.equal(sources["synthetic-audio"].note, "https://cdn.upstream.example/track.m4a");
  assert.doesNotMatch(JSON.stringify(sources), /old-bridge\.example/);
});

test("rebaseArtifactPair：JSON 与 XBS 不一致时拒绝", () => {
  const oldOrigin = "https://old-bridge.example";
  const { json } = artifactBuffers(oldOrigin);
  const other = Buffer.from(`${JSON.stringify({ other: 1 })}\n`);
  assert.throws(
    () => rebaseArtifactPair({
      json,
      xbs: encodeXbs(other),
      oldOrigin,
      newOrigin: "https://new-bridge.example",
    }),
    /不一致/,
  );
});

test("rebaseLibraryArtifact：写入制品、保留 job id，dry-run 不落盘", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-rebase-"));
  const oldOrigin = "https://old-bridge.example";
  const newOrigin = "https://new-bridge.example";
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({
      url: "https://fixture.example/source.json",
      name: "synthetic",
      imageProxyBase: oldOrigin,
    });
    const { json, xbs } = artifactBuffers(oldOrigin);
    await store.saveArtifacts(job.id, { json, xbs });
    await store.saveSourcePayload(job.id, {
      bookSourceName: "payload-keep",
      bookSourceUrl: "https://upstream.fixture.example/",
      marker: "untouched-source-payload",
    });
    await store.updateJob(job.id, { status: "done", count: 1 });

    const dry = await rebaseLibraryArtifact({
      store,
      jobId: job.id,
      oldOrigin,
      newOrigin,
      dryRun: true,
    });
    assert.equal(dry.summary.dryRun, true);
    assert.equal(dry.summary.written, false);
    assert.equal(dry.summary.changed, true);
    assert.ok(dry.summary.replacements >= 3);
    // Artifact still old after dry-run.
    const stillOld = JSON.parse((await store.readArtifact(job.id, "json")).toString("utf8"));
    assert.match(stillOld["synthetic-audio"].searchBook.requestInfo, new RegExp(oldOrigin));

    const applied = await rebaseLibraryArtifact({
      store,
      jobId: job.id,
      oldOrigin,
      newOrigin,
      dryRun: false,
    });
    assert.equal(applied.summary.written, true);
    assert.equal(applied.summary.id, job.id);
    assert.equal(applied.job.id, job.id);
    assert.equal(applied.job.subscribePath, `/library/${job.id}.xbs`);
    assert.equal(applied.job.imageProxyBase, newOrigin);
    assert.equal(applied.job.rebasedFrom, oldOrigin);
    assert.equal(applied.job.rebasedTo, newOrigin);
    assert.ok(applied.job.rebasedAt);

    const nextJson = JSON.parse((await store.readArtifact(job.id, "json")).toString("utf8"));
    const nextXbs = JSON.parse(decodeXbs(await store.readArtifact(job.id, "xbs")).toString("utf8"));
    assert.deepEqual(nextJson, nextXbs);
    assert.match(nextJson["synthetic-audio"].searchBook.requestInfo, new RegExp(`^${newOrigin}/`));
    assert.equal(nextJson["synthetic-audio"].note, "https://cdn.upstream.example/track.m4a");

    const payload = await store.readSourcePayload(job.id);
    assert.equal(payload.marker, "untouched-source-payload");
    assert.equal(payload.bookSourceName, "payload-keep");

    // Second apply is a no-op validation (no remaining old origin).
    const noop = await rebaseLibraryArtifact({
      store,
      jobId: job.id,
      oldOrigin,
      newOrigin,
      dryRun: false,
    });
    assert.equal(noop.summary.changed, false);
    assert.equal(noop.summary.written, false);
    assert.equal(noop.summary.noopReason, "no-matches");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebaseLibraryArtifact：origins 相同为校验 no-op", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-rebase-equal-"));
  const origin = "https://bridge.example";
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({
      url: "https://fixture.example/source.json",
      imageProxyBase: origin,
    });
    const { json, xbs } = artifactBuffers(origin);
    await store.saveArtifacts(job.id, { json, xbs });
    await store.updateJob(job.id, { status: "done", count: 1 });

    const result = await rebaseLibraryArtifact({
      store,
      jobId: job.id,
      oldOrigin: origin,
      newOrigin: `${origin}/`,
      dryRun: false,
    });
    assert.equal(result.summary.noopReason, "origins-equal");
    assert.equal(result.summary.written, false);
    assert.equal(result.job.imageProxyBase, origin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("管理 API rebase：dry-run 与写入摘要，不回传制品正文", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-rebase-api-"));
  const oldOrigin = "https://old-bridge.example";
  const newOrigin = "https://new-bridge.example";
  const store = createLibraryStore(dir);
  const job = await store.createJob({
    url: "https://fixture.example/source.json",
    name: "synthetic",
    imageProxyBase: oldOrigin,
  });
  const { json, xbs } = artifactBuffers(oldOrigin);
  await store.saveArtifacts(job.id, { json, xbs });
  await store.updateJob(job.id, { status: "done", count: 1 });

  const worker = { enqueue() {}, recover: async () => {}, cancel() {} };
  const app = createAppServer({
    config: {
      ...serverConfig({
        ADMIN_TOKEN: "secret-token",
        DATA_DIR: dir,
      }),
      dataDir: dir,
      adminToken: "secret-token",
    },
    store,
    worker,
    recoverJobs: false,
  });
  const base = await listen(app);
  context.after(async () => {
    await close(app);
    await rm(dir, { recursive: true, force: true });
  });

  const dry = await fetch(`${base}/api/jobs/${job.id}/rebase`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: oldOrigin, to: newOrigin, dryRun: true }),
  });
  assert.equal(dry.status, 200);
  const dryBody = await dry.json();
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.written, false);
  assert.ok(dryBody.replacements >= 3);
  assert.equal(dryBody.id, job.id);
  assert.equal(typeof dryBody.json, "undefined");
  assert.equal(typeof dryBody.xbs, "undefined");
  assert.equal(typeof dryBody.sources, "undefined");

  const applied = await fetch(`${base}/api/jobs/${job.id}/rebase`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ oldOrigin, newOrigin }),
  });
  assert.equal(applied.status, 200);
  const body = await applied.json();
  assert.equal(body.written, true);
  assert.equal(body.newOrigin, newOrigin);

  const library = await fetch(`${base}/library/${job.id}.xbs`);
  assert.equal(library.status, 200);
  const sources = JSON.parse(decodeXbs(Buffer.from(await library.arrayBuffer())).toString("utf8"));
  assert.match(sources["synthetic-audio"].searchBook.requestInfo, new RegExp(`^${newOrigin}/`));
});
