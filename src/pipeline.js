import { analyzeSite } from "./siteAnalyze/index.js";
import { verifyConvertedSource } from "./verifySource.js";

/**
 * After Legado conversion + origin preflight: verify each source; on failure
 * try site-analyze fallback; otherwise skip as rules-stale / analyze-failed.
 *
 * When `budgetMs` elapses, remaining sources are kept unverified so large
 * aggregate converts still finish within proxy/client timeouts.
 */
function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(payload);
  } catch {
    // Progress callbacks must not break conversion.
  }
}

export async function applyVerifyAndAnalyzeFallback(sources, {
  download,
  concurrency = 4,
  timeoutMs = 3_000,
  analyzeTimeoutMs = 8_000,
  enabled = true,
  analyzeFallback = true,
  budgetMs = 0,
  onProgress = null,
} = {}) {
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
      done: input.length,
      total: input.length,
      kept: input.length,
      skipped: 0,
      unverified: 0,
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

  const report = () => {
    emitProgress(onProgress, {
      done: processed,
      total,
      kept: Object.keys(kept).length,
      skipped: skipped.length,
      unverified: unverifiedCount,
      fallback: fallbackCount,
      failed: failedVerifyCount,
    });
  };

  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = input[index];

      if (deadline && Date.now() >= deadline) {
        kept[name] = source;
        unverifiedCount += 1;
        processed += 1;
        report();
        continue;
      }

      const verified = await verifyConvertedSource(source, { download, timeoutMs });
      if (verified.ok) {
        kept[name] = source;
        processed += 1;
        report();
        continue;
      }
      failedVerifyCount += 1;
      if (!analyzeFallback) {
        skipped.push({ source: name, reason: verified.reason || "rules-stale: empty-list" });
        processed += 1;
        report();
        continue;
      }
      const host = String(source?.sourceUrl || source?.host || source?.bookSourceUrl || "").trim();
      if (!host) {
        skipped.push({ source: name, reason: verified.reason || "rules-stale: empty-list" });
        processed += 1;
        report();
        continue;
      }
      const preferKind = String(source?.sourceType || "").trim();
      const analyzed = await analyzeSite(host, {
        download,
        sourceName: name,
        timeoutMs: analyzeTimeoutMs,
        preferKind: ["text", "comic", "audio", "video"].includes(preferKind) ? preferKind : "",
      });
      if (!analyzed.ok) {
        skipped.push({
          source: name,
          reason: analyzed.reason || "analyze-failed: 识站失败",
        });
        processed += 1;
        report();
        continue;
      }
      // Prefer a generated source matching the original type; keep display name.
      const generated = analyzed.sources || {};
      const matchName = Object.keys(generated).find((key) => generated[key]?.sourceType === preferKind);
      const picked = (matchName && generated[matchName])
        || analyzed.source
        || Object.values(generated)[0];
      if (!picked) {
        skipped.push({ source: name, reason: analyzed.reason || "analyze-failed: 识站失败" });
        processed += 1;
        report();
        continue;
      }
      picked.sourceName = name;
      kept[name] = picked;
      fallbackCount += 1;
      if (analyzed.warning) warnings.push({ ...analyzed.warning, source: name });
      warnings.push({
        source: name,
        section: "source",
        field: "verify",
        message: `阅读规则抽测失败（${verified.reason}），已回退自动识站`,
        rule: host,
      });
      processed += 1;
      report();
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
