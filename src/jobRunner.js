import { convertOnlineSource, convertParsedSource } from "./convertOnline.js";
import { analyzeSite } from "./siteAnalyze/index.js";
import { encodeXbs } from "./xbs.js";
import { aiCandidateQualityIssue, generateXiangseCandidate, redactDiagnosticText } from "./aiSiteAnalyzer.js";
import { aiProviderReady } from "./aiProvider.js";
import { verifyConvertedSource } from "./verifySource.js";
import { validateXiangseSource } from "./xiangseValidate.js";

function redactUrls(value) {
  return String(value || "unknown")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      const punctuation = match.match(/[),.;，。；]+$/u)?.[0] || "";
      const candidate = punctuation ? match.slice(0, -punctuation.length) : match;
      try {
        const url = new URL(candidate);
        return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}${punctuation}`;
      } catch {
        return `[URL redacted]${punctuation}`;
      }
    })
    .slice(0, 1_200);
}

function summarizeSkippedReasons(skipped = []) {
  const counts = {};
  for (const item of skipped) {
    const reason = redactUrls(item?.reason);
    const typed = reason.match(/^(rules-stale|analyze-failed|pipeline-failed|convert-failed|core-chain|dead-origin)\s*[:：]\s*([a-z][a-z0-9-]*)/i);
    const key = typed
      ? `${typed[1].toLowerCase()}: ${typed[2].toLowerCase()}`
      : reason.replace(/\s+/g, " ").slice(0, 120);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function safeDiagnosticHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.slice(0, 253);
  } catch {
    return "";
  }
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
      const download = (url, headers = {}, requestOptions = {}) => downloadSource(
        url,
        { ...config, fetchTimeoutMs: config.analyzeTimeoutMs },
        headers,
        requestOptions,
      );
      const analyzed = await analyze(job.sourceUrl, {
        download,
        timeoutMs: config.analyzeTimeoutMs,
        sourceName: job.title || undefined,
      });
      if (isCancelled()) return;
      let sources = analyzed.sources || (analyzed.source ? { [analyzed.source.sourceName]: analyzed.source } : {});
      let aiAttemptCount = 0;
      let aiRepairCount = 0;
      const missingKinds = [...new Set((analyzed.skippedKinds || [])
        .map((item) => item?.kind)
        .filter((kind) => ["text", "comic", "audio", "video"].includes(kind)))]
        .filter((kind) => !Object.values(sources).some((source) => source?.sourceType === kind));
      const unresolvedKinds = [];
      const unresolvedReasons = new Map();
      if (!analyzed.ok && !missingKinds.length) missingKinds.push("");
      if (aiProviderReady(config.aiSettings)) {
        for (const kind of missingKinds) {
          if (isCancelled()) return;
          let repaired = false;
          let failure = analyzed.reason || `通用识站未生成${kind || "可用"}类别规则`;
          const aiAttempts = Math.min(3, Math.max(1, Number(config.aiSettings.maxAttempts) || 2));
          for (let attempt = 1; attempt <= aiAttempts; attempt += 1) {
            aiAttemptCount += 1;
            await onProgress({ phase: "analyze", step: "ai-analyze", aiAttempt: attempt, aiAttempts, aiAttemptsTotal: aiAttemptCount, aiRepaired: aiRepairCount });
            let generated;
            try {
              generated = await generateAiCandidate({
                settings: config.aiSettings,
                host: job.sourceUrl,
                sourceName: job.title || job.sourceUrl,
                source: null,
                preferredKind: kind,
                failureReason: failure,
                verification: { stage: "site-discovery", reason: failure },
                seedRequests: [],
                download,
              });
            } catch (error) {
              failure = `AI 识站失败：${error?.message || error}`;
              continue;
            }
            if (!generated?.ok || !generated.source
              || (kind && generated.detectedType !== kind)
              || Number(generated.confidence) < 0.55
              || !validateXiangseSource(generated.source).ok) {
              failure = generated?.reason || "AI 候选类别、置信度或结构校验未通过";
              continue;
            }
            const liveDownload = (url, headers = {}, requestOptions = {}) => downloadSource(
              url,
              { ...config, fetchTimeoutMs: config.jobVerifyRequestTimeoutMs || config.fetchTimeoutMs },
              headers,
              requestOptions,
            );
            const verification = await verifySource(generated.source, {
              download: liveDownload,
              timeoutMs: config.jobVerifyRequestTimeoutMs || config.fetchTimeoutMs,
              sourceTimeoutMs: config.jobVerifySourceBudgetMs || 120_000,
              requireBookWorld: true,
            });
            if (!verification.ok) {
              failure = `AI 候选完整动作链未通过：${verification.detail || verification.reason}`;
              continue;
            }
            const qualityIssue = aiCandidateQualityIssue(generated.source, verification);
            if (qualityIssue) { failure = qualityIssue; continue; }
            const baseName = generated.source.sourceName || job.title || job.sourceUrl;
            const name = Object.hasOwn(sources, baseName) ? `${baseName}·${generated.detectedType}` : baseName;
            sources[name] = { ...generated.source, sourceName: name };
            aiRepairCount += 1;
            repaired = true;
            break;
          }
          if (!repaired) {
            unresolvedKinds.push(kind);
            unresolvedReasons.set(kind, redactDiagnosticText(failure, 800));
          }
        }
      }
      if (!Object.keys(sources).length) throw new Error(analyzed.reason || "自动识站和 AI 修复均未生成可用规则");
      const count = Object.keys(sources).length;
      const json = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`, "utf8");
      const xbs = encodeXbs(json);
      result = {
        sources,
        warnings: [
          ...(analyzed.warnings || (analyzed.warning ? [analyzed.warning] : [])),
          ...(unresolvedKinds.length ? [{ source: job.title || job.sourceUrl, section: "source", field: "verify", message: `AI 识站后仍有 ${unresolvedKinds.length} 个类别未通过规则验证：${unresolvedKinds.map((kind) => `${kind || "unknown"}：${unresolvedReasons.get(kind) || "未通过完整验链"}`).join("；")}`, rule: job.sourceUrl }] : []),
        ],
        skipped: unresolvedKinds.map((kind) => ({
          source: `${job.title || job.sourceUrl}${kind ? `·${kind}` : ""}`,
          sourceType: kind || undefined,
          reason: `analyze-failed: 通用识站和 AI 候选均未通过完整动作链${unresolvedReasons.has(kind) ? `：${unresolvedReasons.get(kind)}` : ""}`,
        })),
        count,
        fallbackCount: count,
        aiAttemptCount,
        aiRepairCount,
        skippedBuckets: {},
        json,
        xbs,
      };
      await onProgress({ done: count, total: count, kept: count, skipped: 0, unverified: 0, fallback: count, aiAttemptsTotal: aiAttemptCount, aiRepaired: aiRepairCount, failed: 0 });
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
      aiAttemptCount: result.aiAttemptCount || 0,
      aiRepairCount: result.aiRepairCount || 0,
      skippedBuckets: result.skippedBuckets || {},
      skippedReasons: summarizeSkippedReasons(result.skipped),
      skippedSources: Array.isArray(result.skipped)
        ? result.skipped.map((item) => {
          const diagnostic = {
            source: String(item?.source || "未命名书源").slice(0, 200),
            reason: redactUrls(item?.reason),
          };
          const sourceType = String(item?.sourceType || "").trim();
          if (["text", "comic", "audio", "video"].includes(sourceType)) {
            diagnostic.sourceType = sourceType;
          }
          const host = safeDiagnosticHost(item?.host);
          if (host) diagnostic.host = host;
          const stage = String(item?.stage || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
          if (stage) diagnostic.stage = stage;
          const recognitionAttempts = Number(item?.recognitionAttempts);
          if (Number.isSafeInteger(recognitionAttempts)
            && recognitionAttempts >= 0
            && recognitionAttempts <= 1_000) {
            diagnostic.recognitionAttempts = recognitionAttempts;
          }
          return diagnostic;
        })
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
        aiAttemptsTotal: result.aiAttemptCount || 0,
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
