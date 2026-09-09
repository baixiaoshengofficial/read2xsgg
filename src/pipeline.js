import { analyzeSite } from "./siteAnalyze/index.js";
import { repairChapterFromBook } from "./siteAnalyze/repairChapter.js";
import { carryReusableComicDecoder, repairContentFromChapter } from "./siteAnalyze/repairContent.js";
import { repairDetailFromBook } from "./siteAnalyze/repairDetail.js";
import { repairBooksFromRequests, repairChaptersFromBookJson } from "./siteAnalyze/repairBooks.js";
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
 * If verification and repair both fail, drop the converted source with a
 * diagnostic. A confirmed empty category/catalogue path would otherwise import
 * successfully while remaining unusable in Xiangse.
 *
 * Pass `budgetMs: 0` for unbounded full verify (async library jobs).
 */
function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(payload);
  } catch {
    // Progress callbacks must not break conversion.
  }
}

async function withinTimeout(promise, timeoutMs, label) {
  const duration = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${duration}ms）`)), duration);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

export async function applyVerifyAndAnalyzeFallback(sources, {
  download,
  concurrency = 4,
  timeoutMs = 3_000,
  sourceTimeoutMs = Math.max(12_000, timeoutMs * 4),
  analyzeTimeoutMs = 8_000,
  enabled = true,
  analyzeFallback = true,
  analyze = analyzeSite,
  repairBooks = repairBooksFromRequests,
  repairChapter = repairChapterFromBook,
  repairContent = repairContentFromChapter,
  repairDetail = repairDetailFromBook,
  repairJsonChapter = repairChaptersFromBookJson,
  budgetMs = 0,
  adapterBase = "",
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
  const verifySource = (source) => verifyConvertedSource(source, {
    download,
    timeoutMs,
    sourceTimeoutMs,
  });
  const initialVerifySource = (source) => verifyConvertedSource(source, {
    download,
    timeoutMs,
    sourceTimeoutMs: Math.min(
      sourceTimeoutMs,
      Math.max(timeoutMs * 2, Math.min(20_000, Math.floor(sourceTimeoutMs / 3))),
    ),
  });
  const improveBookElements = async (source, verified) => {
    const missing = [...new Set([
      ...(verified?.bookElements?.missingRecommended || []),
      ...(verified?.derivedRecommended || []),
    ])];
    if (!verified?.ok || !verified.bookUrl || !missing.length || typeof repairDetail !== "function") return null;
    let repaired;
    try {
      repaired = await withinTimeout(
        Promise.resolve(repairDetail(source, verified.bookUrl, missing, { download, adapterBase })),
        analyzeTimeoutMs,
        "详情元素识站修复",
      );
    } catch {
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    let finalRepaired = repaired;
    let repairedVerify = await verifySource(finalRepaired);
    if (repairedVerify.reason === "rules-stale: empty-content"
      && repairedVerify.chapterUrl
      && typeof repairContent === "function") {
      try {
        const contentRepaired = await withinTimeout(
          Promise.resolve(repairContent(finalRepaired, repairedVerify.chapterUrl, { download, adapterBase })),
          analyzeTimeoutMs,
          "详情后正文识站修复",
        );
        if (contentRepaired && validateXiangseSource(contentRepaired).ok) {
          const contentVerify = await verifySource(contentRepaired);
          if (contentVerify.ok) {
            finalRepaired = contentRepaired;
            repairedVerify = contentVerify;
          }
        }
      } catch {
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
  const keepVerified = async (name, source, verified, improvementMessage = "") => {
    let finalSource = source;
    let finalVerified = verified;
    let improvedAny = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const improved = await improveBookElements(finalSource, finalVerified);
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
  const repairChapterFor = async (source, bookUrl) => {
    let repaired = null;
    if (typeof repairChapter === "function") repaired = await withinTimeout(
      Promise.resolve(repairChapter(source, bookUrl, { download, adapterBase })),
      analyzeTimeoutMs,
      "目录识站修复",
    );
    if (!repaired && typeof repairJsonChapter === "function") {
      repaired = await withinTimeout(
        Promise.resolve(repairJsonChapter(source, bookUrl, { download })),
        analyzeTimeoutMs,
        "JSON 目录识别",
      );
    }
    return repaired;
  };
  const repairContentAndVerify = async (source, failedVerify) => {
    if (failedVerify?.reason !== "rules-stale: empty-content"
      || !failedVerify.chapterUrl
      || typeof repairContent !== "function") return null;
    let repaired = null;
    try {
      repaired = await withinTimeout(
        Promise.resolve(repairContent(source, failedVerify.chapterUrl, { download, adapterBase })),
        analyzeTimeoutMs,
        "正文识站修复",
      );
    } catch {
      return null;
    }
    if (!repaired || !validateXiangseSource(repaired).ok) return null;
    const verified = await verifySource(repaired);
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
      failed: failedVerifyCount,
      current: activeList[0] || "",
      active: activeList,
      ...extra,
    });
  };

  const skipUnusable = (name, reason) => {
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

  const analyzeFor = (host, preferKind, name, source) => {
    const seedRequests = resolveBookTargetRequests(source);
    const seedKey = seedRequests.map((item) => (
      `${item.options?.method || "GET"}:${item.url}:${item.options?.body || ""}`
    )).join("|");
    const key = `${host}|${preferKind || "*"}|${seedKey}`;
    if (!analyzeByHost.has(key)) {
      const recognizedKind = ["text", "comic", "audio", "video"].includes(preferKind) ? preferKind : "";
      const runAnalyze = () => withinTimeout(Promise.resolve(analyze(host, {
        download,
        sourceName: name,
        timeoutMs: analyzeTimeoutMs,
        preferKind: recognizedKind,
        seedRequests,
        adapterBase,
        repairSource: source,
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
    return analyzeByHost.get(key);
  };

  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
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
        let verified = await initialVerifySource(source);
        if (verified.ok) {
          if (structural.ok) {
            const keptResult = await keepVerified(name, source, verified);
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
        const paginationLimited = limitRepeatedPagination(source, reason, verified.detail);
        if (paginationLimited) {
          const limitedVerify = await initialVerifySource(paginationLimited);
          if (limitedVerify.ok && validateXiangseSource(paginationLimited).ok) {
            await keepVerified(name, paginationLimited, limitedVerify);
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
          skipUnusable(name, `${reason}；未启用识站回退`);
          continue;
        }
        if (reason === "rules-stale: empty-content" && verified.chapterUrl
          && typeof repairContent === "function") {
          report({ step: "repair-content" });
          const contentFixed = await repairContentAndVerify(source, verified);
          if (contentFixed) {
            await keepVerified(name, contentFixed.source, contentFixed.verified);
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
              Promise.resolve(repairBooks(source, { download })),
              analyzeTimeoutMs,
              "书籍列表识站修复",
            );
          } catch {
            // Continue with whole-site analysis below.
          }
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              const partialVerify = await verifySource(partial);
              if (partialVerify.ok) {
                await keepVerified(name, partial, partialVerify);
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
              const listContentFixed = await repairContentAndVerify(partial, partialVerify);
              if (listContentFixed) {
                await keepVerified(name, listContentFixed.source, listContentFixed.verified);
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
                  chained = await repairChapterFor(partial, partialVerify.bookUrl);
                } catch {
                  // Whole-site analysis remains the final fallback.
                }
                if (chained) {
                  const chainedStructure = validateXiangseSource(chained);
                  if (chainedStructure.ok) {
                    const chainedVerify = await verifySource(chained);
                    if (chainedVerify.ok) {
                      await keepVerified(name, chained, chainedVerify);
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
                    const contentFixed = await repairContentAndVerify(chained, chainedVerify);
                    if (contentFixed) {
                      await keepVerified(name, contentFixed.source, contentFixed.verified);
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
            partial = await repairChapterFor(source, verified.bookUrl);
          } catch {
            // A malformed detail page only invalidates this repair attempt.
          }
          if (partial) {
            const partialStructure = validateXiangseSource(partial);
            if (partialStructure.ok) {
              const partialVerify = await verifySource(partial);
              if (partialVerify.ok) {
                await keepVerified(name, partial, partialVerify);
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
              const contentFixed = await repairContentAndVerify(partial, partialVerify);
              if (contentFixed) {
                await keepVerified(name, contentFixed.source, contentFixed.verified);
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
          skipUnusable(name, `${reason}；缺少 sourceUrl/host，无法识站修复`);
          continue;
        }
        report({ step: "analyze" });
        const preferKind = String(source?.sourceType || "").trim();
        const analyzed = await analyzeFor(host, preferKind, name, source);
        if (!analyzed.ok) {
          skipUnusable(name, `${analyzed.reason || "analyze-failed: 识站失败"}（阅读规则抽测：${reason}）`);
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
          skipUnusable(
            name,
            `analyze-failed: 识站未生成可用的${preferKind || "匹配"}源${kinds ? `（仅有 ${kinds}）` : ""}（阅读规则抽测：${reason}）`,
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
                Promise.resolve(repairContent(repaired, runtimeChapterUrl, { download, adapterBase })),
                analyzeTimeoutMs,
                "识站候选正文预修复",
              );
              if (contentRepaired) {
                const repairedStructural = validateXiangseSource(contentRepaired);
                if (repairedStructural.ok) {
                  repaired = contentRepaired;
                  structural = repairedStructural;
                }
              }
            } catch {
              // The strict verifier below still decides whether the original candidate works.
            }
          }
          let repairedVerify = await verifySource(repaired);
          if (repairedVerify.reason === "rules-stale: empty-toc"
            && repairedVerify.bookUrl
            && (typeof repairChapter === "function" || typeof repairJsonChapter === "function")) {
            try {
              const chapterRepaired = await repairChapterFor(repaired, repairedVerify.bookUrl);
              if (chapterRepaired && validateXiangseSource(chapterRepaired).ok) {
                const chapterVerify = await verifySource(chapterRepaired);
                if (chapterVerify.ok || chapterVerify.reason === "rules-stale: empty-content") {
                  repaired = chapterRepaired;
                  repairedVerify = chapterVerify;
                } else {
                  repairFailures.push(chapterVerify.detail || chapterVerify.reason || "目录修复后抽测失败");
                }
              }
            } catch (error) {
              repairFailures.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (repairedVerify.reason === "rules-stale: empty-content"
            && repairedVerify.chapterUrl
            && typeof repairContent === "function") {
            try {
              const contentRepaired = await withinTimeout(
                Promise.resolve(repairContent(repaired, repairedVerify.chapterUrl, { download, adapterBase })),
                analyzeTimeoutMs,
                "识站后正文修复",
              );
              if (contentRepaired && validateXiangseSource(contentRepaired).ok) {
                const contentVerify = await verifySource(contentRepaired);
                if (contentVerify.ok) {
                  repaired = contentRepaired;
                  repairedVerify = contentVerify;
                } else {
                  repairFailures.push(contentVerify.detail || contentVerify.reason || "正文修复后抽测失败");
                }
              }
            } catch (error) {
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
          skipUnusable(
            name,
            `analyze-failed: 识站修复结果仍未通过抽测${repairFailures.length ? `：${repairFailures.slice(0, 3).join("；")}` : ""}（原始抽测：${reason}）`,
          );
          continue;
        }
        const keptResult = await keepVerified(
          name,
          picked,
          pickedVerified,
          "通用识站后已继续从真实详情页补全书籍元素并重新验链",
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
      } finally {
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
    verifiedCount: Object.keys(kept).length - fallbackCount - unverifiedCount,
    failedVerifyCount,
    unverifiedCount,
  };
}
