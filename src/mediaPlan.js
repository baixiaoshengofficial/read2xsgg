import { responseText } from "./httpTransport.js";

const MAX_HINTS = 16;
const MAX_EXTRACTS = 16;
const MAX_PLAN_CHARS = 24_576;
const SAFE_NAME = /^[A-Za-z_$][\w$-]{0,63}$/;
const MEDIA_PROPERTY = /(?:url|uri|src|source|audio|sound|voice|track|play|video|media|stream|hls|m3u8|file|path)/i;
const MEDIA_ATTRIBUTE = /(?:src|source|url|file|stream|play|href|data)/i;
const BLOCKED_HEADERS = /^(?:host|content-length|transfer-encoding|connection|te|trailer|upgrade|proxy-|sec-websocket-)/i;
const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z_$][\w$-]{0,63})\s*\}\}/g;

function mediaKind(value) {
  return String(value || "").toLowerCase() === "video" ? "video" : "audio";
}

function uniqueNames(values, matcher) {
  const result = [];
  for (const value of values) {
    const name = String(value || "").trim();
    if (!SAFE_NAME.test(name) || !matcher.test(name) || result.includes(name)) continue;
    result.push(name);
    if (result.length >= MAX_HINTS) break;
  }
  return result;
}

function safeHeaders(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName || "").trim();
    const headerValue = String(rawValue ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || BLOCKED_HEADERS.test(name)) continue;
    if (!headerValue || headerValue.length > 2_048) continue;
    result[name] = headerValue;
    if (Object.keys(result).length >= 16) break;
  }
  return result;
}

