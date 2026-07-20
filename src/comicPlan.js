const MAX_HINTS = 16;
const SAFE_NAME = /^[A-Za-z_$][\w$-]{0,63}$/;
const URL_PROPERTY = /(?:url|uri|src|source|image|img|pic|picture|file|path)/i;
const URL_ATTRIBUTE = /(?:src|source|original|lazy|url|file|style)/i;
const BLOCKED_HEADERS = /^(?:host|content-length|transfer-encoding|connection|te|trailer|upgrade|proxy-|sec-websocket-)/i;

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
 * Compile the portable part of a Legado comic-content rule into declarative
 * extraction hints. The plan contains no executable JavaScript or regex from
 * the source, so an online source cannot inject code into the converter.
 */
export function compileComicExtractionPlan(rule, headers = {}) {
  const source = String(rule || "");
  const properties = [];
  const attributes = [];
  const addProperty = (value) => properties.push(value);
  const addAttribute = (value) => attributes.push(value);

  // JSON/JavaScript object access: item.imageUrl, $.data.images[*].src. Remove
  // Legado's tag.img/class.reader selector tokens before scanning dot access.
  const objectSource = source.replace(/(?:^|[@.])(?:tag|class|id|text)\.[A-Za-z_$][\w$-]*/gi, "");
  for (const match of objectSource.matchAll(/(?:\.|\[['"])([A-Za-z_$][\w$-]{0,63})(?:['"]\])?/g)) {
    if (URL_PROPERTY.test(match[1])) addProperty(match[1]);
  }
  // Regex-based script extraction: \"imageUrl\":\"(.+?)\".
  for (const match of source.matchAll(/[\\]*["']([A-Za-z_$][\w$-]{0,63})[\\]*["']\s*:[\\]*["']/g)) {
    if (URL_PROPERTY.test(match[1])) addProperty(match[1]);
  }
  // Legado selector attributes and common DOM attr()/get() calls.
  for (const match of source.matchAll(/@([A-Za-z_$][\w$-]{0,63})/g)) {
    if (URL_ATTRIBUTE.test(match[1])) addAttribute(match[1]);
  }
  for (const match of source.matchAll(/(?:attr|getAttribute|get)\s*\(\s*["']([A-Za-z_$][\w$-]{0,63})["']/g)) {
    if (URL_ATTRIBUTE.test(match[1])) addAttribute(match[1]);
  }

  const normalizedHeaders = safeHeaders(headers);
  return {
    version: 1,
    properties: uniqueNames(properties, URL_PROPERTY),
    attributes: uniqueNames(attributes, URL_ATTRIBUTE),
    ...(Object.keys(normalizedHeaders).length ? { headers: normalizedHeaders } : {}),
  };
}

export function normalizeComicExtractionPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, properties: [], attributes: [] };
  const headers = safeHeaders(value.headers);
  return {
    version: 1,
    properties: uniqueNames(Array.isArray(value.properties) ? value.properties : [], URL_PROPERTY),
    attributes: uniqueNames(Array.isArray(value.attributes) ? value.attributes : [], URL_ATTRIBUTE),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function encodeComicExtractionPlan(plan) {
  const normalized = normalizeComicExtractionPlan(plan);
  if (!normalized.properties.length && !normalized.attributes.length) return "";
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function decodeComicExtractionPlan(value) {
  const encoded = String(value || "");
  if (!encoded) return normalizeComicExtractionPlan(null);
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TypeError("漫画提取计划编码无效");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("漫画提取计划不是有效 JSON");
  }
  return normalizeComicExtractionPlan(parsed);
}
