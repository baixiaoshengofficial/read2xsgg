import { analyzeSite } from "./siteAnalyze/index.js";
import { verifyConvertedSource } from "./verifySource.js";

/**
 * After Legado conversion + origin preflight: verify each source; on failure
 * try site-analyze fallback. If analyze also fails, keep the original converted
 * source (soft keep) so sync /source and jobs do not drop usable conversions.
 *
 * When `budgetMs` elapses, remaining sources are kept unverified so large
 * aggregate converts still finish within proxy/client timeouts.
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
  const raw = String(source?.sourceUrl || source?.host || source?.bookSourceUrl || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.split("#", 1)[0]).origin;
  } catch {
    return raw;
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

  const softKeep = (name, source, reason) => {
    kept[name] = source;
    unverifiedCount += 1;
    warnings.push({
      source: name,
      section: "source",
      field: "verify",
      message: `抽测/识站未通过（${reason}），已保留阅读转换结果供客户端试用`,
      rule: String(source?.sourceUrl || source?.host || ""),
    });
    processed += 1;
  };

  const analyzeFor = (host, preferKind, name) => {
    const key = `${host}|${preferKind || "*"}`;
    if (!analyzeByHost.has(key)) {
      analyzeByHost.set(key, analyzeSite(host, {
        download,
        sourceName: name,
        timeoutMs: analyzeTimeoutMs,
        preferKind: ["text", "comic", "audio", "video"].includes(preferKind) ? preferKind : "",
      }).catch((error) => ({
        ok: false,
        reason: `analyze-failed: ${error.message || error}`,
      })));
    }
    return analyzeByHost.get(key);
  };

  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = input[index];
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
        const verified = await verifyConvertedSource(source, { download, timeoutMs });
        if (verified.ok) {
          kept[name] = source;
          processed += 1;
          continue;
        }
        failedVerifyCount += 1;
        const reason = verified.reason || "rules-stale: empty-list";
        if (!analyzeFallback) {
          softKeep(name, source, reason);
          continue;
        }
        const host = sourceHostKey(source);
        if (!host) {
          softKeep(name, source, reason);
          continue;
        }
        report({ step: "analyze" });
        const preferKind = String(source?.sourceType || "").trim();
        const analyzed = await analyzeFor(host, preferKind, name);
        if (!analyzed.ok) {
          softKeep(name, source, analyzed.reason || "analyze-failed: 识站失败");
          continue;
        }
        const generated = analyzed.sources || {};
        const matchName = Object.keys(generated).find((key) => generated[key]?.sourceType === preferKind);
        const picked = (matchName && generated[matchName])
          || analyzed.source
          || Object.values(generated)[0];
        if (!picked) {
          softKeep(name, source, analyzed.reason || "analyze-failed: 识站失败");
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
          message: `阅读规则抽测失败（${reason}），已回退自动识站`,
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
