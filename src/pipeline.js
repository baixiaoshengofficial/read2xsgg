import { analyzeSite } from "./siteAnalyze/index.js";
import { Worker } from "node:worker_threads";
import { requestIdentity } from "./requestIdentity.js";
import { repairChapterFromBook } from "./siteAnalyze/repairChapter.js";
import { carryReusableComicDecoder, repairContentFromChapter } from "./siteAnalyze/repairContent.js";
import { repairDetailFromBook } from "./siteAnalyze/repairDetail.js";
import { repairBooksFromRequests, repairChaptersFromBookJson } from "./siteAnalyze/repairBooks.js";
import { aiCandidateQualityIssue, generateXiangseCandidate, redactDiagnosticText } from "./aiSiteAnalyzer.js";
import { aiProviderReady } from "./aiProvider.js";
import {
  resolveBookTargetRequests,
  reuseSearchListRulesForBrowse,
  usableComicContentReport,
  verifyConvertedSource,
} from "./verifySource.js";
import { repairXiangseEntrypoints, validateXiangseSource } from "./xiangseValidate.js";

/**
 * After Legado conversion + origin preflight: verify each source; on a rule
 * failure, keep identifying the live site and verifying newly generated
 * candidates until one completes the Xiangse list → detail → chapter →
 * content chain. A source is published only after that chain succeeds.
 *
 * A request/source timeout is treated as an unavailable or blocked site and
 * is isolated. Structural validity alone is never a publish decision.
 */
function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(payload);
  } catch {
    // Progress callbacks must not break conversion.
  }
}

function abortError(signal, fallback = "操作已取消") {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(String(signal?.reason || fallback));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function delayWithSignal(durationMs, signal) {
  const duration = Math.max(0, Number(durationMs) || 0);
  throwIfAborted(signal);
  if (!duration) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, duration);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function timeoutText(value) {
  if (value instanceof Error) return value.message || String(value);
  if (value && typeof value === "object") {
    return [value.message, value.reason, value.detail, value.error, value.code]
      .filter(Boolean)
      .map(String)
      .join(" ");
  }
  return String(value || "");
}

function isTimeoutFailure(value) {
  return Boolean(value?.sourceTimeout || value?.timedOut)
    || /(?:timeout|timed\s*out|超时|请求超时|操作超时|source-worker-timeout|ETIMEDOUT)/i.test(
      timeoutText(value),
    );
}

function isUnavailableFailure(value) {
  const message = timeoutText(value);
  const responseStatuses = Array.isArray(value?.httpResponseStatuses)
    ? value.httpResponseStatuses
    : [];
  if (value?.originResponded === true || responseStatuses.length > 0
    || /\bHTTP\s+[1-5]\d{2}\b/i.test(message)) return false;
  if (value?.sourceUnavailable) return true;
  // Any HTTP status proves the origin responded; only an explicit no-response
  // result, after all current entry probes fail, can classify it unreachable.
  return /(?:首页及声明分类均不可访问|(?:站点|源站|上游站点)(?:整体)?(?:不可访问|无法访问))/i.test(message);
}

function hasOriginResponseEvidence(value) {
  if (!value || typeof value !== "object") return false;
  if (value.originResponded === true
    || (Array.isArray(value.httpResponseStatuses) && value.httpResponseStatuses.length > 0)) return true;
  const message = timeoutText(value);
  if (/\bHTTP\s+[1-5]\d{2}\b/i.test(message)) return true;
  if (isTimeoutFailure(value)
    || /(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network is unreachable|TLS|SSL|certificate)/i.test(message)) {
    return false;
  }
  // A parsed-list/content/structure failure means the request reached a
  // response, while transport failures above remain inconclusive.
  return /(?:rules-stale|analyze-failed)/i.test(message);
}

function shouldStopOnRepairFailure(error, signal, originReachabilityConfirmed) {
  if (signal?.aborted) return true;
  return !originReachabilityConfirmed && (isTimeoutFailure(error) || isUnavailableFailure(error));
}

function sourceTimeoutError(value, fallback = "源验链超时") {
  const error = new Error(timeoutText(value) || fallback);
  error.code = "ETIMEDOUT";
  error.sourceTimeout = true;
  return error;
}

function sourceUnavailableError(value, fallback = "站点不可访问") {
  const error = new Error(timeoutText(value) || fallback);
  error.code = "EHOSTUNREACH";
  error.sourceUnavailable = true;
  return error;
}

export function aiAttemptsThatFitBudget({ remainingMs, maxAttempts = 1, timeoutMs = 30_000, verificationTimeoutMs = 30_000 } = {}) {
  const attempts = Math.min(3, Math.max(0, Math.floor(Number(maxAttempts) || 0)));
  const aiTimeout = Math.min(120_000, Math.max(5_000, Number(timeoutMs) || 30_000));
  const verificationTimeout = Math.max(1, Number(verificationTimeoutMs) || 1);
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining)) return attempts;
  const perAttemptMs = aiTimeout + verificationTimeout + 1_000;
  return Math.min(attempts, Math.max(0, Math.floor(remaining / perAttemptMs)));
}

function throwIfVerificationTimedOut(result) {
  if (result?.ok || !isTimeoutFailure(result)) return;
  throw sourceTimeoutError(result);
}

function throwIfVerificationUnavailable(result) {
  if (result?.ok || !isUnavailableFailure(result)) return;
  throw sourceUnavailableError(result);
}

function downloadWithSignal(download, signal) {
  if (typeof download !== "function") return download;
  return (url, headers = {}, options = {}) => {
    throwIfAborted(signal);
    return download(url, headers, {
      ...options,
      signal: options?.signal || signal,
    });
  };
}

