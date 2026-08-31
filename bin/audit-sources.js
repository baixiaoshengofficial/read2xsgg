#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { applyVerifyAndAnalyzeFallback } from "../src/pipeline.js";
import { createSourceDownloader, serverConfig } from "../src/server.js";
import { verifyConvertedSource } from "../src/verifySource.js";
import { validateXiangseSource } from "../src/xiangseValidate.js";

function parseArguments(argv) {
  const options = {
    concurrency: 16,
    sourceTimeoutMs: 15_000,
    requestTimeoutMs: 3_000,
    maxSources: 0,
    adapterBase: process.env.AUDIT_ADAPTER_BASE || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index];
    else if (value === "--report") options.report = argv[++index];
    else if (value === "--passed") options.passed = argv[++index];
    else if (value === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (value === "--source-timeout-ms") options.sourceTimeoutMs = Number(argv[++index]);
    else if (value === "--request-timeout-ms") options.requestTimeoutMs = Number(argv[++index]);
    else if (value === "--max-sources") options.maxSources = Number(argv[++index]);
    else if (value === "--adapter-base") options.adapterBase = String(argv[++index] || "");
    else if (value === "--repair") options.repair = true;
    else if (value === "--isolate") options.isolate = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (options.help) return options;
  if (!options.input || !options.report) throw new Error("需要 --input 和 --report");
  for (const field of ["concurrency", "sourceTimeoutMs", "requestTimeoutMs"]) {
    if (!Number.isFinite(options[field]) || options[field] <= 0) throw new Error(`${field} 必须大于 0`);
  }
  options.concurrency = Math.min(64, Math.floor(options.concurrency));
  if (!Number.isFinite(options.maxSources) || options.maxSources < 0) throw new Error("maxSources 不能小于 0");
  options.maxSources = Math.floor(options.maxSources);
  return options;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function runChild(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 4_000) errorText += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, detail: error.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : -1,
        detail: errorText.trim() || (signal ? `子进程被 ${signal} 终止` : ""),
      });
    });
  });
}

function summaryFor(total, reports, startedAt) {
  const values = Object.values(reports);
  const passed = values.filter((item) => item?.ok).length;
  const reasons = {};
  for (const item of values) {
    if (item?.ok) continue;
    const key = String(item?.reason || "unknown");
    reasons[key] = (reasons[key] || 0) + 1;
  }
  return {
    total,
    done: values.length,
    passed,
    failed: values.length - passed,
    pending: total - values.length,
    rate: values.length ? Number((passed / values.length * 100).toFixed(1)) : 0,
    elapsedMs: Date.now() - startedAt,
    reasons: Object.fromEntries(Object.entries(reasons).sort((left, right) => right[1] - left[1])),
  };
}

function strictElementReport(verified) {
  const missing = [...new Set([
    ...(verified?.bookElements?.missingRecommended || []),
    ...(verified?.derivedRecommended || []),
  ])];
  if (!verified?.ok || !missing.length) return verified;
  return {
    ...verified,
    ok: false,
    reason: "rules-stale: invalid-elements",
    detail: `书籍推荐元素缺失：${missing.join("、")}`,
  };
}

