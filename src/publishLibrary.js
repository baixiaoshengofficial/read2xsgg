import { createHash } from "node:crypto";
import { normalizeCatalogPlan } from "./catalogPlan.js";
import { convertParsedSource } from "./convertOnline.js";

function parseSourceInput(source) {
  if (source == null) throw new Error("缺少声明式阅读源");
  if (typeof source === "string") {
    try {
      return JSON.parse(source.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`阅读源不是有效 JSON：${error.message}`);
    }
  }
  if (typeof source === "object") return source;
  throw new Error("阅读源必须是 JSON 对象或字符串");
}

function payloadFingerprint(parsed) {
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

function sourceList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  if (parsed.bookSourceUrl || parsed.bookSourceName || parsed.read2xsgg) return [parsed];
  for (const key of ["sources", "bookSources", "data"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [parsed];
}

function hasCatalogPlan(parsed) {
  return sourceList(parsed).some((source) => Boolean(normalizeCatalogPlan(source?.read2xsgg?.catalogPlan)));
}

/**
 * Replace an existing library job's XBS/JSON artifacts from an explicitly
 * supplied Legado JSON payload (file/API body). Keeps the same job id and
 * subscribe path. Persists the payload so later retries do not re-fetch a
 * legacy remote that lacks declarative mediaResolution.
 *
 * Generic: no source name/domain/endpoint conditionals.
 */
export async function publishLibraryArtifact({
  store,
  jobId,
  source,
  config,
  imageProxyBase = "",
  verify = false,
  convertParsed = convertParsedSource,
} = {}) {
  if (!store) throw new Error("publishLibraryArtifact requires a library store");
  const id = String(jobId || "").trim();
  if (!id) throw new Error("缺少任务 id");
  const job = await store.getJob(id);
  if (!job) throw new Error(`任务不存在：${id}`);

  const parsed = parseSourceInput(source);
  const proxyBase = String(imageProxyBase || job.imageProxyBase || "").trim();
  if (!proxyBase && hasCatalogPlan(parsed)) {
    throw new Error("源含声明式 catalogPlan，发布时必须提供公开代理地址 imageProxyBase；否则分类会降级成搜索入口");
  }
  const publishConfig = {
    ...config,
    // Deterministic publication defaults to convert-only; callers opt into verify.
    preflightSources: verify ? config.preflightSources : false,
    verifyConvertedSources: verify ? config.verifyConvertedSources : false,
    analyzeFallback: verify ? config.analyzeFallback : false,
  };

  const result = await convertParsed(parsed, publishConfig, proxyBase, {
    fullVerify: Boolean(verify),
    analyzeFallback: Boolean(verify),
  });

  await store.saveSourcePayload(id, parsed);
  await store.saveArtifacts(id, { xbs: result.xbs, json: result.json });

  const sourceNames = Object.keys(result.sources || {});
  const next = await store.updateJob(id, {
    status: "done",
    phase: "done",
    error: "",
    count: result.count,
    fallbackCount: result.fallbackCount || 0,
    skippedBuckets: result.skippedBuckets || {},
    finishedAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    publishedFrom: "payload",
    sourcePayloadHash: payloadFingerprint(parsed),
    title: job.title || sourceNames[0] || job.sourceUrl || id,
    imageProxyBase: proxyBase || job.imageProxyBase || "",
    progress: {
      done: result.count + (result.skipped?.length || 0),
      total: result.count + (result.skipped?.length || 0),
      kept: result.count,
      skipped: result.skipped?.length || 0,
      unverified: result.unverifiedCount || 0,
      fallback: result.fallbackCount || 0,
      failed: 0,
    },
  });

  return { job: next, result };
}
