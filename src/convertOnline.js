import { createHash } from "node:crypto";
import { convertLegado, skippedBuckets } from "./converter.js";
import { applyVerifyAndAnalyzeFallback } from "./pipeline.js";
import { encodeXbs } from "./xbs.js";

/**
 * Convert a remote Legado JSON source URL into Xiangse XBS.
 *
 * @param {string} sourceUrl
 * @param {object} config
 * @param {string} [imageProxyBase]
 * @param {object} [options]
 * @param {boolean} [options.fullVerify] - When true, ignore verifyMaxSources / verifyBudgetMs
 *   so async library jobs can finish thorough verify+analyze.
 * @param {(progress: object) => void} [options.onProgress]
 * @param {typeof downloadSource} [options.downloadSource]
 * @param {Function} [options.adaptOnlineSources]
 * @param {Function} [options.filterReachableSources]
 * @param {Function} [options.sourceUrlCandidates]
 * @param {new (status: number, message: string) => Error} [options.HttpError]
 */
export async function convertOnlineSource(sourceUrl, config, imageProxyBase = "", options = {}) {
  // Lazy import avoids a circular dependency with server.js.
  const server = await import("./server.js");
  const downloadSource = options.downloadSource || server.downloadSource;
  const adaptOnlineSources = options.adaptOnlineSources || server.adaptOnlineSources;
  const filterReachableSources = options.filterReachableSources || server.filterReachableSources;
  const HttpError = options.HttpError || server.HttpError;
  const sourceUrlCandidates = options.sourceUrlCandidates || server.sourceUrlCandidates;

  const fullVerify = Boolean(options.fullVerify);
  const onProgress = options.onProgress || null;

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
      // shuyuans -> shuyuan is only a response-format fallback. A transient
      // DNS/TLS/CDN failure must not silently turn an aggregate ID into an
      // unrelated single source with the same numeric ID.
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
  parsed = await adaptOnlineSources(parsed, config);
  let converted;
  try {
    converted = convertLegado(parsed, { imageProxyBase, omitNonPortable: true });
  } catch (error) {
    throw new HttpError(422, `无法转换在线阅读源：${error.message}`);
  }
  const preflight = await filterReachableSources(Object.values(converted.sources), config);
  if (config.preflightSources) {
    const reachableSources = new Set(preflight.input);
    converted.sources = Object.fromEntries(Object.entries(converted.sources).filter(([, source]) => reachableSources.has(source)));
  }
  if (preflight.skipped.length) {
    converted.skipped.unshift(...preflight.skipped);
    converted.warnings.push(...preflight.skipped.map((item) => ({
      source: item.source,
      section: "source",
      field: "availability",
      message: `已从在线 XBS 跳过：${item.reason}`,
      rule: "",
    })));
  }

  const download = (url, headers = {}) => downloadSource(
    url,
    { ...config, fetchTimeoutMs: Math.max(config.preflightTimeoutMs, 1_000) },
    headers,
  );
  const sourceCount = Object.keys(converted.sources).length;
  const verifyEnabled = fullVerify
    ? Boolean(config.verifyConvertedSources) && sourceCount > 0
    : config.verifyConvertedSources
      && sourceCount > 0
      && sourceCount <= (config.verifyMaxSources || 50);
  const gated = await applyVerifyAndAnalyzeFallback(converted.sources, {
    download,
    concurrency: config.preflightConcurrency,
    timeoutMs: config.preflightTimeoutMs,
    analyzeTimeoutMs: config.analyzeTimeoutMs,
    enabled: verifyEnabled,
    analyzeFallback: fullVerify
      ? (options.analyzeFallback !== undefined ? Boolean(options.analyzeFallback) : true)
      : config.analyzeFallback,
    budgetMs: fullVerify ? 0 : config.verifyBudgetMs,
    onProgress,
  });
  converted.sources = gated.sources;
  if (!verifyEnabled && !fullVerify && config.verifyConvertedSources && sourceCount > (config.verifyMaxSources || 50)) {
    converted.warnings.push({
      source: "",
      section: "source",
      field: "verify",
      message: `源数量 ${sourceCount} 超过抽测上限 ${config.verifyMaxSources}，已跳过抽测直接保留转换结果`,
      rule: "",
    });
  }
  if (gated.skipped.length) {
    converted.skipped.push(...gated.skipped);
    converted.warnings.push(...gated.skipped.map((item) => ({
      source: item.source,
      section: "source",
      field: "verify",
      message: `已从在线 XBS 跳过：${item.reason}`,
      rule: "",
    })));
  }
  if (gated.warnings.length) converted.warnings.push(...gated.warnings);
  if (gated.unverifiedCount) {
    converted.warnings.push({
      source: "",
      section: "source",
      field: "verify",
      message: `抽测超时预算已用尽，另有 ${gated.unverifiedCount} 个源未抽测仍保留`,
      rule: "",
    });
  }

  const count = Object.keys(converted.sources).length;
  if (!count) throw new HttpError(422, "在线地址中没有可转换的阅读源");
  const buckets = skippedBuckets(converted.skipped);
  const json = Buffer.from(`${JSON.stringify(converted.sources, null, 2)}\n`, "utf8");
  const xbs = encodeXbs(json);
  return {
    ...converted,
    count,
    fallbackCount: gated.fallbackCount || 0,
    skippedBuckets: buckets,
    json,
    xbs,
    etag: `"${createHash("sha256").update(xbs).digest("hex")}"`,
  };
}
