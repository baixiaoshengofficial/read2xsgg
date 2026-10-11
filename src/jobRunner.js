import { convertOnlineSource, convertParsedSource } from "./convertOnline.js";
import { analyzeSite } from "./siteAnalyze/index.js";
import { encodeXbs } from "./xbs.js";
import { aiCandidateQualityIssue, generateXiangseCandidate } from "./aiSiteAnalyzer.js";
import { aiProviderReady } from "./aiProvider.js";
import { verifyConvertedSource } from "./verifySource.js";
import { validateXiangseSource } from "./xiangseValidate.js";

function summarizeSkippedReasons(skipped = []) {
  const counts = {};
  for (const item of skipped) {
    const reason = String(item?.reason || "unknown");
    const typed = reason.match(/\b(rules-stale|analyze-failed|pipeline-failed|convert-failed|core-chain|dead-origin)\s*[:：]\s*([a-z][a-z0-9-]*)/i);
    const key = typed
      ? `${typed[1].toLowerCase()}: ${typed[2].toLowerCase()}`
      : /上游站点不可访问[^。；]*(?:或|或者)[^。；]*没有数据/i.test(reason)
        ? "preflight-inconclusive"
        : /上游站点不可访问|dead-origin/i.test(reason)
        ? "dead-origin"
        : /登录|分流|Get\s*\(/i.test(reason)
          ? "login"
          : /sourceRegex|媒体流|可播放|媒体/i.test(reason)
            ? "media"
            : /没有数据|有效 URL|请求地址为空|不可移植|核心链路/i.test(reason)
              ? "core-chain"
              : "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * Execute one persistent library conversion.
 *
 * The queue owns scheduling and cancellation; this module owns the conversion
 * lifecycle and artifact persistence. It can run in the HTTP process for
 * tests, or in a Worker Thread in production so a pathological upstream
 * response cannot starve the HTTP event loop.
 */
export async function runLibraryJob({
  store,
  config,
  jobId,
  downloadSource,
  convertParsed = convertParsedSource,
  convertOnline = convertOnlineSource,
  analyze = analyzeSite,
  generateAiCandidate = generateXiangseCandidate,
  verifySource = verifyConvertedSource,
  isCancelled = () => false,
} = {}) {
  if (!store) throw new Error("runLibraryJob requires a library store");
  if (!config) throw new Error("runLibraryJob requires config");
  if (typeof downloadSource !== "function") throw new Error("runLibraryJob requires downloadSource");

  try {
    if (isCancelled()) return;
    const job = await store.getJob(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    if (isCancelled()) return;

    await store.updateJob(jobId, {
      status: "running",
      phase: "download",
      startedAt: job.startedAt || new Date().toISOString(),
      error: "",
    });

    const onProgress = async (progress) => {
      if (isCancelled()) return;
      try {
        const phase = progress?.phase || "verify";
        await store.updateJob(jobId, { progress, phase });
      } catch {
        // Progress writes must not break a conversion.
      }
    };

    let result;
    if (job.mode === "site") {
      await store.updateJob(jobId, { phase: "analyze" });
      const download = (url, headers = {}) => downloadSource(
        url,
        { ...config, fetchTimeoutMs: config.analyzeTimeoutMs },
        headers,
      );
      const analyzed = await analyze(job.sourceUrl, {
        download,
        timeoutMs: config.analyzeTimeoutMs,
        sourceName: job.title || undefined,
      });
      if (isCancelled()) return;
      let sources = analyzed.sources || (analyzed.source ? { [analyzed.source.sourceName]: analyzed.source } : null);
      const warnings = [...(analyzed.warnings || (analyzed.warning ? [analyzed.warning] : []))];
      const aiSettings = config.aiSettings;
      const presentKinds = new Set(Object.values(sources || {}).map((item) => item?.sourceType));
      const missingKinds = [...new Map((analyzed.skippedKinds || [])
        .filter((item) => ["text", "comic", "audio", "video"].includes(item?.kind) && !presentKinds.has(item.kind))
        .map((item) => [item.kind, item])).values()];
      if (!analyzed.ok && !missingKinds.length) missingKinds.push({ kind: "", reason: analyzed.reason });
      let aiRepairCount = 0;
      if (aiProviderReady(aiSettings)) {
        for (const missing of missingKinds) {
          if (isCancelled()) return;
          const unavailable = /(?:timeout|timed\s*out|超时|econn(?:reset|refused)|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i;
          let failure = missing.reason || analyzed.reason || "通用识站未生成可用源";
          if (unavailable.test(failure)) continue;
          for (let attempt = 1; attempt <= Math.min(3, Math.max(1, Number(aiSettings.maxAttempts) || 2)); attempt += 1) {
            await onProgress({ done: aiRepairCount, total: missingKinds.length, kept: Object.keys(sources || {}).length, skipped: 0, unverified: 0, fallback: 0, aiRepaired: aiRepairCount, failed: 0, phase: "analyze", step: "ai-analyze", aiAttempt: attempt });
            let generated;
            try {
              generated = await generateAiCandidate({
                settings: aiSettings,
                host: job.sourceUrl,
                sourceName: `${job.title || job.sourceUrl}${missing.kind ? `·${missing.kind}` : ""}`,
                source: null,
                preferredKind: missing.kind,
                failureReason: failure,
                verification: { stage: "site-discovery", reason: failure },
                seedRequests: [],
                download,
              });
            } catch (error) {
              failure = `AI 识站失败：${error?.message || error}`;
              continue;
            }
            if (!generated?.ok || !generated.source) {
              failure = generated?.reason || "AI 未生成 Xiangse 规则";
              continue;
            }
            if ((missing.kind && generated.source.sourceType !== missing.kind)
              || generated.confidence < 0.55 || !validateXiangseSource(generated.source).ok) {
              failure = "AI 候选规则类型、置信度或 Xiangse 结构校验未通过";
              continue;
            }
            const liveDownload = (url, headers = {}, requestOptions = {}) => downloadSource(
              url,
              { ...config, fetchTimeoutMs: Math.max(config.fetchTimeoutMs, config.preflightConfirmTimeoutMs || 10_000) },
              headers,
              requestOptions,
            );
            const verification = await verifySource(generated.source, {
              download: liveDownload,
              timeoutMs: config.fetchTimeoutMs,
              sourceTimeoutMs: Math.max(Number(config.jobVerifySourceBudgetMs) || 0, Number(config.fetchTimeoutMs) * 5),
            });
            if (!verification.ok) {
              failure = `AI 候选规则完整动作链未通过：${verification.detail || verification.reason}`;
              if (unavailable.test(failure)) break;
              continue;
            }
            const qualityIssue = aiCandidateQualityIssue(generated.source, verification);
            if (qualityIssue) {
              failure = qualityIssue;
              continue;
            }
            const baseName = generated.source.sourceName || job.title || job.sourceUrl;
            let sourceName = baseName;
            if (Object.hasOwn(sources || {}, sourceName)) {
              const prefix = `${baseName}·${generated.source.sourceType}`;
              sourceName = prefix;
              for (let suffix = 2; Object.hasOwn(sources, sourceName); suffix += 1) {
                sourceName = `${prefix}#${suffix}`;
              }
            }
            sources = { ...sources, [sourceName]: { ...generated.source, sourceName } };
            presentKinds.add(generated.source.sourceType);
            aiRepairCount += 1;
            warnings.push({
              source: sourceName,
              section: "source",
              field: "ai-repair",
              message: `通用识站未能完成 ${generated.detectedType} 类型后，AI 生成声明式规则并通过完整动作链验证`,
              rule: verification.chapterUrl || verification.bookUrl || job.sourceUrl,
            });
            break;
          }
        }
      }
      if (!sources || !Object.keys(sources).length) throw new Error(analyzed.reason || "自动识站失败");
      const skipped = missingKinds
        .filter((item) => item.kind && !presentKinds.has(item.kind))
        .map((item) => ({
          source: `${job.title || job.sourceUrl}·${item.kind}`,
          reason: `analyze-failed: ${item.reason || "该类型未生成可用源"}`,
        }));
      const count = Object.keys(sources).length;
      const json = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`, "utf8");
      const xbs = encodeXbs(json);
      result = {
        sources,
        warnings,
        skipped,
        count,
        fallbackCount: count,
        aiRepairCount,
        verifiedCount: count,
        skippedBuckets: {},
        json,
        xbs,
      };
      await onProgress({ done: count + skipped.length, total: count + skipped.length, kept: count, skipped: skipped.length, unverified: 0, fallback: count, aiRepaired: aiRepairCount, failed: 0 });
    } else {
      await store.updateJob(jobId, { phase: "convert" });
      const progressOpts = {
        // Library jobs intentionally verify the full aggregate. The sync
        // endpoint has a small bounded sample budget for interactive use.
        fullVerify: true,
        analyzeFallback: true,
        downloadSource,
        workerPoolEnabled: true,
        onProgress: (progress) => {
          if (isCancelled()) return;
          return onProgress(progress);
        },
      };
      // Prefer an explicitly published payload when present so retries keep
      // declarative fields (e.g. mediaResolution) that remote legacy JSON lacks.
      const sourcePayload = typeof store.readSourcePayload === "function"
        ? await store.readSourcePayload(jobId)
        : null;
      result = sourcePayload
        ? await convertParsed(
          sourcePayload,
          config,
          job.imageProxyBase || "",
          progressOpts,
        )
        : await convertOnline(
          job.sourceUrl,
          config,
          job.imageProxyBase || "",
          progressOpts,
        );
    }

    if (isCancelled()) return;

    await store.updateJob(jobId, { phase: "save" });
    await store.saveArtifacts(jobId, { xbs: result.xbs, json: result.json });
    await store.updateJob(jobId, {
      status: "done",
      phase: "done",
      count: result.count,
      fallbackCount: result.fallbackCount || 0,
      aiRepairCount: result.aiRepairCount || 0,
      verifiedCount: result.verifiedCount || 0,
      skippedBuckets: result.skippedBuckets || {},
      skippedReasons: summarizeSkippedReasons(result.skipped),
      skippedSources: Array.isArray(result.skipped)
        ? result.skipped.map((item) => ({
          source: String(item?.source || "未命名书源"),
          reason: String(item?.reason || "unknown"),
        }))
        : [],
      error: "",
      finishedAt: new Date().toISOString(),
      progress: {
        done: result.count + (result.skipped?.length || 0),
        total: result.count + (result.skipped?.length || 0),
        kept: result.count,
        skipped: result.skipped?.length || 0,
        unverified: result.unverifiedCount || 0,
        fallback: result.fallbackCount || 0,
        aiRepaired: result.aiRepairCount || 0,
        failed: 0,
      },
    });
  } catch (error) {
    if (isCancelled()) return;
    try {
      await store.updateJob(jobId, {
        status: "failed",
        phase: "failed",
        error: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // The job may have been deleted during cancellation.
    }
  }
}
