import { detectKind, detectKinds } from "./detectKind.js";
import { discoverNovel } from "./discoverNovel.js";
import { discoverComic } from "./discoverComic.js";
import { discoverMedia } from "./discoverMedia.js";
import { discoveryToXiangse, kindLabel } from "./toXiangse.js";
import { loadDocument, visibleText } from "./domUtil.js";
import { runXbsPipeline } from "../xbsRuntime.js";
import { downloadAsFetch, validateXiangseSource } from "../xiangseValidate.js";

async function discoverByKind(kind, originUrl, download, homeHtml) {
  if (kind === "text") return discoverNovel(originUrl, { download, homeHtml });
  if (kind === "comic") return discoverComic(originUrl, { download, homeHtml });
  if (kind === "audio" || kind === "video") return discoverMedia(originUrl, kind, { download, homeHtml });
  return null;
}

/**
 * Analyze a live website and produce one Xiangse source per discoverable kind.
 * Each candidate must pass structural 香色规则校验 and the bookWorld→content pipeline.
 */
export async function analyzeSite(siteUrl, {
  download,
  sourceName = "",
  timeoutMs = 8_000,
  preferKind = "",
  validateRuntime = true,
} = {}) {
  if (typeof download !== "function") {
    return { ok: false, reason: "analyze-failed: 缺少下载器" };
  }
  let origin;
  try {
    origin = new URL(siteUrl);
  } catch {
    return { ok: false, reason: "analyze-failed: 网站 URL 无效" };
  }
  if (!/^https?:$/i.test(origin.protocol)) {
    return { ok: false, reason: "analyze-failed: 仅支持 http/https" };
  }

  const timedDownload = async (url, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await download(url, headers, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const homeUrl = `${origin.protocol}//${origin.host}/`;
  let homeHtml = "";
  try {
    homeHtml = (await timedDownload(homeUrl)).toString("utf8");
  } catch (error) {
    return { ok: false, reason: `analyze-failed: 首页不可访问（${error.message || error}）` };
  }

  let kindInfos = detectKinds(homeHtml, origin.toString()).filter((item) => item.kind !== "unknown");
  // Prefer the converted source's type first, but keep other detected kinds as
  // secondary repair candidates when preferred discovery fails.
  if (preferKind) {
    const preferred = kindInfos.filter((item) => item.kind === preferKind);
    const others = kindInfos.filter((item) => item.kind !== preferKind);
    if (preferred.length) kindInfos = [...preferred, ...others];
  }
  if (!kindInfos.length) {
    return { ok: false, reason: "analyze-failed: 未能识别站点类型", kind: "unknown" };
  }

  const pageTitle = visibleText(loadDocument(homeHtml, homeUrl).querySelector("title")).slice(0, 40);
  const baseName = String(sourceName || pageTitle || origin.host).trim() || origin.host;
  const built = [];
  const skippedKinds = [];
  const discoveries = [];
  const fetchImpl = downloadAsFetch(timedDownload);

  for (const info of kindInfos) {
    let discovery = null;
    try {
      discovery = await discoverByKind(info.kind, homeUrl, timedDownload, homeHtml);
    } catch (error) {
      skippedKinds.push({ kind: info.kind, reason: String(error.message || error) });
      continue;
    }
    if (!discovery) {
      skippedKinds.push({ kind: info.kind, reason: "未能发现可用结构" });
      continue;
    }
    discoveries.push(discovery);
    built.push({ kind: info.kind, confidence: info.confidence, discovery });
  }

  if (!built.length) {
    return {
      ok: false,
      reason: `analyze-failed: 检测到 ${kindInfos.map((k) => k.kind).join("/")}，但未能生成可用源`,
      kinds: kindInfos.map((k) => k.kind),
      skippedKinds,
    };
  }

  const multi = built.length > 1;
  const sources = {};
  const warnings = [];
  const runtimeReports = {};

  for (const item of built) {
    const name = multi ? `${baseName}·${kindLabel(item.kind)}` : baseName;
    const source = discoveryToXiangse(item.discovery, { sourceName: name });
    if (!source) {
      skippedKinds.push({ kind: item.kind, reason: "无法导出香色源" });
      continue;
    }

    const structural = validateXiangseSource(source);
    if (!structural.ok) {
      skippedKinds.push({
        kind: item.kind,
        reason: `不符合香色结构规则：${structural.errors.slice(0, 3).join("；")}`,
      });
      continue;
    }

    if (validateRuntime) {
      const report = await runXbsPipeline(source, {
        fetchImpl,
        timeoutMs,
        fetchMedia: item.kind === "comic" || item.kind === "audio" || item.kind === "video",
        maxCandidates: 3,
      });
      runtimeReports[name] = report;
      if (!report.ok) {
        skippedKinds.push({
          kind: item.kind,
          reason: `香色动作链校验失败：${report.error || "分类/列表/详情/章节/正文未通过"}`,
        });
        continue;
      }
      const steps = report.steps || {};
      if (!(steps.bookWorld?.listCount >= 1)
        || !(steps.chapterList?.listCount >= 1)
        || !(steps.chapterContent?.itemCount > 0)) {
        skippedKinds.push({
          kind: item.kind,
          reason: "香色动作链校验失败：分类/章节/正文计数不足",
        });
        continue;
      }
    }

    sources[name] = source;
    warnings.push({
      source: name,
      section: "source",
      field: "fallback",
      message: `fallback:site-analyze：已用启发式页面结构生成并通过香色规则校验的${kindLabel(item.kind)}源`,
      rule: origin.host,
    });
  }

  const names = Object.keys(sources);
  if (!names.length) {
    return {
      ok: false,
      reason: "analyze-failed: 生成的源未通过香色结构或动作链校验",
      kinds: built.map((item) => item.kind),
      skippedKinds,
      runtimeReports,
    };
  }

  const primaryName = names.find((name) => sources[name].sourceType === "text") || names[0];
  return {
    ok: true,
    kind: sources[primaryName].sourceType,
    kinds: names.map((name) => sources[name].sourceType),
    confidence: built.find((item) => item.kind === sources[primaryName].sourceType)?.confidence
      || built[0].confidence,
    discovery: built.find((item) => item.kind === sources[primaryName].sourceType)?.discovery
      || built[0].discovery,
    discoveries,
    sources,
    source: sources[primaryName],
    skippedKinds,
    runtimeReports,
    warning: warnings[0],
    warnings,
  };
}

export { detectKind, detectKinds } from "./detectKind.js";
export { discoverNovel } from "./discoverNovel.js";
export { discoverComic } from "./discoverComic.js";
export { discoverMedia } from "./discoverMedia.js";
export {
  novelDiscoveryToXiangse,
  comicDiscoveryToXiangse,
  mediaDiscoveryToXiangse,
  discoveryToXiangse,
  kindLabel,
  withNovelHtmlStripped,
} from "./toXiangse.js";
