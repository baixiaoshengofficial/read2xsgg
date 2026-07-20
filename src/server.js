import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { convertLegado } from "./converter.js";
import { ImageDecodeError, decodeImage, supportedImageDecoders } from "./imageDecoder.js";
import { decodeComicExtractionPlan, normalizeComicExtractionPlan } from "./comicPlan.js";
import { decodeMediaExtractionPlan, normalizeMediaExtractionPlan } from "./mediaPlan.js";
import { encodeXbs } from "./xbs.js";
import { parseHeaders } from "./requests.js";
import {
  bridgeTocUrl,
  compileBookBridgePlan,
  compileChapterBridgePlan,
  compileTextBridgePlan,
  decodeBridgePlan,
  executeBridgePlan,
} from "./bridgePlan.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function integer(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value));
}

export function serverConfig(environment = process.env) {
  return {
    host: environment.HOST || "0.0.0.0",
    port: integer(environment.PORT, 3000, 0),
    fetchTimeoutMs: integer(environment.FETCH_TIMEOUT_MS, 15_000),
    maxSourceBytes: integer(environment.MAX_SOURCE_BYTES, 10 * 1024 * 1024),
    maxImageBytes: integer(environment.MAX_IMAGE_BYTES, 25 * 1024 * 1024),
    maxRedirects: integer(environment.MAX_REDIRECTS, 5, 0),
    maxConcurrent: integer(environment.MAX_CONCURRENT, 8),
    cacheTtlMs: integer(environment.CACHE_TTL_SECONDS, 300, 0) * 1000,
    maxCacheEntries: integer(environment.MAX_CACHE_ENTRIES, 100),
    allowPrivateNetworks: boolean(environment.ALLOW_PRIVATE_NETWORKS),
    allowDnsProxyNetworks: boolean(environment.ALLOW_DNS_PROXY_NETWORKS, true),
    preflightSources: boolean(environment.PREFLIGHT_SOURCES),
    preflightDeep: boolean(environment.PREFLIGHT_DEEP_SOURCES),
    preflightTimeoutMs: integer(environment.PREFLIGHT_TIMEOUT_MS, 2_500),
    preflightConcurrency: integer(environment.PREFLIGHT_CONCURRENCY, 48),
    corsOrigin: environment.CORS_ORIGIN || "*",
    mwwzDiscoveryUrl: environment.MWWZ_DISCOVERY_URL || "https://www.manwake.cc/",
    jmDiscoveryUrl: environment.JM_DISCOVERY_URL || "https://jmcomicqa.cc/",
  };
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(octets[2])) || (b === 88 && octets[2] === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100)))
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224;
}

function isPrivateIp(address) {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function isDnsProxyIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

async function resolveTarget(url, config) {
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, "阅读源地址只支持 http:// 或 https://");
  if (!url.hostname) throw new HttpError(400, "阅读源地址缺少主机名");
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpError(502, `无法解析阅读源域名：${error.message}`);
  }
  if (!addresses.length) throw new HttpError(502, "阅读源域名没有可用地址");
  const hostnameIsIp = isIP(url.hostname) !== 0;
  const blockedAddresses = addresses.filter(({ address }) => isPrivateIp(address));
  const dnsProxyException = config.allowDnsProxyNetworks
    && !hostnameIsIp
    && blockedAddresses.length > 0
    && blockedAddresses.every(({ address }) => isDnsProxyIpv4(address));
  if (!config.allowPrivateNetworks && blockedAddresses.length && !dnsProxyException) {
    throw new HttpError(403, "出于安全考虑，默认禁止访问本机或内网地址；可信环境可设置 ALLOW_PRIVATE_NETWORKS=true");
  }
  return addresses[0];
}

