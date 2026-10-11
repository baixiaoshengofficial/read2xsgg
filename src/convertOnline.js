import { createHash } from "node:crypto";
import { convertLegado, skippedBuckets } from "./converter.js";
import { applyVerifyAndAnalyzeFallback } from "./pipeline.js";
import { filterValidXiangseSources } from "./xiangseValidate.js";
import { encodeXbs } from "./xbs.js";
import { materializeDynamicCatalogs } from "./siteAnalyze/dynamicCatalog.js";

/**
 * Convert an already-parsed Legado JSON payload into Xiangse XBS.
 * Used by the remote URL path and by explicit artifact publication.
 *
 * @param {object|object[]} parsed
 * @param {object} config
 * @param {string} [imageProxyBase]
 * @param {object} [options]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {typeof downloadSource} [options.downloadSource]
 * @param {Function} [options.filterReachableSources]
 * @param {boolean} [options.fullVerify] - Verify every converted source even
 *   when the synchronous endpoint's verifyMaxSources limit would apply.
 * @param {boolean} [options.analyzeFallback] - Try site analysis to repair a
 *   source whose converted rules fail verification.
 * @param {new (status: number, message: string) => Error} [options.HttpError]
 */
export async function convertParsedSource(parsed, config, imageProxyBase = "", options = {}) {
  // Lazy import avoids a circular dependency with server.js.
  const server = await import("./server.js");
  const downloadSource = options.downloadSource || server.downloadSource;
  const filterReachableSources = options.filterReachableSources || server.filterReachableSources;
  const verifySources = options.verifySources || applyVerifyAndAnalyzeFallback;
  const HttpError = options.HttpError || server.HttpError;
  const analyzeFallback = options.analyzeFallback === undefined
    ? Boolean(config.analyzeFallback)
    : Boolean(options.analyzeFallback);

  const onProgress = options.onProgress || null;
  const emit = (payload) => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress(payload);
    } catch {
      // Progress callbacks must not break conversion.
    }
  };

  let input = parsed;
  const preflight = await filterReachableSources(input, config, {
    onProgress: (progress) => emit(progress),
  });
  input = preflight.input;

  const catalogDownload = (url, headers = {}, requestOptions = {}) => downloadSource(
    url,
    { ...config, fetchTimeoutMs: Math.max(config.preflightTimeoutMs, 1_000) },
    headers,
    requestOptions,
  );
  const materialized = await materializeDynamicCatalogs(input, {
    download: catalogDownload,
    concurrency: config.preflightConcurrency,
  });
  input = materialized.input;

  emit({ phase: "convert", done: 0, total: 0, kept: 0, skipped: 0, unverified: 0 });
  let converted;
  try {
    // Keep every structurally convertible source. The portability heuristic is
    // useful diagnostic information, but it is not proof that a source cannot
    // run in a client and must never silently remove an imported source.
    converted = convertLegado(input, {
      imageProxyBase,
      includeAiRecognitionHints: analyzeFallback,
    });
  } catch (error) {
    throw new HttpError(422, `无法转换在线阅读源：${error.message}`);
  }
  if (preflight.skipped?.length) converted.skipped.push(...preflight.skipped);
  if (preflight.warnings?.length) converted.warnings.push(...preflight.warnings);
  if (materialized.warnings.length) converted.warnings.push(...materialized.warnings);
  const convertedCount = Object.keys(converted.sources).length;
  emit({
    phase: "convert",
    done: convertedCount,
    total: convertedCount + (converted.skipped?.length || 0),
    kept: convertedCount,
    skipped: converted.skipped?.length || 0,
    unverified: 0,
  });

  const sourceCount = Object.keys(converted.sources).length;
  const fullVerify = Boolean(options.fullVerify);
  const verifyMaxSources = Number(config.verifyMaxSources);
  const withinVerifySourceLimit = !Number.isFinite(verifyMaxSources)
    || verifyMaxSources <= 0
    || sourceCount <= verifyMaxSources;
  const verifyEnabled = Boolean(config.verifyConvertedSources) && sourceCount > 0
    && (fullVerify || withinVerifySourceLimit);
  const verifyRequestTimeoutMs = Math.max(
    1_000,
    Number(fullVerify ? config.jobVerifyRequestTimeoutMs : config.verifyRequestTimeoutMs)
      || Number(config.preflightConfirmTimeoutMs)
      || 10_000,
  );
  const download = (url, headers = {}, requestOptions = {}) => downloadSource(
    url,
    { ...config, fetchTimeoutMs: verifyRequestTimeoutMs },
    headers,
    requestOptions,
  );
  const jobBudget = Number(config.jobVerifyBudgetMs);
  const budgetMs = fullVerify
    ? (Number.isFinite(jobBudget) && jobBudget > 0 ? jobBudget : 0)
    : config.verifyBudgetMs;
  const sourceBudgetMs = Number(fullVerify
    ? config.jobVerifySourceBudgetMs
    : config.verifySourceBudgetMs) || 0;
  const sourceTimeoutMs = sourceBudgetMs > 0
    ? sourceBudgetMs
    : Math.max(15_000, verifyRequestTimeoutMs * 3);
  const runtimeFallbackTimeoutMs = Math.max(
    1,
    Number(fullVerify
      ? config.jobVerifyRuntimeFallbackTimeoutMs
      : config.verifyRuntimeFallbackTimeoutMs)
      || Math.min(45_000, sourceTimeoutMs),
  );
  const workerPoolEnabled = options.workerPoolEnabled !== undefined
    ? Boolean(options.workerPoolEnabled)
    : typeof options.downloadSource !== "function";
  const gated = await verifySources(converted.sources, {
    download,
    concurrency: config.preflightConcurrency,
    timeoutMs: verifyRequestTimeoutMs,
    analyzeTimeoutMs: config.analyzeTimeoutMs,
    recognitionAttempts: config.analyzeAttempts,
    continueRecognitionUntilTimeout: true,
    requireBookWorld: true,
    workerCount: fullVerify ? config.jobVerifyWorkers : config.verifyWorkers,
    workerRecycleAfter: Math.min(6, Math.max(1, Number(config.verifyWorkerRecycleAfter) || 6)),
    workerConfig: config,
    workerPoolEnabled,
    sourceTimeoutMs,
    runtimeFallbackTimeoutMs,
    sourceBudgetMs,
    enabled: verifyEnabled,
    analyzeFallback,
    aiSettings: config.aiSettings,
    // Preserve reachability per origin: one inconclusive preflight must not
    // suppress repair attempts for every other source in the same collection.
    originReachabilityConfirmed: Boolean(config.preflightSources)
      && !(preflight.unconfirmed?.length),
    ...(config.preflightSources ? {
      unconfirmedOriginHosts: [...new Set((preflight.unconfirmed || [])
        .map((item) => String(item?.host || "").trim().toLowerCase()).filter(Boolean))],
      unconfirmedOriginSources: [...new Set((preflight.unconfirmed || [])
        .map((item) => String(item?.source || "").trim()).filter(Boolean))],
    } : {}),
    retainUnverified: options.retainUnverified !== undefined
      ? Boolean(options.retainUnverified)
      : Boolean(config.retainUnverifiedSources),
    budgetMs,
    adapterBase: (() => {
      try { return new URL(imageProxyBase).origin; } catch { return ""; }
    })(),
    onProgress: (progress) => emit({ ...progress, phase: progress.phase || "verify" }),
  });
  converted.sources = gated.sources;
  for (const source of Object.values(converted.sources || {})) {
    if (source && typeof source === "object") delete source.__read2xsggAiHints;
  }
  if (gated.skipped.length) converted.skipped.push(...gated.skipped);
  converted.sources = filterValidXiangseSources(converted.sources, {
    warnings: converted.warnings,
    skipped: converted.skipped,
    stage: "post-verify",
  }).sources;
  if (!verifyEnabled && config.verifyConvertedSources && verifyMaxSources > 0 && sourceCount > verifyMaxSources) {
    converted.warnings.push({
      source: "",
      section: "source",
      field: "verify",
      message: `源数量 ${sourceCount} 超过同步抽测上限 ${verifyMaxSources}，请使用任务导入执行完整抽测`,
      rule: "",
    });
  }
  if (gated.warnings.length) converted.warnings.push(...gated.warnings);

  const count = Object.keys(converted.sources).length;
  if (!count) {
    const reasons = (converted.skipped || [])
      .map((item) => `${item.source}: ${item.reason}`)
      .filter(Boolean)
      .slice(0, 5)
      .join("；");
    throw new HttpError(422, reasons || "在线地址中没有可转换的阅读源");
  }
  const buckets = skippedBuckets(converted.skipped);
  const json = Buffer.from(`${JSON.stringify(converted.sources, null, 2)}\n`, "utf8");
  const xbs = encodeXbs(json);
  return {
    ...converted,
    count,
    fallbackCount: gated.fallbackCount || 0,
    aiAttemptCount: gated.aiAttemptCount || 0,
    aiRepairCount: gated.aiRepairCount || 0,
    unverifiedCount: gated.unverifiedCount || 0,
    skippedBuckets: buckets,
    json,
    xbs,
    etag: `"${createHash("sha256").update(xbs).digest("hex")}"`,
  };
}

