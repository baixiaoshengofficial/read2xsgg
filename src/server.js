import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { convertOnlineSource } from "./convertOnline.js";
import { createLibraryStore } from "./libraryStore.js";
import { createJobWorker } from "./jobWorker.js";
import { analyzeSite } from "./siteAnalyze/index.js";
import { createDownloader, redirectLimitForMethod } from "./httpTransport.js";
import { decodeTextBuffer } from "./charset.js";
import { ImageDecodeError, decodeImage, supportedImageDecoders } from "./imageDecoder.js";
import { decodeComicExtractionPlan, normalizeComicExtractionPlan } from "./comicPlan.js";
import {
  decodeMediaExtractionPlan,
  normalizeMediaExtractionPlan,
  resolveChapterMediaUrls,
} from "./mediaPlan.js";
import { decodeCatalogPlan, executeCatalogPlan } from "./catalogPlan.js";
import { encodeXbs } from "./xbs.js";
import { parseHeaders } from "./requests.js";
import { resolveChapterListUrls } from "./verifySource.js";
import {
  bridgeTocUrl,
  compileBookBridgePlan,
  compileChapterBridgePlan,
  compileDetailBridgePlan,
  compileTextBridgePlan,
  decodeBridgePlan,
  executeBridgePlan,
  orderChaptersAscending,
} from "./bridgePlan.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, "../public");

export class HttpError extends Error {
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
    version: environment.npm_package_version || environment.APP_VERSION || "0.2.0",
    commit: environment.GIT_SHA || environment.SOURCE_COMMIT || environment.COMMIT_SHA || "",
    host: environment.HOST || "0.0.0.0",
    port: integer(environment.PORT, 3000, 0),
    fetchTimeoutMs: integer(environment.FETCH_TIMEOUT_MS, 15_000),
    maxSourceBytes: integer(environment.MAX_SOURCE_BYTES, 32 * 1024 * 1024),
    maxImageBytes: integer(environment.MAX_IMAGE_BYTES, 25 * 1024 * 1024),
    maxMediaBytes: integer(environment.MAX_MEDIA_BYTES, 80 * 1024 * 1024),
    maxRedirects: integer(environment.MAX_REDIRECTS, 5, 0),
    maxConcurrent: integer(environment.MAX_CONCURRENT, 8),
    cacheTtlMs: integer(environment.CACHE_TTL_SECONDS, 300, 0) * 1000,
    maxCacheEntries: integer(environment.MAX_CACHE_ENTRIES, 100),
    allowPrivateNetworks: boolean(environment.ALLOW_PRIVATE_NETWORKS),
    allowDnsProxyNetworks: boolean(environment.ALLOW_DNS_PROXY_NETWORKS, true),
    // Origin 探活默认开启：过滤明显死站，避免「能导入却点不开」。
    // 深度预检（分类→章节→正文）成本高，聚合源默认关闭；精选发布可显式开启。
    preflightSources: boolean(environment.PREFLIGHT_SOURCES, true),
    preflightDeep: boolean(environment.PREFLIGHT_DEEP_SOURCES, false),
    preflightTimeoutMs: integer(environment.PREFLIGHT_TIMEOUT_MS, 3_000),
    // Verify/preflight share this pool; 8 keeps large jobs moving without
    // starving small containers as badly as 16+.
    preflightConcurrency: integer(environment.PREFLIGHT_CONCURRENCY, 8),
    // 转换后抽测列表+目录。失败时识站修复；站点可达且仍失败则跳过（不 soft-keep 坏源）。
    verifyConvertedSources: boolean(environment.VERIFY_CONVERTED_SOURCES, true),
    analyzeFallback: boolean(environment.ANALYZE_FALLBACK, true),
    analyzeTimeoutMs: integer(environment.ANALYZE_TIMEOUT_MS, 8_000),
    // Wall-clock budget for verify phase; remainder kept unverified.
    verifyBudgetMs: integer(environment.VERIFY_BUDGET_MS, 20_000),
    // Skip verify entirely above this count (aggregate shuyuans).
    verifyMaxSources: integer(environment.VERIFY_MAX_SOURCES, 50),
    // Async WebUI jobs: 0 = unbounded full verify (default). Set >0 to cap wall time.
    jobVerifyBudgetMs: integer(environment.JOB_VERIFY_BUDGET_MS, 0, 0),
    maxComicPages: integer(environment.MAX_COMIC_PAGES, 50),
    maxComicImages: integer(environment.MAX_COMIC_IMAGES, 2_000),
    comicPageConcurrency: integer(environment.COMIC_PAGE_CONCURRENCY, 4),
    // Bridge adapters page large catalogues (missing upstream pagination) via
    // page/pageSize/slice instead of dropping the tail.
    maxBridgeBookPageSize: integer(environment.MAX_BRIDGE_BOOK_PAGE_SIZE, 40),
    maxBridgeChapterPageSize: integer(environment.MAX_BRIDGE_CHAPTER_PAGE_SIZE, 100),
    maxBridgeHtmlBytes: integer(environment.MAX_BRIDGE_HTML_BYTES, 2 * 1024 * 1024),
    // Back-compat aliases
    maxBridgeBooks: integer(environment.MAX_BRIDGE_BOOKS, integer(environment.MAX_BRIDGE_BOOK_PAGE_SIZE, 40)),
    maxBridgeChapters: integer(environment.MAX_BRIDGE_CHAPTERS, integer(environment.MAX_BRIDGE_CHAPTER_PAGE_SIZE, 100)),
    corsOrigin: environment.CORS_ORIGIN || "*",
    mwwzDiscoveryUrl: environment.MWWZ_DISCOVERY_URL || "https://www.manwake.cc/",
    jmDiscoveryUrl: environment.JM_DISCOVERY_URL || "https://jmcomicqa.cc/",
    dataDir: environment.DATA_DIR || "./data",
    adminToken: String(environment.ADMIN_TOKEN || "").trim(),
    jobConcurrency: integer(environment.JOB_CONCURRENCY, 1),
    publicDir: environment.PUBLIC_DIR || "",
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

function requestBuffer(url, resolved, config, {
  maxBytes = config.maxSourceBytes,
  accept,
  headers = {},
  label = "下载资源",
  method = "GET",
  body = null,
} = {}) {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const requestMethod = String(method || "GET").toUpperCase();
  return new Promise((resolve, reject) => {
    const request = requester(url, {
      method: requestMethod,
      headers: {
        Accept: accept || "application/json,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "read2xsgg/0.2",
        ...(payload ? { "Content-Length": String(payload.length) } : {}),
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
        // Do not replay POST bodies across redirects.
        if (requestMethod !== "GET" && requestMethod !== "HEAD") {
          reject(new HttpError(502, `${label}失败：上游对 ${requestMethod} 返回重定向 HTTP ${status}`));
          return;
        }
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
    if (payload) request.end(payload);
    else request.end();
  });
}

/**
 * SSRF-safe page/API fetch used by conversion and adapters.
 * Prefer createSourceDownloader(config) at call sites that need the adapter
 * transport contract (headers / method / body).
 */
export async function downloadSource(sourceUrl, config = serverConfig(), headers = {}, options = {}) {
  let current;
  try {
    current = new URL(sourceUrl);
  } catch {
    throw new HttpError(400, "阅读源地址不是有效 URL");
  }
  const method = String(options?.method || "GET").toUpperCase();
  const body = options?.body ?? null;
  const maxRedirects = redirectLimitForMethod(method, config.maxRedirects);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config, {
      label: "下载阅读源",
      headers,
      method,
      body: redirects === 0 ? body : null,
    });
    if (result.buffer) {
      Object.defineProperty(result.buffer, "httpHeaders", {
        value: result.headers || {},
        enumerable: false,
        configurable: true,
      });
      return result.buffer;
    }
    if (redirects === maxRedirects) throw new HttpError(502, `阅读源重定向次数超过 ${maxRedirects}`);
    current = result.redirect;
  }
  throw new HttpError(502, "下载阅读源失败");
}

/** Bound adapter transport: download(url, headersOrInit?, options?). */
export function createSourceDownloader(config = serverConfig()) {
  return createDownloader(downloadSource, config);
}

/** Decode a downloaded page with plan/source charset hint (fixes GBK mojibake). */
export function pageText(buffer, charsetHint = "") {
  return decodeTextBuffer(buffer, {
    headers: buffer?.httpHeaders || {},
    charsetHint,
  });
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
  // Allow paging/query params between plan= and url= (e.g. &page=&pageSize=&slice=1).
  const match = requestInfo.match(new RegExp(`/adapter/${type}\\?plan=([A-Za-z0-9_-]+)[^"'\\\\\\s]*?&url=`));
  if (!match) return null;
  try {
    return { plan: decodeBridgePlan(match[1]), requestInfo };
  } catch {
    return null;
  }
}

function safeGeneratedRequestTarget(requestInfo, host, { keyWord = "", pageIndex = 1, offset = 0, filter = "" } = {}) {
  const source = String(requestInfo || "");
  const expression = source.match(/\b(?:var|let|const)\s+url\s*=\s*([^;\r\n]{1,4096})\s*;/)?.[1];
  if (!expression) return "";
  const parts = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "+" && depth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return "";
  parts.push(expression.slice(start).trim());
  let result = "";
  const values = {
    "config.host": host,
    "params.keyWord": keyWord,
    "params.pageIndex": String(pageIndex),
    "params.offset": String(offset),
    "params.filter": filter,
    "encodeURIComponent(params.keyWord)": encodeURIComponent(keyWord),
  };
  for (const part of parts) {
    if (Object.hasOwn(values, part)) {
      result += values[part];
      continue;
    }
    if (/^"(?:\\.|[^"\\])*"$/.test(part)) {
      try { result += JSON.parse(part); } catch { return ""; }
      continue;
    }
    const single = part.match(/^'((?:\\.|[^'\\])*)'$/);
    if (single) {
      result += single[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      continue;
    }
    return "";
  }
  try { return new URL(result, host).toString(); } catch { return ""; }
}

