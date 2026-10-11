import { Worker } from "node:worker_threads";
import { availableParallelism, cpus } from "node:os";

const DEFAULT_CONCURRENCY = Math.max(
  1,
  Math.min(
    2,
    Number(typeof availableParallelism === "function" ? availableParallelism() : cpus().length) || 1,
  ),
);
const WORKER_URL = new URL("./bridgeWorkerThread.js", import.meta.url);

function workerExecArgv() {
  // The test/runtime harness may inject V8 flags that Worker rejects even
  // though the parent process accepts them. The worker is ESM through the
  // package boundary, so it does not need inherited exec arguments.
  return [];
}

function asError(value, fallback = "桥接 Worker 执行失败") {
  return value instanceof Error ? value : new Error(String(value || fallback));
}

/**
 * Execute DOM/XPath bridge plans outside the HTTP event loop.
 *
 * Bridge plans are intentionally data-only, so they can cross a Worker
 * boundary without sharing server state. A task is discarded with its Worker
 * when it exceeds the CPU budget; an upstream source can therefore never pin
 * the HTTP process indefinitely.
 */
export function createBridgeExecutor({
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = 12_000,
} = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY));
  const defaultTimeoutMs = Math.max(1_000, Number(timeoutMs) || 12_000);
  const queue = [];
  const running = new Set();
  let nextId = 1;
  let closed = false;

  function removeQueued(entry) {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  function finish(entry, error, value) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    running.delete(entry);
    if (entry.worker) void entry.worker.terminate();
    if (error) entry.reject(asError(error));
    else entry.resolve(value);
    pump();
  }

  function abortEntry(entry, reason = "桥接 Worker 已取消") {
    if (!entry || entry.settled) return;
    if (removeQueued(entry)) {
      finish(entry, reason);
      return;
    }
    finish(entry, reason);
  }

  function start(entry) {
    running.add(entry);
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: entry.task,
        execArgv: workerExecArgv(),
      });
    } catch (error) {
      finish(entry, error);
      return;
    }
    entry.worker = worker;
    worker.once("message", (message) => {
      if (message?.ok) finish(entry, null, message.result);
      else finish(entry, message?.error || "桥接 Worker 执行失败");
    });
    worker.once("error", (error) => finish(entry, error));
    worker.once("exit", (code) => {
      if (!entry.settled && code !== 0) {
        finish(entry, new Error("桥接 Worker 退出（code " + code + "）"));
      } else if (!entry.settled) {
        finish(entry, new Error("桥接 Worker 未返回结果"));
      }
    });
    entry.timer = setTimeout(() => {
      finish(entry, new Error("桥接规则执行超时（" + entry.timeoutMs + "ms）"));
    }, entry.timeoutMs);
  }

  function pump() {
    if (closed) return;
    while (running.size < limit && queue.length) start(queue.shift());
  }

  function run(task, { signal, timeoutMs: taskTimeoutMs } = {}) {
    if (closed) return Promise.reject(new Error("桥接执行器已关闭"));
    if (signal?.aborted) return Promise.reject(asError(signal.reason, "桥接 Worker 已取消"));
    const entry = {
      id: nextId++,
      task,
      timeoutMs: Math.max(1_000, Number(taskTimeoutMs) || defaultTimeoutMs),
      signal,
      timer: null,
      worker: null,
      settled: false,
      resolve: null,
      reject: null,
      abort: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.abort = () => abortEntry(entry, signal?.reason || "桥接 Worker 已取消");
    signal?.addEventListener("abort", entry.abort, { once: true });
    queue.push(entry);
    pump();
    return promise;
  }

  function executePlan(body, baseUrl, plan, options = {}, runOptions = {}) {
    return run({
      mode: "plan",
      body: typeof body === "string" ? body : String(body || ""),
      baseUrl: String(baseUrl || ""),
      plan,
      options,
    }, runOptions);
  }

  function executeSelector(body, baseUrl, responseType, selector, options = {}, runOptions = {}) {
    return run({
      mode: "selector",
      body: typeof body === "string" ? body : String(body || ""),
      baseUrl: String(baseUrl || ""),
      responseType,
      selector,
      options,
    }, runOptions);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of [...queue]) finish(entry, "桥接执行器已关闭");
    for (const entry of [...running]) finish(entry, "桥接执行器已关闭");
  }

  return {
    executePlan,
    executeSelector,
    close,
    get pending() {
      return queue.length + running.size;
    },
  };
}
