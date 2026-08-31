import { detectKind, detectKinds } from "./detectKind.js";
import { discoverNovel } from "./discoverNovel.js";
import { discoverComic } from "./discoverComic.js";
import { discoverMedia } from "./discoverMedia.js";
import { discoveryToXiangse, kindLabel } from "./toXiangse.js";
import { loadDocument, visibleText } from "./domUtil.js";
import { runXbsPipeline } from "../xbsRuntime.js";
import { downloadAsFetch, validateXiangseSource } from "../xiangseValidate.js";
import { decodeTextBuffer } from "../charset.js";

const CONTENT_NAV_TEXT = /(?:小说|书库|阅读|漫画|动漫|听书|有声|音频|广播剧|视频|影视|轻小说|novel|books?|comic|manga|audio|podcast|video)/i;
const TRANSIENT_NETWORK_ERROR = /(?:abort|timed?\s*out|超时|timeout|socket|network|fetch failed|connection|连接|econnreset|econnrefused|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i;

function retryableDownloadError(error) {
  if (error?.name === "AbortError") return true;
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  if (/^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ETIMEDOUT)$/.test(code)) {
    return true;
  }
  return TRANSIENT_NETWORK_ERROR.test(String(error?.message || error || ""));
}

function siteDomain(hostname) {
  const parts = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const second = parts.at(-2);
  const countrySuffix = parts.at(-1)?.length === 2 && /^(?:ac|co|com|edu|gov|net|org)$/.test(second);
  return parts.slice(countrySuffix ? -3 : -2).join(".");
}

function relatedContentLinks(pages, homeUrl, limit = 3) {
  let base;
  try { base = new URL(homeUrl); } catch { return []; }
  const domain = siteDomain(base.hostname);
  const output = [];
  const seen = new Set();
  for (const page of pages) {
    const document = loadDocument(page.html, page.responseUrl || page.url);
    for (const anchor of document.querySelectorAll("a[href]")) {
      const label = visibleText(anchor);
      if (!CONTENT_NAV_TEXT.test(label)) continue;
      let target;
      try { target = new URL(anchor.getAttribute("href"), page.responseUrl || page.url); } catch { continue; }
      if (!/^https?:$/.test(target.protocol) || siteDomain(target.hostname) !== domain) continue;
      if (target.origin === base.origin || seen.has(target.toString())) continue;
      target.hash = "";
      seen.add(target.toString());
      output.push(target.toString());
      if (output.length >= limit) return output;
    }
  }
  return output;
}

function headerValue(headers, name) {
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";
}