async function withinTimeout(operation, timeoutMs, label, { signal } = {}) {
  const duration = Math.max(1, Number(timeoutMs) || 1);
  const controller = new AbortController();
  let timer;
  let parentAbort;
  let rejectParent;
  const parentPromise = signal
    ? new Promise((_, reject) => { rejectParent = reject; })
    : null;
  const operationPromise = Promise.resolve().then(() => (
    typeof operation === "function" ? operation(controller.signal) : operation
  ));
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${duration}ms）`);
      controller.abort(error);
      reject(error);
    }, duration);
  });
  try {
    if (signal) {
      parentAbort = () => {
        const error = abortError(signal);
        controller.abort(error);
        rejectParent(error);
      };
      if (signal.aborted) parentAbort();
      else signal.addEventListener("abort", parentAbort, { once: true });
    }
    return await Promise.race([operationPromise, timeoutPromise, ...(parentPromise ? [parentPromise] : [])]);
  } finally {
    clearTimeout(timer);
    if (signal && parentAbort) signal.removeEventListener("abort", parentAbort);
  }
}

function sourceDisplayName(name, source) {
  const label = String(name || source?.sourceName || source?.bookSourceName || "").trim();
  const host = String(source?.sourceUrl || source?.host || source?.bookSourceUrl || "").trim();
  if (label && host) {
    try {
      return `${label} (${new URL(host).hostname})`;
    } catch {
      return `${label} (${host})`;
    }
  }
  return label || host || "未命名书源";
}

function sourceHostKey(source) {
  const candidates = [
    source?.sourceUrl,
    source?.host,
    source?.bookSourceUrl,
    ...resolveBookTargetRequests(source).map((request) => request.url),
    ...Object.values(source?.bookWorld || {}).map((action) => action?.host),
    source?.searchBook?.host,
    source?.bookDetail?.host,
    source?.chapterList?.host,
  ];
  for (const value of candidates) {
    const raw = String(value || "").trim().split("#", 1)[0];
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (/^https?:$/.test(url.protocol)) return url.origin;
    } catch {
      // App identifiers and other pseudo hosts are common in aggregate sources;
      // keep looking for a real declarative action URL.
    }
  }
  return "";
}

function sourceDiagnostics(source, stage = "", { recognitionAttempts } = {}) {
  const details = {};
  const sourceType = String(source?.sourceType || "").trim();
  if (["text", "comic", "audio", "video"].includes(sourceType)) {
    details.sourceType = sourceType;
  }
  let origin = "";
  try {
    origin = sourceHostKey(source);
  } catch {
    // Diagnostics must never turn a recoverable source failure into a job failure.
  }
  if (origin) {
    try {
      details.host = new URL(origin).hostname;
    } catch {
      // App-specific hosts are not useful as external-site diagnostics.
    }
  }
  const safeStage = String(stage || "").trim().slice(0, 80);
  if (safeStage) details.stage = safeStage;
  const safeAttempts = Number(recognitionAttempts);
  if (Number.isSafeInteger(safeAttempts) && safeAttempts >= 0 && safeAttempts <= 1_000) {
    details.recognitionAttempts = safeAttempts;
  }
  return details;
}

function warnMissingBookElements(warnings, name, verified) {
  const missing = verified?.bookElements?.missingRecommended || [];
  if (!missing.length) return;
  warnings.push({
    source: name,
    section: "bookWorld/searchBook",
    field: "elements",
    message: `抽测可用但书籍元素缺失：${missing.join("、")}；需要继续优化通用转换/识站规则`,
    rule: verified.bookUrl || "",
  });
}

function limitRepeatedPagination(source, reason, detail) {
  const message = `${reason || ""} ${detail || ""}`;
  const clone = structuredClone(source);
  if (/书籍列表第\s*2\s*页.*重复|翻页无效/.test(message)) {
    const actions = [...Object.values(clone.bookWorld || {}), clone.searchBook].filter(Boolean);
    for (const action of actions) {
      action.moreKeys = { ...(action.moreKeys || {}), maxPage: 1 };
      delete action.nextPageUrl;
    }
    return clone;
  }
  if (/目录第\s*2\s*页.*重复/.test(message) && clone.chapterList) {
    clone.chapterList.moreKeys = { ...(clone.chapterList.moreKeys || {}), maxPage: 1 };
    delete clone.chapterList.nextPageUrl;
    return clone;
  }
  return null;
}

function memoizeRepairDownloads(download, { maxEntries = 128, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof download !== "function") return download;
  const cache = new Map();
  let cachedBytes = 0;
  const memoized = async (url, headers = {}, options = {}) => {
    const method = String(options?.method || "GET").toUpperCase();
    const body = options?.body;
    if (method !== "GET" || body != null) return download(url, headers, options);
    const normalizedHeaders = Object.entries(headers || {})
      .map(([key, value]) => [String(key).toLowerCase(), String(value)])
      .sort(([left], [right]) => left.localeCompare(right));
    const key = JSON.stringify([String(url), normalizedHeaders]);
    if (cache.has(key)) return cache.get(key);
    const result = await download(url, headers, options);
    const size = Number(result?.length || result?.byteLength || 0);
    if (size > 0 && size <= 2 * 1024 * 1024) {
      cache.set(key, result);
      cachedBytes += size;
      while (cache.size > maxEntries || cachedBytes > maxBytes) {
        const oldest = cache.keys().next().value;
        const removed = cache.get(oldest);
        cachedBytes -= Number(removed?.length || removed?.byteLength || 0);
        cache.delete(oldest);
      }
    }
    return result;
  };
  memoized.clearCache = () => {
    cache.clear();
    cachedBytes = 0;
  };
  return memoized;
}

export async function applyVerifyAndAnalyzeFallbackSingle(sources, {
  download,
  concurrency = 4,
  timeoutMs = 3_000,
  sourceTimeoutMs = Math.max(15_000, timeoutMs * 3),
  runtimeFallbackTimeoutMs = 45_000,
  repairRequestLimit = 3,
  analyzeTimeoutMs = 30_000,
  enabled = true,
  analyzeFallback = true,
  aiSettings = null,
  originReachabilityConfirmed = false,
  unconfirmedOriginHosts,
  unconfirmedOriginSources,
  generateAiCandidate = generateXiangseCandidate,
  analyze = analyzeSite,
  repairBooks = repairBooksFromRequests,
  repairChapter = repairChapterFromBook,
  repairContent = repairContentFromChapter,
  repairDetail = repairDetailFromBook,
  repairJsonChapter = repairChaptersFromBookJson,
  budgetMs = 0,
  // A source may need several sequential actions, but a broken upstream must
  // never occupy a worker indefinitely. This is a per-source wall-clock cap;
  // `sourceTimeoutMs` remains the timeout for one verification chain.
  sourceBudgetMs = 120_000,
  // Kept in the signature for API compatibility. It is intentionally ignored:
  // structurally valid but unverified sources must never be published.
  retainUnverified = false,
  recognitionAttempts = 4,
  continueRecognitionUntilTimeout = false,
  requireBookWorld = false,
  adapterBase = "",
  signal = null,
  onProgress = null,
} = {}) {
  download = memoizeRepairDownloads(download);
  const input = Object.entries(sources || {});
  if (!enabled || !input.length) {
    const result = {
      sources: { ...sources },
      skipped: [],
      warnings: [],
      fallbackCount: 0,
      verifiedCount: input.length,
      failedVerifyCount: 0,
      unverifiedCount: 0,
      aiAttemptCount: 0,
      aiRepairCount: 0,
    };
    emitProgress(onProgress, {
      phase: "verify",
      done: input.length,
      total: input.length,
      kept: input.length,
      skipped: 0,
      unverified: 0,
      current: "",
      active: [],
    });
    return result;
  }

  const kept = {};
  const skipped = [];
  const warnings = [];
  let fallbackCount = 0;
  let aiAttemptCount = 0;
  let aiRepairCount = 0;
  let failedVerifyCount = 0;
  let unverifiedCount = 0;
  let cursor = 0;
  let processed = 0;
  const total = input.length;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
  /** @type {Set<string>} */
  const active = new Set();
  const stageHandlers = new WeakMap();
  const runtimeFallbackBudgets = new WeakMap();
  const reachabilityBySignal = new WeakMap();
  const hasPreflightReachability = Array.isArray(unconfirmedOriginHosts)
    || Array.isArray(unconfirmedOriginSources);
  const unconfirmedHostSet = new Set((unconfirmedOriginHosts || [])
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const unconfirmedSourceSet = new Set((unconfirmedOriginSources || [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  const originConfirmedFor = (sourceSignal, source, evidence = null) => {
    const state = sourceSignal ? reachabilityBySignal.get(sourceSignal) : null;
    if (state?.confirmed) return true;
    if (hasOriginResponseEvidence(evidence)) {
      if (state) state.confirmed = true;
      return true;
    }
    if (originReachabilityConfirmed) {
      if (state) state.confirmed = true;
      return true;
    }
    if (!hasPreflightReachability) return false;
    const origin = sourceHostKey(source);
    let hostname = "";
    try { hostname = new URL(origin).hostname.toLowerCase(); } catch { /* no usable host */ }
    const names = [source?.sourceName, source?.bookSourceName].map((value) => String(value || "").trim());
    const confirmed = Boolean(hostname && !unconfirmedHostSet.has(hostname)
      && !names.some((name) => name && unconfirmedSourceSet.has(name)));
    if (confirmed && state) state.confirmed = true;
    return confirmed;
  };
  /** Share analyze work across sources on the same origin + kind. */
  const analyzeByHost = new Map();
  const verificationPhaseTimeoutMs = (sourceSignal) => {
    const deadlineAt = Number(runtimeFallbackBudgets.get(sourceSignal)?.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return sourceTimeoutMs;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const minimumRecognitionMs = Math.min(
      500,
      Math.max(50, Math.floor((Number(analyzeTimeoutMs) || 1_000) / 2)),
    );
    if (remainingMs < minimumRecognitionMs * 2) return sourceTimeoutMs;
    // Leave at least half of the current source budget for generic repair and
    // recognition. A stale XBS chain must not consume the whole source window.
    return Math.min(sourceTimeoutMs, Math.max(1, Math.floor(remainingMs / 2)));
  };
  const hasRecognitionBudget = (sourceSignal) => {
    const deadlineAt = Number(runtimeFallbackBudgets.get(sourceSignal)?.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return true;
    const minimumRecognitionMs = Math.min(
      500,
      Math.max(50, Math.floor((Number(analyzeTimeoutMs) || 1_000) / 2)),
    );
    return deadlineAt - Date.now() >= minimumRecognitionMs;
  };
  const verifySource = (source, sourceSignal) => {
    const phaseTimeoutMs = verificationPhaseTimeoutMs(sourceSignal);
    return verifyConvertedSource(source, {
      download: downloadWithSignal(download, sourceSignal),
      timeoutMs: Math.min(timeoutMs, phaseTimeoutMs),
      sourceTimeoutMs: phaseTimeoutMs,
      runtimeFallbackTimeoutMs,
      runtimeFallbackBudget: runtimeFallbackBudgets.get(sourceSignal),
      requireBookWorld,
      signal: sourceSignal,
      onStage: (stage) => stageHandlers.get(sourceSignal)?.(stage),
    });
  };
  const initialVerifySource = (source, sourceSignal) => {
    const phaseTimeoutMs = verificationPhaseTimeoutMs(sourceSignal);
    return verifyConvertedSource(source, {
      download: downloadWithSignal(download, sourceSignal),
      timeoutMs: Math.min(timeoutMs, phaseTimeoutMs),
      sourceTimeoutMs: phaseTimeoutMs,
      runtimeFallbackTimeoutMs,
      runtimeFallbackBudget: runtimeFallbackBudgets.get(sourceSignal),
      requireBookWorld,
      signal: sourceSignal,
      onStage: (stage) => stageHandlers.get(sourceSignal)?.(stage),
    });
  };
  const verifyChecked = async (source, sourceSignal, { initial = false } = {}) => {
    const result = await (initial
      ? initialVerifySource(source, sourceSignal)
      : verifySource(source, sourceSignal));
    if (!result?.ok && analyzeFallback && !sourceSignal?.aborted
      && hasRecognitionBudget(sourceSignal) && isTimeoutFailure(result)) {
      // A verification phase timing out is not proof that the origin is dead.
      // Return control to the generic repair/analyze path while the enclosing
      // source budget still has time; only its AbortSignal is terminal.
      return {
        ...result,
        reason: "rules-stale: verification-phase-timeout",
        phaseTimeout: true,
      };
    }
    throwIfVerificationTimedOut(result);
    if (!originConfirmedFor(sourceSignal, source, result)) throwIfVerificationUnavailable(result);
    return result;
  };
  const improveBookElements = async (source, verified, context = {}) => {
    const sourceSignal = context.signal;
    const sourceDownload = context.download || download;
    throwIfAborted(sourceSignal);
    const missing = [...new Set([
      ...(verified?.bookElements?.missingRecommended || []),
      ...(verified?.derivedRecommended || []),
    ])];
    if (!verified?.ok || !verified.bookUrl || !missing.length || typeof repairDetail !== "function") return null;
    let repaired;
    try {
      repaired = await withinTimeout(
        (repairSignal) => Promise.resolve(repairDetail(source, verified.bookUrl, missing, {
          download: downloadWithSignal(sourceDownload, repairSignal),
          adapterBase,
          signal: repairSignal,
        })),
        analyzeTimeoutMs,
        "详情元素识站修复",
        { signal: sourceSignal },
      );
    } catch (error) {
      if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, source))) {
        if (sourceSignal?.aborted) throw error;
        throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
      }
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    let finalRepaired = repaired;
    let repairedVerify = await verifyChecked(finalRepaired, sourceSignal);
    if (repairedVerify.reason === "rules-stale: empty-content"
      && repairedVerify.chapterUrl
      && typeof repairContent === "function") {
      try {
        const contentRepaired = await withinTimeout(
          (repairSignal) => Promise.resolve(repairContent(finalRepaired, repairedVerify.chapterUrl, {
            download: downloadWithSignal(sourceDownload, repairSignal),
            adapterBase,
            signal: repairSignal,
          })),
          analyzeTimeoutMs,
          "详情后正文识站修复",
          { signal: sourceSignal },
        );
        if (contentRepaired && validateXiangseSource(contentRepaired).ok) {
          const contentVerify = await verifyChecked(contentRepaired, sourceSignal);
          if (contentVerify.ok) {
            finalRepaired = contentRepaired;
            repairedVerify = contentVerify;
          }
        }
      } catch (error) {
        if (sourceSignal?.aborted) throw error;
        // The detail candidate is still rejected below unless its full chain works.
      }
    }
    if (!repairedVerify.ok) return null;
    const repairedMissing = new Set([
      ...(repairedVerify.bookElements?.missingRecommended || []),
      ...(repairedVerify.derivedRecommended || []),
    ]).size;
    return repairedMissing < missing.length ? { source: finalRepaired, verified: repairedVerify } : null;
  };
  const keepVerified = async (name, source, verified, improvementMessage = "", context = {}) => {
    let finalSource = source;
    let finalVerified = verified;
    let improvedAny = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      throwIfAborted(context.signal);
      const improved = await improveBookElements(finalSource, finalVerified, context);
      if (!improved) break;
      finalSource = improved.source;
      finalVerified = improved.verified;
      improvedAny = true;
    }
    if (improvedAny) {
      warnings.push({
        source: name,
        section: "bookDetail",
        field: "elements",
        message: improvementMessage || "已从真实详情页通用补全书籍元素并重新验证完整动作链",
        rule: finalVerified.bookUrl || "",
      });
    }
    const publishedSource = { ...finalSource };
    delete publishedSource.__read2xsggAiHints;
    kept[name] = publishedSource;
    warnMissingBookElements(warnings, name, finalVerified);
    return { source: publishedSource, verified: finalVerified, improved: improvedAny };
  };
  const repairChapterFor = async (source, bookUrl, context = {}) => {
    const sourceSignal = context.signal;
    const sourceDownload = context.download || download;
    let repaired = null;
    if (typeof repairChapter === "function") repaired = await withinTimeout(
      (repairSignal) => Promise.resolve(repairChapter(source, bookUrl, {
        download: downloadWithSignal(sourceDownload, repairSignal),
        adapterBase,
        signal: repairSignal,
      })),
      analyzeTimeoutMs,
      "目录识站修复",
      { signal: sourceSignal },
    );
    if (!repaired && typeof repairJsonChapter === "function") {
      repaired = await withinTimeout(
        (repairSignal) => Promise.resolve(repairJsonChapter(source, bookUrl, {
          download: downloadWithSignal(sourceDownload, repairSignal),
          signal: repairSignal,
        })),
        analyzeTimeoutMs,
        "JSON 目录识别",
        { signal: sourceSignal },
      );
    }
    return repaired;
  };
  const repairContentAndVerify = async (source, failedVerify, context = {}) => {
    const sourceSignal = context.signal;
    const sourceDownload = context.download || download;
    throwIfAborted(sourceSignal);
    if (failedVerify?.reason !== "rules-stale: empty-content"
      || !failedVerify.chapterUrl
      || typeof repairContent !== "function") return null;
    let repaired = null;
    try {
      repaired = await withinTimeout(
        (repairSignal) => Promise.resolve(repairContent(source, failedVerify.chapterUrl, {
          download: downloadWithSignal(sourceDownload, repairSignal),
          adapterBase,
          signal: repairSignal,
        })),
        analyzeTimeoutMs,
        "正文识站修复",
        { signal: sourceSignal },
      );
    } catch (error) {
      if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, source))) {
        if (sourceSignal?.aborted) throw error;
        throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
      }
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    const verified = await verifyChecked(repaired, sourceSignal);
    return verified.ok ? { source: repaired, verified } : null;
  };

  const report = (extra = {}) => {
    const activeList = [...active];
    emitProgress(onProgress, {
      phase: "verify",
      done: processed,
      total,
      kept: Object.keys(kept).length,
      skipped: skipped.length,
      unverified: unverifiedCount,
      fallback: fallbackCount,
      aiAttemptsTotal: aiAttemptCount,
      aiRepaired: aiRepairCount,
      failed: failedVerifyCount,
      current: activeList[0] || "",
      active: activeList,
      ...extra,
    });
  };

  const skipUnusable = (name, reason, candidate = null, stage = "", recognitionAttempts) => {
    // `candidate` is intentionally accepted for call-site diagnostics, but a
    // structural candidate is never published without a successful runtime
    // verification. This is the key distinction between a convertible source
    // and a usable Xiangse source.
    skipped.push({
      source: name,
      reason,
      ...sourceDiagnostics(candidate, stage, { recognitionAttempts }),
    });
    warnings.push({
      source: name,
      section: "source",
      field: "verify",
      message: `阅读规则抽测未通过，且通用识站未能修复，已过滤：${reason}`,
      rule: "",
    });
    processed += 1;
  };

  const analyzeFor = (host, preferKind, name, source, context = {}) => {
    const sourceSignal = context.signal;
    const attempt = Math.max(0, Number(context.attempt) || 0);
    const seedRequests = resolveBookTargetRequests(source, { limit: 20 });
    const seedKey = seedRequests
      .map((item) => requestIdentity(item, { includeRequestInfo: true }))
      .join("|");
    const key = `${host}|${preferKind || "*"}|${seedKey}|attempt:${attempt}`;
    if (!analyzeByHost.has(key)) {
      const recognizedKind = ["text", "comic", "audio", "video"].includes(preferKind) ? preferKind : "";
      // The shared task must not inherit one source's AbortSignal. Aggregate
      // files often contain renamed copies of the same source; cancelling the
      // first copy used to poison every later copy sharing this promise.
      let probeBatchFingerprint = "";
      const runAnalyze = () => withinTimeout((analyzeSignal) => Promise.resolve(analyze(host, {
        download,
        sourceName: name,
        timeoutMs: analyzeTimeoutMs,
        // The pipeline performs the strict list → detail → chapter → content
        // verification immediately after candidate generation. Site analysis
        // is deliberately discovery-only here; every generated candidate is
        // still required to pass that complete runtime walk below.
        validateRuntime: false,
        preferKind: recognizedKind,
        attempt,
        seedRequests,
        adapterBase,
        repairSource: source,
        signal: analyzeSignal,
        onProbeBatch: (fingerprint) => {
          probeBatchFingerprint = String(fingerprint || "");
          return context.onProbeBatch?.(probeBatchFingerprint);
        },
      })), analyzeTimeoutMs, "通用识站").catch((error) => ({
        ok: false,
        reason: `analyze-failed: ${error.message || error}`,
        ...(probeBatchFingerprint ? { probeBatchFingerprint } : {}),
      }));
      analyzeByHost.set(key, runAnalyze());
    }
    const shared = analyzeByHost.get(key);
    if (!sourceSignal) return shared;
    return withinTimeout(() => shared, analyzeTimeoutMs, "通用识站", { signal: sourceSignal });
  };

  const configuredAiTimeoutMs = Math.min(120_000, Math.max(5_000, Number(aiSettings?.timeoutMs) || 30_000));
  const configuredAiAttempts = Math.min(3, Math.max(1, Number(aiSettings?.maxAttempts) || 2));
  const aiVerificationReserveMs = Math.max(
    1,
    Math.min(
      Number(sourceTimeoutMs) || timeoutMs * 5,
      Math.max((Number(timeoutMs) || 1_000) * 4, Number(runtimeFallbackTimeoutMs) || 0),
    ),
  );
  const aiAttemptsAvailable = (sourceSignal, alreadyUsed = 0) => {
    const deadlineAt = Number(runtimeFallbackBudgets.get(sourceSignal)?.deadlineAt);
    const remainingMs = Number.isFinite(deadlineAt) && deadlineAt > 0
      ? deadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    const attemptsRemaining = Math.max(0, configuredAiAttempts - Math.max(0, Number(alreadyUsed) || 0));
    return aiAttemptsThatFitBudget({
      remainingMs,
      maxAttempts: attemptsRemaining,
      timeoutMs: configuredAiTimeoutMs,
      verificationTimeoutMs: aiVerificationReserveMs,
    });
  };
  const hasAiReserveForRecognition = (sourceSignal, alreadyUsed = 0) => {
    if (!aiProviderReady(aiSettings)) return true;
    const deadlineAt = Number(runtimeFallbackBudgets.get(sourceSignal)?.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return true;
    const remainingMs = deadlineAt - Date.now();
    const minimumRecognitionMs = Math.max(1_000, Number(analyzeTimeoutMs) || 30_000);
    const attemptsRemaining = Math.max(0, configuredAiAttempts - Math.max(0, Number(alreadyUsed) || 0));
    if (!attemptsRemaining || aiAttemptsAvailable(sourceSignal, alreadyUsed) < 1) {
      // Once the configured AI budget is spent (or no AI round can still fit),
      // spend the remaining source budget on converter-owned recognition.
      return remainingMs >= minimumRecognitionMs;
    }
    // Reserve one realistic full list/detail/chapter/content verification,
    // not half of all remaining source time. The old half-budget calculation
    // made the configured second AI attempt mathematically unable to fit.
    const keepAiReserve = remainingMs >= configuredAiTimeoutMs
      + aiVerificationReserveMs
      + Math.max(1_000, Number(analyzeTimeoutMs) || 30_000);
    return keepAiReserve || remainingMs >= minimumRecognitionMs;
  };

  const tryAiRepair = async (host, name, source, failure, verification, context = {}) => {
    if (!aiProviderReady(aiSettings)) return { ok: false, attempts: 0, reason: "AI 未启用或配置不完整" };
    const sourceSignal = context.signal;
    const sourceReachable = originConfirmedFor(sourceSignal, source, verification);
    // Discovery's own timeout is not proof the origin is unreachable. Inspect the
    // actual verification failure, not the concatenated history of repair attempts.
    const originFailure = [verification?.reason, verification?.detail].filter(Boolean).join(" ");
    if (!sourceReachable && (isUnavailableFailure(verification) || verification?.sourceTimeout
      || /(?:timeout|timed\s*out|超时|econn(?:reset|refused)|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i.test(originFailure))) {
      return { ok: false, attempts: 0, reason: "源站可达性尚未确认，按不可访问/超时保护条件未启动 AI 识站" };
    }
    const sourceDownload = context.download || download;
    const attemptsAlreadyUsed = Math.max(0, Number(context.aiAttemptsUsed?.()) || 0);
    const attempts = aiAttemptsAvailable(context.signal, attemptsAlreadyUsed);
    if (!attempts) {
      const reason = attemptsAlreadyUsed >= configuredAiAttempts
        ? `AI 配置的 ${configuredAiAttempts} 次识站尝试已用尽`
        : "源级剩余预算不足以完成一次 AI 识站和完整动作链验链";
      return { ok: false, attempts: 0, reason };
    }
    const preferredKind = String(source?.sourceType || "");
    let feedback = String(failure || "");
    let attemptsUsed = 0;
    let lastVerification = verification || {};
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(sourceSignal);
      if (aiAttemptsAvailable(sourceSignal, attemptsAlreadyUsed + attemptsUsed) < 1) break;
      attemptsUsed += 1;
      context.onAiAttempt?.();
      aiAttemptCount += 1;
      context.onStage?.("ai-analyze");
      context.onFailure?.(feedback);
      report({ step: "ai-analyze", aiAttempt: attemptsAlreadyUsed + attempt, aiAttempts: configuredAiAttempts });
      let generated;
      try {
        generated = await withinTimeout((aiSignal) => generateAiCandidate({
          settings: aiSettings,
          host,
          sourceName: name,
          source,
          preferredKind,
          requireBookWorld,
          failureReason: `第 ${attempt} 次修复。${feedback}`,
          verification: lastVerification,
          seedRequests: resolveBookTargetRequests(source),
          download: downloadWithSignal(sourceDownload, aiSignal),
          signal: aiSignal,
        }), Math.max(Number(sourceBudgetMs) || 0, Math.max(6_000, Number(aiSettings.timeoutMs) || 30_000) + 1_000), "AI 识站修复", { signal: sourceSignal });
      } catch (error) {
        if (sourceSignal?.aborted) throw error;
        feedback = `AI 识站失败：${error?.message || error}`;
        context.onFailure?.(feedback);
        lastVerification = { ...lastVerification, reason: feedback };
        continue;
      }
      if (!generated?.ok || !generated.source) {
        feedback = generated?.reason || "AI 未生成候选规则";
        context.onFailure?.(feedback);
        lastVerification = { ...lastVerification, reason: feedback };
        continue;
      }
      if (generated.confidence < 0.55) {
        feedback = `AI 候选置信度不足（类型 ${generated.detectedType || "unknown"}，置信度 ${generated.confidence}）`;
        context.onFailure?.(feedback);
        lastVerification = { ...lastVerification, reason: feedback };
        continue;
      }
      let candidate = carryReusableComicDecoder({ ...generated.source, sourceName: name }, source);
      const structural = validateXiangseSource(candidate);
      if (!structural.ok) {
        feedback = `Xiangse 结构校验失败：${structural.errors.slice(0, 5).join("；")}`;
        context.onFailure?.(feedback);
        lastVerification = { ...lastVerification, reason: feedback };
        continue;
      }
      let checked;
      try {
        context.onStage?.("ai-verify");
        context.onFailure?.("AI 候选已生成，正在运行完整动作链验证");
        checked = await verifySource(candidate, sourceSignal);
        throwIfAborted(sourceSignal);
        if (checked.reason === "rules-stale: empty-toc" && checked.bookUrl) {
          const chapterCandidate = await repairChapterFor(candidate, checked.bookUrl, { signal: sourceSignal, download: sourceDownload });
          if (chapterCandidate && validateXiangseSource(chapterCandidate).ok) {
            const chapterCheck = await verifySource(chapterCandidate, sourceSignal);
            if (chapterCheck.ok || chapterCheck.reason === "rules-stale: empty-content") {
              candidate = chapterCandidate;
              checked = chapterCheck;
            }
          }
        }
        if (checked.reason === "rules-stale: empty-content" && checked.chapterUrl) {
          const contentFixed = await repairContentAndVerify(candidate, checked, { signal: sourceSignal, download: sourceDownload });
          if (contentFixed) {
            candidate = contentFixed.source;
            checked = contentFixed.verified;
          }
        }
      } catch (error) {
        if (sourceSignal?.aborted) throw error;
        feedback = `AI 候选规则实测失败：${error?.message || error}`;
        context.onFailure?.(feedback);
        lastVerification = { reason: feedback };
        continue;
      }
      if (checked?.ok) {
        const qualityIssue = aiCandidateQualityIssue(candidate, checked);
      if (qualityIssue) {
          feedback = qualityIssue;
          context.onFailure?.(feedback);
          lastVerification = { ...checked, detail: qualityIssue };
          continue;
        }
        await keepVerified(name, candidate, checked, "AI 识站修复后通过完整动作链", { signal: sourceSignal, download: sourceDownload });
        fallbackCount += 1;
        aiRepairCount += 1;
        const preservedActions = generated.preservedActions?.length
          ? `；保留未失败动作：${generated.preservedActions.join("、")}`
          : "";
        warnings.push({
          source: name,
          section: "source",
          field: "ai-repair",
          message: `通用转换与识站未通过后，AI 按 ${generated.detectedType} 生成声明式规则并通过完整链路实测（MCP 只读调用 ${generated.toolCalls || 0} 次）${preservedActions}`,
          rule: checked.chapterUrl || checked.bookUrl || host,
        });
        processed += 1;
        report({ step: "ai-repair-verified" });
        return { ok: true, attempts: attemptsUsed, reason: "" };
      }
      lastVerification = checked || {};
      feedback = `候选规则完整动作链未通过：${checked?.detail || checked?.reason || "未知验证失败"}`;
      context.onFailure?.(feedback);
      if (!originConfirmedFor(sourceSignal, source, lastVerification)
        && /(?:timeout|timed\s*out|超时|econn(?:reset|refused)|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i.test(feedback)) break;
    }
    return { ok: false, attempts: attemptsUsed, reason: feedback };
  };

  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    sourceLoop: while (cursor < input.length) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      const [name, inputSource] = input[index];
      let source = inputSource;
      const label = sourceDisplayName(name, source);

      if (deadline && Date.now() >= deadline) {
        skipped.push({
          source: name,
          reason: "rules-stale: verify-budget-timeout: 未在配置的验链预算内完成",
          ...sourceDiagnostics(source, "verify-budget"),
        });
        warnings.push({
          source: name,
          section: "source",
          field: "verify",
          message: "验链预算已耗尽，源未完成列表/详情/章节/正文校验，已跳过",
          rule: "",
        });
        processed += 1;
        report();
        continue;
      }

      active.add(label);
      const sourceController = new AbortController();
      const sourceSignal = sourceController.signal;
      reachabilityBySignal.set(sourceSignal, { confirmed: false });
      originConfirmedFor(sourceSignal, source);
      runtimeFallbackBudgets.set(sourceSignal, {
        remainingMs: Math.max(0, Number(runtimeFallbackTimeoutMs) || 0),
        deadlineAt: Number(sourceBudgetMs) > 0 ? Date.now() + Number(sourceBudgetMs) : 0,
      });
      const sourceDownload = downloadWithSignal(download, sourceSignal);
      let currentStage = "source-setup";
      let lastFailure = "";
      const rememberFailure = (failure) => {
        if (!failure) return;
        lastFailure = redactDiagnosticText(failure, 600)
          .replace(/https?:\/\/[^\s"'<>\]}]+/gi, "[URL]");
      };
      let recognitionAttemptsUsed = 0;
      const markStage = (stage) => {
        currentStage = String(stage || "unknown").trim().slice(0, 80) || "unknown";
        report({ step: currentStage, ...(lastFailure ? { failure: lastFailure } : {}) });
      };
      stageHandlers.set(sourceSignal, markStage);
      let sourceTimer;
      let parentAbort;
      if (signal) {
        parentAbort = () => sourceController.abort(abortError(signal));
        if (signal.aborted) parentAbort();
        else signal.addEventListener("abort", parentAbort, { once: true });
      }
      if (Number(sourceBudgetMs) > 0) {
        sourceTimer = setTimeout(() => {
          sourceController.abort(new Error(
            `源验链超时（${Number(sourceBudgetMs)}ms；阶段：${currentStage}${lastFailure ? `；最近失败：${lastFailure}` : ""}）`,
          ));
        }, Number(sourceBudgetMs));
      }
      report({ step: "verify" });
      try {
        const entryRepair = repairXiangseEntrypoints(source);
        source = entryRepair.source;
        const structural = entryRepair.validation;
        if (entryRepair.removedWorlds.length || entryRepair.replacedSearch) {
          warnings.push({
            source: name,
            section: "bookWorld/searchBook",
            field: "structure",
            message: [
              entryRepair.removedWorlds.length
                ? `已跳过不可执行分类：${entryRepair.removedWorlds.join("、")}`
                : "",
              entryRepair.replacedSearch ? "已用可执行分类重建搜索入口" : "",
            ].filter(Boolean).join("；"),
            rule: "",
          });
        }
        // Even with a broken core field, execute the representable prefix of
        // the chain so targeted list/catalogue/content repair gets a real URL.
        let verified = await verifyChecked(source, sourceSignal, { initial: true });
        if (!verified.ok) rememberFailure(verified.detail || verified.reason);
        throwIfAborted(sourceSignal);
        if (verified.ok) {
          if (structural.ok) {
            const keptResult = await keepVerified(name, source, verified, "", {
              signal: sourceSignal,
              download: sourceDownload,
            });
            throwIfAborted(sourceSignal);
            source = keptResult.source;
            verified = keptResult.verified;
            if (keptResult.improved) fallbackCount += 1;
            processed += 1;
            continue;
          }
        }
        failedVerifyCount += 1;
        const reason = verified.ok
          ? "rules-stale: invalid-structure"
          : verified.reason || "rules-stale: empty-list";
        const reasonDetail = verified.detail && verified.detail !== reason
          ? `${reason}：${verified.detail}`
          : reason;
        const paginationLimited = limitRepeatedPagination(source, reason, verified.detail);
        if (paginationLimited) {
          const limitedVerify = await verifyChecked(paginationLimited, sourceSignal, { initial: true });
          throwIfAborted(sourceSignal);
          if (limitedVerify.ok && validateXiangseSource(paginationLimited).ok) {
            await keepVerified(name, paginationLimited, limitedVerify, "", {
              signal: sourceSignal,
              download: sourceDownload,
            });
            fallbackCount += 1;
            warnings.push({
              source: name,
              section: "bookWorld/chapterList",
              field: "pagination",
              message: "上游第 2 页与第 1 页重复，已将该入口限制为单页并重新验证通过",
              rule: limitedVerify.bookUrl || "",
            });
            processed += 1;
            continue;
          }
        }
        if (analyzeFallback && requireBookWorld && reason === "rules-stale: empty-list"
          && Object.keys(source?.bookWorld || {}).length && source?.searchBook) {
          markStage("repair-browse-from-search");
          const searchOnly = { ...source, bookWorld: {} };
          const searchProof = await verifyConvertedSource(searchOnly, {
            download: sourceDownload,
            timeoutMs: Math.min(timeoutMs, verificationPhaseTimeoutMs(sourceSignal)),
            sourceTimeoutMs: verificationPhaseTimeoutMs(sourceSignal),
            runtimeFallbackTimeoutMs,
            runtimeFallbackBudget: { remainingMs: 0 },
            signal: sourceSignal,
          });
          throwIfAborted(sourceSignal);
          if (searchProof.ok) {
            const browseRepair = reuseSearchListRulesForBrowse(source);
            if (browseRepair && validateXiangseSource(browseRepair.source).ok) {
              markStage("verify-repaired-browse");
              const browseProof = await verifyChecked(browseRepair.source, sourceSignal);
              throwIfAborted(sourceSignal);
              if (browseProof.ok) {
                await keepVerified(name, browseRepair.source, browseProof, "", {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                fallbackCount += 1;
                warnings.push({
                  source: name,
                  section: "bookWorld",
                  field: "list",
                  message: `分类入口列表规则失效，已复用实测可用的搜索列表结构修复 ${browseRepair.repairedWorlds} 个分类并通过完整动作链`,
                  rule: browseProof.bookUrl || "",
                });
                processed += 1;
                continue;
              }
            }
          }
        }
        if (!analyzeFallback) {
          skipUnusable(name, `${reasonDetail}；未启用持续识站`, source);
          continue;
        }
        if (reason === "rules-stale: empty-content" && verified.chapterUrl
          && typeof repairContent === "function") {
          markStage("repair-content");
          report({ step: "repair-content" });
          const contentFixed = await repairContentAndVerify(source, verified, {
            signal: sourceSignal,
            download: sourceDownload,
          });
          throwIfAborted(sourceSignal);
          if (contentFixed) {
            await keepVerified(name, contentFixed.source, contentFixed.verified, "", {
              signal: sourceSignal,
              download: sourceDownload,
            });
            fallbackCount += 1;
            warnings.push({
              source: name,
              section: "chapterContent",
              field: "verify",
              message: "原正文规则抽测失败，已从真实章节页通用识别正文容器并重新验证通过",
              rule: verified.chapterUrl,
            });
            processed += 1;
            continue;
          }
        }
        const shouldRepairBooks = [
          "rules-stale: empty-list",
          "rules-stale: invalid-elements",
          "rules-stale: empty-content",
        ].includes(reason);
        if (shouldRepairBooks && typeof repairBooks === "function") {
          markStage("repair-books");
          report({ step: "repair-books" });
          let partial = null;
          try {
            partial = await withinTimeout(
              (repairSignal) => Promise.resolve(repairBooks(source, {
                download: downloadWithSignal(sourceDownload, repairSignal),
                signal: repairSignal,
                limit: repairRequestLimit,
              })),
              analyzeTimeoutMs,
              "书籍列表识站修复",
              { signal: sourceSignal },
            );
          } catch (error) {
            if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, source, verified))) {
              if (sourceSignal.aborted) throw error;
              throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
            }
            // Continue with whole-site analysis below.
          }
          throwIfAborted(sourceSignal);
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              const partialVerify = await verifyChecked(partial, sourceSignal);
              throwIfAborted(sourceSignal);
              if (partialVerify.ok) {
                await keepVerified(name, partial, partialVerify, "", {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                fallbackCount += 1;
                warnings.push({
                  source: name,
                  section: "bookWorld/searchBook",
                  field: "verify",
                  message: "原 JSON 书籍列表字段抽测失败，已按实时响应通用重识别并重新验证通过",
                  rule: partialVerify.bookUrl || "",
                });
                processed += 1;
                continue;
              }
              const listContentFixed = await repairContentAndVerify(partial, partialVerify, {
                signal: sourceSignal,
                download: sourceDownload,
              });
              throwIfAborted(sourceSignal);
              if (listContentFixed) {
                await keepVerified(name, listContentFixed.source, listContentFixed.verified, "", {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                fallbackCount += 1;
                warnings.push({
                  source: name,
                  section: "bookWorld/searchBook/chapterContent",
                  field: "verify",
                  message: "原书籍列表和正文均失效，已依次通用重识别并重新验证通过",
                  rule: listContentFixed.verified.chapterUrl || partialVerify.bookUrl || "",
                });
                processed += 1;
                continue;
              }
              if (partialVerify.reason === "rules-stale: empty-toc"
                && partialVerify.bookUrl
                && typeof repairChapter === "function") {
                let chained = null;
                try {
                  chained = await repairChapterFor(partial, partialVerify.bookUrl, {
                    signal: sourceSignal,
                    download: sourceDownload,
                  });
                } catch (error) {
                  if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, source, partialVerify))) {
                    if (sourceSignal.aborted) throw error;
                    throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
                  }
                  // Whole-site recognition remains the next stage.
                }
                if (chained) {
                  const chainedStructure = validateXiangseSource(chained);
                  if (chainedStructure.ok) {
                    const chainedVerify = await verifyChecked(chained, sourceSignal);
                    throwIfAborted(sourceSignal);
                    if (chainedVerify.ok) {
                      await keepVerified(name, chained, chainedVerify, "", {
                        signal: sourceSignal,
                        download: sourceDownload,
                      });
                      fallbackCount += 1;
                      warnings.push({
                        source: name,
                        section: "bookWorld/chapterList",
                        field: "verify",
                        message: "原 JSON 列表和目录均失效，已依次通用重识别并重新验证通过",
                        rule: partialVerify.bookUrl,
                      });
                      processed += 1;
                      continue;
                    }
                    const contentFixed = await repairContentAndVerify(chained, chainedVerify, {
                      signal: sourceSignal,
                      download: sourceDownload,
                    });
                    throwIfAborted(sourceSignal);
                    if (contentFixed) {
                      await keepVerified(name, contentFixed.source, contentFixed.verified, "", {
                        signal: sourceSignal,
                        download: sourceDownload,
                      });
                      fallbackCount += 1;
                      warnings.push({
                        source: name,
                        section: "bookWorld/chapterList/chapterContent",
                        field: "verify",
                        message: "原 JSON 列表、目录和正文连续失效，已逐级通用重识别并重新验证通过",
                        rule: contentFixed.verified.chapterUrl || partialVerify.bookUrl,
                      });
                      processed += 1;
                      continue;
                    }
                  }
                }
              }
            }
          }
        }
        if (reason === "rules-stale: empty-toc" && verified.bookUrl
          && (typeof repairChapter === "function" || typeof repairJsonChapter === "function")) {
          markStage("repair-chapter");
          report({ step: "repair-chapter" });
          let partial = null;
          try {
            partial = await repairChapterFor(source, verified.bookUrl, {
              signal: sourceSignal,
              download: sourceDownload,
            });
          } catch (error) {
            if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, source, verified))) {
              if (sourceSignal.aborted) throw error;
              throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
            }
            // A malformed detail page only invalidates this repair attempt.
          }
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              const partialVerify = await verifyChecked(partial, sourceSignal);
              throwIfAborted(sourceSignal);
              if (partialVerify.ok) {
                await keepVerified(name, partial, partialVerify, "", {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                fallbackCount += 1;
                warnings.push({
                  source: name,
                  section: "chapterList",
                  field: "verify",
                  message: "原目录规则抽测失败，已从真实详情页通用识别目录并重新验证通过",
                  rule: verified.bookUrl,
                });
                processed += 1;
                continue;
              }
              const contentFixed = await repairContentAndVerify(partial, partialVerify, {
                signal: sourceSignal,
                download: sourceDownload,
              });
              throwIfAborted(sourceSignal);
              if (contentFixed) {
                await keepVerified(name, contentFixed.source, contentFixed.verified, "", {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                fallbackCount += 1;
                warnings.push({
                  source: name,
                  section: "chapterList/chapterContent",
                  field: "verify",
                  message: "原目录和正文均失效，已依次从真实目录页和章节页通用识别并重新验证通过",
                  rule: contentFixed.verified.chapterUrl || verified.bookUrl,
                });
                processed += 1;
                continue;
              }
            }
          }
        }
        const host = sourceHostKey(source);
        if (!host) {
          skipUnusable(name, `${reasonDetail}；缺少 sourceUrl/host，无法识站修复`, source);
          continue;
        }
        const preferKind = String(source?.sourceType || "").trim();
        let analyzed = null;
        let correctedKind = "";
        let picked = null;
        let pickedVerified = null;
        const repairFailures = [];
        const seenProbeBatches = new Set();
        const timedOutProbeBatches = new Set();
        const retriedTimedOutProbeBatches = new Set();
        const configuredRecognitionAttempts = Math.max(1, Number(recognitionAttempts) || 1);
        const maxRecognitionAttempts = continueRecognitionUntilTimeout
          ? Number.POSITIVE_INFINITY
          : configuredRecognitionAttempts;
        let earlyAiAttempted = false;
        let sourceAiAttemptsUsed = 0;
        let acceptedByAiDuringRecognition = false;
        const waitBeforeRecognitionRetry = async (completedAttempts) => {
          if (completedAttempts >= maxRecognitionAttempts) return;
          const delayMs = continueRecognitionUntilTimeout
            ? completedAttempts <= configuredRecognitionAttempts
              ? 100
              : Math.min(2_000, 100 * (2 ** Math.min(completedAttempts - configuredRecognitionAttempts, 5)))
            : 100;
          await delayWithSignal(delayMs, sourceSignal);
        };
        const tryEarlyAiRepair = async () => {
          if (!continueRecognitionUntilTimeout || earlyAiAttempted
            || recognitionAttemptsUsed < configuredRecognitionAttempts
            || !aiProviderReady(aiSettings)) return false;
          earlyAiAttempted = true;
          const result = await tryAiRepair(
            host,
            name,
            source,
            `首轮通用识站 ${recognitionAttemptsUsed} 轮仍未通过完整验链：${repairFailures.slice(-4).join("；")}（原始抽测：${reasonDetail}）`,
            verified,
            {
              signal: sourceSignal,
              download: sourceDownload,
              aiAttemptsUsed: () => sourceAiAttemptsUsed,
              onAiAttempt: () => { sourceAiAttemptsUsed += 1; },
              onStage: markStage,
              onFailure: rememberFailure,
            },
          );
          if (result.ok) {
            acceptedByAiDuringRecognition = true;
            return true;
          }
          if (result.attempts) {
            repairFailures.push(`首轮 AI 已尝试 ${result.attempts} 次但未通过：${redactDiagnosticText(result.reason)}`);
          } else {
            repairFailures.push(`首轮 AI 未启动：${redactDiagnosticText(result.reason || "未提供原因", 300)}`);
          }
          return false;
        };
        recognition: for (let recognitionAttempt = 0;
          recognitionAttempt < maxRecognitionAttempts && !picked
            && (!aiProviderReady(aiSettings) || hasAiReserveForRecognition(sourceSignal, sourceAiAttemptsUsed));
          recognitionAttempt += 1) {
          recognitionAttemptsUsed = recognitionAttempt + 1;
          markStage(recognitionAttempt ? "analyze-retry" : "analyze");
          report({
            step: recognitionAttempt ? "analyze-retry" : "analyze",
            attempt: recognitionAttempt + 1,
          });
          analyzed = await analyzeFor(host, preferKind, name, source, {
            signal: sourceSignal,
            download: sourceDownload,
            attempt: recognitionAttempt,
            onProbeBatch: (fingerprint) => {
              if (seenProbeBatches.has(fingerprint)) {
                // A short transient can recover on one fresh request. Repeating
                // the same timed-out URLs indefinitely does not add recognition
                // evidence; let the next distinct seed batch use the remaining
                // source budget instead.
                if (timedOutProbeBatches.has(fingerprint)
                  && !retriedTimedOutProbeBatches.has(fingerprint)) {
                  retriedTimedOutProbeBatches.add(fingerprint);
                  return true;
                }
                return false;
              }
              seenProbeBatches.add(fingerprint);
              return true;
            },
          });
          originConfirmedFor(sourceSignal, source, analyzed);
          if (!analyzed?.ok && analyzed?.reason) rememberFailure(analyzed.reason);
          throwIfAborted(sourceSignal);
          if (analyzed?.probeBatchFingerprint) {
            seenProbeBatches.add(analyzed.probeBatchFingerprint);
          }
          if (analyzed?.repeatedEvidence) {
            repairFailures.push(analyzed.reason || "识站入口批次重复，已停止无新增证据的重试");
            break recognition;
          }
          if (!analyzed.ok) {
            if (isTimeoutFailure(analyzed)) {
              if (analyzed.probeBatchFingerprint) {
                timedOutProbeBatches.add(analyzed.probeBatchFingerprint);
              }
              // `analyzeTimeoutMs` bounds one recognition pass, not the whole
              // source. A single slow probe must not be mislabeled as an
              // unreachable site; retry with the next recognition attempt and
              // let the enclosing per-source budget be the terminal timeout.
              repairFailures.push(analyzed.reason || "analyze-failed: 单轮识站超时");
              if (await tryEarlyAiRepair()) break recognition;
              await waitBeforeRecognitionRetry(recognitionAttempt + 1);
              continue recognition;
            }
            if (isUnavailableFailure(analyzed) && !originConfirmedFor(sourceSignal, source, analyzed)) {
              if (Number(analyzed.remainingSeedRequests) > 0) {
                repairFailures.push(
                  `${analyzed.reason || "analyze-failed: 当前入口不可访问"}；仍有 ${analyzed.remainingSeedRequests} 个声明入口未探测，继续轮换尝试`,
                );
                if (await tryEarlyAiRepair()) break recognition;
                await waitBeforeRecognitionRetry(recognitionAttempt + 1);
                continue recognition;
              }
              throw sourceUnavailableError(analyzed);
            }
            repairFailures.push(analyzed.reason || "analyze-failed: 识站失败");
            if (await tryEarlyAiRepair()) break recognition;
            await waitBeforeRecognitionRetry(recognitionAttempt + 1);
            continue recognition;
          }
          const generated = {
            ...(analyzed.sources || {}),
            ...(analyzed.repairCandidates || {}),
          };
          let candidates = Object.entries(generated)
            .filter(([, candidate]) => !preferKind || candidate?.sourceType === preferKind);
          correctedKind = "";
          if (!candidates.length && preferKind) {
            const generatedKinds = [...new Set(Object.values(generated)
              .map((candidate) => String(candidate?.sourceType || ""))
              .filter((kind) => ["text", "comic", "audio", "video"].includes(kind)))];
            const preferredKindDetected = Array.isArray(analyzed.detectedKinds)
              ? analyzed.detectedKinds.includes(preferKind)
              : (analyzed.skippedKinds || []).some((item) => item?.kind === preferKind);
            // A single independently verified detected kind is stronger evidence
            // than stale source metadata only when the declared kind was not also
            // detected. A broken preferred discovery must remain a repair failure.
            if (generatedKinds.length === 1 && (!preferredKindDetected || preferKind === "text")) {
              correctedKind = generatedKinds[0];
              candidates = Object.entries(generated)
                .filter(([, candidate]) => candidate?.sourceType === correctedKind);
            }
          }
          if (!candidates.length && !preferKind && analyzed.source) {
            candidates.push([analyzed.source.sourceName || name, analyzed.source]);
          }
          if (!candidates.length) {
            const kinds = Object.values(generated)
              .map((item) => item?.sourceType)
              .filter(Boolean)
              .join("/");
            repairFailures.push(
              `识站未生成可用的${preferKind || "匹配"}源${kinds ? `（仅有 ${kinds}）` : ""}`,
            );
            if (await tryEarlyAiRepair()) break recognition;
            await waitBeforeRecognitionRetry(recognitionAttempt + 1);
            continue recognition;
          }
          for (const [candidateName, candidate] of candidates) {
            markStage("candidate-chain");
            let repaired = carryReusableComicDecoder({ ...candidate, sourceName: name }, source);
            let structural = validateXiangseSource(repaired);
            if (!structural.ok) {
              repairFailures.push(`结构校验失败：${structural.errors.slice(0, 3).join("；")}`);
              continue;
            }
            const runtime = analyzed.runtimeReports?.[candidateName];
            const runtimeChapterUrl = runtime?.steps?.chapterList?.chapterUrl || "";
            const runtimeContent = runtime?.steps?.chapterContent;
            const runtimeShowsBrokenContent = Boolean(runtimeChapterUrl) && (
              (repaired.sourceType === "comic" && !usableComicContentReport(runtimeContent))
              || (!runtime?.ok && /(?:content|正文)/i.test(String(runtime?.error || "")))
            );
            if (runtimeShowsBrokenContent && typeof repairContent === "function") {
              try {
                const contentRepaired = await withinTimeout(
                  (repairSignal) => Promise.resolve(repairContent(repaired, runtimeChapterUrl, {
                    download: downloadWithSignal(sourceDownload, repairSignal),
                    adapterBase,
                    signal: repairSignal,
                  })),
                  analyzeTimeoutMs,
                  "识站候选正文预修复",
                  { signal: sourceSignal },
                );
                throwIfAborted(sourceSignal);
                if (contentRepaired) {
                  const repairedStructural = validateXiangseSource(contentRepaired);
                  if (repairedStructural.ok) {
                    repaired = contentRepaired;
                    structural = repairedStructural;
                  }
                }
              } catch (error) {
                if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, repaired, runtime))) {
                  if (sourceSignal.aborted) throw error;
                  throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
                }
                // The strict verifier below still decides whether the original candidate works.
              }
            }
            let repairedVerify = await verifyChecked(repaired, sourceSignal);
            throwIfAborted(sourceSignal);
            if (repairedVerify.reason === "rules-stale: empty-toc"
              && repairedVerify.bookUrl
              && (typeof repairChapter === "function" || typeof repairJsonChapter === "function")) {
              try {
                const chapterRepaired = await repairChapterFor(repaired, repairedVerify.bookUrl, {
                  signal: sourceSignal,
                  download: sourceDownload,
                });
                if (chapterRepaired && validateXiangseSource(chapterRepaired).ok) {
                  const chapterVerify = await verifyChecked(chapterRepaired, sourceSignal);
                  throwIfAborted(sourceSignal);
                  if (chapterVerify.ok || chapterVerify.reason === "rules-stale: empty-content") {
                    repaired = chapterRepaired;
                    repairedVerify = chapterVerify;
                  } else {
                    repairFailures.push(chapterVerify.detail || chapterVerify.reason || "目录修复后抽测失败");
                  }
                }
              } catch (error) {
                if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, repaired, repairedVerify))) {
                  if (sourceSignal.aborted) throw error;
                  throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
                }
                repairFailures.push(error instanceof Error ? error.message : String(error));
              }
            }
            if (repairedVerify.reason === "rules-stale: empty-content"
              && repairedVerify.chapterUrl
              && typeof repairContent === "function") {
              try {
                const contentRepaired = await withinTimeout(
                  (repairSignal) => Promise.resolve(repairContent(repaired, repairedVerify.chapterUrl, {
                    download: downloadWithSignal(sourceDownload, repairSignal),
                    adapterBase,
                    signal: repairSignal,
                  })),
                  analyzeTimeoutMs,
                  "识站后正文修复",
                  { signal: sourceSignal },
                );
                if (contentRepaired && validateXiangseSource(contentRepaired).ok) {
                  const contentVerify = await verifyChecked(contentRepaired, sourceSignal);
                  throwIfAborted(sourceSignal);
                  if (contentVerify.ok) {
                    repaired = contentRepaired;
                    repairedVerify = contentVerify;
                  } else {
                    repairFailures.push(contentVerify.detail || contentVerify.reason || "正文修复后抽测失败");
                  }
                }
              } catch (error) {
                if (shouldStopOnRepairFailure(error, sourceSignal, originConfirmedFor(sourceSignal, repaired, repairedVerify))) {
                  if (sourceSignal.aborted) throw error;
                  throw isTimeoutFailure(error) ? sourceTimeoutError(error) : sourceUnavailableError(error);
                }
                repairFailures.push(error instanceof Error ? error.message : String(error));
              }
            }
            if (repairedVerify.ok) {
              picked = repaired;
              pickedVerified = repairedVerify;
              break;
            }
            repairFailures.push(repairedVerify.detail || repairedVerify.reason || "抽测失败");
          }
          if (picked) break recognition;
          if (await tryEarlyAiRepair()) break recognition;
          if (!analyzed?.probeBatchFingerprint) download.clearCache?.();
          await waitBeforeRecognitionRetry(recognitionAttempt + 1);
        }
        if (acceptedByAiDuringRecognition) continue sourceLoop;
        if (!picked) {
          const aiResult = await tryAiRepair(host, name, source,
            `通用识站持续 ${recognitionAttemptsUsed} 轮仍未通过完整验链：${repairFailures.slice(0, 4).join("；")}（原始抽测：${reasonDetail}）`,
            verified,
            {
              signal: sourceSignal,
              download: sourceDownload,
              aiAttemptsUsed: () => sourceAiAttemptsUsed,
              onAiAttempt: () => { sourceAiAttemptsUsed += 1; },
              onStage: markStage,
              onFailure: rememberFailure,
            });
          if (aiResult?.ok) continue;
          const attemptsDescription = Number.isFinite(maxRecognitionAttempts)
            ? maxRecognitionAttempts
            : recognitionAttemptsUsed;
          const aiFailure = aiResult?.attempts
            ? `；AI 已尝试 ${aiResult.attempts} 次但未通过：${redactDiagnosticText(aiResult.reason)}`
            : aiProviderReady(aiSettings)
              ? `；AI 未启动：${redactDiagnosticText(aiResult?.reason || "未提供原因", 300)}`
              : "";
          skipUnusable(
            name,
            `analyze-failed: 持续识站 ${attemptsDescription} 轮仍未通过完整验链${repairFailures.length ? `：${repairFailures.slice(0, 3).join("；")}` : ""}${aiFailure}（原始抽测：${reasonDetail}）`,
            source,
            currentStage,
            recognitionAttemptsUsed,
          );
          continue;
        }
        const keptResult = await keepVerified(
          name,
          picked,
          pickedVerified,
          "通用识站后已继续从真实详情页补全书籍元素并重新验链",
          {
            signal: sourceSignal,
            download: sourceDownload,
          },
        );
        picked = keptResult.source;
        pickedVerified = keptResult.verified;
        fallbackCount += 1;
        if (analyzed.warning) warnings.push({ ...analyzed.warning, source: name });
        if (correctedKind && correctedKind !== preferKind) {
          warnings.push({
            source: name,
            section: "source",
            field: "sourceType",
            message: `原源类型 ${preferKind} 与实时站点不符，已按唯一可验证识站结果修正为 ${correctedKind}`,
            rule: host,
          });
        }
        warnings.push({
          source: name,
          section: "source",
          field: "verify",
          message: `阅读规则抽测失败（${reason}），已持续识站并通过完整验链`,
          rule: host,
        });
        processed += 1;
      } catch (error) {
        const alreadyReported = Object.prototype.hasOwnProperty.call(kept, name)
          || skipped.some((item) => item.source === name);
        if (!alreadyReported) {
          const message = error?.message || String(error);
          const timedOut = sourceSignal.aborted || isTimeoutFailure(error);
          const unavailable = isUnavailableFailure(error);
          skipUnusable(
            name,
            unavailable
              ? `dead-origin: ${message}`
              : timedOut
              ? `rules-stale: source-timeout: ${message}`
              : `pipeline-failed: ${message}`,
            source,
            currentStage,
            recognitionAttemptsUsed,
          );
        }
      } finally {
        if (sourceTimer) clearTimeout(sourceTimer);
        if (signal && parentAbort) signal.removeEventListener("abort", parentAbort);
        stageHandlers.delete(sourceSignal);
        active.delete(label);
        report();
      }
    }
  });
  await Promise.all(workers);

  return {
    sources: kept,
    skipped,
    warnings,
    fallbackCount,
    aiAttemptCount,
    aiRepairCount,
    verifiedCount: Object.keys(kept).length - fallbackCount - unverifiedCount,
    failedVerifyCount,
    unverifiedCount,
  };
}

function workerPoolResult() {
  return {
    sources: {},
    skipped: [],
    warnings: [],
    fallbackCount: 0,
    aiAttemptCount: 0,
    aiRepairCount: 0,
    verifiedCount: 0,
    failedVerifyCount: 0,
    unverifiedCount: 0,
  };
}

function workerPoolOptions(options) {
  return {
    concurrency: 1,
    timeoutMs: options.timeoutMs,
    sourceTimeoutMs: options.sourceTimeoutMs,
    runtimeFallbackTimeoutMs: options.runtimeFallbackTimeoutMs,
    repairRequestLimit: options.repairRequestLimit,
    analyzeTimeoutMs: options.analyzeTimeoutMs,
    enabled: options.enabled,
    analyzeFallback: options.analyzeFallback,
    originReachabilityConfirmed: options.originReachabilityConfirmed,
    unconfirmedOriginHosts: options.unconfirmedOriginHosts,
    unconfirmedOriginSources: options.unconfirmedOriginSources,
    retainUnverified: options.retainUnverified,
    recognitionAttempts: options.recognitionAttempts,
    continueRecognitionUntilTimeout: options.continueRecognitionUntilTimeout,
    requireBookWorld: options.requireBookWorld,
    budgetMs: 0,
    sourceBudgetMs: options.sourceBudgetMs,
    adapterBase: options.adapterBase,
    aiSettings: options.aiSettings,
  };
}

function workerExecArgv() {
  // `node --input-type=module` is valid for eval/stdin only and cannot be
  // inherited by a file-backed Worker. Test-runner flags likewise belong to
  // the parent process, not to every verification worker.
  return process.execArgv.filter((argument) => !/^(?:--input-type(?:=|$)|--test(?:=|$)|--test-.*|--experimental-test-coverage$)/.test(argument));
}

/**
 * Run complete source verification in CPU-bound worker threads. Network
 * preflight remains an async pool because it is I/O-bound; this pool is for
 * DOM/JSON parsing, rule execution and generic site analysis that otherwise
 * monopolise the job worker's event loop.
 */
async function applyVerifyAndAnalyzeFallbackInWorkers(sources, options, workerCount) {
  const entries = Object.entries(sources || {});
  if (entries.length <= 1 || workerCount <= 1) {
    return applyVerifyAndAnalyzeFallbackSingle(sources, options);
  }

  const result = workerPoolResult();
  const handles = new Set();
  const states = new Map();
  const total = entries.length;
  const workerRecycleAfter = Math.max(0, Number(options.workerRecycleAfter) || 0);
  let cursor = 0;
  let completed = 0;
  let nextTaskId = 1;
  let settled = false;
  let resolvePool;
  let rejectPool;
  const sourceBudgetMs = Math.max(0, Number(options.sourceBudgetMs) || 0);
  const workerGraceMs = Math.max(2_000, Number(options.workerGraceMs) || 2_000);
  const workerSourceTimeoutMs = sourceBudgetMs > 0
    ? sourceBudgetMs + workerGraceMs
    : 0;
  const poolPromise = new Promise((resolve, reject) => {
    resolvePool = resolve;
    rejectPool = reject;
  });

  const report = (step = "verify") => {
    const active = [...states.values()];
    const activeAi = active.find((item) => item.stage === "ai-analyze" || item.stage === "ai-verify");
    const aiAttemptsTotal = result.aiAttemptCount
      + active.reduce((sum, item) => sum + (Number(item.aiAttemptsTotal) || 0), 0);
    const aiRepaired = result.aiRepairCount
      + active.reduce((sum, item) => sum + (Number(item.aiRepaired) || 0), 0);
    emitProgress(options.onProgress, {
      phase: "verify",
      step: activeAi?.stage || step,
      done: completed,
      total,
      kept: Object.keys(result.sources).length,
      skipped: result.skipped.length,
      unverified: result.unverifiedCount,
      fallback: result.fallbackCount,
      aiAttemptsTotal,
      aiRepaired,
      ...(activeAi ? { aiAttempt: activeAi.aiAttempt, aiAttempts: activeAi.aiAttempts } : {}),
      failed: result.failedVerifyCount,
      current: activeAi?.current || active[0]?.current || active[0]?.label || "",
      active: active.map((item) => item.label),
    });
  };

  const finish = () => {
    if (settled || completed < total) return;
    settled = true;
    for (const handle of handles) {
      handle.retiring = true;
      if (handle.timer) clearTimeout(handle.timer);
      void handle.worker.terminate();
    }
    if (options.signal && abortListener) {
      options.signal.removeEventListener("abort", abortListener);
    }
    resolvePool(result);
  };

  const mergeFailure = (state, reason) => {
    if (!state || state.finished) return;
    state.finished = true;
    result.aiAttemptCount += Number(state.aiAttemptsTotal) || 0;
    result.aiRepairCount += Number(state.aiRepaired) || 0;
    result.skipped.push({
      source: state.name,
      reason: state.lastFailure ? `${reason}；最近失败：${state.lastFailure}` : reason,
      ...sourceDiagnostics(state.source, state.stage),
    });
    result.warnings.push({
      source: state.name,
      section: "source",
      field: "verify",
      message: `阅读规则抽测 Worker 未完成，已隔离：${reason}`,
      rule: "",
    });
    completed += 1;
    states.delete(state.handle);
  };

  const mergeResult = (state, childResult) => {
    if (!state || state.finished) return;
    state.finished = true;
    Object.assign(result.sources, childResult?.sources || {});
    result.skipped.push(...(childResult?.skipped || []));
    result.warnings.push(...(childResult?.warnings || []));
    result.fallbackCount += Number(childResult?.fallbackCount) || 0;
    result.aiAttemptCount += Number(childResult?.aiAttemptCount) || 0;
    result.aiRepairCount += Number(childResult?.aiRepairCount) || 0;
    result.verifiedCount += Number(childResult?.verifiedCount) || 0;
    result.failedVerifyCount += Number(childResult?.failedVerifyCount) || 0;
    result.unverifiedCount += Number(childResult?.unverifiedCount) || 0;
    completed += 1;
    states.delete(state.handle);
  };

  const retire = (handle) => {
    if (!handle || handle.retiring) return;
    handle.retiring = true;
    handles.delete(handle);
    if (handle.timer) clearTimeout(handle.timer);
    void handle.worker.terminate().finally(() => {
      if (!settled && completed < total) spawnWorker();
      else finish();
    });
  };

  const failWorkerTask = (handle, error, timedOut = false) => {
    const state = handle?.current;
    if (state) {
      const message = error?.message || String(error || "Worker 异常退出");
      mergeFailure(
        state,
        timedOut
          ? `rules-stale: source-worker-timeout: 源验链 Worker 超时（${sourceBudgetMs}ms；阶段：${state.stage || "unknown"}）`
          : `pipeline-failed: source-worker: ${message}`,
      );
      handle.current = null;
      report(timedOut ? "worker-timeout" : "worker-failed");
    }
    retire(handle);
    if (!state && !settled && completed >= total) finish();
  };

  const assign = (handle) => {
    if (settled || handle.retiring) return;
    if (cursor >= entries.length) {
      if (completed >= total) finish();
      return;
    }
    const [name, source] = entries[cursor];
    cursor += 1;
    const state = {
      handle,
      id: nextTaskId++,
      name,
      source,
      label: sourceDisplayName(name, source),
      current: sourceDisplayName(name, source),
      stage: "worker-start",
      aiAttemptsTotal: 0,
      aiRepaired: 0,
      finished: false,
      timer: null,
    };
    handle.current = state;
    states.set(handle, state);
    if (workerSourceTimeoutMs > 0) {
      state.timer = setTimeout(() => {
        failWorkerTask(
          handle,
          new Error(`源验链 Worker 超时（${workerSourceTimeoutMs}ms；阶段：${state.stage}）`),
          true,
        );
      }, workerSourceTimeoutMs);
    }
    handle.worker.postMessage({
      type: "source",
      id: state.id,
      name,
      source,
      options: workerPoolOptions(options),
    });
    report("verify");
  };

  const handleMessage = (handle, message) => {
    const state = handle.current;
    if (!state || message?.id !== state.id) return;
    if (message.type === "progress") {
      state.current = message.progress?.current || state.label;
      state.stage = String(message.progress?.step || state.stage || "unknown").slice(0, 80);
      if (Number.isFinite(Number(message.progress?.aiAttemptsTotal))) {
        state.aiAttemptsTotal = Number(message.progress.aiAttemptsTotal);
      }
      if (Number.isFinite(Number(message.progress?.aiRepaired))) {
        state.aiRepaired = Number(message.progress.aiRepaired);
      }
      if (Number.isFinite(Number(message.progress?.aiAttempt))) state.aiAttempt = Number(message.progress.aiAttempt);
      if (Number.isFinite(Number(message.progress?.aiAttempts))) state.aiAttempts = Number(message.progress.aiAttempts);
      if (typeof message.progress?.failure === "string" && message.progress.failure) {
        state.lastFailure = redactDiagnosticText(message.progress.failure, 600)
          .replace(/https?:\/\/[^\s"'<>\]}]+/gi, "[URL]");
      }
      report(message.progress?.step || "verify");
      return;
    }
    if (message.type === "error") {
      failWorkerTask(handle, new Error(message.error || "source worker failed"));
      return;
    }
    if (message.type !== "result") return;
    if (state.timer) clearTimeout(state.timer);
    handle.current = null;
    mergeResult(state, message.result);
    handle.completedTasks += 1;
    report("verify");
    if (completed >= total) finish();
    else if (workerRecycleAfter > 0 && handle.completedTasks >= workerRecycleAfter) retire(handle);
    else assign(handle);
  };

  function spawnWorker() {
    if (settled || handles.size >= workerCount) return;
    let worker;
    try {
      worker = new Worker(new URL("./verifyWorkerThread.js", import.meta.url), {
        workerData: { config: options.workerConfig },
        execArgv: workerExecArgv(),
      });
    } catch (error) {
      if (!handles.size && completed === 0) {
        settled = true;
        if (options.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
        void applyVerifyAndAnalyzeFallbackSingle(sources, options).then(resolvePool, rejectPool);
      } else {
        rejectPool(error);
      }
      return;
    }
    const handle = { worker, current: null, timer: null, completedTasks: 0, retiring: false };
    handles.add(handle);
    worker.on("message", (message) => handleMessage(handle, message));
    worker.on("error", (error) => failWorkerTask(handle, error));
    worker.on("exit", (code) => {
      if (handle.retiring || settled) return;
      if (handle.current) {
        failWorkerTask(handle, new Error(`Worker 退出（code ${code}）`));
      } else if (completed < total) {
        retire(handle);
      }
    });
    assign(handle);
  }

  let abortListener;
  if (options.signal) {
    abortListener = () => {
      if (settled) return;
      settled = true;
      for (const handle of handles) {
        handle.retiring = true;
        if (handle.timer) clearTimeout(handle.timer);
        void handle.worker.terminate();
      }
      rejectPool(abortError(options.signal));
    };
    if (options.signal.aborted) abortListener();
    else options.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    for (let index = 0; index < workerCount; index += 1) spawnWorker();
    report("verify");
  } catch (error) {
    if (!settled) {
      settled = true;
      rejectPool(error);
    }
  }
  return poolPromise;
}

/**
 * Verify a source aggregate. `workerCount` is opt-in at this low-level API so
 * existing embedders and deterministic tests remain in-process; the online
 * conversion path enables the CPU-sized pool through serverConfig.
 */
export async function applyVerifyAndAnalyzeFallback(sources, options = {}) {
  const workerCount = Math.max(1, Number(options.workerCount) || 1);
  const canUsePool = options.workerPoolEnabled === true
    && options.workerConfig
    && workerCount > 1
    && Object.keys(sources || {}).length > 1
    // A bounded wall-clock budget has special "keep the unverified tail"
    // semantics implemented by the single-thread coordinator.
    && !(Number(options.budgetMs) > 0);
  if (!canUsePool) return applyVerifyAndAnalyzeFallbackSingle(sources, options);
  return applyVerifyAndAnalyzeFallbackInWorkers(sources, options, workerCount);
}
