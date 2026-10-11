import { createHash } from "node:crypto";
import { detectKind, detectKinds } from "./detectKind.js";
import { discoverNovel } from "./discoverNovel.js";
import { discoverComic } from "./discoverComic.js";
import { discoverMedia } from "./discoverMedia.js";
import { discoveryToXiangse, kindLabel } from "./toXiangse.js";
import { loadDocument, visibleText } from "./domUtil.js";
import { runXbsPipeline } from "../xbsRuntime.js";
import { downloadAsFetch, validateXiangseSource } from "../xiangseValidate.js";
import { decodeTextBuffer } from "../charset.js";
import { parseHeaders } from "../requests.js";
import { usableComicContentReport } from "../verifySource.js";
import { carryReusableComicDecoder, repairContentFromChapter } from "./repairContent.js";
import { requestIdentity } from "../requestIdentity.js";

const CONTENT_NAV_TEXT = /(?:小说|书库|阅读|漫画|动漫|听书|有声|音频|广播剧|视频|影视|轻小说|novel|books?|comic|manga|audio|podcast|video)/i;
const CATALOG_NAV_TEXT = /(?:小说|书库|分类(?:列表)?|排行(?:榜)?|全部作品|漫画|听书|有声|影视|novel|books?|comic|manga|audio|video)/i;
const CATALOG_PATH = /(?:^|\/)(?:books?|novels?|library|catalog(?:ue)?|categories?|sort|rank(?:ing)?|list|explore|fenlei|shuku|manhua|comics?|manga|audio|ting|video|vod)(?:\/|$)/i;
const TRANSIENT_NETWORK_ERROR = /(?:abort|timed?\s*out|超时|timeout|socket|network|fetch failed|connection|连接|econnreset|econnrefused|ehostunreach|enetunreach|eai_again|enotfound|tls|ssl|http\s*(?:408|425|429|5\d\d)\b)/i;
const CONTENT_KINDS = new Set(["text", "comic", "audio", "video"]);

