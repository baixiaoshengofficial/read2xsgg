const MAX_HINTS = 16;
const SAFE_NAME = /^[A-Za-z_$][\w$-]{0,63}$/;
const MEDIA_PROPERTY = /(?:url|uri|src|source|audio|sound|voice|track|play|video|media|stream|hls|m3u8|file|path)/i;
const MEDIA_ATTRIBUTE = /(?:src|source|url|file|stream|play|href|data)/i;
const BLOCKED_HEADERS = /^(?:host|content-length|transfer-encoding|connection|te|trailer|upgrade|proxy-|sec-websocket-)/i;

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

/**
 * Compile safe, declarative hints from a Legado audio/video content rule.
 * Executable JavaScript is never copied into the plan. sourceRegex is reduced
 * to literal URL substring hints (e.g. ".mp3") so the server can prefer the
 * same media the reading WebView interceptor would have captured.
 */
export function compileMediaExtractionPlan(rule, kind = "audio", headers = {}, { sourceRegex = "" } = {}) {
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
  return {
    version: 1,
    kind: mediaKind(value.kind || kind),
    properties: uniqueNames(Array.isArray(value.properties) ? value.properties : [], MEDIA_PROPERTY),
    attributes: uniqueNames(Array.isArray(value.attributes) ? value.attributes : [], MEDIA_ATTRIBUTE),
    urlHints,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function encodeMediaExtractionPlan(plan) {
  const normalized = normalizeMediaExtractionPlan(plan, plan?.kind);
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function decodeMediaExtractionPlan(value, kind = "audio") {
  const encoded = String(value || "");
  if (!encoded) return normalizeMediaExtractionPlan(null, kind);
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TypeError("媒体提取计划编码无效");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("媒体提取计划不是有效 JSON");
  }
  return normalizeMediaExtractionPlan(parsed, kind);
}
