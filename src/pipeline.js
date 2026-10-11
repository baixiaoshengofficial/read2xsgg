import { analyzeSite } from "./siteAnalyze/index.js";
import { Worker } from "node:worker_threads";
import { repairChapterFromBook } from "./siteAnalyze/repairChapter.js";
import { carryReusableComicDecoder, repairContentFromChapter } from "./siteAnalyze/repairContent.js";
import { repairDetailFromBook } from "./siteAnalyze/repairDetail.js";
import { repairBooksFromRequests, repairChaptersFromBookJson } from "./siteAnalyze/repairBooks.js";
import { aiCandidateQualityIssue, generateXiangseCandidate } from "./aiSiteAnalyzer.js";
import { aiProviderReady } from "./aiProvider.js";
import {
  resolveBookTargetRequests,
  usableComicContentReport,
  verifyConvertedSource,
} from "./verifySource.js";
import { repairXiangseEntrypoints, validateXiangseSource } from "./xiangseValidate.js";

/**
 * After Legado conversion + origin preflight: verify each source; on failure
 * try site-analyze (generic heuristic) to REPLACE the broken conversion.
 *
 * If verification and repair both fail, the online aggregate path retains a
 * structurally valid converted source as unverified. Only a source that is
 * unreachable before conversion or cannot form a valid Xiangse structure is
 * filtered; temporary upstream responses are not proof that the source is bad.
 *
 * Pass `budgetMs: 0` for unbounded full verify (async library jobs). The
 * online aggregate path may retain a structurally valid source as unverified
 * when its live chain cannot be reproduced during this run.
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
  sourceTimeoutMs = Math.max(15_000, timeoutMs * 5),
  repairRequestLimit = 3,
  analyzeTimeoutMs = 8_000,
  enabled = true,
  analyzeFallback = true,
  aiSettings = null,
  analyze = analyzeSite,
  generateAiCandidate = generateXiangseCandidate,
  repairBooks = repairBooksFromRequests,
  repairChapter = repairChapterFromBook,
  repairContent = repairContentFromChapter,
  repairDetail = repairDetailFromBook,
  repairJsonChapter = repairChaptersFromBookJson,
  budgetMs = 0,
  // A source may need several sequential actions, but a broken upstream must
  // never occupy a worker indefinitely. This is a per-source wall-clock cap;
  // `sourceTimeoutMs` remains the timeout for one verification chain.
  sourceBudgetMs = 30_000,
  // A structurally valid source is still useful when a live action cannot be
  // reproduced right now. The online aggregate path enables this explicitly;
  // low-level callers keep the strict historical default.
  retainUnverified = false,
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
      aiRepairCount: 0,
      verifiedCount: enabled ? input.length : 0,
      failedVerifyCount: 0,
      unverifiedCount: enabled ? 0 : input.length,
    };
    emitProgress(onProgress, {
      phase: "verify",
      done: input.length,
      total: input.length,
      kept: input.length,
      skipped: 0,
      unverified: enabled ? 0 : input.length,
      current: "",
      active: [],
    });
    return result;
  }

  const kept = {};
  const skipped = [];
  const warnings = [];
  let fallbackCount = 0;
  let aiRepairCount = 0;
  let failedVerifyCount = 0;
  let unverifiedCount = 0;
  let cursor = 0;
  let processed = 0;
  const total = input.length;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
  /** @type {Set<string>} */
  const active = new Set();
  /** Share analyze work across sources on the same origin + kind. */
  const analyzeByHost = new Map();
  const verifySource = (source, sourceSignal) => verifyConvertedSource(source, {
    download: downloadWithSignal(download, sourceSignal),
    timeoutMs,
    sourceTimeoutMs,
    signal: sourceSignal,
  });
  const initialVerifySource = (source, sourceSignal) => verifyConvertedSource(source, {
    download: downloadWithSignal(download, sourceSignal),
    timeoutMs,
    // 初始验源是门槛而非精测：预算过短会把慢站（每请求 3~4s）误判为
    // rules-stale/empty-list 直接过滤。给到与完整验源同级的下限（15s）。
    sourceTimeoutMs: Math.min(
      sourceTimeoutMs,
      Math.max(15_000, timeoutMs * 5),
    ),
    signal: sourceSignal,
  });
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
      if (sourceSignal?.aborted) throw error;
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    let finalRepaired = repaired;
    let repairedVerify = await verifySource(finalRepaired, sourceSignal);
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
          const contentVerify = await verifySource(contentRepaired, sourceSignal);
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
    kept[name] = finalSource;
    warnMissingBookElements(warnings, name, finalVerified);
    return { source: finalSource, verified: finalVerified, improved: improvedAny };
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
      if (sourceSignal?.aborted) throw error;
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    const verified = await verifySource(repaired, sourceSignal);
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
      aiRepaired: aiRepairCount,
      failed: failedVerifyCount,
      current: activeList[0] || "",
      active: activeList,
      ...extra,
    });
  };

  const retainIfStructurallyConvertible = (name, candidate, reason) => {
    if (!retainUnverified || signal?.aborted || !candidate) return false;
    let validation;
    try {
      validation = validateXiangseSource(candidate);
    } catch {
      return false;
    }
    if (!validation.ok) return false;
    kept[name] = candidate;
    unverifiedCount += 1;
    warnings.push({
      source: name,
      section: "source",
      field: "verify",
      message: `源结构可转换，但列表/详情/章节/正文完整动作链暂未复现，已保留未验证源：${reason}`,
      rule: String(candidate.sourceUrl || candidate.host || ""),
    });
    processed += 1;
    return true;
  };

  const skipUnusable = (name, reason, candidate = null) => {
    if (retainIfStructurallyConvertible(name, candidate, reason)) return;
    skipped.push({ source: name, reason });
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
    const seedRequests = resolveBookTargetRequests(source);
    const seedKey = seedRequests.map((item) => (
      `${item.options?.method || "GET"}:${item.url}:${item.options?.body || ""}`
    )).join("|");
    const key = `${host}|${preferKind || "*"}|${seedKey}`;
    if (!analyzeByHost.has(key)) {
      const recognizedKind = ["text", "comic", "audio", "video"].includes(preferKind) ? preferKind : "";
      // The shared task must not inherit one source's AbortSignal. Aggregate
      // files often contain renamed copies of the same source; cancelling the
      // first copy used to poison every later copy sharing this promise.
      const runAnalyze = () => withinTimeout((analyzeSignal) => Promise.resolve(analyze(host, {
        download,
        sourceName: name,
        timeoutMs: analyzeTimeoutMs,
        // The pipeline performs the strict list → detail → chapter → content
        // verification immediately after candidate generation. Running the
        // same runtime walk inside analyzeSite first doubled upstream traffic
        // and made fallback timeouts look like source failures.
        validateRuntime: false,
        preferKind: recognizedKind,
        seedRequests,
        adapterBase,
        repairSource: source,
        signal: analyzeSignal,
      })), analyzeTimeoutMs, "通用识站").catch((error) => ({
        ok: false,
        reason: `analyze-failed: ${error.message || error}`,
      }));
      analyzeByHost.set(key, (async () => {
        const first = await runAnalyze();
        const generated = [
          ...Object.values(first?.sources || {}),
          ...Object.values(first?.repairCandidates || {}),
        ];
        const detectedButMissing = Boolean(recognizedKind)
          && !generated.some((candidate) => candidate?.sourceType === recognizedKind)
          && ((first?.skippedKinds || []).some((item) => item?.kind === recognizedKind)
            || (first?.kinds || []).includes(recognizedKind));
        if (!detectedButMissing) return first;
        download.clearCache?.();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return runAnalyze();
      })());
    }
    const shared = analyzeByHost.get(key);
    if (!sourceSignal) return shared;
    return withinTimeout(() => shared, analyzeTimeoutMs, "通用识站", { signal: sourceSignal });
  };

  const tryAiRepair = async (host, preferKind, name, source, failure, verification, context = {}) => {
    if (!aiProviderReady(aiSettings)) return false;
    // AI cannot repair a site that failed at the transport layer. Keep provider
    // calls for reachable responses with a real rule/selector mismatch only.
    if (/(?:timeout|timed\s*out|超时|econn(?:reset|refused)|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i.test(String(failure || ""))) return false;
    const sourceSignal = context.signal;
    const sourceDownload = context.download || download;
    const attempts = Math.min(3, Math.max(1, Number(aiSettings.maxAttempts) || 2));
    let feedback = String(failure || "");
    let lastVerification = verification || {};
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(sourceSignal);
      report({ step: "ai-analyze", aiAttempt: attempt, aiAttempts: attempts });
      let generated;
      try {
        generated = await withinTimeout(
          (aiSignal) => generateAiCandidate({
            settings: aiSettings,
            host,
            sourceName: name,
            source,
            preferredKind: preferKind,
            failureReason: `第 ${attempt} 次修复。${feedback}`,
            verification: lastVerification,
            seedRequests: resolveBookTargetRequests(source),
            download: downloadWithSignal(sourceDownload, aiSignal),
            signal: aiSignal,
          }),
          Math.max(6_000, Number(aiSettings.timeoutMs) || 30_000) + 1_000,
          "AI 识站修复",
          { signal: sourceSignal },
        );
      } catch (error) {
        if (sourceSignal?.aborted) throw error;
        feedback = `AI 识站失败：${error?.message || error}`;
        lastVerification = { reason: feedback };
        continue;
      }
      if (!generated?.ok || !generated.source) {
        feedback = generated?.reason || "AI 未生成候选规则";
        lastVerification = { reason: feedback };
        continue;
      }
      if (generated.confidence < 0.55) {
        feedback = `AI 置信度不足（${generated.confidence}），需要更明确的链路证据`;
        lastVerification = { reason: feedback, detectedType: generated.detectedType };
        continue;
      }
      let candidate = carryReusableComicDecoder({ ...generated.source, sourceName: name }, source);
      const structural = validateXiangseSource(candidate);
      if (!structural.ok) {
        feedback = `Xiangse 结构校验失败：${structural.errors.slice(0, 5).join("；")}`;
        lastVerification = { reason: feedback };
        continue;
      }
      let checked;
      try {
        checked = await verifySource(candidate, sourceSignal);
        throwIfAborted(sourceSignal);
        if (checked.reason === "rules-stale: empty-toc" && checked.bookUrl) {
          const chapterCandidate = await repairChapterFor(candidate, checked.bookUrl, {
            signal: sourceSignal,
            download: sourceDownload,
          });
          if (chapterCandidate && validateXiangseSource(chapterCandidate).ok) {
            const chapterCheck = await verifySource(chapterCandidate, sourceSignal);
            if (chapterCheck.ok || chapterCheck.reason === "rules-stale: empty-content") {
              candidate = chapterCandidate;
              checked = chapterCheck;
            }
          }
        }
        if (checked.reason === "rules-stale: empty-content" && checked.chapterUrl) {
          const contentFixed = await repairContentAndVerify(candidate, checked, {
            signal: sourceSignal,
            download: sourceDownload,
          });
          if (contentFixed) {
            candidate = contentFixed.source;
            checked = contentFixed.verified;
          }
        }
      } catch (error) {
        if (sourceSignal?.aborted) throw error;
        feedback = `AI 候选规则实测失败：${error?.message || error}`;
        lastVerification = { reason: feedback };
        continue;
      }
      if (checked?.ok) {
        const qualityIssue = aiCandidateQualityIssue(candidate, checked);
        if (qualityIssue) {
          feedback = qualityIssue;
          lastVerification = { ...checked, detail: qualityIssue };
          continue;
        }
        await keepVerified(name, candidate, checked, "", {
          signal: sourceSignal,
          download: sourceDownload,
        });
        fallbackCount += 1;
        aiRepairCount += 1;
        warnings.push({
          source: name,
          section: "source",
          field: "ai-repair",
          message: `通用转换/识站未通过后，AI 按 ${generated.detectedType} 生成声明式规则并通过完整链路实测（尝试 ${attempt}/${attempts}，MCP 只读工具 ${generated.toolCalls || 0} 次）`,
          rule: checked.chapterUrl || checked.bookUrl || host,
        });
        processed += 1;
        report({ step: "ai-repair-verified" });
        return true;
      }
      lastVerification = checked || {};
      feedback = `候选规则完整链路未通过：${checked?.detail || checked?.reason || "未知验证失败"}`;
      if (/(?:timeout|timed\s*out|超时|econn(?:reset|refused)|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i.test(feedback)) break;
    }
    return false;
  };

  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      const [name, inputSource] = input[index];
      let source = inputSource;
      const label = sourceDisplayName(name, source);

      if (deadline && Date.now() >= deadline) {
        kept[name] = source;
        unverifiedCount += 1;
        processed += 1;
        report();
        continue;
      }

      active.add(label);
      const sourceController = new AbortController();
      const sourceSignal = sourceController.signal;
      const sourceDownload = downloadWithSignal(download, sourceSignal);
      let sourceTimer;
      let parentAbort;
      if (signal) {
        parentAbort = () => sourceController.abort(abortError(signal));
        if (signal.aborted) parentAbort();
        else signal.addEventListener("abort", parentAbort, { once: true });
      }
      if (Number(sourceBudgetMs) > 0) {
        sourceTimer = setTimeout(() => {
          sourceController.abort(new Error(`源验链超时（${Number(sourceBudgetMs)}ms）`));
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
        let verified = await initialVerifySource(source, sourceSignal);
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
          const limitedVerify = await initialVerifySource(paginationLimited, sourceSignal);
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
        if (!analyzeFallback) {
          skipUnusable(name, `${reasonDetail}；未启用识站回退`, source);
          continue;
        }
        if (reason === "rules-stale: empty-content" && verified.chapterUrl
          && typeof repairContent === "function") {
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
            if (sourceSignal.aborted) throw error;
            // Continue with whole-site analysis below.
          }
          throwIfAborted(sourceSignal);
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              // Keep each structurally valid repair as the working candidate,
              // even if a later action still needs repair. If analysis cannot
              // complete the chain, retain the best rules already discovered.
              source = partial;
              const partialVerify = await verifySource(partial, sourceSignal);
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
                  if (sourceSignal.aborted) throw error;
                  // Whole-site analysis remains the final fallback.
                }
                if (chained) {
                  const chainedStructure = validateXiangseSource(chained);
                  if (chainedStructure.ok) {
                    source = chained;
                    const chainedVerify = await verifySource(chained, sourceSignal);
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
          report({ step: "repair-chapter" });
          let partial = null;
          try {
            partial = await repairChapterFor(source, verified.bookUrl, {
              signal: sourceSignal,
              download: sourceDownload,
            });
          } catch (error) {
            if (sourceSignal.aborted) throw error;
            // A malformed detail page only invalidates this repair attempt.
          }
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              source = partial;
              const partialVerify = await verifySource(partial, sourceSignal);
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
        report({ step: "analyze" });
        const preferKind = String(source?.sourceType || "").trim();
        const analyzed = await analyzeFor(host, preferKind, name, source, {
          signal: sourceSignal,
          download: sourceDownload,
        });
        throwIfAborted(sourceSignal);
        if (!analyzed.ok) {
          if (await tryAiRepair(host, preferKind, name, source, reasonDetail, verified, {
            signal: sourceSignal,
            download: sourceDownload,
          })) continue;
          skipUnusable(name, `${analyzed.reason || "analyze-failed: 识站失败"}（阅读规则抽测：${reasonDetail}）`, source);
          continue;
        }
        const generated = {
          ...(analyzed.sources || {}),
          ...(analyzed.repairCandidates || {}),
        };
        let candidates = Object.entries(generated)
          .filter(([, candidate]) => !preferKind || candidate?.sourceType === preferKind);
        let correctedKind = "";
        if (!candidates.length && preferKind) {
          const generatedKinds = [...new Set(Object.values(generated)
            .map((candidate) => String(candidate?.sourceType || ""))
            .filter((kind) => ["text", "comic", "audio", "video"].includes(kind)))];
          const preferredKindDetected = (analyzed.skippedKinds || [])
            .some((item) => item?.kind === preferKind);
          // A single independently verified detected kind is stronger evidence
          // than stale source metadata only when the declared kind was not also
          // detected. A broken preferred discovery must remain a repair failure.
          if (generatedKinds.length === 1 && !preferredKindDetected) {
            correctedKind = generatedKinds[0];
            candidates = Object.entries(generated)
              .filter(([, candidate]) => candidate?.sourceType === correctedKind);
          }
        }
        if (!candidates.length && !preferKind && analyzed.source) {
          candidates.push([analyzed.source.sourceName || name, analyzed.source]);
        }
        if (!candidates.length) {
          const kinds = Object.values(generated).map((item) => item?.sourceType).filter(Boolean).join("/");
          if (await tryAiRepair(
            host,
            preferKind,
            name,
            source,
            `通用识站未生成匹配类型规则（${preferKind || "未指定"}）；${reasonDetail}`,
            verified,
            { signal: sourceSignal, download: sourceDownload },
          )) continue;
          skipUnusable(
            name,
            `analyze-failed: 识站未生成可用的${preferKind || "匹配"}源${kinds ? `（仅有 ${kinds}）` : ""}（阅读规则抽测：${reasonDetail}）`,
            source,
          );
          continue;
        }
        let picked = null;
        let pickedVerified = null;
        const repairFailures = [];
        for (const [candidateName, candidate] of candidates) {
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
              if (sourceSignal.aborted) throw error;
              // The strict verifier below still decides whether the original candidate works.
            }
          }
          let repairedVerify = await verifySource(repaired, sourceSignal);
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
                const chapterVerify = await verifySource(chapterRepaired, sourceSignal);
                throwIfAborted(sourceSignal);
                if (chapterVerify.ok || chapterVerify.reason === "rules-stale: empty-content") {
                  repaired = chapterRepaired;
                  repairedVerify = chapterVerify;
                } else {
                  repairFailures.push(chapterVerify.detail || chapterVerify.reason || "目录修复后抽测失败");
                }
              }
            } catch (error) {
              if (sourceSignal.aborted) throw error;
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
                const contentVerify = await verifySource(contentRepaired, sourceSignal);
                throwIfAborted(sourceSignal);
                if (contentVerify.ok) {
                  repaired = contentRepaired;
                  repairedVerify = contentVerify;
                } else {
                  repairFailures.push(contentVerify.detail || contentVerify.reason || "正文修复后抽测失败");
                }
              }
            } catch (error) {
              if (sourceSignal.aborted) throw error;
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
        if (!picked) {
          if (await tryAiRepair(
            host,
            preferKind,
            name,
            source,
            `通用识站候选规则完整链路未通过：${reasonDetail}；${repairFailures.slice(0, 4).join("；")}`,
            verified,
            { signal: sourceSignal, download: sourceDownload },
          )) continue;
          skipUnusable(
            name,
            `analyze-failed: 识站修复结果仍未通过抽测${repairFailures.length ? `：${repairFailures.slice(0, 3).join("；")}` : ""}（原始抽测：${reasonDetail}）`,
            source,
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
          message: `阅读规则抽测失败（${reason}），已用自动识站修复为可用香色源`,
          rule: host,
        });
        processed += 1;
      } catch (error) {
        const alreadyReported = Object.prototype.hasOwnProperty.call(kept, name)
          || skipped.some((item) => item.source === name);
        if (!alreadyReported) {
          const message = error?.message || String(error);
          skipUnusable(
            name,
            sourceSignal.aborted
              ? `rules-stale: source-timeout: ${message}`
              : `pipeline-failed: ${message}`,
            source,
          );
        }
      } finally {
        if (sourceTimer) clearTimeout(sourceTimer);
        if (signal && parentAbort) signal.removeEventListener("abort", parentAbort);
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
    aiRepairCount,
    verifiedCount: Object.keys(kept).length - unverifiedCount,
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
    repairRequestLimit: options.repairRequestLimit,
    analyzeTimeoutMs: options.analyzeTimeoutMs,
    enabled: options.enabled,
    analyzeFallback: options.analyzeFallback,
    retainUnverified: options.retainUnverified,
    budgetMs: 0,
    sourceBudgetMs: options.sourceBudgetMs,
    adapterBase: options.adapterBase,
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
    emitProgress(options.onProgress, {
      phase: "verify",
      step,
      done: completed,
      total,
      kept: Object.keys(result.sources).length,
      skipped: result.skipped.length,
      unverified: result.unverifiedCount,
      fallback: result.fallbackCount,
      aiRepaired: result.aiRepairCount,
      failed: result.failedVerifyCount,
      current: active[0]?.current || active[0]?.label || "",
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
    let retained = false;
    if (options.retainUnverified && !options.signal?.aborted) {
      try {
        retained = validateXiangseSource(state.source).ok;
      } catch {
        retained = false;
      }
    }
    if (retained) {
      result.sources[state.name] = state.source;
      result.unverifiedCount += 1;
      result.warnings.push({
        source: state.name,
        section: "source",
        field: "verify",
        message: `源结构可转换，但验链 Worker 未完成，已保留未验证源：${reason}`,
        rule: String(state.source?.sourceUrl || state.source?.host || ""),
      });
    } else {
      result.skipped.push({ source: state.name, reason });
      result.warnings.push({
        source: state.name,
        section: "source",
        field: "verify",
        message: `阅读规则抽测 Worker 未完成，已隔离：${reason}`,
        rule: "",
      });
    }
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
          ? `rules-stale: source-worker-timeout: 源验链 Worker 超时（${sourceBudgetMs}ms）`
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
      finished: false,
      timer: null,
    };
    handle.current = state;
    states.set(handle, state);
    if (workerSourceTimeoutMs > 0) {
      state.timer = setTimeout(() => {
        failWorkerTask(
          handle,
          new Error(`源验链 Worker 超时（${workerSourceTimeoutMs}ms）`),
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
    report("verify");
    if (completed >= total) finish();
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
    const handle = { worker, current: null, timer: null, retiring: false };
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
