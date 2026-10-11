import { workerData } from "node:worker_threads";
import { createLibraryStore } from "./libraryStore.js";
import { runLibraryJob } from "./jobRunner.js";
import { downloadSource } from "./server.js";

const { jobId, config } = workerData || {};
if (!jobId || !config) throw new Error("job worker thread requires jobId and config");

await runLibraryJob({
  store: createLibraryStore(config.dataDir),
  config,
  jobId,
  downloadSource,
});
