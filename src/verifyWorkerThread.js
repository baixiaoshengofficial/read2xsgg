import { parentPort, workerData } from "node:worker_threads";
import { downloadSource } from "./server.js";
import { applyVerifyAndAnalyzeFallbackSingle } from "./pipeline.js";

if (!parentPort) throw new Error("verify worker requires parentPort");

const config = workerData?.config || {};

parentPort.on("message", async (message) => {
  if (message?.type === "close") {
    parentPort.close();
    return;
  }
  if (message?.type !== "source") return;

  const options = message.options || {};
  // The preflight timeout is intentionally short and only applies to the
  // origin probe. Worker verification must use the request timeout selected by
  // the complete list → detail → chapter → content chain; otherwise every
  // slow-but-live source is discarded at the CPU-worker boundary.
  const requestTimeoutMs = Math.max(
    1,
    Number(options.timeoutMs)
      || Number(config.jobVerifyRequestTimeoutMs)
      || Number(config.verifyRequestTimeoutMs)
      || Number(config.preflightConfirmTimeoutMs)
      || Number(config.analyzeTimeoutMs)
      || 10_000,
  );
  const download = (url, headers = {}, requestOptions = {}) => downloadSource(
    url,
    { ...config, fetchTimeoutMs: requestTimeoutMs },
    headers,
    requestOptions,
  );
  try {
    const result = await applyVerifyAndAnalyzeFallbackSingle(
      { [message.name]: message.source },
      {
        ...options,
        download,
        concurrency: 1,
        workerPoolEnabled: false,
        workerConfig: null,
        onProgress: (progress) => {
          parentPort.postMessage({
            type: "progress",
            id: message.id,
            progress,
          });
        },
      },
    );
    parentPort.postMessage({ type: "result", id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      id: message.id,
      error: error?.message || String(error),
    });
  }
});
