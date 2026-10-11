import { Worker } from "node:worker_threads";
import { convertOnlineSource, convertParsedSource } from "./convertOnline.js";
import { runLibraryJob } from "./jobRunner.js";

/**
 * Persistent queue that converts, verifies, and persists source artifacts.
 * Production uses a Worker Thread per active job by default so a large or
 * pathological conversion cannot starve the HTTP event loop. Tests may keep
 * the in-process path when injecting fake converters/downloaders.
 *
 * Deleting a running job cancels it and frees the concurrency slot so the
 * next queued job can start immediately.
 */
export function createJobWorker({
  store,
  config,
  concurrency = 1,
  downloadSource,
  convertParsed = convertParsedSource,
  convertOnline = convertOnlineSource,
  isolate = false,
} = {}) {
  if (!store) throw new Error("createJobWorker requires a library store");
  if (typeof downloadSource !== "function") throw new Error("createJobWorker requires downloadSource");
  const maxConcurrent = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];
  const cancelled = new Set();
  /** @type {Map<string, { freed: boolean, worker?: Worker }>} */
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
    const handle = running.get(jobId);
    if (handle?.worker) void handle.worker.terminate();
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

  async function pause(jobId) {
    if (!jobId) return null;
    const job = await store.getJob(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return job;
    cancelled.add(jobId);
    removeFromQueue(jobId);
    const handle = running.get(jobId);
    if (handle?.worker) await handle.worker.terminate().catch(() => {});
    releaseSlot(jobId);
    const paused = await store.updateJob(jobId, {
      status: "paused",
      phase: "paused",
      error: "",
      pausedAt: new Date().toISOString(),
    });
    if (!handle) cancelled.delete(jobId);
    void pump();
    return paused;
  }

  async function pauseRecoverable() {
    const recoverable = await store.listRecoverableJobs();
    const paused = [];
    for (const job of recoverable) {
      const next = await store.updateJob(job.id, {
        status: "paused",
        phase: "paused",
        error: "",
        pausedAt: new Date().toISOString(),
      });
      paused.push(next);
    }
    return paused;
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

  async function runIsolatedJob(jobId) {
    const worker = new Worker(new URL("./jobWorkerThread.js", import.meta.url), {
      workerData: { jobId, config },
    });
    const handle = running.get(jobId);
    if (handle) handle.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      worker.once("error", (error) => {
        if (!isCancelled(jobId)) {
          void store.updateJob(jobId, {
            status: "failed",
            phase: "failed",
            error: `任务工作线程异常：${error.message || error}`,
            finishedAt: new Date().toISOString(),
          });
        }
        settle(reject, error);
      });
      worker.once("exit", (code) => {
        if (code !== 0 && !isCancelled(jobId)) {
          const error = new Error(`任务工作线程退出（code ${code}）`);
          void store.updateJob(jobId, {
            status: "failed",
            phase: "failed",
            error: error.message,
            finishedAt: new Date().toISOString(),
          });
          settle(reject, error);
          return;
        }
        settle(resolve);
      });
    });
  }

  async function runJob(jobId) {
    if (isolate) {
      return runIsolatedJob(jobId).finally(() => {
        cancelled.delete(jobId);
      });
    }
    return runLibraryJob({
      store,
      config,
      jobId,
      downloadSource,
      convertParsed,
      convertOnline,
      isCancelled: () => isCancelled(jobId),
    }).finally(() => {
      cancelled.delete(jobId);
    });
  }

  return {
    enqueue,
    cancel,
    pause,
    pauseRecoverable,
    recover,
    syncQueued,
    get active() { return active; },
    get queued() { return queue.length; },
  };
}