async function runIsolatedAudit(options, sources, previous) {
  const mode = options.repair ? "repair" : "verify";
  const compatible = previous?.mode === mode;
  const reports = compatible && previous?.reports && typeof previous.reports === "object"
    ? previous.reports
    : {};
  const repairedSources = compatible && previous?.repairedSources
    && typeof previous.repairedSources === "object"
    ? previous.repairedSources
    : {};
  const candidateSources = compatible && previous?.candidateSources
    && typeof previous.candidateSources === "object"
    ? previous.candidateSources
    : {};
  const pending = Object.entries(sources).filter(([name]) => !Object.hasOwn(reports, name));
  const entries = options.maxSources > 0 ? pending.slice(0, options.maxSources) : pending;
  const total = Object.keys(sources).length;
  const startedAt = Date.now();
  const temporaryDir = path.resolve(`${options.report}.isolated-${process.pid}`);
  await mkdir(temporaryDir, { recursive: true });
  let cursor = 0;
  let saveTail = Promise.resolve();
  const persist = () => {
    const payload = {
      version: 2,
      mode,
      updatedAt: new Date().toISOString(),
      summary: summaryFor(total, reports, startedAt),
      reports,
      ...(options.repair ? { repairedSources } : {}),
      ...(options.repair ? { candidateSources } : {}),
    };
    saveTail = saveTail.then(() => writeJsonAtomic(options.report, payload));
    return saveTail;
  };
  const workers = Array.from({ length: Math.min(options.concurrency, entries.length || 1) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = entries[index];
      const inputFile = path.join(temporaryDir, `${index}.input.json`);
      const reportFile = path.join(temporaryDir, `${index}.report.json`);
      await writeFile(inputFile, `${JSON.stringify({ [name]: source }, null, 2)}\n`, "utf8");
      const args = [
        path.resolve(process.argv[1]),
        "--input", inputFile,
        "--report", reportFile,
        "--concurrency", "1",
        "--source-timeout-ms", String(options.sourceTimeoutMs),
        "--request-timeout-ms", String(options.requestTimeoutMs),
      ];
      if (options.repair) args.push("--repair");
      if (options.adapterBase) args.push("--adapter-base", options.adapterBase);
      const child = await runChild(args, options.sourceTimeoutMs + 15_000);
      const childReport = await readJson(reportFile, null);
      if (childReport?.reports?.[name]) {
        reports[name] = childReport.reports[name];
        if (childReport.repairedSources?.[name]) repairedSources[name] = childReport.repairedSources[name];
        if (childReport.candidateSources?.[name]) candidateSources[name] = childReport.candidateSources[name];
      } else {
        reports[name] = {
          ok: false,
          reason: "verify-error",
          detail: `隔离审计子进程失败（exit=${child.code}）：${child.detail || "没有生成报告"}`,
        };
      }
      await persist();
      const current = summaryFor(total, reports, startedAt);
      process.stderr.write(
        `audit ${current.done}/${total} passed=${current.passed} rate=${current.rate}% pending=${current.pending}\n`,
      );
    }
  });
  try {
    await Promise.all(workers);
    await persist();
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  if (options.passed) {
    const passed = Object.fromEntries(Object.entries(sources)
      .filter(([name]) => reports[name]?.ok)
      .map(([name, source]) => [name, repairedSources[name] || source]));
    await writeJsonAtomic(options.passed, passed);
  }
  process.stdout.write(`${JSON.stringify(summaryFor(total, reports, startedAt), null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("audit-sources --input converted.json --report audit.json [--passed passed.json] [--repair] [--isolate] [--adapter-base https://host] [--max-sources 25]\n");
    return;
  }
  const sources = await readJson(options.input, null);
  if (!sources || Array.isArray(sources) || typeof sources !== "object") throw new Error("输入必须是香色源对象");
  const previous = await readJson(options.report, {});
  if (options.isolate) {
    await runIsolatedAudit(options, sources, previous);
    return;
  }
  const mode = options.repair ? "repair" : "verify";
  const compatible = previous?.mode === mode;
  const reports = compatible && previous?.reports && typeof previous.reports === "object"
    ? previous.reports
    : {};
  const repairedSources = compatible && previous?.repairedSources
    && typeof previous.repairedSources === "object"
    ? previous.repairedSources
    : {};
  const candidateSources = compatible && previous?.candidateSources
    && typeof previous.candidateSources === "object"
    ? previous.candidateSources
    : {};
  const pendingEntries = Object.entries(sources).filter(([name]) => !Object.hasOwn(reports, name));
  const entries = options.maxSources > 0 ? pendingEntries.slice(0, options.maxSources) : pendingEntries;
  const total = Object.keys(sources).length;
  const startedAt = Date.now();
  const config = {
    ...serverConfig(),
    fetchTimeoutMs: options.requestTimeoutMs,
    allowPrivateNetworks: false,
  };
  const download = createSourceDownloader(config);
  let cursor = 0;
  let dirty = 0;
  let saveTail = Promise.resolve();
  const persist = () => {
    const payload = {
      version: 2,
      mode,
      updatedAt: new Date().toISOString(),
      summary: summaryFor(total, reports, startedAt),
      reports,
      ...(options.repair ? { repairedSources } : {}),
      ...(options.repair ? { candidateSources } : {}),
    };
    saveTail = saveTail.then(() => writeJsonAtomic(options.report, payload));
    return saveTail;
  };
  const workers = Array.from({ length: Math.min(options.concurrency, entries.length || 1) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = entries[index];
      const sourceStartedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`单源总时限（${options.sourceTimeoutMs}ms）`)),
        options.sourceTimeoutMs,
      );
      const scopedDownload = (url, headers = {}, requestOptions = {}) => {
        const signals = [controller.signal, requestOptions.signal].filter(Boolean);
        const signal = signals.length > 1 && typeof AbortSignal.any === "function"
          ? AbortSignal.any(signals)
          : controller.signal;
        return download(url, headers, { ...requestOptions, signal });
      };
      try {
        if (options.repair) {
          // Reserve part of the per-source budget for the required final
          // structural check and full request-chain verification. A failed
          // initial chain must not consume the whole budget before analysis.
          const repairBudgetMs = Math.max(
            options.requestTimeoutMs,
            Math.floor(options.sourceTimeoutMs * 0.7),
          );
          const stageTimeoutMs = Math.max(
            options.requestTimeoutMs,
            Math.floor(repairBudgetMs / 3),
          );
          const repairController = new AbortController();
          const repairTimer = setTimeout(
            () => repairController.abort(new Error(`识站修复预算耗尽（${repairBudgetMs}ms）`)),
            repairBudgetMs,
          );
          const repairDownload = (url, headers = {}, requestOptions = {}) => {
            const signals = [repairController.signal, requestOptions.signal].filter(Boolean);
            const signal = signals.length > 1 && typeof AbortSignal.any === "function"
              ? AbortSignal.any(signals)
              : repairController.signal;
            return scopedDownload(url, headers, { ...requestOptions, signal });
          };
          let gated;
          try {
            gated = await applyVerifyAndAnalyzeFallback({ [name]: source }, {
              download: repairDownload,
              concurrency: 1,
              timeoutMs: options.requestTimeoutMs,
              sourceTimeoutMs: stageTimeoutMs,
              analyzeTimeoutMs: stageTimeoutMs,
              adapterBase: options.adapterBase,
            });
          } finally {
            clearTimeout(repairTimer);
          }
          const repaired = gated.sources[name];
          if (!repaired) {
            reports[name] = {
              ok: false,
              reason: "repair-failed",
              detail: gated.skipped[0]?.reason || "通用识站未生成可用源",
            };
          } else {
            candidateSources[name] = repaired;
            const structural = validateXiangseSource(repaired);
            const remainingMs = Math.max(
              options.requestTimeoutMs,
              options.sourceTimeoutMs - (Date.now() - sourceStartedAt),
            );
            const verified = structural.ok
              ? await verifyConvertedSource(repaired, {
                download: scopedDownload,
                timeoutMs: options.requestTimeoutMs,
                sourceTimeoutMs: remainingMs,
                signal: controller.signal,
              })
              : { ok: false, reason: "invalid-structure", detail: structural.errors.join("；") };
            const audited = strictElementReport(verified);
            reports[name] = {
              ...audited,
              repaired: gated.fallbackCount > 0,
              warnings: gated.warnings.map((item) => item.message).filter(Boolean),
            };
            if (audited.ok) repairedSources[name] = repaired;
          }
        } else {
          reports[name] = strictElementReport(await verifyConvertedSource(source, {
            download: scopedDownload,
            timeoutMs: options.requestTimeoutMs,
            sourceTimeoutMs: options.sourceTimeoutMs,
            signal: controller.signal,
          }));
        }
      } catch (error) {
        reports[name] = { ok: false, reason: "verify-error", detail: String(error?.message || error) };
      } finally {
        clearTimeout(timer);
      }
      dirty += 1;
      const current = summaryFor(total, reports, startedAt);
      if (dirty >= 5 || current.done === total || cursor >= entries.length) {
        dirty = 0;
        await persist();
        process.stderr.write(
          `audit ${current.done}/${total} passed=${current.passed} rate=${current.rate}% pending=${current.pending}\n`,
        );
      }
    }
  });
  await Promise.all(workers);
  await persist();
  if (options.passed) {
    const passed = Object.fromEntries(Object.entries(sources)
      .filter(([name]) => reports[name]?.ok)
      .map(([name, source]) => [name, repairedSources[name] || source]));
    await writeJsonAtomic(options.passed, passed);
  }
  process.stdout.write(`${JSON.stringify(summaryFor(total, reports, startedAt), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