function safeRegexPattern(value) {
  const pattern = String(value || "");
  if (!pattern || pattern.length > 256) return "";
  if (/\((?:[^()]|\\.)*(?:\||[+*?{])(?:[^()]|\\.)*\)[+*?{]/.test(pattern)) return "";
  try { new RegExp(pattern); } catch { return ""; }
  return pattern;
}

function safeTemplate(value) {
  const text = String(value ?? "");
  if (!text || text.length > 2_048) return "";
  if (/[<>\r\n]/.test(text)) return "";
  return text;
}

function compileExtractionHints(rule, kind, headers, sourceRegex) {
  const source = String(rule || "");
  const properties = [];
  const attributes = [];
  const objectSource = source.replace(/(?:^|[@.])(?:tag|class|id|text)\.[A-Za-z_$][\w$-]*/gi, "");

  for (const match of objectSource.matchAll(/(?:\.|\[['"])([A-Za-z_$][\w$-]{0,63})(?:['"]\])?/g)) {
    if (MEDIA_PROPERTY.test(match[1])) properties.push(match[1]);
  }
  for (const match of source.matchAll(/[\\]*["']([A-Za-z_$][\w$-]{0,63})[\\]*["']\s*:[\\]*["']/g)) {
    if (MEDIA_PROPERTY.test(match[1])) properties.push(match[1]);
  }
  for (const match of source.matchAll(/@([A-Za-z_$][\w$-]{0,63})/g)) {
    if (MEDIA_ATTRIBUTE.test(match[1])) attributes.push(match[1]);
  }
  for (const match of source.matchAll(/(?:attr|getAttribute|getString)\s*\(\s*["'](?:[^"']*@)?([A-Za-z_$][\w$-]{0,63})["']/g)) {
    if (MEDIA_ATTRIBUTE.test(match[1])) attributes.push(match[1]);
  }

  const urlHints = [];
  for (const match of String(sourceRegex || "").matchAll(/\.(?:mp3|m4a|aac|flac|ogg|opus|wav|mp4|m4v|webm|mkv|m3u8|ts)(?:\b|(?=[^a-z0-9]))/gi)) {
    const hint = match[0].toLowerCase();
    if (!urlHints.includes(hint)) urlHints.push(hint);
    if (urlHints.length >= MAX_HINTS) break;
  }

  const normalizedHeaders = safeHeaders(headers);
  return {
    version: 1,
    kind: mediaKind(kind),
    properties: uniqueNames(properties, MEDIA_PROPERTY),
    attributes: uniqueNames(attributes, MEDIA_ATTRIBUTE),
    urlHints: urlHints.slice(0, MAX_HINTS),
    ...(Object.keys(normalizedHeaders).length ? { headers: normalizedHeaders } : {}),
  };
}

function normalizeExtractStep(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = String(raw.name || "").trim();
  if (!SAFE_NAME.test(name)) return null;
  const source = String(raw.source || "").trim().toLowerCase();
  if (source === "meta") {
    const key = String(raw.key || "").trim();
    if (!key || key.length > 64 || /[<>\r\n"']/.test(key)) return null;
    const step = { name, source: "meta", key };
    if (raw.default !== undefined) {
      const fallback = String(raw.default).slice(0, 256);
      if (fallback) step.default = fallback;
    }
    return step;
  }
  if (source === "url" || source === "html") {
    const pattern = safeRegexPattern(raw.pattern);
    const group = Number(raw.group);
    if (!pattern || !Number.isInteger(group) || group < 1 || group > 16) return null;
    const step = { name, source, pattern, group };
    if (raw.default !== undefined) {
      const fallback = String(raw.default).slice(0, 256);
      if (fallback) step.default = fallback;
    }
    return step;
  }
  if (source === "constant") {
    const value = String(raw.value ?? "").slice(0, 256);
    if (!value) return null;
    return { name, source: "constant", value };
  }
  return null;
}

function normalizeResolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const extract = [];
  for (const item of Array.isArray(value.extract) ? value.extract : []) {
    const step = normalizeExtractStep(item);
    if (!step || extract.some((entry) => entry.name === step.name)) continue;
    extract.push(step);
    if (extract.length >= MAX_EXTRACTS) break;
  }
  const requestRaw = value.request && typeof value.request === "object" ? value.request : null;
  const url = safeTemplate(requestRaw?.url);
  if (!url || !extract.length) return null;
  const method = String(requestRaw?.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const headers = {};
  if (requestRaw?.headers && typeof requestRaw.headers === "object" && !Array.isArray(requestRaw.headers)) {
    for (const [rawName, rawValue] of Object.entries(requestRaw.headers)) {
      const name = String(rawName || "").trim();
      const headerValue = safeTemplate(rawValue);
      if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || BLOCKED_HEADERS.test(name)) continue;
      if (!headerValue) continue;
      headers[name] = headerValue;
      if (Object.keys(headers).length >= 16) break;
    }
  }
  const body = requestRaw?.body === undefined || requestRaw?.body === null
    ? ""
    : safeTemplate(requestRaw.body);
  const responseProps = [];
  const responseRaw = value.response && typeof value.response === "object" ? value.response : {};
  for (const prop of Array.isArray(responseRaw.properties) ? responseRaw.properties : []) {
    const name = String(prop || "").trim();
    if (!SAFE_NAME.test(name) || responseProps.includes(name)) continue;
    responseProps.push(name);
    if (responseProps.length >= MAX_HINTS) break;
  }
  if (!responseProps.length) responseProps.push("url");
  return {
    extract,
    request: {
      url,
      method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body ? { body } : {}),
    },
    response: { properties: responseProps },
  };
}

/**
 * Compile a safe multi-step MediaResolutionPlan fragment from a Legado content
 * rule when the workflow is clearly declarative-enough:
 *   chapter values → follow-up java.ajax request → JSON URL property.
 * Returns null when the rule is not safely recognizable (no heuristics).
 */
export function compileMediaResolutionFromRule(rule) {
  const source = String(rule || "").trim();
  if (!source || source.length > 12_000) return null;

  const extract = [];
  let js = "";

  const metaPrefix = source.match(
    /^(?:meta)?\[\s*name\s*=\s*["']?([^"'\]]+)["']?\s*\]\s*@content\s*@js:\s*/i,
  );
  if (metaPrefix) {
    extract.push({ name: "result", source: "meta", key: metaPrefix[1] });
    js = source.slice(metaPrefix[0].length);
  } else {
    const wrapped = source.match(/^(?:@js:|<js>)\s*([\s\S]*?)\s*(?:<\/js>)?\s*$/i);
    if (!wrapped) return null;
    js = wrapped[1];
  }
  if (!/java\.ajax\s*\(/i.test(js)) return null;
  // Reject rules that need crypto, eval, or Android packages — not portable.
  if (/\b(?:eval|Function|Packages|javax\.|java\.lang|hexDecode|digest|encrypt|decrypt)\b/i.test(js)) {
    return null;
  }

  const bodyReplace = js.match(
    /baseUrl\.replace\(\s*\/((?:\\.|[^/])+)\/([a-z]*)\s*,\s*(["'])([\s\S]*?)\3\s*\)/i,
  );
  let bodyTemplate = "";
  if (bodyReplace) {
    const pattern = safeRegexPattern(bodyReplace[1]);
    if (!pattern) return null;
    const replacement = String(bodyReplace[4] || "");
    const groupNames = new Map();
    for (const match of replacement.matchAll(/\$(\d{1,2})/g)) {
      const group = Number(match[1]);
      if (!Number.isInteger(group) || group < 1 || group > 16) continue;
      if (!groupNames.has(group)) {
        const name = `g${group}`;
        groupNames.set(group, name);
        extract.push({ name, source: "url", pattern, group });
      }
    }
    bodyTemplate = replacement.replace(/\$(\d{1,2})/g, (_, group) => {
      const name = groupNames.get(Number(group));
      return name ? `{{${name}}}` : "";
    });
    if (!safeTemplate(bodyTemplate)) return null;
  } else {
    const literalBody = js.match(/\bbody\s*:\s*(["'])([\s\S]*?)\1/i);
    if (literalBody) {
      bodyTemplate = safeTemplate(literalBody[2].replace(/\$\{result\}/g, "{{result}}"));
      if (!bodyTemplate && literalBody[2]) return null;
    }
  }

  const ajaxUrlMatch = js.match(/(?:var|let|const)\s+url\s*=\s*(["'])([^"']+?),?\1\s*;/i)
    || js.match(/java\.ajax\(\s*(["'`])([^"'`]+?),/);
  if (!ajaxUrlMatch) return null;
  let ajaxUrl = String(ajaxUrlMatch[2] || "").replace(/,\s*$/, "").trim();
  if (!ajaxUrl || ajaxUrl.length > 2_048) return null;
  // Prefer same-origin relative form so mirrors/fixtures stay portable.
  try {
    if (/^https?:\/\//i.test(ajaxUrl)) {
      const parsed = new URL(ajaxUrl);
      ajaxUrl = `{{origin}}${parsed.pathname}${parsed.search}`;
    } else if (ajaxUrl.startsWith("/")) {
      ajaxUrl = `{{origin}}${ajaxUrl}`;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const headerBlock = js.match(/(?:var|let|const)\s+headers\s*=\s*\{([\s\S]*?)\}\s*;/i);
  const headers = {};
  if (headerBlock) {
    for (const match of headerBlock[1].matchAll(
      /(["']?)([!#$%&'*+.^_`|~0-9A-Za-z-]+)\1\s*:\s*(?:(["'])([\s\S]*?)\3|(result|baseUrl))\s*,?/gi,
    )) {
      const name = match[2];
      if (BLOCKED_HEADERS.test(name)) continue;
      let value;
      if (match[4] !== undefined) value = match[4];
      else if (/^result$/i.test(match[5] || "")) value = "{{result}}";
      else if (/^baseUrl$/i.test(match[5] || "")) value = "{{chapterUrl}}";
      else continue;
      const safe = safeTemplate(value);
      if (!safe) continue;
      headers[name] = safe;
      if (Object.keys(headers).length >= 16) break;
    }
  }

  const method = /\bmethod\s*:\s*["']post["']/i.test(js) ? "POST" : "GET";
  const responseProp = js.match(
    /JSON\.parse\s*\(\s*java\.ajax\s*\([\s\S]*?\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/i,
  )?.[1]
    || js.match(/java\.getString\s*\(\s*["']\$\.([A-Za-z_$][\w$]*)["']/i)?.[1];
  if (!responseProp || !SAFE_NAME.test(responseProp)) return null;
  if (!extract.length) return null;

  return normalizeResolution({
    extract,
    request: {
      url: ajaxUrl,
      method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(bodyTemplate ? { body: bodyTemplate } : {}),
    },
    response: { properties: [responseProp] },
  });
}

/**
 * Compile safe, declarative hints from a Legado audio/video content rule.
 * When the rule contains a safely recognizable multi-step protected-media
 * workflow, attach a `resolution` block (MediaResolutionPlan). Executable
 * JavaScript is never copied into the plan.
 */
export function compileMediaExtractionPlan(rule, kind = "audio", headers = {}, { sourceRegex = "", resolution = null } = {}) {
  const plan = compileExtractionHints(rule, kind, headers, sourceRegex);
  const fromRule = compileMediaResolutionFromRule(rule);
  const explicit = normalizeResolution(resolution);
  if (explicit) plan.resolution = explicit;
  else if (fromRule) plan.resolution = fromRule;
  return plan;
}

/** True when a compiled plan can execute a follow-up media request. */
export function mediaPlanHasResolution(plan) {
  return Boolean(normalizeResolution(plan?.resolution));
}

/**
 * Sources that only rely on Legado WebView + sourceRegex (or trivial
 * `<js>result</js>`), or that contain a multi-step script we could not safely
 * compile, do not describe a portable MediaResolutionPlan. Portable selectors
 * such as `audio@src` with sourceRegex hints are not warned.
 */
export function mediaRuleNeedsPortabilityWarning(contentRule = {}, tocRule = {}, plan = null) {
  if (mediaPlanHasResolution(plan)) return false;
  if (contentRule?.mediaResolution || contentRule?.read2xsgg?.mediaResolution) return false;
  const content = String(contentRule.content || "").trim();
  const sourceRegex = String(contentRule.sourceRegex || "").trim();
  const chapterUrl = String(tocRule.chapterUrl || "");
  const usesWebView = /\bwebView\b/i.test(chapterUrl) || /\bwebView\b/i.test(content);
  const trivialContent = !content
    || /^<?\/?js>?[\s;]*result[\s;]*(?:<\/js>)?$/i.test(content)
    || /^<js>\s*result\s*<\/js>$/i.test(content);
  const opaqueJs = /(?:@js:|<js>)/i.test(content)
    && /(?:\bjava\.|\bPackages\b|\bandroid\.)/i.test(content);
  // java.ajax that failed compilation must not invent a private follow-up API.
  if (opaqueJs && /java\.ajax\s*\(/i.test(content)) return true;
  // Warn when playback clearly depends on an undescribed interceptor path.
  if (!(sourceRegex || usesWebView)) return false;
  return trivialContent || opaqueJs || usesWebView;
}

export const MEDIA_PORTABILITY_WARNING = "正文依赖阅读 WebView/sourceRegex（或不可识别的 Android 脚本）拦截播放流，规则中没有可安全编译的多步媒体流程（页面取值 → 二次请求 → 解析 URL）；已保留通用 HTML/JSON/媒体回退，但受保护播放地址无法从当前规则还原。请用包含该流程的原始阅读源重新转换";

export function normalizeMediaExtractionPlan(value, kind = "audio") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, kind: mediaKind(kind), properties: [], attributes: [], urlHints: [] };
  }
  const headers = safeHeaders(value.headers);
  const urlHints = [];
  for (const hint of Array.isArray(value.urlHints) ? value.urlHints : []) {
    const text = String(hint || "").trim().toLowerCase();
    if (!/^\.[a-z0-9]{2,8}$/.test(text) || urlHints.includes(text)) continue;
    urlHints.push(text);
    if (urlHints.length >= MAX_HINTS) break;
  }
  const plan = {
    version: 1,
    kind: mediaKind(value.kind || kind),
    properties: uniqueNames(Array.isArray(value.properties) ? value.properties : [], MEDIA_PROPERTY),
    attributes: uniqueNames(Array.isArray(value.attributes) ? value.attributes : [], MEDIA_ATTRIBUTE),
    urlHints,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  const resolution = normalizeResolution(value.resolution);
  if (resolution) plan.resolution = resolution;
  return plan;
}

export function encodeMediaExtractionPlan(plan) {
  const normalized = normalizeMediaExtractionPlan(plan, plan?.kind);
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  if (encoded.length > MAX_PLAN_CHARS) throw new TypeError("媒体解析计划过大");
  return encoded;
}

export function decodeMediaExtractionPlan(value, kind = "audio") {
  const encoded = String(value || "");
  if (!encoded) return normalizeMediaExtractionPlan(null, kind);
  if (encoded.length > MAX_PLAN_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("媒体提取计划编码无效");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("媒体提取计划不是有效 JSON");
  }
  return normalizeMediaExtractionPlan(parsed, kind);
}

function metaContent(html, name) {
  const source = String(html || "");
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+[^>]*\\bname=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["']`, "i"),
    new RegExp(`<meta\\s+[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bname=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return "";
}

function interpolate(template, vars) {
  return String(template || "").replace(TEMPLATE_TOKEN, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return "";
    return String(vars[name] ?? "");
  });
}

function collectExtractVars(html, chapterUrl, extract) {
  const vars = {
    chapterUrl: String(chapterUrl || ""),
    baseUrl: String(chapterUrl || ""),
    origin: "",
  };
  try {
    vars.origin = new URL(chapterUrl).origin;
  } catch {
    vars.origin = "";
  }
  for (const step of extract) {
    let value = "";
    if (step.source === "constant") value = step.value;
    else if (step.source === "meta") value = metaContent(html, step.key);
    else if (step.source === "url" || step.source === "html") {
      const target = step.source === "url" ? String(chapterUrl || "") : String(html || "");
      try {
        const match = target.match(new RegExp(step.pattern));
        value = match?.[step.group] != null ? String(match[step.group]) : "";
      } catch {
        value = "";
      }
    }
    if (!value && step.default !== undefined) value = String(step.default);
    vars[step.name] = value;
  }
  return vars;
}

function jsonProperty(payload, name) {
  if (!payload || typeof payload !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(payload, name)) {
    const value = payload[name];
    return value == null ? "" : String(value).trim();
  }
  if (payload.data && typeof payload.data === "object" && Object.prototype.hasOwnProperty.call(payload.data, name)) {
    const value = payload.data[name];
    return value == null ? "" : String(value).trim();
  }
  return "";
}

/**
 * Execute a declarative MediaResolutionPlan.resolution block.
 * Transport is injected (`download`); no source/domain branches live here.
 */
export async function executeMediaResolution(html, chapterUrl, plan, download) {
  const resolution = normalizeResolution(plan?.resolution);
  if (!resolution || typeof download !== "function") return [];
  const vars = collectExtractVars(html, chapterUrl, resolution.extract);
  if (resolution.extract.some((step) => !vars[step.name] && step.source !== "constant")) return [];

  const url = interpolate(resolution.request.url, vars).trim();
  if (!url || /[<>\r\n]/.test(url) || !/^https?:\/\//i.test(url)) return [];
  const headers = {};
  for (const [name, template] of Object.entries(resolution.request.headers || {})) {
    const value = interpolate(template, vars).trim();
    if (value) headers[name] = value;
  }
  if (!headers.Referer && vars.chapterUrl) headers.Referer = vars.chapterUrl;
  const body = resolution.request.body ? interpolate(resolution.request.body, vars) : null;
  try {
    const response = await download(url, {
      headers,
      method: resolution.request.method,
      body: resolution.request.method === "POST" ? body : null,
    });
    const payload = JSON.parse(responseText(response));
    for (const property of resolution.response.properties) {
      const mediaUrl = jsonProperty(payload, property);
      if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) return [mediaUrl];
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * Orchestrate chapter media discovery without source/domain identifiers:
 * 1. direct playable chapter URL (no chapter fetch)
 * 2. declarative MediaResolutionPlan follow-up (when present)
 * 3. general HTML/JSON/media page scrape via `extractPageMediaUrls`
 *
 * `htmlOrLoad` may be the chapter HTML string, or a lazy loader invoked only
 * when resolution/scrape actually needs the page body.
 */
export async function resolveChapterMediaUrls(
  htmlOrLoad,
  chapterUrl,
  extractionPlan,
  download,
  extractPageMediaUrls,
) {
  if (typeof extractPageMediaUrls !== "function") {
    throw new TypeError("resolveChapterMediaUrls requires extractPageMediaUrls");
  }
  const plan = normalizeMediaExtractionPlan(extractionPlan, extractionPlan?.kind);
  const direct = extractPageMediaUrls("", chapterUrl, plan);
  if (direct.length) return direct;

  let htmlPromise;
  const loadHtml = async () => {
    if (!htmlPromise) {
      htmlPromise = Promise.resolve(
        typeof htmlOrLoad === "function" ? htmlOrLoad() : htmlOrLoad,
      ).then((value) => String(value ?? ""));
    }
    return htmlPromise;
  };

  if (plan.resolution) {
    const resolved = await executeMediaResolution(await loadHtml(), chapterUrl, plan, download);
    if (resolved.length) return resolved;
  }

  return extractPageMediaUrls(await loadHtml(), chapterUrl, plan);
}
