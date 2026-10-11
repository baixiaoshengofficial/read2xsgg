import { parentPort, workerData } from "node:worker_threads";
import { downloadSource } from "./server.js";
import { applyVerifyAndAnalyzeFallbackSingle } from "./pipeline.js";

if (!parentPort) throw new Error("verify worker requires parentPort");

const config = workerData?.config || {};
const download = (url, headers = {}, requestOptions = {}) => downloadSource(
  url,
  {
    ...config,
    fetchTimeoutMs: Math.max(Number(config.preflightTimeoutMs) || 1_000, 1_000),
  },
  headers,
  requestOptions,
);

parentPort.on("message", async (message) => {
  if (message?.type === "close") {
    parentPort.close();
    return;
  }
  if (message?.type !== "source") return;

  const options = message.options || {};
  try {
    const result = await applyVerifyAndAnalyzeFallbackSingle(
      { [message.name]: message.source },
      {
        ...options,
        aiSettings: config.aiSettings || null,
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
