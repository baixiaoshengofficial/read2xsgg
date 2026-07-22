import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppServer, createLibraryStore, encodeXbs, serverConfig } from "../src/index.js";

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

test("libraryStore 持久化任务与制品", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-lib-"));
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({ url: "https://example.com/legado.json", name: "demo" });
    assert.equal(job.status, "queued");
    assert.match(job.subscribePath, new RegExp(`/library/${job.id}\\.xbs`));

    const xbs = encodeXbs(Buffer.from('{"a":1}\n'));
    const json = Buffer.from('{"a":1}\n');
    await store.saveArtifacts(job.id, { xbs, json });
    await store.saveSourcePayload(job.id, { bookSourceName: "payload" });
    await store.updateJob(job.id, { status: "done", count: 1 });

    const artifactDir = path.join(dir, "artifacts");
    assert.equal((await stat(path.join(artifactDir, `${job.id}.xbs`))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(artifactDir, `${job.id}.source.json`))).mode & 0o777, 0o644);

    const listed = await store.listJobs();
    assert.equal(listed[0].id, job.id);
    assert.equal(listed[0].status, "done");
    assert.deepEqual(await store.readArtifact(job.id, "xbs"), xbs);

    await store.deleteJob(job.id);
    assert.equal(await store.getJob(job.id), null);
    assert.equal((await store.listJobs()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("同步转换结果写入 DATA_DIR，服务重启后可直接复用", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-conversion-cache-"));
  const json = Buffer.from('{"演示源":{"sourceName":"演示源"}}\n');
  const xbs = encodeXbs(json);
  const converted = {
    sources: JSON.parse(json.toString("utf8")),
    warnings: [],
    skipped: [],
    skippedBuckets: {},
    fallbackCount: 0,
    unverifiedCount: 0,
    count: 1,
    json,
    xbs,
    etag: '"fixture"',
  };
  const config = {
    ...serverConfig({ DATA_DIR: dir, CACHE_TTL_SECONDS: "60" }),
    dataDir: dir,
    cacheTtlMs: 60_000,
  };
  const stableOrigin = {
    "X-Forwarded-Host": "converter.example",
    "X-Forwarded-Proto": "https",
  };
  let calls = 0;
  let app = createAppServer({
    config,
    recoverJobs: false,
    convertOnlineSource: async () => {
      calls += 1;
      return converted;
    },
  });
  let base = await listen(app);
  context.after(async () => {
    await close(app).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const target = "https://example.com/legado.json";
  const first = await fetch(`${base}/convert.xbs?url=${encodeURIComponent(target)}`, { headers: stableOrigin });
  assert.equal(first.status, 200);
  assert.equal(calls, 1);
  await close(app);

  app = createAppServer({
    config,
    recoverJobs: false,
    convertOnlineSource: async () => {
      throw new Error("重启后不应重新下载和转换");
    },
  });
  base = await listen(app);
  const restored = await fetch(`${base}/convert.xbs?url=${encodeURIComponent(target)}`, { headers: stableOrigin });
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), xbs);
  assert.equal(calls, 1);
});

test("管理 API 需要 ADMIN_TOKEN；公开 /library 仅 done 可取", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-api-"));
  const store = createLibraryStore(dir);
  const worker = {
    enqueue() {},
    recover: async () => {},
  };
  const app = createAppServer({
    config: {
      ...serverConfig({
        ADMIN_TOKEN: "secret-token",
        DATA_DIR: dir,
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "false",
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

  const denied = await fetch(`${base}/api/jobs`);
  assert.equal(denied.status, 401);

  const listed = await fetch(`${base}/api/jobs`, {
    headers: { Authorization: "Bearer secret-token" },
  });
  assert.equal(listed.status, 200);

  const created = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: "https://example.com/legado.json", name: "t" }),
  });
  assert.equal(created.status, 202);
  const job = await created.json();
  assert.equal(job.status, "queued");

  const pending = await fetch(`${base}/library/${job.id}.xbs`);
  assert.equal(pending.status, 409);

  const xbs = encodeXbs(Buffer.from('{"ok":true}\n'));
  await store.saveArtifacts(job.id, { xbs, json: Buffer.from('{"ok":true}\n') });
  await store.updateJob(job.id, { status: "done", count: 1 });

  const ready = await fetch(`${base}/library/${job.id}.xbs`);
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await ready.arrayBuffer()), xbs);

  const ui = await fetch(`${base}/ui/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /源管理/);
});

test("未配置 ADMIN_TOKEN 时管理接口 503", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-noadmin-"));
  const app = createAppServer({
    config: {
      ...serverConfig({ ADMIN_TOKEN: "", DATA_DIR: dir }),
      adminToken: "",
      dataDir: dir,
    },
    store: createLibraryStore(dir),
    worker: { enqueue() {}, recover: async () => {} },
    recoverJobs: false,
  });
  const base = await listen(app);
  context.after(async () => {
    await close(app);
    await rm(dir, { recursive: true, force: true });
  });
  const response = await fetch(`${base}/api/jobs`);
  assert.equal(response.status, 503);
});

test("serverConfig 暴露 dataDir / adminToken / jobConcurrency", () => {
  assert.equal(serverConfig({}).dataDir, "./data");
  assert.equal(serverConfig({}).adminToken, "");
  assert.equal(serverConfig({}).jobConcurrency, 1);
  assert.equal(serverConfig({}).jobVerifyBudgetMs, 0);
  assert.equal(serverConfig({ ADMIN_TOKEN: "x", DATA_DIR: "/data", JOB_CONCURRENCY: "2" }).adminToken, "x");
  assert.equal(serverConfig({ ADMIN_TOKEN: "x", DATA_DIR: "/data", JOB_CONCURRENCY: "2" }).dataDir, "/data");
  assert.equal(serverConfig({ ADMIN_TOKEN: "x", DATA_DIR: "/data", JOB_CONCURRENCY: "2" }).jobConcurrency, 2);
  assert.equal(serverConfig({ JOB_VERIFY_BUDGET_MS: "120000" }).jobVerifyBudgetMs, 120_000);
  assert.equal(serverConfig({ JOB_VERIFY_BUDGET_MS: "0" }).jobVerifyBudgetMs, 0);
});

test("删除运行中任务会释放队列槽位并启动下一个", async () => {
  const { createJobWorker } = await import("../src/index.js");
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-cancel-"));
  const store = createLibraryStore(dir);
  let releaseHang;
  const hang = new Promise((resolve) => { releaseHang = resolve; });
  let started = 0;
  const downloadSource = async () => {
    started += 1;
    if (started === 1) {
      await hang;
      return Buffer.from("<html><title>slow</title></html>");
    }
    return Buffer.from("<html><title>fast</title><body><a href='/a'>A</a></body></html>");
  };
  const worker = createJobWorker({
    store,
    config: serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "false",
      ANALYZE_FALLBACK: "false",
      ALLOW_PRIVATE_NETWORKS: "true",
      ANALYZE_TIMEOUT_MS: "2000",
    }),
    concurrency: 1,
    downloadSource,
  });

  try {
    const first = await store.createJob({ url: "https://example.com/slow", name: "slow", mode: "site" });
    const second = await store.createJob({ url: "https://example.com/fast", name: "fast", mode: "site" });
    worker.enqueue(first.id);
    worker.enqueue(second.id);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(started, 1);
    assert.equal((await store.getJob(first.id)).status, "running");
    assert.equal((await store.getJob(second.id)).status, "queued");

    worker.cancel(first.id);
    await store.deleteJob(first.id);
    await worker.syncQueued();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(started, 2, "second job should start after cancel");
    releaseHang();
    await new Promise((r) => setTimeout(r, 300));
    const secondJob = await store.getJob(second.id);
    assert.ok(secondJob);
    assert.notEqual(secondJob.status, "queued");
  } finally {
    releaseHang?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("并发进度更新不会损坏 job JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-lock-"));
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({ url: "https://example.com/a.json" });
    await store.updateJob(job.id, { status: "running", phase: "verify" });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => store.updateJob(job.id, {
        progress: { done: i, total: 40, kept: i, skipped: 0, unverified: 0, fallback: 0, failed: 0 },
      })),
    );
    const final = await store.getJob(job.id);
    assert.equal(final.status, "running");
    assert.equal(final.progress.total, 40);
    const listed = await store.listJobs();
    assert.equal(listed[0].id, job.id);
    assert.equal(listed[0].status, "running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("进度回写不会覆盖 done 状态", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-race-"));
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({ url: "https://example.com/a.json" });
    await store.updateJob(job.id, { status: "done", count: 3 });
    const again = await store.updateJob(job.id, { progress: { done: 1, total: 10 } });
    assert.equal(again.status, "done");
    assert.equal(again.count, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publishLibraryArtifact：显式 payload 覆盖同 id 制品并带上 mediaResolution", async () => {
  const { publishLibraryArtifact, mediaPlanHasResolution, decodeMediaExtractionPlan, decodeXbs } = await import("../src/index.js");
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-publish-"));
  const fixture = JSON.parse(
    await readFile(path.resolve("sources/migrations/lian-ting.legado.json"), "utf8"),
  );
  const previousUmask = process.umask(0o077);
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({
      url: "https://example.com/legacy-remote.json",
      name: "legacy-remote",
      imageProxyBase: "https://convert.example",
    });
    // Seed a legacy href-only artifact to prove replacement.
    const staleJson = Buffer.from(`${JSON.stringify({
      stale: {
        sourceName: "stale",
        chapterContent: {
          requestInfo: "https://convert.example/adapter/media?kind=audio&plan=e30&url=%40%40result",
        },
      },
    }, null, 2)}\n`);
    await store.saveArtifacts(job.id, { xbs: encodeXbs(staleJson), json: staleJson });
    await store.updateJob(job.id, { status: "done", count: 1 });

    let seenAdapt;
    const published = await publishLibraryArtifact({
      store,
      jobId: job.id,
      source: fixture,
      config: serverConfig({
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "false",
        ANALYZE_FALLBACK: "false",
      }),
      imageProxyBase: "https://convert.example",
      verify: false,
      convertParsed: async (parsed, config, proxy, options = {}) => {
        seenAdapt = options.adapt;
        const { convertParsedSource } = await import("../src/convertOnline.js");
        return convertParsedSource(parsed, config, proxy, {
          ...options,
          adaptOnlineSources: async () => {
            throw new Error("offline publish must not adapt");
          },
          filterReachableSources: async (sources) => ({ input: sources, skipped: [] }),
          downloadSource: async () => {
            throw new Error("offline publish must not download");
          },
        });
      },
    });
    assert.equal(seenAdapt, false);
    assert.equal(published.job.id, job.id);
    assert.equal(published.job.status, "done");
    assert.equal(published.job.publishedFrom, "payload");
    assert.equal(published.job.subscribePath, `/library/${job.id}.xbs`);
    assert.ok(published.job.sourcePayloadHash);

    const payload = await store.readSourcePayload(job.id);
    assert.equal(payload.ruleContent.mediaResolution.request.url, "{{origin}}/nlinka");
    // Root-style umask 0077 must not leave payload/metadata 0600 for the service user.
    assert.equal((await stat(path.join(dir, "artifacts", `${job.id}.source.json`))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(dir, "artifacts", `${job.id}.xbs`))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(dir, "jobs", `${job.id}.json`))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(dir, "index.json"))).mode & 0o777, 0o644);

    const xbs = await store.readArtifact(job.id, "xbs");
    const sources = JSON.parse(decodeXbs(xbs).toString("utf8"));
    const converted = sources["恋听🎧💜"];
    assert.ok(converted);
    const planMatch = String(converted.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
    assert.ok(planMatch);
    const plan = decodeMediaExtractionPlan(planMatch[1], "audio");
    assert.equal(mediaPlanHasResolution(plan), true);
    assert.equal(plan.resolution.request.url, "{{origin}}/nlinka");
  } finally {
    process.umask(previousUmask);
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry 优先使用已发布 source payload，不回落缺 mediaResolution 的远程源", async () => {
  const {
    createJobWorker,
    publishLibraryArtifact,
    mediaPlanHasResolution,
    decodeMediaExtractionPlan,
    decodeXbs,
  } = await import("../src/index.js");
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-retry-payload-"));
  const fixture = JSON.parse(
    await readFile(path.resolve("sources/migrations/lian-ting.legado.json"), "utf8"),
  );
  fixture.bookSourceName = "payload-retry-audio";
  fixture.bookSourceUrl = "https://audio.fixture.example/";
  const store = createLibraryStore(dir);
  const job = await store.createJob({
    url: "https://example.com/legacy-remote-without-mediaResolution.json",
    name: "legacy-remote",
    imageProxyBase: "https://convert.example",
  });
  await store.updateJob(job.id, { status: "done", count: 0 });
  await publishLibraryArtifact({
    store,
    jobId: job.id,
    source: fixture,
    config: serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "false",
      ANALYZE_FALLBACK: "false",
    }),
    imageProxyBase: "https://convert.example",
    verify: false,
  });

  let remoteConverts = 0;
  let payloadConverts = 0;
  const worker = createJobWorker({
    store,
    config: serverConfig({
      PREFLIGHT_SOURCES: "false",
      VERIFY_CONVERTED_SOURCES: "false",
      ANALYZE_FALLBACK: "false",
    }),
    concurrency: 1,
    downloadSource: async () => {
      throw new Error("retry must not download when a source payload is present");
    },
    convertOnline: async () => {
      remoteConverts += 1;
      throw new Error("retry must not convert the legacy remote URL");
    },
    convertParsed: async (parsed, _config, _proxy, options = {}) => {
      payloadConverts += 1;
      assert.equal(parsed.ruleContent.mediaResolution.request.url, "{{origin}}/nlinka");
      // Payload retries must stay offline: never re-run adaptOnlineSources.
      assert.equal(options.adapt, false);
      const json = Buffer.from(`${JSON.stringify({
        "payload-retry-audio": {
          sourceName: "payload-retry-audio",
          chapterContent: {
            requestInfo: "https://convert.example/adapter/media?kind=audio&plan=eyJ2ZXJzaW9uIjoxLCJraW5kIjoiYXVkaW8iLCJwcm9wZXJ0aWVzIjpbInVybCJdLCJhdHRyaWJ1dGVzIjpbXSwidXJsSGludHMiOltdLCJyZXNvbHV0aW9uIjp7ImV4dHJhY3QiOlt7Im5hbWUiOiJ4dCIsInNvdXJjZSI6Im1ldGEiLCJrZXkiOiJfYyJ9XSwicmVxdWVzdCI6eyJ1cmwiOiJ7e29yaWdpbn19L25saW5rYSIsIm1ldGhvZCI6IlBPU1QifSwicmVzcG9uc2UiOnsicHJvcGVydGllcyI6WyJ1cmwiXX19fQ&url=",
          },
        },
      }, null, 2)}\n`);
      return {
        sources: JSON.parse(json.toString("utf8")),
        warnings: [],
        skipped: [],
        count: 1,
        fallbackCount: 0,
        unverifiedCount: 0,
        skippedBuckets: {},
        json,
        xbs: encodeXbs(json),
      };
    },
  });

  try {
    await store.updateJob(job.id, {
      status: "queued",
      phase: "queued",
      error: "",
      finishedAt: null,
      startedAt: null,
      count: null,
      progress: { done: 0, total: 0, kept: 0, skipped: 0, unverified: 0, fallback: 0, failed: 0 },
    });
    worker.enqueue(job.id);
    const deadline = Date.now() + 5_000;
    let next;
    while (Date.now() < deadline) {
      next = await store.getJob(job.id);
      if (next.status === "done" || next.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(next.status, "done", next.error || next.status);
    assert.equal(remoteConverts, 0);
    assert.equal(payloadConverts, 1);
    const xbs = await store.readArtifact(job.id, "xbs");
    const sources = JSON.parse(decodeXbs(xbs).toString("utf8"));
    const converted = sources["payload-retry-audio"];
    assert.ok(converted);
    const planMatch = String(converted.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
    assert.ok(planMatch);
    assert.equal(mediaPlanHasResolution(decodeMediaExtractionPlan(planMatch[1], "audio")), true);
  } finally {
    worker.cancel?.(job.id);
    await rm(dir, { recursive: true, force: true });
  }
});

test("publishLibraryArtifact：verify=true 才允许 adapt", async () => {
  const { publishLibraryArtifact } = await import("../src/index.js");
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-publish-adapt-"));
  const fixture = JSON.parse(
    await readFile(path.resolve("sources/migrations/lian-ting.legado.json"), "utf8"),
  );
  fixture.bookSourceName = "verify-adapt-audio";
  fixture.bookSourceUrl = "https://audio.fixture.example/";
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({
      url: "https://example.com/legacy-remote.json",
      name: "legacy-remote",
      imageProxyBase: "https://convert.example",
    });
    let seenAdapt;
    let adapted = false;
    await publishLibraryArtifact({
      store,
      jobId: job.id,
      source: fixture,
      config: serverConfig({
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "false",
        ANALYZE_FALLBACK: "false",
      }),
      imageProxyBase: "https://convert.example",
      verify: true,
      convertParsed: async (parsed, config, proxy, options = {}) => {
        seenAdapt = options.adapt;
        const { convertParsedSource } = await import("../src/convertOnline.js");
        return convertParsedSource(parsed, config, proxy, {
          ...options,
          adaptOnlineSources: async (input) => {
            adapted = true;
            return input;
          },
          filterReachableSources: async (sources) => ({ input: sources, skipped: [] }),
          downloadSource: async () => Buffer.from("{}"),
        });
      },
    });
    assert.equal(seenAdapt, true);
    assert.equal(adapted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("convert/publish：opaque 正文仍捕获嵌套 ruleContent.mediaResolution", async () => {
  const {
    convertLegado,
    publishLibraryArtifact,
    mediaPlanHasResolution,
    decodeMediaExtractionPlan,
    decodeXbs,
    declaredMediaResolution,
  } = await import("../src/index.js");
  const fixture = JSON.parse(
    await readFile(path.resolve("sources/migrations/lian-ting.legado.json"), "utf8"),
  );
  // Opaque content cannot compile a resolution from JS; only the nested
  // ruleContent.mediaResolution declaration may populate the generic plan.
  const source = {
    bookSourceName: "声明式有声",
    bookSourceUrl: "https://audio.fixture.example/",
    bookSourceType: 1,
    searchUrl: "https://audio.fixture.example/search?q={{key}}",
    ruleSearch: { bookList: "li", name: "a", bookUrl: "a@href" },
    ruleBookInfo: { name: "h1" },
    ruleToc: { chapterList: "li", chapterName: "a", chapterUrl: "a@href" },
    ruleContent: {
      content: "<js>result</js>",
      sourceRegex: ".*\\.(mp3|m4a).*",
      mediaResolution: fixture.ruleContent.mediaResolution,
    },
  };
  assert.equal(declaredMediaResolution(source).request.url, "{{origin}}/nlinka");
  assert.equal(source.read2xsgg?.mediaResolution, undefined);

  const convertedOffline = convertLegado(source, {
    imageProxyBase: "https://convert.example",
    omitNonPortable: true,
  });
  const offline = convertedOffline.sources["声明式有声"];
  assert.ok(offline);
  const offlineMatch = String(offline.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(offlineMatch);
  const offlinePlan = decodeMediaExtractionPlan(offlineMatch[1], "audio");
  assert.equal(mediaPlanHasResolution(offlinePlan), true);
  assert.equal(offlinePlan.resolution.request.url, "{{origin}}/nlinka");
  assert.deepEqual(offlinePlan.resolution.response.properties, ["url", "ourl"]);

  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-nested-mr-"));
  try {
    const store = createLibraryStore(dir);
    const job = await store.createJob({
      url: "https://example.com/legacy-remote.json",
      name: "legacy-remote",
      imageProxyBase: "https://convert.example",
    });
    await store.updateJob(job.id, { status: "done", count: 0 });
    const published = await publishLibraryArtifact({
      store,
      jobId: job.id,
      source,
      config: serverConfig({
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "false",
        ANALYZE_FALLBACK: "false",
      }),
      imageProxyBase: "https://convert.example",
      verify: false,
    });
    assert.equal(published.job.publishedFrom, "payload");
    const payload = await store.readSourcePayload(job.id);
    assert.equal(payload.ruleContent.mediaResolution.request.url, "{{origin}}/nlinka");
    assert.equal(payload.read2xsgg?.mediaResolution, undefined);

    const xbs = await store.readArtifact(job.id, "xbs");
    const sources = JSON.parse(decodeXbs(xbs).toString("utf8"));
    const converted = sources["声明式有声"];
    assert.ok(converted);
    const planMatch = String(converted.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
    assert.ok(planMatch);
    const plan = decodeMediaExtractionPlan(planMatch[1], "audio");
    assert.equal(mediaPlanHasResolution(plan), true);
    assert.equal(plan.resolution.request.url, "{{origin}}/nlinka");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("管理 API publish 用声明式 source 覆盖制品", async (context) => {
  const { mediaPlanHasResolution, decodeMediaExtractionPlan, decodeXbs } = await import("../src/index.js");
  const dir = await mkdtemp(path.join(tmpdir(), "read2xsgg-publish-api-"));
  const store = createLibraryStore(dir);
  const fixture = JSON.parse(
    await readFile(path.resolve("sources/migrations/lian-ting.legado.json"), "utf8"),
  );
  // Swap fixture identity so the test proves the path is payload-driven, not name/domain keyed.
  fixture.bookSourceName = "迁移示例听书";
  fixture.bookSourceUrl = "https://audio.fixture.example/";
  const worker = { enqueue() {}, recover: async () => {}, cancel() {} };
  const app = createAppServer({
    config: {
      ...serverConfig({
        ADMIN_TOKEN: "secret-token",
        DATA_DIR: dir,
        PREFLIGHT_SOURCES: "false",
        VERIFY_CONVERTED_SOURCES: "false",
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

  const created = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: "https://example.com/legacy.json", name: "legacy" }),
  });
  assert.equal(created.status, 202);
  const job = await created.json();
  await store.updateJob(job.id, { status: "done", count: 1 });

  const published = await fetch(`${base}/api/jobs/${job.id}/publish`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: fixture }),
  });
  assert.equal(published.status, 200);
  const next = await published.json();
  assert.equal(next.id, job.id);
  assert.equal(next.publishedFrom, "payload");

  const ready = await fetch(`${base}/library/${job.id}.xbs`);
  assert.equal(ready.status, 200);
  const sources = JSON.parse(decodeXbs(Buffer.from(await ready.arrayBuffer())).toString("utf8"));
  const converted = sources["迁移示例听书"];
  assert.ok(converted);
  const planMatch = String(converted.chapterContent.requestInfo).match(/plan=([A-Za-z0-9_-]+)/);
  assert.ok(planMatch);
  assert.equal(mediaPlanHasResolution(decodeMediaExtractionPlan(planMatch[1], "audio")), true);
});