function abortError(signal, fallback = "操作已取消") {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(String(signal?.reason || fallback));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

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
    try { seen.add(new URL(page.url, homeUrl).toString()); } catch { /* ignore invalid page URLs */ }
  }
  for (const page of pages) {
    const document = loadDocument(page.html, page.responseUrl || page.url);
    for (const anchor of document.querySelectorAll("a[href]")) {
      const label = visibleText(anchor);
      let target;
      try { target = new URL(anchor.getAttribute("href"), page.responseUrl || page.url); } catch { continue; }
      if (!/^https?:$/.test(target.protocol) || siteDomain(target.hostname) !== domain) continue;
      target.hash = "";
      const targetUrl = target.toString();
      if (seen.has(targetUrl)) continue;
      const sameOriginCatalog = target.origin === base.origin
        && (CATALOG_NAV_TEXT.test(label) || CATALOG_PATH.test(target.pathname));
      const relatedContentHost = target.origin !== base.origin && CONTENT_NAV_TEXT.test(label);
      if (!sameOriginCatalog && !relatedContentHost) continue;
      seen.add(targetUrl);
      output.push(targetUrl);
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
  timeoutMs = 30_000,
  preferKind = "",
  attempt = 0,
  validateRuntime = true,
  seedUrls = [],
  seedRequests = [],
  adapterBase = "",
  repairSource = null,
  contentRepair = repairContentFromChapter,
  maxPageBytes = 2 * 1024 * 1024,
  signal = null,
  onProbeBatch = null,
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

  const sourceHeaders = (() => {
    if (!repairSource || typeof repairSource !== "object") return {};
    const parsed = parseHeaders(repairSource.header, () => {});
    const explicit = repairSource.httpHeaders && typeof repairSource.httpHeaders === "object"
      && !Array.isArray(repairSource.httpHeaders)
      ? repairSource.httpHeaders
      : {};
    const headers = { ...parsed, ...explicit };
    if (repairSource.httpUserAgent) headers["User-Agent"] = String(repairSource.httpUserAgent);
    return headers;
  })();

  const timedDownload = async (url, headers = {}, options = {}) => {
    throwIfAborted(signal);
    const controller = new AbortController();
    const abortParent = () => controller.abort(abortError(signal));
    const timer = setTimeout(() => controller.abort(new Error(`页面下载超时（${timeoutMs}ms）`)), timeoutMs);
    if (signal) {
      if (signal.aborted) abortParent();
      else signal.addEventListener("abort", abortParent, { once: true });
    }
    try {
      const page = await download(url, { ...sourceHeaders, ...headers }, {
        ...options,
        signal: controller.signal,
      });
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
      if (signal) signal.removeEventListener("abort", abortParent);
    }
  };

  const retryingSeedDownload = async (url, headers = {}, options = {}) => {
    try {
      return await timedDownload(url, headers, options);
    } catch (error) {
      if (!retryableDownloadError(error) || options?.signal?.aborted || signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120));
      throwIfAborted(signal);
      return timedDownload(url, headers, options);
    }
  };

  const homeUrl = `${origin.protocol}//${origin.host}/`;
  const pageRequests = [{ url: homeUrl, headers: sourceHeaders, options: {} }];
  for (const value of Array.isArray(seedUrls) ? seedUrls : []) {
    try {
      const seed = new URL(String(value), homeUrl);
      seed.hash = "";
      if (/^https?:$/.test(seed.protocol)) {
        pageRequests.push({ url: seed.toString(), headers: sourceHeaders, options: {} });
      }
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
        headers: {
          ...sourceHeaders,
          ...(request?.headers && typeof request.headers === "object" ? request.headers : {}),
        },
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
    const key = requestIdentity(request, { includeRequestInfo: true });
    if (requestKeys.has(key)) continue;
    requestKeys.add(key);
    uniqueRequests.push(request);
  }

  const pages = [];
  const httpResponseStatuses = new Set();
  const recordHttpResponseStatus = (error) => {
    const message = String(error?.message || error || "");
    for (const match of message.matchAll(/\bHTTP\s+(\d{3})\b/gi)) {
      httpResponseStatuses.add(Number(match[1]));
    }
  };
  const homeRequestIndex = uniqueRequests.findIndex((request) => (
    request.url === homeUrl
    && String(request.options?.method || "GET").toUpperCase() === "GET"
    && !request.options?.body
  ));
  const homeRequests = homeRequestIndex >= 0 ? [uniqueRequests[homeRequestIndex]] : [];
  const declaredRequests = uniqueRequests.filter((_, index) => index !== homeRequestIndex);
  const seedLimit = Math.max(0, 5 - homeRequests.length);
  const attemptIndex = Math.max(0, Math.floor(Number(attempt) || 0));
  const firstSeedIndex = declaredRequests.length
    ? (attemptIndex * seedLimit) % declaredRequests.length
    : 0;
  const selectedRequests = [...homeRequests];
  for (let index = 0; index < Math.min(seedLimit, declaredRequests.length); index += 1) {
    selectedRequests.push(declaredRequests[(firstSeedIndex + index) % declaredRequests.length]);
  }
  const probeBatchFingerprint = createHash("sha256")
    .update(selectedRequests
      .map((request) => requestIdentity(request, { includeRequestInfo: true }))
      .sort()
      .join("\n"))
    .digest("hex");
  const remainingSeedRequests = Math.max(
    0,
    declaredRequests.length - Math.min(declaredRequests.length, (attemptIndex + 1) * seedLimit),
  );
  if (typeof onProbeBatch === "function") {
    let accepted = true;
    try {
      accepted = onProbeBatch(probeBatchFingerprint) !== false;
    } catch {
      // A diagnostic callback must not break a source conversion.
    }
    if (!accepted) {
      return {
        ok: false,
        reason: "analyze-failed: 当前识站入口批次与已探测批次相同，停止重复请求",
        repeatedEvidence: true,
        probeBatchFingerprint,
        remainingSeedRequests,
        detectedKinds: [],
      };
    }
  }
  const initialPageUrls = new Set(selectedRequests.map((request) => request.url));
  let homeError = "";
  const loadSeedPage = async (request) => {
    throwIfAborted(signal);
    try {
      const downloaded = await retryingSeedDownload(request.url, request.headers, request.options);
      return {
        url: request.url,
        responseUrl: downloaded.read2xsggResponseUrl || request.url,
        html: downloaded.toString("utf8"),
        probeKey: requestIdentity(request, { includeRequestInfo: true }),
        // The concrete request already succeeded. Persist that executable
        // descriptor instead of reintroducing an opaque source script.
        requestInfo: portableSeedRequestInfo(request),
      };
    } catch (error) {
      recordHttpResponseStatus(error);
      if (request.url !== homeUrl) return null;
      const alternate = new URL(homeUrl);
      alternate.protocol = alternate.protocol === "https:" ? "http:" : "https:";
      try {
        const downloaded = await retryingSeedDownload(alternate.toString(), request.headers, request.options);
        return {
          url: alternate.toString(),
          responseUrl: downloaded.read2xsggResponseUrl || alternate.toString(),
          html: downloaded.toString("utf8"),
          requestInfo: alternate.toString(),
        };
      } catch (alternateError) {
        recordHttpResponseStatus(alternateError);
        homeError = `${String(error.message || error)}；备用协议失败：${alternateError.message || alternateError}`;
        return null;
      }
    }
  };

  // Home/category seeds are independent probes. Serializing them made a site
  // with several slow-but-live category endpoints exceed the single analysis
  // budget before discovery even started. Keep the batch bounded while
  // allowing the analyzer to use the same I/O parallelism as the verifier.
  const seedResults = await Promise.all(
    selectedRequests.map((request) => loadSeedPage(request)),
  );
  pages.push(...seedResults.filter(Boolean));
  if (!pages.length) {
    return {
      ok: false,
      reason: `analyze-failed: 首页及声明分类均不可访问（${homeError || "无响应"}）`,
      detectedKinds: [],
      remainingSeedRequests,
      probeBatchFingerprint,
      originResponded: httpResponseStatuses.size > 0,
      httpResponseStatuses: [...httpResponseStatuses],
    };
  }

  const linkedPages = await Promise.all(relatedContentLinks(pages, homeUrl).map(async (linkedUrl) => {
    throwIfAborted(signal);
    try {
      const downloaded = await timedDownload(linkedUrl, sourceHeaders);
      return {
        url: linkedUrl,
        responseUrl: downloaded.read2xsggResponseUrl || linkedUrl,
        html: downloaded.toString("utf8"),
        probeKey: requestIdentity({ url: linkedUrl, headers: sourceHeaders, requestInfo: linkedUrl }, {
          includeRequestInfo: true,
        }),
        requestInfo: linkedUrl,
      };
    } catch {
      // A related content subdomain is only an additional generic seed.
      return null;
    }
  }));
  pages.push(...linkedPages.filter(Boolean));

  let kindInfos = pages.flatMap((page) => (
    detectKinds(page.html, page.url)
      .filter((item) => item.kind !== "unknown")
      .map((item) => ({ ...item, page }))
  ));
  const seenKindPages = new Set();
  kindInfos = kindInfos.filter((item) => {
    const key = `${item.kind}|${item.page.probeKey || item.page.url}`;
    if (seenKindPages.has(key)) return false;
    seenKindPages.add(key);
    return true;
  });
  const detectedKinds = [...new Set(kindInfos.map((item) => item.kind))];
  // A source's declared type is useful evidence even when the landing page is
  // an unlabelled SPA shell. Previously `preferKind` only reordered types
  // already detected by page text, so a declared video/audio source could
  // never reach its media parser when the homepage itself had no player or
  // media keywords. Probe that declared kind against the best fetched pages;
  // the normal structural and full action-chain checks still decide whether
  // any resulting candidate can be published.
  const kindPageRank = (item) => {
    const isHome = item.page.url === homeUrl && item.page.requestInfo === homeUrl;
    const isDeclaredSeed = !isHome && initialPageUrls.has(item.page.url);
    return isDeclaredSeed ? 0 : (isHome ? 1 : 2);
  };
  if (CONTENT_KINDS.has(preferKind) && !detectedKinds.includes(preferKind)) {
    const seenPreferredPages = new Set();
    for (const page of [...pages].sort((left, right) => (
      kindPageRank({ page: left }) - kindPageRank({ page: right })
    ))) {
      const pageKey = page.probeKey || page.url;
      if (seenPreferredPages.has(pageKey)) continue;
      seenPreferredPages.add(pageKey);
      kindInfos.push({ kind: preferKind, confidence: 0.25, score: 0, page, declaredPreference: true });
      if (seenPreferredPages.size >= 2) break;
    }
  }
  // A shell page plus several declared categories often all score as the same
  // kind. Probing every duplicate serially wastes the source budget and can
  // make a live site look unavailable. Prefer declared seed pages (they are
  // usually real catalogues), retain the home page as a fallback, and cap each
  // kind at two independent discovery candidates.
  kindInfos.sort((left, right) => kindPageRank(left) - kindPageRank(right));
  const kindPageCounts = new Map();
  kindInfos = kindInfos.filter((item) => {
    const count = kindPageCounts.get(item.kind) || 0;
    if (count >= 2) return false;
    kindPageCounts.set(item.kind, count + 1);
    return true;
  });
  // Prefer the converted source's type first. A repair pass only needs the
  // declared capability; probing unrelated kinds after that capability has a
  // concrete discovery candidate delays the strict runtime chain and can let
  // an unrelated slow media page consume the whole source budget. Other kinds
  // remain a fallback only when preferred-kind discovery finds no structure.
  if (preferKind) {
    const preferred = kindInfos.filter((item) => item.kind === preferKind);
    const others = kindInfos.filter((item) => item.kind !== preferKind);
    if (preferred.length) kindInfos = [...preferred, ...others];
  }
  if (!kindInfos.length) {
    return {
      ok: false,
      reason: "analyze-failed: 未能识别站点类型",
      kind: "unknown",
      detectedKinds,
      remainingSeedRequests,
      probeBatchFingerprint,
    };
  }

  const primaryPage = pages.find((page) => page.url === homeUrl) || pages[0];
  const pageTitle = visibleText(loadDocument(primaryPage.html, primaryPage.url).querySelector("title")).slice(0, 40);
  const baseName = String(sourceName || pageTitle || origin.host).trim() || origin.host;
  const built = [];
  const skippedKinds = [];
  const discoveries = [];
  const fetchImpl = downloadAsFetch(timedDownload);

  let preferredDiscoveryFound = false;
  for (const info of kindInfos) {
    throwIfAborted(signal);
    if (CONTENT_KINDS.has(preferKind) && info.kind !== preferKind && preferredDiscoveryFound) break;
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
    if (info.kind === preferKind) preferredDiscoveryFound = true;
  }

  if (!built.length) {
    return {
      ok: false,
      reason: `analyze-failed: 检测到 ${kindInfos.map((k) => k.kind).join("/")}，但未能生成可用源`,
      kinds: kindInfos.map((k) => k.kind),
      detectedKinds,
      skippedKinds,
      remainingSeedRequests,
      probeBatchFingerprint,
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
    throwIfAborted(signal);
    if (acceptedKinds.has(item.kind)) continue;
    const name = multi ? `${baseName}·${kindLabel(item.kind)}` : baseName;
    const attempt = (attemptsByKind.get(item.kind) || 0) + 1;
    attemptsByKind.set(item.kind, attempt);
    const candidateName = attempt === 1 ? name : `${name}#候选${attempt}`;
    let source = discoveryToXiangse(item.discovery, { sourceName: name });
    if (!source) {
      skippedKinds.push({ kind: item.kind, reason: "无法导出香色源" });
      continue;
    }
    source = carryReusableComicDecoder(source, repairSource);

    let structural = validateXiangseSource(source);
    if (!structural.ok) {
      skippedKinds.push({
        kind: item.kind,
        reason: `不符合香色结构规则：${structural.errors.slice(0, 3).join("；")}`,
      });
      continue;
    }

    if (validateRuntime) {
      const runCandidate = (candidate, maxCandidates) => runXbsPipeline(candidate, {
        fetchImpl,
        timeoutMs,
        fetchMedia: item.kind === "comic" || item.kind === "audio" || item.kind === "video",
        maxCandidates,
      });
      let report = await runCandidate(source, item.kind === "comic" ? 1 : 3);
      const contentReport = report.steps?.chapterContent;
      const chapterUrl = report.steps?.chapterList?.chapterUrl || item.discovery.chapterSampleUrl;
      const comicContentInvalid = item.kind === "comic"
        && !usableComicContentReport(contentReport, report.steps?.bookDetail?.cover);
      let comicRepairAccepted = false;
      if (comicContentInvalid && chapterUrl && typeof contentRepair === "function") {
        try {
          const repaired = await contentRepair(source, chapterUrl, {
            download: timedDownload,
            adapterBase,
            signal,
          });
          if (repaired) {
            const repairedStructural = validateXiangseSource(repaired);
            if (repairedStructural.ok) {
              const repairedReport = await runCandidate(repaired, 3);
              if (repairedReport.ok && usableComicContentReport(
                repairedReport.steps?.chapterContent,
                repairedReport.steps?.bookDetail?.cover,
              )) {
                source = repaired;
                structural = repairedStructural;
                report = repairedReport;
                comicRepairAccepted = true;
              }
            }
          }
        } catch {
          // The report below preserves the concrete failure from the original candidate.
        }
      }
      if (item.kind === "comic" && !comicRepairAccepted
        && (!report.ok || !usableComicContentReport(
          report.steps?.chapterContent,
          report.steps?.bookDetail?.cover,
        ))) {
        report = await runCandidate(source, 3);
      }
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
        || !(steps.chapterContent?.itemCount > 0)
        || (item.kind === "comic" && !usableComicContentReport(
          steps.chapterContent,
          steps.bookDetail?.cover,
        ))) {
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
      field: "analyze",
      message: `site-analyze：已用通用页面结构生成并通过香色规则校验的${kindLabel(item.kind)}源`,
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
        detectedKinds,
        skippedKinds,
        runtimeReports,
        remainingSeedRequests,
        probeBatchFingerprint,
      };
    }
    return {
      ok: false,
      reason: "analyze-failed: 生成的源未通过香色结构或动作链校验",
      kinds: built.map((item) => item.kind),
      detectedKinds,
      skippedKinds,
      runtimeReports,
      remainingSeedRequests,
      probeBatchFingerprint,
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
    detectedKinds,
    skippedKinds,
    runtimeReports,
    remainingSeedRequests,
    probeBatchFingerprint,
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
export { discoverContentRule } from "./repairContent.js";
export { repairContentFromChapter };
export { repairBooksFromRequests, repairChaptersFromBookJson } from "./repairBooks.js";
export {
  novelDiscoveryToXiangse,
  comicDiscoveryToXiangse,
  mediaDiscoveryToXiangse,
  discoveryToXiangse,
  kindLabel,
  withNovelHtmlStripped,
} from "./toXiangse.js";