function requestBuffer(url, resolved, config, { maxBytes = config.maxSourceBytes, accept, headers = {}, label = "下载资源" } = {}) {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requester(url, {
      headers: {
        Accept: accept || "application/json,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "read2xsgg/0.2",
        ...headers,
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      ...(!isIP(url.hostname) ? { servername: url.hostname } : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new HttpError(502, `${label}失败：上游返回 HTTP ${status}`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maxBytes) {
        response.destroy();
        reject(new HttpError(413, `${label}超过大小限制 ${maxBytes} 字节`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy(new HttpError(413, `${label}超过大小限制 ${maxBytes} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let buffer = Buffer.concat(chunks, length);
        const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        try {
          if (encoding.includes("gzip")) buffer = gunzipSync(buffer, { maxOutputLength: maxBytes });
          else if (encoding.includes("deflate")) buffer = inflateSync(buffer, { maxOutputLength: maxBytes });
          else if (encoding.includes("br")) buffer = brotliDecompressSync(buffer, { maxOutputLength: maxBytes });
        } catch (error) {
          reject(new HttpError(502, `${label}解压失败：${error.message}`));
          return;
        }
        if (buffer.length > maxBytes) {
          reject(new HttpError(413, `${label}解压后超过大小限制 ${maxBytes} 字节`));
          return;
        }
        resolve({ buffer, headers: response.headers });
      });
      response.on("error", reject);
    });
    request.setTimeout(config.fetchTimeoutMs, () => request.destroy(new HttpError(504, `${label}超时（${config.fetchTimeoutMs}ms）`)));
    request.on("error", (error) => reject(error instanceof HttpError ? error : new HttpError(502, `${label}失败：${error.message}`)));
    request.end();
  });
}

export async function downloadSource(sourceUrl, config = serverConfig(), headers = {}) {
  let current;
  try {
    current = new URL(sourceUrl);
  } catch {
    throw new HttpError(400, "阅读源地址不是有效 URL");
  }
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config, { label: "下载阅读源", headers });
    if (result.buffer) return result.buffer;
    if (redirects === config.maxRedirects) throw new HttpError(502, `阅读源重定向次数超过 ${config.maxRedirects}`);
    current = result.redirect;
  }
  throw new HttpError(502, "下载阅读源失败");
}

function probeRequest(url, resolved, config, headers = {}, method = "HEAD") {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requester(url, {
      method,
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        ...headers,
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      ...(!isIP(url.hostname) ? { servername: url.hostname } : {}),
    }, (response) => {
      response.resume();
      resolve({ status: response.statusCode || 0, location: response.headers.location });
    });
    request.setTimeout(config.preflightTimeoutMs, () => request.destroy(new Error("preflight timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function sourceOriginReachable(source, config) {
  let current;
  try {
    current = new URL(String(source?.bookSourceUrl || source?.sourceUrl || source?.url || "").split("#", 1)[0]);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(current.protocol)) return false;
  let headers = {};
  try {
    headers = source?.httpHeaders && typeof source.httpHeaders === "object"
      ? { ...source.httpHeaders }
      : parseHeaders(source?.header);
  } catch {
    headers = {};
  }
  if (source?.httpUserAgent) headers["User-Agent"] = String(source.httpUserAgent);
  for (let redirects = 0; redirects <= Math.min(config.maxRedirects, 3); redirects += 1) {
    try {
      const resolved = await resolveTarget(current, config);
      const result = await probeRequest(current, resolved, config, headers);
      if (result.status >= 300 && result.status < 400 && result.location) {
        current = new URL(result.location, current);
        continue;
      }
      if ([401, 403].includes(result.status) || result.status >= 500) {
        const getResult = await probeRequest(current, resolved, config, headers, "GET");
        return getResult.status > 0 && getResult.status < 500 && ![401, 403].includes(getResult.status);
      }
      return result.status > 0 && result.status < 500;
    } catch {
      return false;
    }
  }
  return false;
}

function firstRequestFilter(action) {
  const raw = action?.moreKeys?.requestFilters;
  if (!raw) return "";
  if (Array.isArray(raw)) return String(raw[0]?.items?.[0]?.value || "");
  if (raw && typeof raw === "object") return String(Object.values(raw)[0] || "");
  const line = String(raw).split(/\r?\n/).find((item) => item.includes("::")) || "";
  return line.slice(line.indexOf("::") + 2).trim();
}

function declarativeBridgeAction(action, type) {
  const requestInfo = String(action?.requestInfo || "");
  const match = requestInfo.match(new RegExp(`/adapter/${type}\\?plan=([A-Za-z0-9_-]+)&url=`));
  if (!match) return null;
  try {
    return { plan: decodeBridgePlan(match[1]), requestInfo };
  } catch {
    return null;
  }
}

function declarativeBookTarget(action, bridge) {
  if (!bridge || /^@js:/i.test(bridge.requestInfo.trim())) return "";
  const marker = "&url=";
  const index = bridge.requestInfo.indexOf(marker);
  const embedded = index >= 0;
  let target = (embedded ? bridge.requestInfo.slice(index + marker.length) : bridge.requestInfo)
    .replaceAll("%@filter", firstRequestFilter(action))
    .replaceAll("%@pageIndex", "1")
    .replaceAll("%@offset", "0")
    .replaceAll("%@keyWord", "");
  if (!target || /%@|\{\{|<[^>]*>/.test(target)) return "";
  if (embedded) {
    try { target = decodeURIComponent(target); } catch { return ""; }
  }
  try { return new URL(target, bridge.plan.host).toString(); } catch { return ""; }
}

function actionHeaders(source, action) {
  return { ...(source?.httpHeaders || {}), ...(action?.httpHeaders || {}) };
}

function executableBookAction(source, action) {
  const bridged = declarativeBridgeAction(action, "books");
  if (bridged) return bridged;
  const requestInfo = String(action?.requestInfo || "");
  if (!requestInfo || /^@js:/i.test(requestInfo.trim())) return null;
  try {
    const plan = compileBookBridgePlan(action, actionHeaders(source, action));
    if (!plan.list || !plan.fields.name || !plan.fields.url) return null;
    return { plan, requestInfo };
  } catch {
    return null;
  }
}

function executableChapterAction(source) {
  const action = source?.chapterList;
  const bridged = declarativeBridgeAction(action, "chapters");
  if (bridged) return bridged;
  let tocSelector = "";
  const requestInfo = String(action?.requestInfo || "");
  const selector = requestInfo.match(/\/adapter\/toc\?[^"'`\s]*?selector=([^&"'`\s]+)/)?.[1];
  if (selector) {
    try { tocSelector = decodeURIComponent(selector); } catch { return null; }
  }
  try {
    const plan = compileChapterBridgePlan(action, { tocSelector, headers: actionHeaders(source, action) });
    if (!plan.list || !plan.fields.title || !plan.fields.url) return null;
    return { plan, requestInfo };
  } catch {
    return null;
  }
}

async function executeDeclarativeUrl(plan, targetUrl, config, { chapters = false, limit = Infinity } = {}) {
  const page = await downloadSource(targetUrl, config, plan.headers);
  const text = page.toString("utf8");
  if (chapters && plan.tocSelector) {
    const tocUrl = bridgeTocUrl(text, targetUrl, plan);
    if (tocUrl) {
      try {
        const tocPage = await downloadSource(tocUrl, config, plan.headers);
        const output = executeBridgePlan(tocPage.toString("utf8"), tocUrl, plan, { limit });
        if (Array.isArray(output.data) && output.data.length) return output;
      } catch {
        // The normal adapter also falls back to chapters embedded in details.
      }
    }
  }
  return executeBridgePlan(text, targetUrl, plan, { limit });
}

function encodedAdapterPlan(action, endpoint) {
  const requestInfo = String(action?.requestInfo || "");
  if (!new RegExp(`/adapter/${endpoint.replace("/", "\\/")}\\?`).test(requestInfo)) return null;
  const match = requestInfo.match(/(?:[?&])plan=([A-Za-z0-9_-]+)/);
  return match?.[1] || "";
}

async function sourceContentReachable(source, chapterUrl, config) {
  let textAction = declarativeBridgeAction(source?.chapterContent, "text");
  if (!textAction && source?.sourceType === "text") {
    try {
      const plan = compileTextBridgePlan(source.chapterContent, actionHeaders(source, source.chapterContent));
      if (plan.fields.content) textAction = { plan };
    } catch {
      // An unrepresentable native text action is not safe to claim as usable.
    }
  }
  if (textAction) {
    const output = await executeDeclarativeUrl(textAction.plan, chapterUrl, config);
    return String(output?.content || "").trim().length > 0;
  }
  if (source?.sourceType === "text") return false;

  const imagePlan = encodedAdapterPlan(source?.chapterContent, "images");
  if (imagePlan !== null) {
    const page = await downloadSource(chapterUrl, config);
    return pageImageUrls(page.toString("utf8"), chapterUrl, decodeComicExtractionPlan(imagePlan)).length > 0;
  }

  const mediaPlan = encodedAdapterPlan(source?.chapterContent, "media");
  if (mediaPlan !== null) {
    const kind = source?.sourceType === "video" ? "video" : "audio";
    const plan = decodeMediaExtractionPlan(mediaPlan, kind);
    const direct = pageMediaUrls("", chapterUrl, plan);
    if (direct.length) return true;
    const page = await downloadSource(chapterUrl, config);
    return pageMediaUrls(page.toString("utf8"), chapterUrl, plan).length > 0;
  }

  // Native JM and other fully portable XSGG actions do not expose a safe
  // server-side plan. Their static action-chain gate remains authoritative.
  return true;
}

async function sourceBridgeChainReachable(source, config) {
  if (!config.preflightDeep) return true;
  const chapterBridge = executableChapterAction(source);
  if (!chapterBridge) return false;
  // This runs while generating an aggregate XBS and must stay below normal
  // reverse-proxy timeouts. One real category/book chain is enough to reject
  // dead selectors; the standalone validator performs the exhaustive retries.
  const worlds = Object.values(source?.bookWorld || {}).slice(0, 1);
  const deepConfig = { ...config, fetchTimeoutMs: config.preflightTimeoutMs };
  for (const action of worlds) {
    const bookBridge = executableBookAction(source, action);
    const targetUrl = declarativeBookTarget(action, bookBridge);
    if (!bookBridge || !targetUrl) continue;
    try {
      const books = await executeDeclarativeUrl(bookBridge.plan, targetUrl, deepConfig, { limit: 3 });
      for (const book of (books.data || []).slice(0, 3)) {
        if (!book?.url) continue;
        try {
          const chapters = await executeDeclarativeUrl(chapterBridge.plan, book.url, deepConfig, { chapters: true, limit: 2 });
          for (const chapter of (chapters.data || []).slice(0, 2)) {
            if (chapter?.url && await sourceContentReachable(source, chapter.url, deepConfig)) return true;
          }
        } catch {
          // Try another book because fresh/deleted entries often have no toc.
        }
      }
    } catch {
      // Try another category action before declaring the source unusable.
    }
  }
  // If a source has a server-bridge chapter rule but none of its category
  // requests can be represented and exercised safely, importing it would only
  // recreate the previous "visible source, empty category" failure mode.
  return false;
}

export async function filterReachableSources(input, config) {
  const sources = legacySourceList(input);
  if (!config.preflightSources || !sources.length) return { input, skipped: [] };
  const results = new Array(sources.length);
  const originTasks = new Map();
  const deepTasks = new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(config.preflightConcurrency, sources.length) }, async () => {
    while (cursor < sources.length) {
      const index = cursor;
      cursor += 1;
      const source = sources[index];
      let key = String(source?.bookSourceUrl || source?.sourceUrl || source?.url || "");
      try {
        key = new URL(key.split("#", 1)[0]).origin;
      } catch {
        // Invalid URLs intentionally remain unique and fail the probe.
      }
      if (!originTasks.has(key)) originTasks.set(key, sourceOriginReachable(source, config));
      const originReachable = await originTasks.get(key);
      if (!originReachable) {
        results[index] = false;
        continue;
      }
      // Aggregates often contain renamed copies of exactly the same source.
      // Share their expensive list→chapter→content probe while keeping the
      // original entries and names intact in the converted output.
      const chainKey = JSON.stringify([
        Object.entries(source?.bookWorld || {})[0] || null,
        source?.chapterList || null,
        source?.chapterContent || null,
        source?.httpHeaders || null,
      ]);
      if (!deepTasks.has(chainKey)) deepTasks.set(chainKey, sourceBridgeChainReachable(source, config));
      results[index] = await deepTasks.get(chainKey);
    }
  });
  await Promise.all(workers);
  const reachable = [];
  const skipped = [];
  sources.forEach((source, index) => {
    if (results[index]) reachable.push(source);
    else skipped.push({ source: String(source?.bookSourceName || source?.sourceName || source?.name || "未命名书源"), reason: "上游站点不可访问，或核心分类/章节链路没有数据" });
  });
  return { input: reachable, skipped };
}

function normalizeRemoteUrl(value) {
  let source = String(value ?? "").trim();
  if (!source) throw new HttpError(400, "缺少图片 URL");
  try {
    source = decodeURIComponent(source);
  } catch {
    throw new HttpError(400, "图片 URL 编码无效");
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new HttpError(400, "图片 URL 不是有效 URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, "图片 URL 只支持 http:// 或 https://");
  if (url.username || url.password) throw new HttpError(400, "图片 URL 不能包含用户名或密码");
  return url.toString();
}

export async function downloadImage(imageUrl, decoder = "auto", config = serverConfig()) {
  let current;
  try {
    current = new URL(normalizeRemoteUrl(imageUrl));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "图片 URL 不是有效 URL");
  }
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config, {
      maxBytes: config.maxImageBytes,
      label: "下载图片",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      // A same-origin Referer works for sources which reject empty Referer, while
      // keeping the endpoint free of caller-controlled request headers.
      headers: { Referer: `${current.protocol}//${current.host}/` },
    });
    if (!result.buffer) {
      if (redirects === config.maxRedirects) throw new HttpError(502, `图片重定向次数超过 ${config.maxRedirects}`);
      current = result.redirect;
      continue;
    }
    try {
      return { ...await decodeImage(result.buffer, decoder, { url: current.toString() }), upstreamUrl: current.toString() };
    } catch (error) {
      if (error instanceof ImageDecodeError) throw new HttpError(422, `图片无法解码：${error.message}`);
      throw error;
    }
  }
  throw new HttpError(502, "下载图片失败");
}

function legacySourceList(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  if (input.bookSourceUrl || input.bookSourceName) return [input];
  for (const key of ["sources", "bookSources", "data"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  return [];
}

function isMwwzSource(source) {
  return /(?:mwwz|manwake|漫蛙)/i.test(String(source?.bookSourceUrl || ""))
    && /(?:manwake|GLOBAL_IMAGE_ROUTES|api\/comic\/image)/i.test(String(source?.loginUrl || "") + String(source?.ruleContent?.imageDecode || ""));
}

function isJmSource(source) {
  const runtimeRules = `${source?.loginUrl || ""}\n${source?.ruleContent?.imageDecode || ""}`;
  return /(?:jmcomic|18comic|comic18j)/i.test(String(source?.bookSourceUrl || ""))
    || (/(?:BitmapFactory\.decodeByteArray|new\s+Canvas)/i.test(runtimeRules) && /(?:photos|bookId|imgId)/i.test(runtimeRules));
}

export function mwwzMirrorCandidates(releasePage, baseUrl) {
  const result = [];
  for (const match of String(releasePage || "").matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (/^https?:$/.test(url.protocol) && !result.includes(url.origin)) result.push(url.origin);
    } catch {
      // Ignore malformed published links and continue with the remaining mirrors.
    }
  }
  return result;
}

function htmlAttribute(tag, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag).match(new RegExp(`\\b${escaped}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, "i"));
  return match ? (match[2] ?? match[3]) : null;
}

function htmlText(value) {
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
      const numeric = String(code).toLowerCase().startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 漫蛙的阅读 exploreUrl 依赖 java.ajax + Jsoup 动态抓取 /cate，香色无法执行。
 * 在线转换时取一次公开分类页，把每个分类固化为同语义的 API 请求。
 */
export function mwwzCategoryEntries(categoryPage) {
  const entries = [];
  const seen = new Set();
  for (const match of String(categoryPage || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const href = htmlAttribute(attributes, "href");
    const tag = htmlAttribute(attributes, "data-value");
    if (!href || tag === null || !/^\/cate(?:\/|$)/.test(href)) continue;
    const title = htmlText(match[2]);
    const identity = `${href}\n${tag}`;
    if (!title || seen.has(identity)) continue;
    seen.add(identity);
    entries.push({ title, path: href, tag });
  }
  return entries;
}

function mwwzExploreRequest(path, tag) {
  const payload = {
    page: { page: "{{page}}", pageSize: 10 },
    category: "comic",
    sort: 0,
    comic: { status: -1, day: 0, tag },
    video: { year: 0, typeId: 0, typeId1: 0, area: "", lang: "", status: -1, day: 0 },
    novel: { status: -1, day: 0, sortId: 0 },
  };
  // page must be a JSON number, not the string "{{page}}". JSON.stringify
  // provides safe escaping for the tag, then this narrow replacement restores
  // the runtime page placeholder used by convertRequest().
  const body = JSON.stringify(payload).replace('"{{page}}"', "{{page}}");
  return `{{Get('url')}}/api${path},${JSON.stringify({ method: "POST", body })}`;
}

async function resolveMwwzMirror(config) {
  let discovery;
  try {
    discovery = await downloadSource(config.mwwzDiscoveryUrl, config);
  } catch {
    return "";
  }
  const candidates = mwwzMirrorCandidates(discovery.toString("utf8"), config.mwwzDiscoveryUrl);
  for (const origin of candidates) {
    try {
      const body = await downloadSource(`${origin}/api/search?keyword=test&type=mh&page=1&pageSize=1`, config);
      const parsed = JSON.parse(body.toString("utf8"));
      if (Array.isArray(parsed?.data?.list)) return origin;
    } catch {
      // Mirrors frequently rotate; test the next published address.
    }
  }
  return "";
}

export function jmMirrorCandidates(discoveryPage, baseUrl, runtimeRules = "") {
  const result = [];
  const add = (value) => {
    let raw = htmlText(value).trim();
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const url = new URL(raw, baseUrl);
      if (/^https?:$/.test(url.protocol) && !result.includes(url.origin)) result.push(url.origin);
    } catch {
      // Ignore malformed published links.
    }
  };
  for (const match of String(discoveryPage || "").matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) add(match[1]);
  for (const match of String(runtimeRules || "").matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) add(match[0]);
  return result;
}

async function resolveJmMirror(config, sources) {
  let discovery = "";
  try {
    discovery = (await downloadSource(config.jmDiscoveryUrl, config)).toString("utf8");
  } catch {
    // The source itself contains fallback international domains; try those next.
  }
  const runtimeRules = sources.map((source) => source?.loginUrl || "").join("\n");
  const candidates = jmMirrorCandidates(discovery, config.jmDiscoveryUrl, runtimeRules);
  for (const origin of candidates) {
    try {
      const body = await downloadSource(`${origin}/albums?o=mr&page=1`, config);
      const html = body.toString("utf8");
      if (/class=["'][^"']*\blist-col\b/i.test(html) && /class=["'][^"']*\bvideo-title\b/i.test(html)) return origin;
    } catch {
      // Cloudflare and published mirrors rotate independently; test the next one.
    }
  }
  return "";
}

async function adaptOnlineSources(input, config) {
  const sources = legacySourceList(input);
  const hasMwwz = sources.some(isMwwzSource);
  const jmSources = sources.filter(isJmSource);
  if (!hasMwwz && !jmSources.length) return input;
  const mwwzMirror = hasMwwz ? await resolveMwwzMirror(config) : "";
  const jmMirror = jmSources.length ? await resolveJmMirror(config, jmSources) : "";

  let categories = [];
  if (mwwzMirror) {
    try {
      const categoryPage = await downloadSource(`${mwwzMirror}/cate`, config);
      categories = mwwzCategoryEntries(categoryPage.toString("utf8"));
    } catch {
      // The mirror remains useful for search/detail even if its category page is
      // temporarily blocked. Keep the original exploration rule in that case.
    }
  }

  const cloned = structuredClone(input);
  for (const source of legacySourceList(cloned)) {
    if (isMwwzSource(source) && mwwzMirror) {
      source.bookSourceUrl = mwwzMirror;
      // The original header is a Legado @js expression. 香色 needs a concrete UA.
      source.header = JSON.stringify({
        "User-Agent": "Mozilla/5.0 (Linux; Android 9) Mobile Safari/537.36",
        Referer: `${mwwzMirror}/`,
      });
      if (categories.length) {
        source.exploreUrl = categories.map(({ title, path, tag }) => ({
          title,
          url: mwwzExploreRequest(path, tag),
          pageSize: 10,
        }));
      }
    }
    if (isJmSource(source) && jmMirror) {
      source.bookSourceUrl = jmMirror;
      source.header = JSON.stringify({
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Referer: `${jmMirror}/`,
      });
    }
  }
  return cloned;
}

/**
 * 把路径里嵌套的阅读源地址还原成可抓取 URL。
 * 支持：
 * - 完整 URL（可编码或原样）: https://host/path.json
 * - 去协议手拼接: host/path.json
 * - 代理友好: https/host/path.json
 */
export function normalizeEmbeddedSourceUrl(value) {
  let source = String(value ?? "").trim();
  if (!source) throw new HttpError(400, "缺少在线阅读源 URL");
  if (source.endsWith(".xbs")) source = source.slice(0, -".xbs".length);
  if (/%[0-9A-Fa-f]{2}/.test(source)) {
    try {
      source = decodeURIComponent(source);
    } catch {
      throw new HttpError(400, "路径中的阅读源 URL 编码无效");
    }
  }
  source = source.trim().replace(/^\/+/, "");
  if (!source) throw new HttpError(400, "缺少在线阅读源 URL");

  if (/^https?:\/\//i.test(source)) return source;
  // /xbs/https/www.example.com/a.json.xbs 或误写成 https:/www...
  const schemeSlash = source.match(/^(https?)\/+(.*)$/i);
  if (schemeSlash?.[2]) return `${schemeSlash[1].toLowerCase()}://${schemeSlash[2]}`;

  // 手拼最简形式：去掉协议后直接接在 /xbs/ 后面
  // 域名默认 https；字面量 IP（含端口）默认 http，便于本地/内网源。
  if (/^[a-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(source) || /^\[[0-9a-f:]+\](?::\d+)?(?:\/|$)/i.test(source)) {
    const host = source.startsWith("[") ? (source.match(/^\[[0-9a-f:]+\]/i)?.[0] ?? "") : source.split("/")[0].replace(/:\d+$/, "");
    const scheme = host && isIP(host.replace(/^\[|\]$/g, "")) ? "http" : "https";
    return `${scheme}://${source}`;
  }

  throw new HttpError(400, "无法解析阅读源地址，请使用 https://host/path 或 host/path");
}

/**
 * yckceo 的 shuyuans（聚合/跳转）与 shuyuan（直接 JSON）接口并不总是同步：
 * 有些 ID 在复数接口有效，有些会返回“数据不存在”的 HTML。保留原地址优先，
 * 仅在解析失败时尝试对应的直接 JSON 地址。
 */
export function sourceUrlCandidates(sourceUrl) {
  const result = [sourceUrl];
  try {
    const url = new URL(sourceUrl);
    if (/(?:^|\.)yckceo\.com$/i.test(url.hostname) && /\/shuyuans\/json\/id\//i.test(url.pathname)) {
      const fallback = new URL(url);
      fallback.pathname = fallback.pathname.replace(/\/shuyuans\/json\/id\//i, "/shuyuan/json/id/");
      if (fallback.toString() !== sourceUrl) result.push(fallback.toString());
    }
  } catch {
    // normalizeEmbeddedSourceUrl already validates public request input.
  }
  return result;
}

function sourceUrlFromRequest(request) {
  const rawUrl = request.url || "/";
  const pathOnly = rawUrl.split(/[?#]/, 1)[0];

  // 推荐手拼：/xbs/www.example.com/legado.json.xbs
  for (const prefix of ["/xbs/", "/x/", "/url/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "xbs" };
    }
  }
  for (const prefix of ["/json/", "/j/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "json" };
    }
  }

  const parsed = new URL(rawUrl, "http://read2xsgg.local");
  if (["/convert", "/convert.xbs", "/x.xbs", "/convert/json"].includes(parsed.pathname)) {
    let sourceUrl = "";
    // /x.xbs?u=... 把 u= 后面整段都当阅读源（支持源地址自带 ?query，免编码）
    if (parsed.pathname === "/x.xbs") {
      const marker = rawUrl.includes("?u=") ? "?u=" : rawUrl.includes("&u=") ? "&u=" : "";
      sourceUrl = marker ? rawUrl.slice(rawUrl.indexOf(marker) + marker.length) : (parsed.searchParams.get("url") || "");
    } else {
      sourceUrl = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    }
    return {
      sourceUrl: sourceUrl ? normalizeEmbeddedSourceUrl(sourceUrl) : "",
      format: parsed.pathname.endsWith("/json") || parsed.searchParams.get("format") === "json" ? "json" : "xbs",
    };
  }
  return null;
}

function imageRequestFromRequest(request) {
  const parsed = new URL(request.url || "/", "http://read2xsgg.local");
  let decoder;
  if (parsed.pathname === "/image") decoder = parsed.searchParams.get("decoder") || "auto";
  else if (parsed.pathname.startsWith("/image/")) decoder = parsed.pathname.slice("/image/".length);
  else return null;
  if (!/^(?:auto|passthrough|[a-z0-9-]+)$/i.test(decoder)) throw new HttpError(400, "图片解码器名称无效");
  return { imageUrl: parsed.searchParams.get("url") || parsed.searchParams.get("u") || "", decoder };
}

function adapterRequestFromRequest(request) {
  const parsed = new URL(request.url || "/", "http://read2xsgg.local");
  const type = parsed.pathname === "/adapter/jm/chapters" ? "jm-chapters"
    : parsed.pathname === "/adapter/images" || parsed.pathname === "/adapter/jm/images" ? "page-images"
      : parsed.pathname === "/adapter/media" ? "page-media"
        : parsed.pathname === "/adapter/toc" ? "toc-redirect"
          : parsed.pathname === "/adapter/books" ? "bridge-books"
            : parsed.pathname === "/adapter/chapters" ? "bridge-chapters"
              : parsed.pathname === "/adapter/text" ? "bridge-text"
      : "";
  if (!type) return null;
  let extractionPlan;
  let bridgePlan;
  try {
    extractionPlan = type === "page-media"
      ? decodeMediaExtractionPlan(parsed.searchParams.get("plan") || "", parsed.searchParams.get("kind") || "audio")
      : type === "page-images" ? decodeComicExtractionPlan(parsed.searchParams.get("plan") || "") : null;
    if (type.startsWith("bridge-")) bridgePlan = decodeBridgePlan(parsed.searchParams.get("plan") || "");
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  const rawRequestUrl = String(request.url || "");
  const rawMarker = rawRequestUrl.indexOf("&url=") >= 0 ? "&url=" : "?url=";
  const rawIndex = rawRequestUrl.indexOf(rawMarker);
  let rawSourceUrl = rawIndex >= 0 ? rawRequestUrl.slice(rawIndex + rawMarker.length) : "";
  if (/^https?%3A/i.test(rawSourceUrl) || /^%2F/i.test(rawSourceUrl)) {
    try { rawSourceUrl = decodeURIComponent(rawSourceUrl); } catch { /* validate below */ }
  }
  return {
    type,
    sourceUrl: type.startsWith("bridge-") ? rawSourceUrl : (parsed.searchParams.get("url") || parsed.searchParams.get("u") || ""),
    hint: parsed.searchParams.get("hint") || "",
    selector: parsed.searchParams.get("selector") || "",
    extractionPlan,
    bridgePlan,
  };
}

function plainText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTocUrl(page, baseUrl, hint = "", selector = "") {
  if (selector) {
    const document = new JSDOM(String(page || "")).window.document;
    for (const expression of String(selector).split(/\s*\|\|\s*/).filter(Boolean)) {
      try {
        const found = document.evaluate(expression, document, null, document.defaultView.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        const value = found?.nodeType === 2 ? found.nodeValue : found?.getAttribute?.("href") || found?.querySelector?.("a[href]")?.getAttribute("href");
        if (value && !/^(?:javascript|#)/i.test(value)) return new URL(value, baseUrl).toString();
      } catch {
        // Fall through to the heuristic scorer for malformed/unsupported XPath.
      }
    }
  }
  const candidates = [];
  let order = 0;
  for (const match of String(page || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = htmlAttribute(match[1], "href");
    if (!href || /^(?:javascript|#)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = plainText(match[2]);
    let score = -order;
    if (hint && text.includes(hint)) score += 1_000;
    if (/(?:章节目录|全部章节|目录|chapter\s*list|catalog|directory)/i.test(text)) score += 500;
    if (/(?:rcatalog|catalog|chapter[-_/]?list|chapters|directory|mulu)/i.test(url)) score += 200;
    if (/(?:开始阅读|立即阅读|下一章|上一章|read\s*now)/i.test(text)) score -= 300;
    candidates.push({ url, score });
    order += 1;
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.url || "";
}

function isLocalHost(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || isIP(bare) !== 0;
}

function forwardedProtocol(request) {
  const forwarded = String(request.headers.forwarded || "").match(/(?:^|[;,]\s*)proto=\"?([^;,\s\"]+)/i)?.[1];
  const xForwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwarded || xForwarded;
  return /^(https?|wss?)$/i.test(protocol) ? protocol.replace(/^ws/i, "http").toLowerCase() : "";
}

function publicHost(request) {
  const forwarded = String(request.headers.forwarded || "").match(/(?:^|[;,]\s*)host=\"?([^;,\s\"]+)/i)?.[1];
  const xForwarded = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = String(forwarded || xForwarded || request.headers.host || "").trim();
  return /^[a-z0-9.[\]-]+(?::\d+)?$/i.test(host) ? host : "";
}

/**
 * Derive the browser-visible converter origin rather than requiring a deployment
 * variable. Reverse proxies conventionally provide X-Forwarded-Proto/Forwarded;
 * for a public hostname without either header, HTTPS is the safe default.
 */
function publicBaseUrl(request) {
  const host = publicHost(request);
  if (!host) return "";
  const hostname = host.startsWith("[") ? (host.match(/^\[([^\]]+)\]/)?.[1] || "") : host.replace(/:\d+$/, "");
  const protocol = forwardedProtocol(request) || (request.socket.encrypted ? "https" : (isLocalHost(hostname) ? "http" : "https"));
  return `${protocol}://${host}`;
}

function help(config) {
  return {
    name: "read2xsgg",
    status: "ok",
    usage: {
      easy: "/xbs/www.example.com/legado.json.xbs",
      easyRule: "订阅地址 = {本站}/xbs/ + 去掉 https:// 后的阅读源地址 + .xbs",
      easyQuery: "/x.xbs?u=https://www.example.com/legado.json",
      xbs: "/convert.xbs?url=https://www.example.com/legado.json",
      path: "/url/https://www.example.com/legado.json.xbs",
      json: "/j/www.example.com/legado.json",
      image: "/image/mwwz-aes?url=https://cdn.example.com/encrypted-image",
      health: "/healthz",
    },
    limits: {
      maxSourceBytes: config.maxSourceBytes,
      maxImageBytes: config.maxImageBytes,
      fetchTimeoutMs: config.fetchTimeoutMs,
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowDnsProxyNetworks: config.allowDnsProxyNetworks,
      imageDecoders: supportedImageDecoders(),
    },
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, ...headers });
  response.end(body);
}

function jmAnchorEntries(fragment, baseUrl) {
  const entries = [];
  const seen = new Set();
  for (const match of String(fragment || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = htmlAttribute(match[1], "href");
    if (!href || /^javascript:/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!/^\/photo\/\d+/i.test(url.pathname) || seen.has(url.toString())) continue;
    const title = htmlText(match[2]);
    if (!title) continue;
    seen.add(url.toString());
    entries.push({ title, url: url.toString() });
  }
  return entries;
}

export function jmChapterEntries(detailPage, baseUrl) {
  const html = String(detailPage || "");
  for (const match of html.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi)) {
    const className = htmlAttribute(match[1], "class") || "";
    if (!/(?:^|\s)btn-toolbar(?:\s|$)/i.test(className)) continue;
    const chapters = jmAnchorEntries(match[2], baseUrl);
    if (chapters.length) return chapters;
  }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const className = htmlAttribute(match[1], "class") || "";
    if (!/(?:^|\s)reading(?:\s|$)/i.test(className)) continue;
    const chapters = jmAnchorEntries(match[0], baseUrl);
    if (chapters.length) return chapters;
  }
  return [];
}

/**
 * Extract a comic page's image sequence without knowing the site beforehand.
 * Chapter images normally form the largest same-directory sequence, whereas
 * navigation, recommendations and ads are isolated images or smaller groups.
 */
function normalizedImageUrl(value, baseUrl) {
  let raw = String(value || "")
    .replace(/\\u([\da-f]{4})/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\([\\"'])/g, "$1")
    .replace(/&amp;/gi, "&")
    .trim();
  if (!raw || /[<>\r\n]/.test(raw) || /^(?:data|blob|javascript):/i.test(raw)) return "";
  // srcset values may include a density/width suffix.
  raw = raw.split(/\s+(?:\d+(?:\.\d+)?x|\d+w)\s*$/i, 1)[0];
  if (!/^(?:https?:)?\/\//i.test(raw) && !/^(?:\/|\.\.?\/)/.test(raw)
    && !/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(raw)) return "";
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function hydrationDocuments(html) {
  const documents = [];
  let nextFlightStream = "";
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    // React/Next and similar hydration runtimes split one serialized payload
    // across ordered push([...,"chunk"]) calls. Rejoin string chunks before
    // extracting properties so URLs split at script boundaries remain intact.
    const push = script[1].match(/self(?:\.[A-Za-z_$][\w$]*)+\.push\((\[[\s\S]*\])\)\s*;?$/);
    if (!push) continue;
    try {
      const payload = JSON.parse(push[1]);
      if (typeof payload[1] === "string") nextFlightStream += payload[1];
    } catch {
      // A malformed hydration chunk should not prevent ordinary HTML fallback.
    }
  }
  if (nextFlightStream) documents.push(nextFlightStream);
  documents.push(html);
  return documents;
}

function propertyImageUrls(document, baseUrl, extractionPlan) {
  const plan = normalizeComicExtractionPlan(extractionPlan);
  const hints = new Set(plan.properties.map((value) => value.toLowerCase()));
  const groups = new Map();
  const add = (keyValue, value) => {
    const key = String(keyValue || "").toLowerCase();
    const semantic = /(?:url|uri|src|source|image|img|pic|picture|file|path)/i.test(key);
    if (!hints.has(key) && !semantic) return;
    const url = normalizedImageUrl(value, baseUrl);
    if (!url) return;
    const explicit = hints.has(key);
    const imageSemantic = /(?:image|img|pic|picture|src|source)/i.test(key);
    const imageExtension = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    // SEO JSON-LD commonly contains many page-level `url` fields. Generic
    // url/path/file keys are only image candidates when the original rule
    // named that key or the value itself looks like an image.
    if (!explicit && !imageSemantic && !imageExtension) return;
    const group = groups.get(key) || [];
    if (!group.includes(url)) group.push(url);
    groups.set(key, group);
  };

  // The second form decodes JSON strings embedded inside HTML/JavaScript. Only
  // declarative property names are used; source-provided regex/JS is never run.
  const variants = [
    String(document || ""),
    String(document || "").replace(/\\"/g, '"').replace(/\\\//g, "/"),
  ];
  for (const variant of variants) {
    for (const match of variant.matchAll(/"([A-Za-z_$][\w$-]{0,63})"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      add(match[1], match[2]);
    }
  }
  // Direct JSON APIs frequently use arrays of strings, which cannot be found
  // by key:value text matching. Walk parsed data after the text pass so repeated
  // textual properties retain their original order.
  try {
    const parsed = JSON.parse(String(document || ""));
    const walk = (value, parentKey = "") => {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") add(parentKey, item);
          else walk(item, parentKey);
        }
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string") add(key, item);
        else walk(item, key);
      }
    };
    walk(parsed);
  } catch {
    // HTML and hydration streams continue through the safe text extractor.
  }
  let best = [];
  let bestScore = -1;
  for (const [key, urls] of groups) {
    const explicit = hints.has(key);
    const imageLike = /(?:image|img|pic|picture|src|source)/i.test(key);
    const score = (explicit ? 1_000_000 : 0) + (imageLike ? 10_000 : 0) + urls.length;
    if (score > bestScore) {
      best = urls;
      bestScore = score;
    }
  }
  return best;
}

export function pageImageUrls(page, baseUrl, extractionPlan = null) {
  const html = String(page || "");
  const plan = normalizeComicExtractionPlan(extractionPlan);
  let embeddedUrls = [];
  for (const document of hydrationDocuments(html)) {
    const found = propertyImageUrls(document, baseUrl, plan);
    if (found.length > 1) return found;
    if (found.length) embeddedUrls = found;
  }

  const lazyUrls = [];
  const directUrls = [];
  const seen = new Set();
  const attributes = [...new Set([
    ...plan.attributes,
    "data-original", "data-src", "data-lazy-src", "data-url", "data-srcset", "src", "srcset",
  ])];
  for (const match of html.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/g)) {
    const tagName = match[1].toLowerCase();
    let attribute = "";
    let raw = "";
    for (const name of attributes) {
      const value = htmlAttribute(match[2], name);
      if (value) {
        attribute = name;
        raw = /srcset/i.test(name) ? value.split(",", 1)[0] : value;
        if (name.toLowerCase() === "style") raw = value.match(/url\(\s*(["']?)(.*?)\1\s*\)/i)?.[2] || "";
        break;
      }
    }
    if (!raw) continue;
    const key = normalizedImageUrl(raw, baseUrl);
    if (!key) continue;
    if (seen.has(key)) continue;
    // For ordinary src attributes, avoid common page chrome unless no lazy URLs
    // exist. Lazy attributes are normally reserved for actual comic pages.
    const lazy = attribute !== "src" && attribute !== "srcset";
    const pathname = new URL(key).pathname;
    const imageElement = /^(?:img|picture|source)$/i.test(tagName);
    const imageExtension = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(pathname);
    // data-url is also widely used by pagination/navigation controls. Signed
    // extensionless images remain valid on actual image elements, but an
    // arbitrary div/a data-url must look like an image before it is accepted.
    if (!imageElement && attribute !== "style" && !imageExtension) continue;
    if (!lazy && (!imageExtension
      || /(?:ad|avatar|banner|blank|captcha|icon|loading|logo)/i.test(pathname))) continue;
    seen.add(key);
    (lazy ? lazyUrls : directUrls).push(key);
  }
  const candidates = lazyUrls.length ? lazyUrls : directUrls;
  if (candidates.length < 2) {
    if (candidates.length) return candidates;
    if (embeddedUrls.length) return embeddedUrls;
    const plainUrls = [];
    for (const match of html.replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = normalizedImageUrl(match[0], baseUrl);
      if (url && /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url) && !plainUrls.includes(url)) plainUrls.push(url);
    }
    return plainUrls;
  }

  const groups = new Map();
  for (const value of candidates) {
    const parsed = new URL(value);
    const directory = parsed.pathname.replace(/\/[^/]*$/, "/");
    const group = groups.get(directory) || [];
    group.push(value);
    groups.set(directory, group);
  }
  let largest = [];
  for (const group of groups.values()) {
    if (group.length > largest.length) largest = group;
  }
  const numbered = largest.map((value, index) => {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/(?:^|\/)(?:[^/]*?)(\d+)(?:\.[A-Za-z0-9]+)$/);
    return { value, index, number: match ? Number(match[1]) : null };
  });
  if (numbered.length >= 2 && numbered.filter((item) => Number.isFinite(item.number)).length / numbered.length >= 0.8) {
    return numbered
      .sort((left, right) => (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
      .map((item) => item.value);
  }
  return largest;
}

// Backward-compatible export for callers that previously used the JM-specific name.
export const jmImageUrls = pageImageUrls;

const AUDIO_ONLY_EXTENSION = /\.(?:aac|flac|m4a|m4b|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i;
const VIDEO_ONLY_EXTENSION = /\.(?:mp4|m4v|mov|mkv|ts|webm)(?:[?#]|$)/i;
const STREAM_MEDIA_EXTENSION = /\.(?:m3u8|m4s)(?:[?#]|$)/i;
const NON_MEDIA_EXTENSION = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|png|svg|ttf|woff2?|webp)(?:[?#]|$)/i;

function mediaExtensionPattern(kind) {
  return kind === "video"
    ? /\.(?:m3u8|m4s|mp4|m4v|mov|mkv|ts|webm)(?:[?#]|$)/i
    : /\.(?:aac|flac|m3u8|m4a|m4b|m4s|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i;
}

function normalizedMediaUrl(value, baseUrl, kind, { allowGeneric = false } = {}) {
  let raw = String(value || "")
    .replace(/\\u([\da-f]{4})/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\([\\"'])/g, "$1")
    .replace(/&amp;/gi, "&")
    .trim();
  const embedded = raw.match(/https?:\/\/[^\s"'<>]+/i);
  if (embedded && embedded[0] !== raw) raw = embedded[0];
  raw = raw.replace(/[),;]+$/, "");
  if (!raw || /[<>\r\n]/.test(raw) || /^(?:blob|data|javascript):/i.test(raw)) return "";
  if (!/^(?:https?:)?\/\//i.test(raw) && !/^(?:\/|\.\.?\/)/.test(raw)) return "";
  try {
    const url = new URL(raw, baseUrl);
    if (!/^https?:$/.test(url.protocol) || NON_MEDIA_EXTENSION.test(url.toString())) return "";
    if (kind === "audio" && VIDEO_ONLY_EXTENSION.test(url.toString())) return "";
    if (kind === "video" && AUDIO_ONLY_EXTENSION.test(url.toString())) return "";
    if (!allowGeneric && !mediaExtensionPattern(kind).test(url.toString())) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Extract playable audio/video URLs from JSON, HTML and inline player scripts.
 * Rule-derived plans only prioritize field/attribute names; source JavaScript
 * is never evaluated by the server.
 */
export function pageMediaUrls(page, baseUrl, extractionPlan = null) {
  const plan = normalizeMediaExtractionPlan(extractionPlan, extractionPlan?.kind);
  const kind = plan.kind;
  const direct = normalizedMediaUrl(baseUrl, baseUrl, kind);
  if (direct) return [direct];

  const hints = new Set(plan.properties.map((value) => value.toLowerCase()));
  const candidates = new Map();
  let order = 0;
  const add = (keyValue, value, allowGeneric = false) => {
    const key = String(keyValue || "").toLowerCase();
    const semantic = /(?:url|uri|src|source|audio|sound|voice|track|play|video|media|stream|hls|m3u8|file|path)/i.test(key);
    if (!semantic && !hints.has(key) && !allowGeneric) return;
    const url = normalizedMediaUrl(value, baseUrl, kind, { allowGeneric: allowGeneric || hints.has(key) || semantic });
    if (!url || candidates.has(url)) return;
    const extension = mediaExtensionPattern(kind).test(url);
    const kindName = kind === "video" ? /(?:video|stream|hls|m3u8)/i.test(key) : /(?:audio|sound|voice|track)/i.test(key);
    const quality = Number(key.match(/(?:^|_)(\d{2,4})$/)?.[1] || 0);
    const stream = STREAM_MEDIA_EXTENSION.test(url);
    const score = (extension ? 1_000_000 : 0) + (hints.has(key) ? 100_000 : 0)
      + (kindName ? 10_000 : 0) + (stream ? 1_000 : 0) + quality - order;
    candidates.set(url, score);
    order += 1;
  };

  const text = String(page || "");
  const variants = [text, text.replace(/\\"/g, '"').replace(/\\\//g, "/")];
  for (const variant of variants) {
    for (const match of variant.matchAll(/"([A-Za-z_$][\w$-]{0,63})"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      add(match[1], match[2]);
    }
  }

  try {
    const parsed = JSON.parse(text);
    const walk = (value, parentKey = "") => {
      if (Array.isArray(value)) {
        for (const item of value) typeof item === "string" ? add(parentKey, item) : walk(item, parentKey);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string") add(key, item);
        else walk(item, key);
      }
    };
    walk(parsed);
  } catch {
    // Ordinary HTML/player pages continue through attribute and URL scanning.
  }

  const attributes = [...new Set([...plan.attributes, "src", "data-src", "data-url", "data-play-url", "href"])];
  for (const match of text.matchAll(/<(audio|video|source|iframe)\b([^>]*)>/gi)) {
    for (const attribute of attributes) {
      const value = htmlAttribute(match[2], attribute);
      if (value) add(attribute, value, true);
    }
  }
  for (const match of text.replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    add("media", match[0], false);
  }

  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([url]) => url);
}

function cacheSet(cache, key, value, config) {
  if (config.cacheTtlMs <= 0) return;
  if (cache.size >= config.maxCacheEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { expiresAt: Date.now() + config.cacheTtlMs, value });
}

async function convertOnlineSource(sourceUrl, config, imageProxyBase = "") {
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
  const count = Object.keys(converted.sources).length;
  if (!count) throw new HttpError(422, "在线地址中没有可转换的阅读源");
  const json = Buffer.from(`${JSON.stringify(converted.sources, null, 2)}\n`, "utf8");
  const xbs = encodeXbs(json);
  return { ...converted, count, json, xbs, etag: `"${createHash("sha256").update(xbs).digest("hex")}"` };
}

export function createAppServer(options = {}) {
  const config = { ...serverConfig(), ...(options.config ?? {}) };
  const cache = new Map();
  let active = 0;

  return createServer(async (request, response) => {
    const commonHeaders = {
      "Access-Control-Allow-Origin": config.corsOrigin,
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,If-None-Match",
      "X-Content-Type-Options": "nosniff",
    };
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, commonHeaders);
        response.end();
        return;
      }
      if (!new Set(["GET", "HEAD"]).has(request.method)) throw new HttpError(405, "仅支持 GET、HEAD 和 OPTIONS");
      const pathname = new URL(request.url || "/", "http://read2xsgg.local").pathname;
      if (pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" }, commonHeaders);
        return;
      }
      const adapterTarget = adapterRequestFromRequest(request);
      if (adapterTarget) {
        if (!adapterTarget.sourceUrl) throw new HttpError(400, "缺少待解析页面 URL");
        if (active >= config.maxConcurrent) throw new HttpError(429, "当前章节解析任务过多，请稍后重试");
        let requestedSourceUrl = adapterTarget.sourceUrl;
        if (adapterTarget.bridgePlan) {
          try {
            requestedSourceUrl = new URL(requestedSourceUrl, adapterTarget.bridgePlan.host).toString();
          } catch {
            throw new HttpError(400, "规则桥接目标 URL 无效");
          }
        }
        const sourceUrl = normalizeRemoteUrl(requestedSourceUrl);
        if (adapterTarget.type.startsWith("bridge-")) {
          active += 1;
          let output;
          try {
            let pageUrl = sourceUrl;
            let page = await downloadSource(pageUrl, config, adapterTarget.bridgePlan.headers);
            if (adapterTarget.type === "bridge-chapters" && adapterTarget.bridgePlan.tocSelector) {
              const tocUrl = bridgeTocUrl(page.toString("utf8"), pageUrl, adapterTarget.bridgePlan);
              if (tocUrl) {
                try {
                  const tocPageUrl = normalizeRemoteUrl(tocUrl);
                  const tocPage = await downloadSource(tocPageUrl, config, adapterTarget.bridgePlan.headers);
                  const tocOutput = executeBridgePlan(tocPage.toString("utf8"), tocPageUrl, adapterTarget.bridgePlan);
                  if (Array.isArray(tocOutput.data) && tocOutput.data.length) output = tocOutput;
                } catch {
                  // A number of Legado sources keep a stale or optional tocUrl
                  // while their chapter list still exists on the detail page.
                  // Fall through and parse the detail response with the same rule.
                }
              }
            }
            if (!output) output = executeBridgePlan(page.toString("utf8"), pageUrl, adapterTarget.bridgePlan);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(422, `规则桥接解析失败：${error.message}`);
          } finally {
            active -= 1;
          }
          sendJson(response, 200, output, { ...commonHeaders, "Cache-Control": "public, max-age=120" });
          return;
        }
        if (adapterTarget.type === "toc-redirect") {
          active += 1;
          let targetUrl;
          try {
            for (let attempt = 0; attempt < 3 && !targetUrl; attempt += 1) {
              if (attempt) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
              const detailPage = await downloadSource(sourceUrl, config);
              targetUrl = pageTocUrl(detailPage.toString("utf8"), sourceUrl, adapterTarget.hint, adapterTarget.selector);
            }
          } finally {
            active -= 1;
          }
          if (!targetUrl) throw new HttpError(422, "详情页没有解析到目录链接");
          response.writeHead(302, { ...commonHeaders, Location: targetUrl, "Cache-Control": "public, max-age=300" });
          response.end();
          return;
        }
        active += 1;
        let values;
        try {
          if (adapterTarget.type === "page-media") {
            values = pageMediaUrls("", sourceUrl, adapterTarget.extractionPlan);
          }
          if (!values?.length) {
            const detailPage = await downloadSource(sourceUrl, config);
            values = adapterTarget.type === "jm-chapters"
              ? jmChapterEntries(detailPage.toString("utf8"), sourceUrl)
              : adapterTarget.type === "page-media"
                ? pageMediaUrls(detailPage.toString("utf8"), sourceUrl, adapterTarget.extractionPlan)
                : pageImageUrls(detailPage.toString("utf8"), sourceUrl, adapterTarget.extractionPlan);
          }
        } finally {
          active -= 1;
        }
        if (!values.length) {
          const message = adapterTarget.type === "jm-chapters" ? "详情页没有解析到章节"
            : adapterTarget.type === "page-media" ? "页面没有解析到媒体地址" : "页面没有解析到图片";
          throw new HttpError(422, message);
        }
        const payload = adapterTarget.type === "jm-chapters" ? { chapters: values }
          : adapterTarget.type === "page-media" ? { url: values[0] } : { urls: values };
        sendJson(response, 200, payload, { ...commonHeaders, "Cache-Control": "public, max-age=300" });
        return;
      }
      const imageTarget = imageRequestFromRequest(request);
      if (imageTarget) {
        if (!imageTarget.imageUrl) throw new HttpError(400, "缺少图片 URL");
        if (active >= config.maxConcurrent) throw new HttpError(429, "当前图片处理任务过多，请稍后重试");
        active += 1;
        let image;
        try {
          image = await downloadImage(imageTarget.imageUrl, imageTarget.decoder, config);
        } finally {
          active -= 1;
        }
        response.writeHead(200, {
          ...commonHeaders,
          "Content-Type": image.mimeType,
          "Content-Length": image.buffer.length,
          "Cache-Control": "public, max-age=3600",
          "X-Image-Decoder": image.decoder,
        });
        if (request.method === "HEAD") response.end();
        else response.end(image.buffer);
        return;
      }
      const target = sourceUrlFromRequest(request);
      if (!target) {
        sendJson(response, pathname === "/" ? 200 : 404, help(config), commonHeaders);
        return;
      }
      if (!target.sourceUrl) throw new HttpError(400, "缺少在线阅读源 URL");
      if (active >= config.maxConcurrent) throw new HttpError(429, "当前转换任务过多，请稍后重试");

      // The conversion may embed this server's public image-proxy URL in a
      // recognised comic rule, so do not share it across distinct public hosts.
      const cacheKey = `${target.sourceUrl}\n${publicBaseUrl(request)}`;
      let converted = cache.get(cacheKey);
      if (converted && converted.expiresAt <= Date.now()) {
        cache.delete(cacheKey);
        converted = undefined;
      }
      if (converted) converted = converted.value;
      else {
        active += 1;
        try {
          converted = await convertOnlineSource(target.sourceUrl, config, publicBaseUrl(request));
          cacheSet(cache, cacheKey, converted, config);
        } finally {
          active -= 1;
        }
      }

      const headers = {
        ...commonHeaders,
        ETag: converted.etag,
        "Cache-Control": `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
        "X-Converted-Count": String(converted.count),
        "X-Skipped-Count": String(converted.skipped?.length || 0),
        "X-Warning-Count": String(converted.warnings.length),
      };
      if (request.headers["if-none-match"] === converted.etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      if (target.format === "json") {
        sendJson(response, 200, { sources: converted.sources, warnings: converted.warnings, skipped: converted.skipped || [] }, headers);
        return;
      }
      const filename = `read2xsgg-${createHash("sha256").update(target.sourceUrl).digest("hex").slice(0, 12)}.xbs`;
      response.writeHead(200, {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": converted.xbs.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(converted.xbs);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error.message || "服务器内部错误" }, commonHeaders);
    }
  });
}

export function startServer(config = serverConfig()) {
  const server = createAppServer({ config });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`read2xsgg listening on http://${config.host}:${config.port}\n`);
  });
  return server;
}
