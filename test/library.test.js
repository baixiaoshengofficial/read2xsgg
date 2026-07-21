import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    await store.updateJob(job.id, { status: "done", count: 1 });

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