/**
 * Convert a remote Legado JSON source URL into Xiangse XBS.
 *
 * @param {string} sourceUrl
 * @param {object} config
 * @param {string} [imageProxyBase]
 * @param {object} [options]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {typeof downloadSource} [options.downloadSource]
 * @param {Function} [options.filterReachableSources]
 * @param {Function} [options.sourceUrlCandidates]
 * @param {new (status: number, message: string) => Error} [options.HttpError]
 */
export async function convertOnlineSource(sourceUrl, config, imageProxyBase = "", options = {}) {
  const server = await import("./server.js");
  const downloadSource = options.downloadSource || server.downloadSource;
  const HttpError = options.HttpError || server.HttpError;
  const sourceUrlCandidates = options.sourceUrlCandidates || server.sourceUrlCandidates;

  let parsed;
  let parseError;
  let downloadError;
  const candidates = sourceUrlCandidates(sourceUrl);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    let raw;
    try {
      raw = await downloadSource(candidate, config);
    } catch (error) {
      downloadError = error;
      if (candidateIndex === 0) throw error;
      continue;
    }
    try {
      parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
      break;
    } catch (error) {
      parseError = error;
    }
  }
  if (!parsed && parseError) throw new HttpError(422, `在线阅读源不是有效 JSON：${parseError.message}`);
  if (!parsed && downloadError) throw downloadError;
  if (!parsed) throw new HttpError(422, "在线阅读源不是有效 JSON");

  return convertParsedSource(parsed, config, imageProxyBase, options);
}
