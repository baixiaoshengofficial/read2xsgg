import { parentPort, workerData } from "node:worker_threads";
import { executeBridgePlan, executeBridgeSelector } from "./bridgePlan.js";

if (!parentPort) throw new Error("bridge worker requires parentPort");

try {
  const task = workerData || {};
  const result = task.mode === "selector"
    ? executeBridgeSelector(
      task.body,
      task.baseUrl,
      task.responseType,
      task.selector,
      task.options || {},
    )
    : executeBridgePlan(
      task.body,
      task.baseUrl,
      task.plan,
      task.options || {},
    );
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.message || String(error),
  });
}