function declarativeBookTarget(action, bridge, values = {}) {
  if (!bridge) return "";
  if (/^@js:/i.test(bridge.requestInfo.trim())) {
    return safeGeneratedRequestTarget(bridge.requestInfo, bridge.plan.host, values);
  }
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

function bridgeExecuteLimits(config = {}) {
  return {
    books: config.maxBridgeBookPageSize || config.maxBridgeBooks,
    chapters: config.maxBridgeChapterPageSize || config.maxBridgeChapters,
  };
}

function bridgePageOptions(adapterTarget, config = {}) {
  const kind = adapterTarget?.type === "bridge-chapters" ? "chapters" : "books";
  const defaults = bridgeExecuteLimits(config);
  const fallback = kind === "chapters" ? defaults.chapters : defaults.books;
  const requested = Number.parseInt(String(adapterTarget?.pageSize || ""), 10);
  const pageSize = Number.isInteger(requested) && requested > 0
    ? Math.min(200, requested)
    : fallback;
  const page = Math.max(1, Number.parseInt(String(adapterTarget?.page || "1"), 10) || 1);
  const slice = adapterTarget?.slice === true;
  return {
    limit: pageSize,
    offset: slice ? (page - 1) * pageSize : 0,
    page,
    pageSize,
    slice,
    limits: defaults,
  };
}

function prepareBridgeHtml(buffer, charsetHint = "", maxBytes = 2 * 1024 * 1024) {
  let text = pageText(buffer, charsetHint);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    // Keep the head of the document where lists usually live; truncating mid-tag
    // is acceptable because JSDOM recovers and we already cap extracted rows.
    text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  // Drop script/style payloads before DOM construction — they inflate CPU without
  // helping XPath book/chapter extraction.
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

async function executeDeclarativeUrl(plan, targetUrl, config, { chapters = false, limit, offset = 0 } = {}) {
  const page = await downloadSource(targetUrl, config, plan.headers);
  const text = prepareBridgeHtml(page, plan.charset, config.maxBridgeHtmlBytes);
  const options = { limit, offset, limits: bridgeExecuteLimits(config) };
  if (chapters && plan.tocSelector) {
    const tocUrl = bridgeTocUrl(text, targetUrl, plan);
    if (tocUrl) {
      try {
        const tocPage = await downloadSource(tocUrl, config, plan.headers);
        const output = executeBridgePlan(
          prepareBridgeHtml(tocPage, plan.charset, config.maxBridgeHtmlBytes),
          tocUrl,
          plan,
          options,
        );
        if (Array.isArray(output.data) && output.data.length) return output;
      } catch {
        // The normal adapter also falls through to chapters embedded in details.
      }
    }
  }
  return executeBridgePlan(text, targetUrl, plan, options);
}

/**
 * A common mixed API/web source shape returns `/api/book/123` from its JSON
 * list while the chapter selector is declared for `/book/123` HTML. Generated
 * XSGG requestInfo performs that rewrite at runtime; deep preflight must try the
 * same same-origin, declarative fallback without evaluating source JavaScript.
 */
export function chapterPageCandidates(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return [];
  }
  const candidates = [parsed.toString()];
  if (/(?:^|\/)api\//i.test(parsed.pathname)) {
    const page = new URL(parsed);
    page.pathname = page.pathname.replace(/(^|\/)api\//i, "$1");
    page.search = "";
    page.hash = "";
    if (!candidates.includes(page.toString())) candidates.push(page.toString());
  }
  return candidates;
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
    const plan = decodeComicExtractionPlan(imagePlan);
    const page = await downloadSource(chapterUrl, config, plan.headers);
    return pageImageUrls(page.toString("utf8"), chapterUrl, plan).length > 0;
  }

  const mediaPlan = encodedAdapterPlan(source?.chapterContent, "media");
  if (mediaPlan !== null) {
    const kind = source?.sourceType === "video" ? "video" : "audio";
    const plan = decodeMediaExtractionPlan(mediaPlan, kind);
    const download = createSourceDownloader(config);
    const urls = await resolveChapterMediaUrls(
      async () => (await download(chapterUrl, plan.headers || {})).toString("utf8"),
      chapterUrl,
      plan,
      download,
      pageMediaUrls,
    );
    return urls.length > 0;
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
  const worlds = [
    ...Object.values(source?.bookWorld || {}).slice(0, 1),
    ...(source?.searchBook ? [source.searchBook] : []),
  ];
  const keyWord = source?.sourceType === "comic" ? "漫画" : "小说";
  const deepConfig = { ...config, fetchTimeoutMs: config.preflightTimeoutMs };
  for (const action of worlds) {
    const bookBridge = executableBookAction(source, action);
    const targetUrl = declarativeBookTarget(action, bookBridge, { keyWord });
    if (!bookBridge || !targetUrl) continue;
    try {
      const books = await executeDeclarativeUrl(bookBridge.plan, targetUrl, deepConfig, { limit: 3 });
      for (const book of (books.data || []).slice(0, 3)) {
        if (!book?.url) continue;
        for (const chapterPageUrl of resolveChapterListUrls(chapterBridge.requestInfo, book.url)) {
          try {
            const chapters = await executeDeclarativeUrl(chapterBridge.plan, chapterPageUrl, deepConfig, { chapters: true, limit: 2 });
            for (const chapter of (chapters.data || []).slice(0, 2)) {
              if (chapter?.url && await sourceContentReachable(source, chapter.url, deepConfig)) return true;
            }
          } catch {
            // Try the next safe same-origin detail-page candidate.
          }
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

export async function filterReachableSources(input, config, { onProgress = null } = {}) {
  const sources = legacySourceList(input);
  const sourceLabel = (source) => {
    const name = String(source?.bookSourceName || source?.sourceName || source?.name || "").trim();
    const host = String(source?.bookSourceUrl || source?.sourceUrl || source?.url || "").trim();
    if (name && host) {
      try {
        return `${name} (${new URL(host.split("#", 1)[0]).hostname})`;
      } catch {
        return `${name} (${host})`;
      }
    }
    return name || host || "未命名书源";
  };
  if (!config.preflightSources || !sources.length) {
    if (typeof onProgress === "function") {
      try {
        onProgress({
          phase: "preflight",
          done: sources.length,
          total: sources.length,
          kept: sources.length,
          skipped: 0,
          unverified: 0,
          current: "",
          active: [],
        });
      } catch { /* ignore */ }
    }
    return { input, skipped: [] };
  }
  const results = new Array(sources.length);
  const originTasks = new Map();
  const deepTasks = new Map();
  let cursor = 0;
  let processed = 0;
  /** @type {Set<string>} */
  const active = new Set();
  const report = () => {
    if (typeof onProgress !== "function") return;
    try {
      const activeList = [...active];
      onProgress({
        phase: "preflight",
        done: processed,
        total: sources.length,
        kept: results.filter((value) => value === true).length,
        skipped: results.filter((value) => value === false).length,
        unverified: 0,
        current: activeList[0] || "",
        active: activeList,
      });
    } catch {
      // Progress callbacks must not break conversion.
    }
  };
  const workers = Array.from({ length: Math.min(config.preflightConcurrency, sources.length) }, async () => {
    while (cursor < sources.length) {
      const index = cursor;
      cursor += 1;
      const source = sources[index];
      const label = sourceLabel(source);
      let key = String(source?.bookSourceUrl || source?.sourceUrl || source?.url || "");
      try {
        key = new URL(key.split("#", 1)[0]).origin;
      } catch {
        // Invalid URLs intentionally remain unique and fail the probe.
      }
      active.add(label);
      report();
      try {
        if (!originTasks.has(key)) originTasks.set(key, sourceOriginReachable(source, config));
        const originReachable = await originTasks.get(key);
        if (!originReachable) {
          results[index] = false;
          processed += 1;
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
        processed += 1;
      } finally {
        active.delete(label);
        report();
      }
    }
  });
  await Promise.all(workers);
  const reachable = [];
  const skipped = [];
  sources.forEach((source, index) => {
    if (results[index]) reachable.push(source);
    else {
      skipped.push({
        source: String(source?.bookSourceName || source?.sourceName || source?.name || "未命名书源"),
        reason: config.preflightDeep
          ? "上游站点不可访问，或核心分类/章节链路没有数据"
          : "上游站点不可访问",
      });
    }
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

function mediaMimeType(url, contentType = "") {
  const declared = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && !declared.startsWith("text/")) return declared;
  const pathName = (() => {
    try { return new URL(url).pathname; } catch { return String(url || ""); }
  })();
  if (/\.m3u8(?:$|\?)/i.test(pathName)) return "application/vnd.apple.mpegurl";
  if (/\.mp3(?:$|\?)/i.test(pathName)) return "audio/mpeg";
  if (/\.m4a(?:$|\?)/i.test(pathName)) return "audio/mp4";
  if (/\.aac(?:$|\?)/i.test(pathName)) return "audio/aac";
  if (/\.ogg(?:$|\?)/i.test(pathName)) return "audio/ogg";
  if (/\.wav(?:$|\?)/i.test(pathName)) return "audio/wav";
  if (/\.flac(?:$|\?)/i.test(pathName)) return "audio/flac";
  if (/\.mp4(?:$|\?)/i.test(pathName)) return "video/mp4";
  if (/\.webm(?:$|\?)/i.test(pathName)) return "video/webm";
  if (/\.mkv(?:$|\?)/i.test(pathName)) return "video/x-matroska";
  return declared || "application/octet-stream";
}

/** Fetch a remote audio/video URL the same way /image fetches comics (Referer + SSRF guards). */
export async function downloadMedia(mediaUrl, config = serverConfig()) {
  let current;
  try {
    current = new URL(normalizeRemoteUrl(mediaUrl));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "媒体 URL 不是有效 URL");
  }
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config, {
      maxBytes: config.maxMediaBytes,
      label: "下载媒体",
      accept: "audio/*,video/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
      headers: { Referer: `${current.protocol}//${current.host}/` },
    });
    if (!result.buffer) {
      if (redirects === config.maxRedirects) throw new HttpError(502, `媒体重定向次数超过 ${config.maxRedirects}`);
      current = result.redirect;
      continue;
    }
    return {
      buffer: result.buffer,
      mimeType: mediaMimeType(current.toString(), result.headers?.["content-type"]),
      upstreamUrl: current.toString(),
    };
  }
  throw new HttpError(502, "下载媒体失败");
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

export async function adaptOnlineSources(input, config) {
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

/**
 * Parse public subscribe paths into either:
 * - mode "source": Legado JSON → Xiangse ( /source/... /xbs/... )
 * - mode "site": live website → analyze → Xiangse ( /url/... )
 */
function requestTargetFromRequest(request) {
  const rawUrl = request.url || "/";
  const pathOnly = rawUrl.split(/[?#]/, 1)[0];

  // 网站识站：/url/{去掉 https:// 后的站点}.xbs
  for (const prefix of ["/url/"]) {
    if (pathOnly.startsWith(prefix)) {
      const rest = pathOnly.slice(prefix.length);
      return {
        mode: "site",
        siteUrl: normalizeEmbeddedSourceUrl(rest),
        format: rest.endsWith(".xbs") ? "xbs" : "json",
      };
    }
  }

  // 阅读源转换：/source/{去掉 https:// 后的阅读源}.xbs
  // /xbs/ /x/ 保留为兼容别名
  for (const prefix of ["/source/", "/xbs/", "/x/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { mode: "source", sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "xbs" };
    }
  }
  for (const prefix of ["/json/", "/j/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { mode: "source", sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "json" };
    }
  }

  const parsed = new URL(rawUrl, "http://read2xsgg.local");
  if (["/analyze", "/analyze.xbs", "/analyze/json"].includes(parsed.pathname)) {
    const siteUrl = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    return {
      mode: "site",
      siteUrl: siteUrl ? normalizeEmbeddedSourceUrl(siteUrl) : "",
      format: parsed.pathname === "/analyze.xbs" ? "xbs" : "json",
    };
  }
  if (["/convert", "/convert.xbs", "/x.xbs", "/convert/json"].includes(parsed.pathname)) {
    let sourceUrl = "";
    if (parsed.pathname === "/x.xbs") {
      const marker = rawUrl.includes("?u=") ? "?u=" : rawUrl.includes("&u=") ? "&u=" : "";
      sourceUrl = marker ? rawUrl.slice(rawUrl.indexOf(marker) + marker.length) : (parsed.searchParams.get("url") || "");
    } else {
      sourceUrl = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    }
    return {
      mode: "source",
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

function mediaProxyRequestFromRequest(request) {
  const parsed = new URL(request.url || "/", "http://read2xsgg.local");
  if (parsed.pathname !== "/media") return null;
  return { mediaUrl: parsed.searchParams.get("url") || parsed.searchParams.get("u") || "" };
}

function adapterRequestFromRequest(request) {
  const parsed = new URL(request.url || "/", "http://read2xsgg.local");
  const type = parsed.pathname === "/adapter/jm/chapters" ? "jm-chapters"
    : parsed.pathname === "/adapter/catalog" ? "catalog"
    : parsed.pathname === "/adapter/images" || parsed.pathname === "/adapter/jm/images" ? "page-images"
      : parsed.pathname === "/adapter/media" ? "page-media"
        : parsed.pathname === "/adapter/toc" ? "toc-redirect"
          : parsed.pathname === "/adapter/books" ? "bridge-books"
            : parsed.pathname === "/adapter/detail" ? "bridge-detail"
            : parsed.pathname === "/adapter/chapters" ? "bridge-chapters"
              : parsed.pathname === "/adapter/text" ? "bridge-text"
      : "";
  if (!type) return null;
  let extractionPlan;
  let bridgePlan;
  let catalogPlan;
  try {
    extractionPlan = type === "page-media"
      ? decodeMediaExtractionPlan(parsed.searchParams.get("plan") || "", parsed.searchParams.get("kind") || "audio")
      : type === "page-images" ? decodeComicExtractionPlan(parsed.searchParams.get("plan") || "") : null;
    if (type.startsWith("bridge-")) bridgePlan = decodeBridgePlan(parsed.searchParams.get("plan") || "");
    if (type === "catalog") catalogPlan = decodeCatalogPlan(parsed.searchParams.get("plan") || "");
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
    entityId: parsed.searchParams.get("entityId") || "",
    hint: parsed.searchParams.get("hint") || "",
    selector: parsed.searchParams.get("selector") || "",
    extractionPlan,
    bridgePlan,
    catalogPlan,
    page: parsed.searchParams.get("page") || "1",
    pageSize: parsed.searchParams.get("pageSize") || "",
    slice: parsed.searchParams.get("slice") === "1",
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
    version: config.version || "",
    commit: config.commit || "",
    status: "ok",
    usage: {
      ui: "/ui/",
      library: "/library/{id}.xbs",
      site: "/url/www.novel-site.example.xbs",
      siteRule: "识站订阅 = {本站}/url/ + 去掉 https:// 后的小说站主机（或主机/路径） + .xbs",
      source: "/source/www.yckceo.com/yuedu/shuyuans/json/id/1193.json.xbs",
      sourceRule: "阅读源订阅 = {本站}/source/ + 去掉 https:// 后的阅读源地址 + .xbs；大聚合源建议用 /ui/ 异步转换",
      sourceAlias: "/xbs/www.example.com/legado.json.xbs",
      easyQuery: "/x.xbs?u=https://www.example.com/legado.json",
      convert: "/convert.xbs?url=https://www.example.com/legado.json",
      json: "/j/www.example.com/legado.json",
      image: "/image/mwwz-aes?url=https://cdn.example.com/encrypted-image",
      media: "/media?url=https://cdn.example.com/chapter.mp3",
      health: "/healthz",
      jobs: "/api/jobs",
    },
    limits: {
      maxSourceBytes: config.maxSourceBytes,
      maxImageBytes: config.maxImageBytes,
      maxMediaBytes: config.maxMediaBytes,
      maxBridgeBookPageSize: config.maxBridgeBookPageSize,
      maxBridgeChapterPageSize: config.maxBridgeChapterPageSize,
      maxBridgeHtmlBytes: config.maxBridgeHtmlBytes,
      fetchTimeoutMs: config.fetchTimeoutMs,
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowDnsProxyNetworks: config.allowDnsProxyNetworks,
      preflightSources: config.preflightSources,
      preflightDeep: config.preflightDeep,
      preflightTimeoutMs: config.preflightTimeoutMs,
      verifyConvertedSources: config.verifyConvertedSources,
      analyzeFallback: config.analyzeFallback,
      verifyBudgetMs: config.verifyBudgetMs,
      verifyMaxSources: config.verifyMaxSources,
      jobConcurrency: config.jobConcurrency,
      adminConfigured: Boolean(config.adminToken),
      imageDecoders: supportedImageDecoders(),
    },
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, ...headers });
  response.end(body);
}

function readRequestBody(request, { maxBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function adminAuthorized(request, config) {
  const token = String(config.adminToken || "").trim();
  if (!token) return false;
  const header = String(request.headers.authorization || "");
  if (header === `Bearer ${token}`) return true;
  if (String(request.headers["x-admin-token"] || "") === token) return true;
  return false;
}

function requireAdmin(request, config) {
  if (!String(config.adminToken || "").trim()) {
    throw new HttpError(503, "未配置 ADMIN_TOKEN，管理接口不可用");
  }
  if (!adminAuthorized(request, config)) {
    throw new HttpError(401, "需要有效的管理口令");
  }
}

function contentTypeForPublic(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function servePublicFile(response, publicDir, relativePath, headers) {
  const safe = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safe);
  if (!filePath.startsWith(path.resolve(publicDir))) {
    throw new HttpError(403, "禁止访问");
  }
  let body;
  try {
    body = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "页面不存在");
    throw error;
  }
  response.writeHead(200, {
    ...headers,
    "Content-Type": contentTypeForPublic(filePath),
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  response.end(body);
}

function libraryIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/library\/([A-Za-z0-9_-]+)\.(xbs|json)$/i);
  if (!match) return null;
  return { id: match[1], format: match[2].toLowerCase() };
}

function jobIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(?:\/(retry))?$/);
  if (!match) return null;
  return { id: match[1], action: match[2] || "" };
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
    const chapters = orderChaptersAscending(jmAnchorEntries(match[2], baseUrl));
    if (chapters.length) return chapters;
  }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const className = htmlAttribute(match[1], "class") || "";
    if (!/(?:^|\s)reading(?:\s|$)/i.test(className)) continue;
    const chapters = orderChaptersAscending(jmAnchorEntries(match[0], baseUrl));
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

const IMAGE_SEQ_PARENT = /(?:images?|pages?|pics?|pictures?|photos?|slides?|gallery|list|items?|files?|data)$/i;
const IMAGE_ORDER_KEYS = ["page", "pageIndex", "pageNo", "pageNum", "pageNumber", "index", "order", "seq", "sort", "no", "num", "number"];

function imageObjectOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const name of IMAGE_ORDER_KEYS) {
    if (!Object.hasOwn(value, name)) continue;
    const number = Number(value[name]);
    if (Number.isFinite(number)) return number;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!/^(?:page|index|order|seq|sort|no|num|number)/i.test(key)) continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function pickObjectImageUrl(value, baseUrl, hints) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const preferred = [...hints, "pageSrc", "imageUrl", "image_url", "img", "src", "url", "uri", "path", "file"];
  for (const key of preferred) {
    if (!Object.hasOwn(value, key)) continue;
    const url = normalizedImageUrl(value[key], baseUrl);
    if (url) return url;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!/(?:url|uri|src|source|image|img|pic|picture|file|path)/i.test(key)) continue;
    const url = normalizedImageUrl(raw, baseUrl);
    if (url) return url;
  }
  return "";
}

/** Prefer the last digit run before the extension (page_10.jpg → 10, not a leading id). */
function imageFilenameNumber(pathname) {
  const file = String(pathname || "").split("/").pop() || "";
  const match = file.match(/(\d+)(?=\.[A-Za-z0-9]+$)/) || file.match(/(\d+)(?=[?#]|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * Only reorder when DOM/JSON appearance order is clearly out of sequence
 * (e.g. cover reused as page 1). Already ascending sequences stay untouched.
 */
function maybeReorderByFilename(urls) {
  if (!Array.isArray(urls) || urls.length < 2) return urls;
  const numbered = urls.map((value, index) => {
    try {
      return { value, index, number: imageFilenameNumber(new URL(value).pathname) };
    } catch {
      return { value, index, number: null };
    }
  });
  const withNums = numbered.filter((item) => Number.isFinite(item.number));
  if (withNums.length / numbered.length < 0.8) return urls;
  let decreases = 0;
  for (let i = 1; i < withNums.length; i += 1) {
    if (withNums[i].number < withNums[i - 1].number) decreases += 1;
  }
  if (!decreases) return urls;
  return numbered
    .slice()
    .sort((left, right) => (
      (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index
    ))
    .map((item) => item.value);
}

function propertyImageUrls(document, baseUrl, extractionPlan) {
  const plan = normalizeComicExtractionPlan(extractionPlan);
  const hints = new Set(plan.properties.map((value) => value.toLowerCase()));
  const groups = new Map();
  const sequences = [];
  const add = (keyValue, value, { sequenceKey = "" } = {}) => {
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
    const bucket = sequenceKey ? `${sequenceKey}::${key}` : key;
    const group = groups.get(bucket) || [];
    if (!group.includes(url)) group.push(url);
    groups.set(bucket, group);
  };

  const recordObjectArray = (items, parentKey) => {
    if (!Array.isArray(items) || items.length < 2) return false;
    if (!items.every((item) => item && typeof item === "object" && !Array.isArray(item))) return false;
    const ranked = items.map((item, index) => ({
      item,
      index,
      order: imageObjectOrder(item),
    }));
    const orderedCount = ranked.filter((entry) => Number.isFinite(entry.order)).length;
    if (orderedCount >= Math.ceil(ranked.length * 0.6)) {
      ranked.sort((left, right) => (
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ));
    }
    const urls = [];
    for (const entry of ranked) {
      const url = pickObjectImageUrl(entry.item, baseUrl, hints);
      if (url && !urls.includes(url)) urls.push(url);
    }
    if (urls.length < 2) return false;
    sequences.push({
      key: String(parentKey || "images").toLowerCase(),
      urls,
      fromArray: true,
    });
    return true;
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
  // Direct JSON APIs frequently use arrays of strings/objects. Prefer whole
  // array sequences (optionally sorted by page/index) over flat key merges.
  try {
    const parsed = JSON.parse(String(document || ""));
    const walk = (value, parentKey = "") => {
      if (Array.isArray(value)) {
        if (recordObjectArray(value, parentKey)) {
          // Still walk nested structures, but the array itself is the reading order.
          for (const item of value) {
            if (item && typeof item === "object") walk(item, parentKey);
          }
          return;
        }
        const stringUrls = [];
        for (const item of value) {
          if (typeof item === "string") {
            const url = normalizedImageUrl(item, baseUrl);
            if (url && !stringUrls.includes(url)) stringUrls.push(url);
          } else if (item && typeof item === "object") {
            walk(item, parentKey);
          }
        }
        if (stringUrls.length > 1 && (hints.has(String(parentKey || "").toLowerCase()) || IMAGE_SEQ_PARENT.test(parentKey))) {
          sequences.push({ key: String(parentKey || "images").toLowerCase(), urls: stringUrls, fromArray: true });
        } else {
          for (const url of stringUrls) add(parentKey, url, { sequenceKey: parentKey });
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
  const consider = (key, urls, { fromArray = false } = {}) => {
    if (!urls?.length) return;
    const explicit = [...hints].some((hint) => key === hint || key.endsWith(`::${hint}`));
    const imageLike = /(?:image|img|pic|picture|src|source|page)/i.test(key);
    const parentBoost = IMAGE_SEQ_PARENT.test(key.split("::")[0] || key) ? 50_000 : 0;
    const arrayBoost = fromArray ? 200_000 : 0;
    const score = (explicit ? 1_000_000 : 0) + arrayBoost + parentBoost + (imageLike ? 10_000 : 0) + urls.length;
    if (score > bestScore) {
      best = urls;
      bestScore = score;
    }
  };
  for (const sequence of sequences) consider(sequence.key, sequence.urls, { fromArray: true });
  for (const [key, urls] of groups) consider(key, urls);
  return maybeReorderByFilename(best);
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
  return maybeReorderByFilename(largest);
}

const PAGE_QUERY_KEYS = new Set([
  "page", "p", "pageindex", "pageidx", "pageno", "pagenum", "pagenumber",
]);

function normalizedPaginationKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function paginationNumber(object, names) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const wanted = new Set(names.map(normalizedPaginationKey));
  for (const [key, value] of Object.entries(object)) {
    if (!wanted.has(normalizedPaginationKey(key))) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return null;
}

function paginationMetadata(document, requestedPage) {
  let root;
  try {
    root = JSON.parse(String(document || ""));
  } catch {
    return null;
  }
  let best = null;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (!Array.isArray(value)) {
      const current = paginationNumber(value, ["current_page", "currentPage", "page", "pageIndex", "pageNo", "pageNum"]);
      const directPages = paginationNumber(value, ["total_pages", "totalPages", "page_count", "pageCount", "last_page", "lastPage"]);
      const total = paginationNumber(value, ["total", "total_count", "totalCount", "record_count", "recordCount"]);
      const pageSize = paginationNumber(value, ["page_size", "pageSize", "per_page", "perPage", "limit"]);
      const totalPages = directPages || (total !== null && pageSize ? Math.ceil(total / pageSize) : null);
      if (totalPages !== null && totalPages > 1) {
        const effectiveCurrent = current ?? requestedPage;
        if (effectiveCurrent !== null && effectiveCurrent >= 0 && totalPages > effectiveCurrent) {
          const score = (directPages ? 8 : 4)
            + (current !== null ? 2 : 0)
            + (current === requestedPage ? 4 : 0)
            + (total !== null && pageSize ? 1 : 0);
          if (!best || score > best.score) best = { current: effectiveCurrent, totalPages, score };
        }
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(root);
  return best;
}

/**
 * Discover subsequent JSON comic API pages from conventional pagination
 * metadata. Only an existing page-like query parameter is changed, so data
 * returned by an untrusted source cannot redirect the adapter to another host.
 */
export function comicPageUrls(page, requestUrl, maxPages = 50) {
  let parsed;
  try {
    parsed = new URL(String(requestUrl || ""));
  } catch {
    return [];
  }
  let pageKey = "";
  let requestedPage = null;
  for (const [key, value] of parsed.searchParams) {
    if (!PAGE_QUERY_KEYS.has(normalizedPaginationKey(key))) continue;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) continue;
    pageKey = key;
    requestedPage = number;
    break;
  }
  if (!pageKey) return [];
  const metadata = paginationMetadata(page, requestedPage);
  if (!metadata) return [];
  const pageLimit = Math.max(1, Number.parseInt(maxPages, 10) || 50);
  const lastPage = Math.min(metadata.totalPages, metadata.current + pageLimit - 1);
  const urls = [];
  for (let value = metadata.current + 1; value <= lastPage; value += 1) {
    const next = new URL(parsed);
    next.searchParams.set(pageKey, String(value));
    urls.push(next.toString());
  }
  return urls;
}

async function downloadComicImageSequence(sourceUrl, config, extractionPlan) {
  if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(sourceUrl)) return [sourceUrl];
  const maxPages = Number.isInteger(config.maxComicPages) ? config.maxComicPages : 50;
  const maxImages = Number.isInteger(config.maxComicImages) ? config.maxComicImages : 2_000;
  const concurrency = Number.isInteger(config.comicPageConcurrency) ? config.comicPageConcurrency : 4;
  const firstPage = await downloadSource(sourceUrl, config, extractionPlan?.headers);
  const firstText = firstPage.toString("utf8");
  const firstImages = pageImageUrls(firstText, sourceUrl, extractionPlan);
  const followingPages = comicPageUrls(firstText, sourceUrl, maxPages);
  if (!followingPages.length) return firstImages.slice(0, maxImages);

  const pageResults = Array.from({ length: followingPages.length }, () => []);
  let cursor = 0;
  const workerCount = Math.min(concurrency, followingPages.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < followingPages.length) {
      const index = cursor;
      cursor += 1;
      const pageUrl = followingPages[index];
      try {
        const body = await downloadSource(pageUrl, config, extractionPlan?.headers);
        pageResults[index] = pageImageUrls(body.toString("utf8"), pageUrl, extractionPlan);
      } catch {
        // Preserve all successfully decoded pages. A transient later-page error
        // should not make an otherwise readable chapter completely unavailable.
      }
    }
  });
  await Promise.all(workers);
  const seen = new Set();
  const images = [];
  for (const url of [firstImages, ...pageResults].flat()) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push(url);
    if (images.length >= maxImages) break;
  }
  return images;
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
  const urlHints = (plan.urlHints || []).map((value) => String(value || "").toLowerCase()).filter(Boolean);
  const matchesUrlHint = (url) => urlHints.some((hint) => String(url).toLowerCase().includes(hint));
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
    const hintMatch = matchesUrlHint(url);
    const score = (extension ? 1_000_000 : 0) + (hintMatch ? 500_000 : 0) + (hints.has(key) ? 100_000 : 0)
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
    // sourceRegex-derived extension hints (e.g. ".mp3") promote matching URLs
    // even when they sit outside semantic JSON keys. Skip bare page links: the
    // synthetic key "media" is semantic and must not make every href playable.
    const candidate = match[0];
    const hintMatch = urlHints.length > 0 && matchesUrlHint(candidate);
    if (!mediaExtensionPattern(kind).test(candidate) && !hintMatch) continue;
    add("media", candidate, hintMatch);
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

function conversionCacheExpiry(config) {
  return config.cacheTtlMs > 0 ? Date.now() + config.cacheTtlMs : 0;
}

function conversionCacheExpired(item) {
  return Boolean(item?.expiresAt) && item.expiresAt <= Date.now();
}

export function createAppServer(options = {}) {
  const config = { ...serverConfig(), ...(options.config ?? {}) };
  const cache = new Map();
  const pendingConversions = new Map();
  let active = 0;
  const publicDir = path.resolve(config.publicDir || DEFAULT_PUBLIC_DIR);
  const store = options.store || createLibraryStore(config.dataDir);
  const convertRemoteSource = options.convertOnlineSource || convertOnlineSource;
  const worker = options.worker || createJobWorker({
    store,
    config,
    concurrency: config.jobConcurrency,
    downloadSource,
  });
  if (options.recoverJobs === true) {
    void store.ensure().then(() => worker.recover()).catch((error) => {
      process.stderr.write(`library recover failed: ${error.message}\n`);
    });
  }

  const server = createServer(async (request, response) => {
    const commonHeaders = {
      "Access-Control-Allow-Origin": config.corsOrigin,
      "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,If-None-Match,Authorization,X-Admin-Token",
      "X-Content-Type-Options": "nosniff",
    };
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, commonHeaders);
        response.end();
        return;
      }
      const method = request.method || "GET";
      const allowed = new Set(["GET", "HEAD", "POST", "DELETE"]);
      if (!allowed.has(method)) throw new HttpError(405, "仅支持 GET、HEAD、POST、DELETE 和 OPTIONS");
      const pathname = new URL(request.url || "/", "http://read2xsgg.local").pathname;
      if (pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" }, commonHeaders);
        return;
      }

      if (pathname === "/ui" || pathname === "/ui/") {
        await servePublicFile(response, publicDir, "index.html", commonHeaders);
        return;
      }
      if (pathname.startsWith("/ui/")) {
        const rel = pathname.slice("/ui/".length) || "index.html";
        await servePublicFile(response, publicDir, rel, commonHeaders);
        return;
      }

      const libraryTarget = libraryIdFromPath(pathname);
      if (libraryTarget) {
        if (!["GET", "HEAD"].includes(method)) throw new HttpError(405, "订阅地址仅支持 GET/HEAD");
        const job = await store.getJob(libraryTarget.id);
        if (!job) throw new HttpError(404, "书库条目不存在");
        if (job.status !== "done") throw new HttpError(409, `转换尚未完成（${job.status}）`);
        const body = await store.readArtifact(libraryTarget.id, libraryTarget.format === "json" ? "json" : "xbs");
        if (!body) throw new HttpError(404, "制品不存在");
        if (libraryTarget.format === "json") {
          response.writeHead(200, {
            ...commonHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "public, max-age=60",
            "X-Converted-Count": String(job.count || 0),
          });
          if (method === "HEAD") response.end();
          else response.end(body);
          return;
        }
        response.writeHead(200, {
          ...commonHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="library-${libraryTarget.id}.xbs"`,
          "Content-Length": body.length,
          "Cache-Control": "public, max-age=60",
          "X-Converted-Count": String(job.count || 0),
        });
        if (method === "HEAD") response.end();
        else response.end(body);
        return;
      }

      if (pathname === "/api/jobs" || pathname.startsWith("/api/jobs/")) {
        requireAdmin(request, config);
        if (pathname === "/api/jobs") {
          if (method === "GET" || method === "HEAD") {
            const jobs = await store.listJobs();
            sendJson(response, 200, { jobs }, commonHeaders);
            return;
          }
          if (method === "POST") {
            const raw = await readRequestBody(request);
            let body = {};
            try {
              body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
            } catch {
              throw new HttpError(400, "请求体必须是 JSON");
            }
            const url = String(body.url || body.u || "").trim();
            if (!url) throw new HttpError(400, "缺少 url");
            let normalized;
            try {
              normalized = normalizeRemoteUrl(url);
            } catch (error) {
              throw new HttpError(400, error.message || "url 无效");
            }
            const mode = body.mode === "site" ? "site" : "source";
            const job = await store.createJob({
              url: normalized,
              mode,
              name: body.name || "",
              imageProxyBase: publicBaseUrl(request),
            });
            worker.enqueue(job.id);
            void worker.syncQueued?.();
            sendJson(response, 202, job, commonHeaders);
            return;
          }
          throw new HttpError(405, "不支持的方法");
        }

        const jobRoute = jobIdFromPath(pathname);
        if (!jobRoute) throw new HttpError(404, "任务不存在");
        if (jobRoute.action === "retry") {
          if (method !== "POST") throw new HttpError(405, "重试仅支持 POST");
          const job = await store.getJob(jobRoute.id);
          if (!job) throw new HttpError(404, "任务不存在");
          const next = await store.updateJob(jobRoute.id, {
            status: "queued",
            phase: "queued",
            error: "",
            finishedAt: null,
            startedAt: null,
            count: null,
            fallbackCount: 0,
            skippedBuckets: {},
            progress: { done: 0, total: 0, kept: 0, skipped: 0, unverified: 0, fallback: 0, failed: 0 },
          });
          worker.cancel?.(jobRoute.id);
          worker.enqueue(jobRoute.id);
          sendJson(response, 202, next, commonHeaders);
          return;
        }
        if (method === "GET" || method === "HEAD") {
          const job = await store.getJob(jobRoute.id);
          if (!job) throw new HttpError(404, "任务不存在");
          sendJson(response, 200, job, commonHeaders);
          return;
        }
        if (method === "DELETE") {
          const job = await store.getJob(jobRoute.id);
          if (!job) throw new HttpError(404, "任务不存在");
          worker.cancel?.(jobRoute.id);
          await store.deleteJob(jobRoute.id);
          void worker.syncQueued?.();
          sendJson(response, 200, { ok: true, id: jobRoute.id }, commonHeaders);
          return;
        }
        throw new HttpError(405, "不支持的方法");
      }

      if (!["GET", "HEAD"].includes(method)) throw new HttpError(405, "该路径仅支持 GET、HEAD 和 OPTIONS");

      const adapterTarget = adapterRequestFromRequest(request);
      if (adapterTarget) {
        if (adapterTarget.type === "catalog") {
          if (!adapterTarget.catalogPlan) throw new HttpError(400, "缺少分类目录计划");
          if (!adapterTarget.entityId) throw new HttpError(400, "缺少 entityId");
          if (active >= config.maxConcurrent) throw new HttpError(429, "当前章节解析任务过多，请稍后重试");
          active += 1;
          try {
            const download = createSourceDownloader(config);
            const output = await executeCatalogPlan(adapterTarget.catalogPlan, {
              entityId: adapterTarget.entityId,
              pageIndex: adapterTarget.page,
              pageSize: adapterTarget.pageSize || adapterTarget.catalogPlan.pageSize || 20,
              download,
            });
            sendJson(response, 200, output, commonHeaders);
          } finally {
            active -= 1;
          }
          return;
        }
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
            const charset = adapterTarget.bridgePlan.charset || "";
            const htmlBudget = config.maxBridgeHtmlBytes;
            const paging = bridgePageOptions(adapterTarget, config);
            const htmlCacheKey = `bridge-html:${adapterTarget.type}:${pageUrl}:${charset}:${adapterTarget.bridgePlan?.list || ""}`;
            let html = "";
            const cachedHtml = config.cacheTtlMs > 0 ? cache.get(htmlCacheKey) : null;
            if (cachedHtml && cachedHtml.expiresAt > Date.now()) {
              html = cachedHtml.value;
            } else {
              if (cachedHtml) cache.delete(htmlCacheKey);
              const page = await downloadSource(pageUrl, config, adapterTarget.bridgePlan.headers);
              html = prepareBridgeHtml(page, charset, htmlBudget);
              cacheSet(cache, htmlCacheKey, html, config);
            }
            if (adapterTarget.type === "bridge-chapters" && adapterTarget.bridgePlan.tocSelector) {
              const tocUrl = bridgeTocUrl(html, pageUrl, adapterTarget.bridgePlan);
              if (tocUrl) {
                try {
                  const tocPageUrl = normalizeRemoteUrl(tocUrl);
                  const tocCacheKey = `bridge-html:${adapterTarget.type}:toc:${tocPageUrl}:${charset}`;
                  let tocHtml = "";
                  const cachedToc = config.cacheTtlMs > 0 ? cache.get(tocCacheKey) : null;
                  if (cachedToc && cachedToc.expiresAt > Date.now()) {
                    tocHtml = cachedToc.value;
                  } else {
                    if (cachedToc) cache.delete(tocCacheKey);
                    const tocPage = await downloadSource(tocPageUrl, config, adapterTarget.bridgePlan.headers);
                    tocHtml = prepareBridgeHtml(tocPage, charset, htmlBudget);
                    cacheSet(cache, tocCacheKey, tocHtml, config);
                  }
                  const tocOutput = executeBridgePlan(
                    tocHtml,
                    tocPageUrl,
                    adapterTarget.bridgePlan,
                    paging,
                  );
                  if (Array.isArray(tocOutput.data) && tocOutput.data.length) output = tocOutput;
                } catch {
                  // A number of Legado sources keep a stale or optional tocUrl
                  // while their chapter list still exists on the detail page.
                  // Fall through and parse the detail response with the same rule.
                }
              }
            }
            if (!output) {
              output = executeBridgePlan(html, pageUrl, adapterTarget.bridgePlan, paging);
            }
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
            const download = createSourceDownloader(config);
            const headers = adapterTarget.extractionPlan?.headers || {};
            values = await resolveChapterMediaUrls(
              async () => (await download(sourceUrl, headers)).toString("utf8"),
              sourceUrl,
              adapterTarget.extractionPlan,
              download,
              pageMediaUrls,
            );
          } else if (adapterTarget.type === "page-images") {
            values = await downloadComicImageSequence(sourceUrl, config, adapterTarget.extractionPlan);
            if (!values?.length) {
              const detailPage = await downloadSource(sourceUrl, config, adapterTarget.extractionPlan?.headers);
              values = pageImageUrls(detailPage.toString("utf8"), sourceUrl, adapterTarget.extractionPlan);
            }
          } else {
            const detailPage = await downloadSource(sourceUrl, config, adapterTarget.extractionPlan?.headers);
            const html = detailPage.toString("utf8");
            values = adapterTarget.type === "jm-chapters"
              ? jmChapterEntries(html, sourceUrl)
              : pageImageUrls(html, sourceUrl, adapterTarget.extractionPlan);
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
      const mediaTarget = mediaProxyRequestFromRequest(request);
      if (mediaTarget) {
        if (!mediaTarget.mediaUrl) throw new HttpError(400, "缺少媒体 URL");
        if (active >= config.maxConcurrent) throw new HttpError(429, "当前媒体处理任务过多，请稍后重试");
        active += 1;
        let media;
        try {
          media = await downloadMedia(mediaTarget.mediaUrl, config);
        } finally {
          active -= 1;
        }
        response.writeHead(200, {
          ...commonHeaders,
          "Content-Type": media.mimeType,
          "Content-Length": media.buffer.length,
          "Cache-Control": "public, max-age=3600",
        });
        if (request.method === "HEAD") response.end();
        else response.end(media.buffer);
        return;
      }
      const target = requestTargetFromRequest(request);
      if (!target) {
        sendJson(response, pathname === "/" ? 200 : 404, help(config), commonHeaders);
        return;
      }

      // Direct site URL → auto analyze → Xiangse source (direction 1).
      if (target.mode === "site") {
        if (!target.siteUrl) throw new HttpError(400, "缺少网站 URL");
        if (active >= config.maxConcurrent) throw new HttpError(429, "当前分析任务过多，请稍后重试");
        active += 1;
        let analyzed;
        try {
          const download = (targetUrl, headers = {}) => downloadSource(
            targetUrl,
            { ...config, fetchTimeoutMs: config.analyzeTimeoutMs },
            headers,
          );
          analyzed = await analyzeSite(target.siteUrl, {
            download,
            timeoutMs: config.analyzeTimeoutMs,
          });
        } finally {
          active -= 1;
        }
        if (!analyzed.ok) throw new HttpError(422, analyzed.reason || "自动识站失败");
        const sources = analyzed.sources || { [analyzed.source.sourceName]: analyzed.source };
        const count = Object.keys(sources).length;
        const json = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`, "utf8");
        const xbs = encodeXbs(json);
        const headers = {
          ...commonHeaders,
          "X-Converted-Count": String(count),
          "X-Fallback-Count": String(count),
          "X-Analyze-Kind": (analyzed.kinds || [analyzed.kind]).filter(Boolean).join(",") || "text",
        };
        if (target.format === "json") {
          sendJson(response, 200, {
            sources,
            kind: analyzed.kind,
            kinds: analyzed.kinds || [analyzed.kind],
            confidence: analyzed.confidence,
            discovery: analyzed.discovery,
            skippedKinds: analyzed.skippedKinds || [],
            warnings: analyzed.warnings || (analyzed.warning ? [analyzed.warning] : []),
          }, headers);
          return;
        }
        response.writeHead(200, {
          ...headers,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="analyzed.xbs"',
          "Content-Length": xbs.length,
        });
        if (request.method === "HEAD") response.end();
        else response.end(xbs);
        return;
      }

      if (!target.sourceUrl) throw new HttpError(400, "缺少在线阅读源 URL");

      // The conversion may embed this server's public image-proxy URL in a
      // recognised comic rule, so do not share it across distinct public hosts.
      const cacheKey = `${target.sourceUrl}\n${publicBaseUrl(request)}`;
      let converted = cache.get(cacheKey);
      if (converted && conversionCacheExpired(converted)) {
        cache.delete(cacheKey);
        converted = undefined;
      }
      if (converted) converted = converted.value;
      else {
        const persisted = await store.readConversion?.(cacheKey);
        if (persisted && !conversionCacheExpired(persisted)) {
          converted = persisted;
          cacheSet(cache, cacheKey, converted, config);
        }
        if (!converted) {
          let pending = pendingConversions.get(cacheKey);
          if (!pending) {
            if (active >= config.maxConcurrent) throw new HttpError(429, "当前转换任务过多，请稍后重试");
            active += 1;
            pending = convertRemoteSource(target.sourceUrl, config, publicBaseUrl(request))
              .then(async (result) => {
                await store.saveConversion?.(cacheKey, result, { expiresAt: conversionCacheExpiry(config) });
                cacheSet(cache, cacheKey, result, config);
                return result;
              })
              .finally(() => {
                active -= 1;
                pendingConversions.delete(cacheKey);
              });
            pendingConversions.set(cacheKey, pending);
          }
          converted = await pending;
        }
      }

      const headers = {
        ...commonHeaders,
        ETag: converted.etag,
        "Cache-Control": `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
        "X-Converted-Count": String(converted.count),
        "X-Skipped-Count": String(converted.skipped?.length || 0),
        "X-Skipped-Buckets": JSON.stringify(converted.skippedBuckets || {}),
        "X-Fallback-Count": String(converted.fallbackCount || 0),
        "X-Warning-Count": String(converted.warnings.length),
      };
      if (request.headers["if-none-match"] === converted.etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      if (target.format === "json") {
        sendJson(response, 200, {
          sources: converted.sources,
          warnings: converted.warnings,
          skipped: converted.skipped || [],
          skippedBuckets: converted.skippedBuckets || {},
          fallbackCount: converted.fallbackCount || 0,
        }, headers);
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

  server.libraryStore = store;
  server.jobWorker = worker;
  return server;
}

export function startServer(config = serverConfig()) {
  const server = createAppServer({ config, recoverJobs: true });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`read2xsgg listening on http://${config.host}:${config.port}\n`);
    process.stdout.write(`webui: http://${config.host}:${config.port}/ui/\n`);
  });
  return server;
}