function portableSeedRequestInfo(request) {
  const method = String(request?.options?.method || "GET").toUpperCase();
  if (method !== "POST") return String(request?.url || "");
  const body = String(request?.options?.body || "");
  const contentType = String(headerValue(request?.headers, "content-type"));
  let params = {};
  try {
    if (/json/i.test(contentType)) {
      const parsed = JSON.parse(body || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return String(request?.requestInfo || "");
      params = parsed;
    } else {
      params = Object.fromEntries(new URLSearchParams(body));
    }
  } catch {
    return String(request?.requestInfo || "");
  }
  const descriptor = {
    url: String(request?.url || ""),
    POST: true,
    httpParams: params,
    httpHeaders: request?.headers && typeof request.headers === "object" ? request.headers : {},
  };
  return `@js:return ${JSON.stringify(descriptor)};`;
}

async function discoverByKind(kind, originUrl, download, homeHtml, homeRequestInfo = "", diagnostics = [], options = {}) {
  if (kind === "text") return discoverNovel(originUrl, {
    download,
    homeHtml,
    homeRequestInfo,
    homeResponseUrl: options.homeResponseUrl,
    adapterBase: options.adapterBase,
    diagnostics,
  });
  if (kind === "comic") return discoverComic(originUrl, {
    download,
    homeHtml,
    homeRequestInfo,
    homeResponseUrl: options.homeResponseUrl,
    adapterBase: options.adapterBase,
    diagnostics,
  });
  if (kind === "audio" || kind === "video") {
    return discoverMedia(originUrl, kind, {
      download,
      homeHtml,
      homeRequestInfo,
      diagnostics,
      homeResponseUrl: options.homeResponseUrl,
      adapterBase: options.adapterBase,
      repairSource: options.repairSource,
    });
  }
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
  seedUrls = [],
  seedRequests = [],
  adapterBase = "",
  repairSource = null,
  maxPageBytes = 2 * 1024 * 1024,
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

  const timedDownload = async (url, headers = {}, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const page = await download(url, headers, { ...options, signal: controller.signal });
      const buffer = Buffer.isBuffer(page) ? page : Buffer.from(page ?? "");
      const limit = Math.max(64 * 1024, Number(maxPageBytes) || 2 * 1024 * 1024);
      const clipped = buffer.length > limit ? buffer.subarray(0, limit) : buffer;
      const decoded = Buffer.from(decodeTextBuffer(clipped, { headers: buffer.httpHeaders || {} }), "utf8");
      Object.defineProperty(decoded, "read2xsggDecodedText", { value: true });
      Object.defineProperty(decoded, "httpHeaders", {
        value: buffer.httpHeaders || {},
        configurable: true,
      });
      Object.defineProperty(decoded, "read2xsggResponseUrl", {
        value: buffer.read2xsggResponseUrl || String(url),
        configurable: true,
      });
      return decoded;
    } finally {
      clearTimeout(timer);
    }
  };

  const retryingSeedDownload = async (url, headers = {}, options = {}) => {
    try {
      return await timedDownload(url, headers, options);
    } catch (error) {
      if (!retryableDownloadError(error) || options?.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return timedDownload(url, headers, options);
    }
  };

  const homeUrl = `${origin.protocol}//${origin.host}/`;
  const pageRequests = [{ url: homeUrl, headers: {}, options: {} }];
  for (const value of Array.isArray(seedUrls) ? seedUrls : []) {
    try {
      const seed = new URL(String(value), homeUrl);
      seed.hash = "";
      if (/^https?:$/.test(seed.protocol)) pageRequests.push({ url: seed.toString(), headers: {}, options: {} });
    } catch {
      // Ignore malformed seeds.
    }
  }
  for (const request of Array.isArray(seedRequests) ? seedRequests : []) {
    try {
      const seed = new URL(String(request?.url || ""), homeUrl);
      seed.hash = "";
      if (!/^https?:$/.test(seed.protocol)) continue;
      pageRequests.push({
        url: seed.toString(),
        headers: request?.headers && typeof request.headers === "object" ? request.headers : {},
        options: request?.options && typeof request.options === "object" ? request.options : {},
        requestInfo: String(request?.requestInfo || ""),
      });
    } catch {
      // Ignore malformed request seeds.
    }
  }

  const uniqueRequests = [];
  const requestKeys = new Set();
  for (const request of pageRequests) {
    const key = `${request.options?.method || "GET"}|${request.url}|${request.options?.body || ""}`;
    if (requestKeys.has(key)) continue;
    requestKeys.add(key);
    uniqueRequests.push(request);
  }

  const pages = [];
  let homeError = "";
  for (const request of uniqueRequests.slice(0, 5)) {
    try {
      const downloaded = await retryingSeedDownload(request.url, request.headers, request.options);
      pages.push({
        url: request.url,
        responseUrl: downloaded.read2xsggResponseUrl || request.url,
        html: downloaded.toString("utf8"),
        // The concrete request already succeeded. Persist that executable
        // descriptor instead of reintroducing an opaque source script.
        requestInfo: portableSeedRequestInfo(request),
      });
    } catch (error) {
      if (request.url === homeUrl) {
        homeError = String(error.message || error);
        const alternate = new URL(homeUrl);
        alternate.protocol = alternate.protocol === "https:" ? "http:" : "https:";
        try {
          const downloaded = await retryingSeedDownload(alternate.toString(), request.headers, request.options);
          pages.push({
            url: alternate.toString(),
            responseUrl: downloaded.read2xsggResponseUrl || alternate.toString(),
            html: downloaded.toString("utf8"),
            requestInfo: alternate.toString(),
          });
        } catch (alternateError) {
          homeError = `${homeError}；备用协议失败：${alternateError.message || alternateError}`;
        }
      }
    }
  }
  if (!pages.length) {
    return { ok: false, reason: `analyze-failed: 首页及声明分类均不可访问（${homeError || "无响应"}）` };
  }

  for (const linkedUrl of relatedContentLinks(pages, homeUrl)) {
    try {
      const downloaded = await timedDownload(linkedUrl);
      pages.push({
        url: linkedUrl,
        responseUrl: downloaded.read2xsggResponseUrl || linkedUrl,
        html: downloaded.toString("utf8"),
        requestInfo: linkedUrl,
      });
    } catch {
      // A related content subdomain is only an additional generic seed.
    }
  }

  let kindInfos = pages.flatMap((page) => (
    detectKinds(page.html, page.url)
      .filter((item) => item.kind !== "unknown")
      .map((item) => ({ ...item, page }))
  ));
  const seenKindPages = new Set();
  kindInfos = kindInfos.filter((item) => {
    const key = `${item.kind}|${item.page.url}`;
    if (seenKindPages.has(key)) return false;
    seenKindPages.add(key);
    return true;
  });
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

  const primaryPage = pages.find((page) => page.url === homeUrl) || pages[0];
  const pageTitle = visibleText(loadDocument(primaryPage.html, primaryPage.url).querySelector("title")).slice(0, 40);
  const baseName = String(sourceName || pageTitle || origin.host).trim() || origin.host;
  const built = [];
  const skippedKinds = [];
  const discoveries = [];
  const fetchImpl = downloadAsFetch(timedDownload);

  for (const info of kindInfos) {
    let discovery = null;
    const diagnostics = [];
    try {
      discovery = await discoverByKind(
        info.kind,
        info.page.url,
        timedDownload,
        info.page.html,
        info.page.requestInfo,
        diagnostics,
        {
          homeResponseUrl: info.page.responseUrl,
          adapterBase,
          repairSource,
        },
      );
    } catch (error) {
      skippedKinds.push({ kind: info.kind, reason: String(error.message || error) });
      continue;
    }
    if (!discovery) {
      const detail = diagnostics.length ? `：${[...new Set(diagnostics)].join("、")}` : "";
      skippedKinds.push({ kind: info.kind, reason: `未能发现可用结构${detail}` });
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
  const repairCandidates = {};
  const warnings = [];
  const runtimeReports = {};
  const acceptedKinds = new Set();
  const attemptsByKind = new Map();

  for (const item of built) {
    if (acceptedKinds.has(item.kind)) continue;
    const name = multi ? `${baseName}·${kindLabel(item.kind)}` : baseName;
    const attempt = (attemptsByKind.get(item.kind) || 0) + 1;
    attemptsByKind.set(item.kind, attempt);
    const candidateName = attempt === 1 ? name : `${name}#候选${attempt}`;
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
      runtimeReports[candidateName] = report;
      if (!report.ok) {
        repairCandidates[candidateName] = source;
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
        repairCandidates[candidateName] = source;
        skippedKinds.push({
          kind: item.kind,
          reason: "香色动作链校验失败：分类/章节/正文计数不足",
        });
        continue;
      }
    }

    sources[name] = source;
    acceptedKinds.add(item.kind);
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
    if (repairSource && Object.keys(repairCandidates).length) {
      return {
        ok: true,
        kind: "",
        kinds: [],
        sources: {},
        repairCandidates,
        skippedKinds,
        runtimeReports,
      };
    }
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
    repairCandidates,
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
export { repairChapterFromBook } from "./repairChapter.js";
export { repairDetailFromBook } from "./repairDetail.js";
export { discoverContentRule, repairContentFromChapter } from "./repairContent.js";
export { repairBooksFromRequests, repairChaptersFromBookJson } from "./repairBooks.js";
export {
  novelDiscoveryToXiangse,
  comicDiscoveryToXiangse,
  mediaDiscoveryToXiangse,
  discoveryToXiangse,
  kindLabel,
  withNovelHtmlStripped,
} from "./toXiangse.js";
