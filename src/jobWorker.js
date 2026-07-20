import { convertOnlineSource } from "./convertOnline.js";
import { analyzeSite } from "./siteAnalyze/index.js";
import { encodeXbs } from "./xbs.js";

/**
 * In-process queue that runs full verify conversions and persists results.
 */
export function createJobWorker({ store, config, concurrency = 1, downloadSource } = {}) {
  if (!store) throw new Error("createJobWorker requires a library store");
  if (typeof downloadSource !== "function") throw new Error("createJobWorker requires downloadSource");
  const maxConcurrent = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];
  let pumping = false;

  function enqueue(jobId) {
    if (!jobId) return;
    if (!queue.includes(jobId)) queue.push(jobId);
    void pump();
  }

  async function recover() {
    const recoverable = await store.listRecoverableJobs();
    for (const job of recoverable) {
      if (job.status === "running") {
        await store.updateJob(job.id, {
          status: "queued",
          error: "",
          progress: { done: 0, total: 0, kept: 0, skipped: 0, unverified: 0, fallback: 0, failed: 0 },
        });
      }
      enqueue(job.id);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (active < maxConcurrent && queue.length) {
        const jobId = queue.shift();
        active += 1;
        void runJob(jobId).finally(() => {
          active -= 1;
          void pump();
        });
      }
    } finally {
      pumping = false;
    }
  }

  async function runJob(jobId) {
    const job = await store.getJob(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;

    await store.updateJob(jobId, {
      status: "running",
      startedAt: job.startedAt || new Date().toISOString(),
      error: "",
    });

    const onProgress = async (progress) => {
      try {
        await store.updateJob(jobId, { progress });
      } catch {
        // Ignore progress write races.
      }
    };

    try {
      let result;
      if (job.mode === "site") {
        const download = (url, headers = {}) => downloadSource(
          url,
          { ...config, fetchTimeoutMs: config.analyzeTimeoutMs },
          headers,
        );
        const analyzed = await analyzeSite(job.sourceUrl, {
          download,
          timeoutMs: config.analyzeTimeoutMs,
          sourceName: job.title || undefined,
        });
        if (!analyzed.ok) throw new Error(analyzed.reason || "自动识站失败");
        const sources = analyzed.sources || { [analyzed.source.sourceName]: analyzed.source };
        const count = Object.keys(sources).length;
        const json = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`, "utf8");
        const xbs = encodeXbs(json);
        result = {
          sources,
          warnings: analyzed.warnings || (analyzed.warning ? [analyzed.warning] : []),
          skipped: [],
          count,
          fallbackCount: count,
          skippedBuckets: {},
          json,
          xbs,
        };
        await onProgress({ done: count, total: count, kept: count, skipped: 0, unverified: 0, fallback: count, failed: 0 });
      } else {
        const jobConfig = {
          ...config,
          verifyConvertedSources: true,
        };
        result = await convertOnlineSource(
          job.sourceUrl,
          jobConfig,
          job.imageProxyBase || "",
          { fullVerify: true, analyzeFallback: true, onProgress },
        );
      }

      await store.saveArtifacts(jobId, { xbs: result.xbs, json: result.json });
      await store.updateJob(jobId, {
        status: "done",
        count: result.count,
        fallbackCount: result.fallbackCount || 0,
        skippedBuckets: result.skippedBuckets || {},
        error: "",
        finishedAt: new Date().toISOString(),
        progress: {
          done: result.count,
          total: result.count + (result.skipped?.length || 0),
          kept: result.count,
          skipped: result.skipped?.length || 0,
          unverified: 0,
          fallback: result.fallbackCount || 0,
          failed: 0,
        },
      });
    } catch (error) {
      await store.updateJob(jobId, {
        status: "failed",
        error: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  return {
    enqueue,
    recover,
    get active() { return active; },
    get queued() { return queue.length; },
  };
}
