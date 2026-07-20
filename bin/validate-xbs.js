#!/usr/bin/env node
import { loadXbsSources, runXbsPipeline } from "../src/xbsRuntime.js";

const args = process.argv.slice(2);
const location = args.find((value) => !value.startsWith("-"));
const all = args.includes("--all");
const noMedia = args.includes("--no-media");
const optionValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const positional = args.filter((value, index) => !value.startsWith("-")
  && !["--limit", "--concurrency", "--timeout"].includes(args[index - 1]));
const requestedSource = positional[1] || "";
if (!location) {
  console.error("用法: read2xsgg-validate <文件.xbs|https://...xbs> [源名称] [--all] [--limit N] [--concurrency N] [--timeout MS] [--no-media]");
  process.exit(2);
}

try {
  const sources = await loadXbsSources(location);
  const entries = requestedSource
    ? Object.entries(sources).filter(([name, source]) => name === requestedSource || source.sourceName === requestedSource)
    : (all ? Object.entries(sources) : Object.entries(sources).slice(0, 1));
  if (!entries.length) throw new Error(`找不到源：${requestedSource}`);
  const limit = Math.max(1, optionValue("--limit", entries.length));
  const concurrency = Math.max(1, Math.min(16, optionValue("--concurrency", 4)));
  const timeoutMs = Math.max(1_000, optionValue("--timeout", 20_000));
  const queue = entries.slice(0, limit);
  const reports = new Array(queue.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      reports[index] = await runXbsPipeline(queue[index][1], { timeoutMs, fetchMedia: !noMedia });
    }
  }));
  if (!all && reports.length === 1) console.log(JSON.stringify(reports[0], null, 2));
  else {
    const passed = reports.filter((report) => report.ok).length;
    console.log(JSON.stringify({ total: reports.length, passed, failed: reports.length - passed, reports }, null, 2));
  }
  if (reports.some((report) => !report.ok)) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
