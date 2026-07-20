import { convertOnlineSource } from "./convertOnline.js";
import { analyzeSite } from "./siteAnalyze/index.js";
import { encodeXbs } from "./xbs.js";

/**
 * In-process queue that runs full verify conversions and persists results.
 *
 * Deleting a running job cancels it and frees the concurrency slot so the
 * next queued job can start immediately.
 */
export function createJobWorker({ store, config, concurrency = 1, downloadSource } = {}) {
  if (!store) throw new Error("createJobWorker requires a library store");
  if (typeof downloadSource !== "function") throw new Error("createJobWorker requires downloadSource");
  const maxConcurrent = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];
  const cancelled = new Set();
  /** @type {Map<string, { freed: boolean }>} */
  const running = new Map();
  let pumping = false;

  function removeFromQueue(jobId) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i] === jobId) queue.splice(i, 1);
    }
  }

  function releaseSlot(jobId) {
    const handle = running.get(jobId);
    if (!handle || handle.freed) return false;
    handle.freed = true;
    active = Math.max(0, active - 1);
    return true;
  }

  function enqueue(jobId) {
    if (!jobId) return;
    cancelled.delete(jobId);
    if (!queue.includes(jobId) && !running.has(jobId)) queue.push(jobId);
    void pump();
  }

  /**
   * Cancel a job: drop from pending queue and free the slot if it is running.
   * In-flight conversion may continue in the background but its result is ignored.
   */
  function cancel(jobId) {
    if (!jobId) return;
    cancelled.add(jobId);
    removeFromQueue(jobId);
    if (releaseSlot(jobId)) void pump();
    else void pump();
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

  /** Re-enqueue any disk-queued jobs missing from the in-memory queue. */
  async function syncQueued() {
    const recoverable = await store.listRecoverableJobs();
    for (const job of recoverable) {
      if (job.status !== "queued") continue;
      if (running.has(job.id) || cancelled.has(job.id)) continue;
      if (!queue.includes(job.id)) queue.push(job.id);
    }
    void pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (active < maxConcurrent && queue.length) {
        const jobId = queue.shift();
        if (!jobId || cancelled.has(jobId)) continue;
        active += 1;
        running.set(jobId, { freed: false });
        void runJob(jobId).finally(() => {
          if (releaseSlot(jobId)) {
            // slot was still held
          }
          running.delete(jobId);
          void pump();
        });
      }
    } finally {
      pumping = false;
    }
  }

  function isCancelled(jobId) {
    return cancelled.has(jobId);
  }

  async function runJob(jobId) {
    try {
      if (isCancelled(jobId)) return;
      const job = await store.getJob(jobId);
      if (!job || (job.status !== "queued" && job.status !== "running")) return;
      if (isCancelled(jobId)) return;

      await store.updateJob(jobId, {
        status: "running",
        phase: "download",
        startedAt: job.startedAt || new Date().toISOString(),
        error: "",
      });

      const onProgress = async (progress) => {
        if (isCancelled(jobId)) return;
        try {
          await store.updateJob(jobId, { progress, phase: "verify" });
        } catch {
          // Ignore progress write races.
        }
      };

      let result;
      if (job.mode === "site") {
        await store.updateJob(jobId, { phase: "analyze" });
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
        if (isCancelled(jobId)) return;
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
        await store.updateJob(jobId, { phase: "convert" });
        const jobConfig = {
          ...config,
          verifyConvertedSources: true,
        };
        result = await convertOnlineSource(
          job.sourceUrl,
          jobConfig,
          job.imageProxyBase || "",
          {
            fullVerify: true,
            analyzeFallback: true,
            downloadSource,
            onProgress: (progress) => {
              if (isCancelled(jobId)) return;
              return onProgress(progress);
            },
          },
        );
      }

      if (isCancelled(jobId)) return;

      await store.updateJob(jobId, { phase: "save" });
      await store.saveArtifacts(jobId, { xbs: result.xbs, json: result.json });
      await store.updateJob(jobId, {
        status: "done",
        phase: "done",
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
      if (isCancelled(jobId)) return;
      try {
        await store.updateJob(jobId, {
          status: "failed",
          phase: "failed",
          error: error?.message || String(error),
          finishedAt: new Date().toISOString(),
        });
      } catch {
        // Job may have been deleted.
      }
    } finally {
      cancelled.delete(jobId);
    }
  }

  return {
    enqueue,
    cancel,
    recover,
    syncQueued,
    get active() { return active; },
    get queued() { return queue.length; },
  };
}
