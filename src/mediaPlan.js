import { createHash } from "node:crypto";
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
  const resultPrefixMatch = source.match(
    /(?:@js:|<js>)\s*(?:return\s+)?\(?\s*(["'])(https?:\/\/[^"'\r\n]{1,2048})\1\s*\+\s*(?:String\(\s*)?result\b/i,
  );
  return {
    version: 1,
    kind: mediaKind(kind),
    properties: uniqueNames(properties, MEDIA_PROPERTY),
    attributes: uniqueNames(attributes, MEDIA_ATTRIBUTE),
    urlHints: urlHints.slice(0, MAX_HINTS),
    ...(resultPrefixMatch ? { resultPrefix: resultPrefixMatch[2] } : {}),
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
  let signature;
  const signatureRaw = value.signature && typeof value.signature === "object" ? value.signature : null;
  if (signatureRaw?.algorithm === "md5" && /^[A-Za-z0-9_-]{1,64}$/.test(String(signatureRaw.param || ""))) {
    const secret = String(signatureRaw.secret || "");
    const params = {};
    for (const [name, template] of Object.entries(signatureRaw.params || {})) {
      const rawTemplate = String(template ?? "");
      const safe = rawTemplate === "" ? "" : safeTemplate(rawTemplate);
      if (!SAFE_NAME.test(name) || (rawTemplate !== "" && !safe)) continue;
      params[name] = safe;
      if (Object.keys(params).length >= 64) break;
    }
    if (secret && secret.length <= 256 && Object.keys(params).length) {
      signature = {
        algorithm: "md5",
        param: String(signatureRaw.param),
        secret,
        params,
        joiner: signatureRaw.joiner === "&" ? "&" : "",
      };
    }
  }
  return {
    extract,
    request: {
      url,
      method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body ? { body } : {}),
    },
    response: { properties: responseProps },
    ...(signature ? { signature } : {}),
  };
}

function quotedValue(token) {
  const source = String(token || "");
  if (source.startsWith('"')) return JSON.parse(source);
  return source.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function compileSortedMd5QueryResolution(source) {
  if (!/Object\.keys\(\s*params\s*\)\.sort\(\s*\)/.test(source)) return null;
  const secretMatch = source.match(
    /java\.md5Encode\(\s*(["'])([^"'\r\n]{1,256})\1\s*\+\s*signstr\s*\+\s*(["'])([^"'\r\n]{1,256})\3\s*\)/,
  );
  if (!secretMatch || secretMatch[2] !== secretMatch[4]) return null;
  const endpointMatch = source.match(/java\.ajax\(\s*(["'])(https?:\/\/[^"'?\r\n]+\?)["']\s*\+\s*querystr/);
  const objectMatch = source.match(/(?:let|const|var)\s+params\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (!endpointMatch || !objectMatch) return null;

  const extract = [];
  const vars = new Set();
  const splitArray = source.match(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*baseUrl\.split\(\s*(["'])\/\2\s*\)/);
  if (splitArray) {
    const arrayName = splitArray[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const variablePattern = new RegExp(
      `(?:let|const|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${arrayName}\\[(\\d{1,2})\\](?:\\.split\\(\\s*(["'])\\.\\3\\s*\\)\\[0\\])?`,
      "g",
    );
    for (const match of source.matchAll(variablePattern)) {
      const index = Number(match[2]);
      if (!Number.isInteger(index) || index < 3 || index > 32) continue;
      const before = Math.max(0, index - 3);
      const pattern = `^https?://[^/]+/${Array.from({ length: before }, () => "[^/]+/").join("")}([^/${match[3] ? "." : ""}]+)`;
      if (!safeRegexPattern(pattern)) continue;
      extract.push({ name: match[1], source: "url", pattern, group: 1 });
      vars.add(match[1]);
    }
  }
  if (!extract.length) return null;

  const params = {};
  for (const entry of objectMatch[1].split(/,\s*(?:\r?\n|$)/)) {
    const pair = entry.trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (!pair) continue;
    const value = pair[2].trim();
    if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(value)) {
      params[pair[1]] = quotedValue(value);
    } else if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      params[pair[1]] = value;
    } else if (/^Math\.(?:ceil|floor)\(Date\.now\(\)\s*\/\s*1000\)$/.test(value)) {
      params[pair[1]] = "{{unixTime}}";
    } else if (vars.has(value)) {
      params[pair[1]] = `{{${value}}}`;
    }
  }
  if (!Object.keys(params).length || !Object.values(params).some((value) => /\{\{/.test(value))) return null;
  const responseProperties = [];
  for (const match of source.matchAll(/\bdata\.([A-Za-z_$][\w$]*)/g)) {
    if (MEDIA_PROPERTY.test(match[1]) && !responseProperties.includes(match[1])) responseProperties.push(match[1]);
  }
  return normalizeResolution({
    extract,
    request: { url: endpointMatch[2].replace(/\?$/, ""), method: "GET" },
    response: { properties: responseProperties.length ? responseProperties : ["url"] },
    signature: {
      algorithm: "md5",
      param: "signature",
      secret: secretMatch[2],
      params,
      joiner: "",
    },
  });
}

function compileInlinePlayerResolution(source) {
  const functionMatch = String(source || "").match(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\n\}/,
  );
  if (!functionMatch) return null;
  const body = functionMatch[4];
  const endpointMatch = body.match(/(?:const|let|var)\s+url\s*=\s*(["'])(https?:\/\/[^"'\r\n]+)\1/);
  const requestBody = body.match(/\bbody\s*:\s*`([^`]+)`/);
  if (!endpointMatch || !requestBody) return null;
  const [typeParam, idParam] = [functionMatch[2], functionMatch[3]];
  if (!requestBody[1].includes(`\${${typeParam}}`) || !requestBody[1].includes(`\${${idParam}}`)) return null;
  const endpoint = endpointMatch[2].replace(/,+$/, "");
  const callPattern = `${functionMatch[1]}\\(\\s*["']([^"']+)["']\\s*,\\s*["']([^"']+)["']\\s*\\)`;
  const headers = {};
  for (const match of body.matchAll(/(["'])(Content-Type|Referer|User-Agent)\1\s*:\s*(["'])([^"'\r\n]+)\3/gi)) {
    headers[match[2]] = match[4];
  }
  return normalizeResolution({
    extract: [
      { name: typeParam, source: "html", pattern: callPattern, group: 1 },
      { name: idParam, source: "html", pattern: callPattern, group: 2 },
    ],
    request: {
      url: endpoint,
      method: "POST",
      headers,
      body: requestBody[1]
        .replace(new RegExp(`\\$\\{${typeParam}\\}`, "g"), `{{${typeParam}}}`)
        .replace(new RegExp(`\\$\\{${idParam}\\}`, "g"), `{{${idParam}}}`),
    },
    response: { properties: ["url"] },
  });
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

  const inlinePlayer = compileInlinePlayerResolution(source);
  if (inlinePlayer) return inlinePlayer;
  const signedQuery = compileSortedMd5QueryResolution(source);
  if (signedQuery) return signedQuery;

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
 * Read a declared MediaResolutionPlan fragment from a container object.
 * Accepts either a direct `mediaResolution` field or a nested
 * `read2xsgg.mediaResolution` bag (common on ruleContent objects).
 */
function mediaResolutionFrom(container) {
  if (!container || typeof container !== "object" || Array.isArray(container)) return null;
  const direct = container.mediaResolution;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const nested = container.read2xsgg?.mediaResolution;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return null;
}

/**
 * Resolve declared media-resolution metadata from a Legado source without
 * site/domain conditionals. Prefers rule-object declarations
 * (`ruleContent` / `contentRule`, including nested `read2xsgg`) over
 * source-root `read2xsgg.mediaResolution` / `mediaResolution` so migration
 * fixtures that nest under ruleContent are retained into the generic plan.
 */
export function declaredMediaResolution(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const contentRule = source.ruleContent ?? source.contentRule ?? null;
  return (
    mediaResolutionFrom(contentRule)
    || mediaResolutionFrom(source.read2xsgg)
    || mediaResolutionFrom(source)
  );
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
 * Legacy published media plans that only retained `attributes:["href"]` from
 * chapter-list link selectors. They lack properties, urlHints, and a
 * declarative MediaResolutionPlan — not enough to recover protected playback.
 */
export function mediaPlanIsLegacyHrefOnly(plan) {
  const normalized = normalizeMediaExtractionPlan(plan, plan?.kind);
  if (mediaPlanHasResolution(normalized)) return false;
  if (normalized.properties.length || normalized.urlHints.length) return false;
  if (!normalized.attributes.length) return false;
  return normalized.attributes.every((name) => name === "href");
}

/**
 * Sources that only rely on Legado WebView + sourceRegex (or trivial
 * `<js>result</js>`), or that contain a multi-step script we could not safely
 * compile, do not describe a portable MediaResolutionPlan. Portable selectors
 * such as `audio@src` with sourceRegex hints are not warned.
 */
export function mediaRuleNeedsPortabilityWarning(contentRule = {}, tocRule = {}, plan = null) {
  if (mediaPlanHasResolution(plan)) return false;
  if (mediaResolutionFrom(contentRule)) return false;
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

/** Adapter/runtime diagnostic for legacy href-only plans that cannot play. */
export const MEDIA_RECONVERSION_DIAGNOSTIC = "媒体提取计划仅有导航型 href、缺少声明式多步解析（resolution），无法把章节 HTML 当作播放地址；请用包含 mediaResolution/可编译多步流程的原始阅读源重新转换";
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
    ...(/^https?:\/\/[^<>\r\n]{1,2048}$/i.test(String(value.resultPrefix || ""))
      ? { resultPrefix: String(value.resultPrefix) }
      : {}),
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

function hasHeader(headers, name) {
  const wanted = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === wanted);
}

function responseHeader(response, name) {
  const wanted = String(name || "").toLowerCase();
  const headers = response?.httpHeaders;
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * Keep only the name=value part of cookies issued by the chapter request.
 * They are deliberately used for one same-origin follow-up only; this is not
 * a shared cookie jar and must never leak a chapter session to another host.
 */
function chapterSessionCookies(response) {
  const value = responseHeader(response, "set-cookie");
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const cookies = [];
  let total = 0;
  for (const entry of entries) {
    const pair = String(entry || "").split(";", 1)[0].trim();
    const equal = pair.indexOf("=");
    const name = equal > 0 ? pair.slice(0, equal).trim() : "";
    const cookieValue = equal > 0 ? pair.slice(equal + 1).trim() : "";
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) continue;
    if (!cookieValue || /[\r\n;]/.test(cookieValue) || pair.length > 1_024) continue;
    if (total + pair.length + (cookies.length ? 2 : 0) > 4_096) break;
    cookies.push(pair);
    total += pair.length + (cookies.length > 1 ? 2 : 0);
    if (cookies.length >= 16) break;
  }
  return cookies.join("; ");
}

function staticPageVariables(source) {
  const values = {};
  for (const match of String(source || "").matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]{0,63})\s*=\s*(["'])((?:\\.|(?!\2)[\s\S]){0,2048}?)\2\s*;/g,
  )) {
    const value = match[3]
      .replace(/\\([\\"'])/g, "$1")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
    values[match[1]] = value;
    if (Object.keys(values).length >= 64) break;
  }
  return values;
}

function packerWord(value, radix) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let number = value;
  let output = "";
  do {
    output = alphabet[number % radix] + output;
    number = Math.floor(number / radix);
  } while (number > 0);
  return output;
}

export function unpackDeanEdwards(source) {
  const match = String(source || "").match(
    /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]{0,4096}?\}\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\.split\(\s*['"]\|['"]\s*\)/,
  );
  if (!match) return "";
  const radix = Number(match[2]);
  const count = Number(match[3]);
  if (!Number.isInteger(radix) || radix < 2 || radix > 62
    || !Number.isInteger(count) || count < 1 || count > 2_048) return "";
  let payload;
  let keywords;
  try {
    payload = quotedValue(match[1]);
    keywords = quotedValue(match[4]).split("|");
  } catch {
    return "";
  }
  if (!payload || payload.length > 256_000 || keywords.length > 2_048) return "";
  for (let index = Math.min(count, keywords.length) - 1; index >= 0; index -= 1) {
    if (!keywords[index]) continue;
    const word = packerWord(index, radix);
    payload = payload.replace(new RegExp(`\\b${word}\\b`, "g"), keywords[index]);
  }
  return payload;
}

function metaContentValues(html) {
  const values = {};
  for (const match of String(html || "").matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1];
    const name = attributes.match(/\bname\s*=\s*(["'])([^"']+)\1/i)?.[2];
    const content = attributes.match(/\bcontent\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1/i)?.[2];
    if (name && content !== undefined) values[name] = content;
  }
  return values;
}

function scriptStaticValues(script, html) {
  const values = { ...staticPageVariables(html), ...staticPageVariables(script) };
  const meta = metaContentValues(html);
  for (const [name, value] of Object.entries(meta)) values[`meta:${name}`] = value;
  for (const match of String(script || "").matchAll(
    /\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]{0,63})\s*=\s*\$\(\s*(["'])meta\[name=(?:["'])([^"']+)(?:["'])\]\2\s*\)\.attr\(\s*(["'])content\4\s*\)/g,
  )) {
    if (Object.prototype.hasOwnProperty.call(meta, match[3])) values[match[1]] = meta[match[3]];
  }
  // Resolve function parameters from a statically visible call such as
  // play(currentPage, 1) without executing the function body.
  for (const declaration of String(script || "").matchAll(
    /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,256})\)\s*\{(?:(?!\bfunction\b)[\s\S]){0,8192}?\$\.ajax\s*\(/g,
  )) {
    const params = declaration[2].split(",").map((item) => item.trim()).filter(Boolean);
    const callPattern = new RegExp(`\\b${declaration[1]}\\s*\\(([^)]{0,256})\\)`, "g");
    for (const call of String(script || "").matchAll(callPattern)) {
      if (call.index === declaration.index + declaration[0].indexOf(`${declaration[1]}(`)) continue;
      const args = call[1].split(",").map((item) => item.trim());
      let resolved = 0;
      params.forEach((param, index) => {
        const token = args[index] || "";
        if (/^[A-Za-z_$][\w$]*$/.test(token) && Object.prototype.hasOwnProperty.call(values, token)) {
          values[param] = values[token];
          resolved += 1;
        } else if (/^-?\d+(?:\.\d+)?$/.test(token)) {
          values[param] = token;
          resolved += 1;
        }
      });
      if (resolved) break;
    }
  }
  return values;
}

function staticExpressionValue(expression, variables) {
  const token = String(expression || "").trim();
  if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(token)) return quotedValue(token);
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return token;
  if (/^[A-Za-z_$][\w$]*$/.test(token)
    && Object.prototype.hasOwnProperty.call(variables, token)) return String(variables[token]);
  const metaName = token.match(
    /^\$\(\s*(["'])meta\[name=(?:["'])([^"']+)(?:["'])\]\1\s*\)\.attr\(\s*(["'])content\3\s*\)$/,
  )?.[2];
  if (metaName && Object.prototype.hasOwnProperty.call(variables, `meta:${metaName}`)) {
    return String(variables[`meta:${metaName}`]);
  }
  return "";
}

function staticObjectAssignments(script, variables) {
  const objects = {};
  for (const match of String(script || "").matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*\}\s*;/g)) {
    objects[match[1]] = {};
  }
  for (const match of String(script || "").matchAll(
    /\b([A-Za-z_$][\w$]*)\s*\[\s*(["'])([!#$%&'*+.^_`|~0-9A-Za-z-]+)\2\s*\]\s*=\s*([^;]{1,1024});/g,
  )) {
    if (!objects[match[1]]) continue;
    const value = staticExpressionValue(match[4], variables);
    if (value && !BLOCKED_HEADERS.test(match[3])) objects[match[1]][match[3]] = value;
  }
  return objects;
}

function staticUrlExpression(expression, variables) {
  const parts = String(expression || "").trim().replace(/;$/, "").split(/\s*\+\s*/);
  if (!parts.length || parts.length > 24) return "";
  let result = "";
  for (const part of parts) {
    const token = part.trim();
    const literal = token.match(/^(["'])((?:\\.|(?!\1)[\s\S])*)\1$/);
    if (literal) {
      result += literal[2].replace(/\\([\\"'])/g, "$1");
      continue;
    }
    if (/^(?:Date\.now\(\)|new\s+Date\(\)\.getTime\(\))$/.test(token)) {
      result += String(Date.now());
      continue;
    }
    if (/^[A-Za-z_$][\w$]{0,63}$/.test(token)
      && Object.prototype.hasOwnProperty.call(variables, token)) {
      result += String(variables[token]);
      continue;
    }
    return "";
  }
  return result.length <= 2_048 ? result : "";
}

function scriptAjaxRequests(script, variables, chapterUrl) {
  const requests = [];
  const assignedObjects = staticObjectAssignments(script, variables);
  for (const match of String(script || "").matchAll(/\$\.ajax\s*\(\s*\{([\s\S]{0,8192}?)\}\s*\)/gim)) {
    const block = match[1];
    const urlExpression = block.match(/\burl\s*:\s*([^,\r\n}]+)/i)?.[1] || "";
    const relative = staticUrlExpression(urlExpression, variables);
    if (!relative) continue;
    let url;
    try { url = new URL(relative, chapterUrl).toString(); } catch { continue; }
    const method = /\b(?:type|method)\s*:\s*["']post["']/i.test(block) ? "POST" : "GET";
    const headers = {};
    const headerVariable = block.match(/\bheaders\s*:\s*([A-Za-z_$][\w$]*)/i)?.[1];
    if (headerVariable && assignedObjects[headerVariable]) Object.assign(headers, assignedObjects[headerVariable]);
    let body = "";
    const dataBlock = block.match(/\bdata\s*:\s*\{([^{}]{0,4096})\}/i)?.[1] || "";
    if (dataBlock) {
      const params = new URLSearchParams();
      for (const pair of dataBlock.matchAll(/(?:^|,)\s*(?:([A-Za-z_$][\w$]*)|(["'])([^"']+)\2)\s*:\s*([^,]+)(?=,|$)/g)) {
        const name = pair[1] || pair[3] || "";
        const value = staticExpressionValue(pair[4], variables);
        if (name && value !== "") params.set(name, value);
      }
      body = params.toString();
      if (body && !hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }
    requests.push({ url, method, headers, body });
    if (requests.length >= 4) break;
  }
  return requests;
}

function declaredMediaReplacements(script) {
  const replacements = [];
  for (const match of String(script || "").matchAll(
    /new\s+RegExp\s*\(\s*(["'])([^"'\r\n]{1,64})\1[^)]*\)[\s\S]{0,256}?\.replace\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(["'])([^"'\r\n]{1,64})\3\s*\)/gi,
  )) {
    const pattern = safeRegexPattern(match[2]);
    if (!pattern) continue;
    replacements.push({ pattern, value: match[4] });
    if (replacements.length >= 8) break;
  }
  return replacements;
}

async function resolvePageScriptMedia(html, chapterUrl, plan, download, chapterResponse, extractPageMediaUrls) {
  if (typeof download !== "function") return [];
  const scripts = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
    let url;
    try { url = new URL(match[2].replace(/&amp;/gi, "&"), chapterUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !sameOrigin(url, chapterUrl)) continue;
    if (scripts.some((item) => item === url.toString())) continue;
    scripts.push(url.toString());
    if (scripts.length >= 8) break;
  }
  if (!scripts.length) return [];

  const cookies = chapterSessionCookies(chapterResponse);
  const baseHeaders = { Referer: chapterUrl };
  if (cookies) baseHeaders.Cookie = cookies;
  const variables = staticPageVariables(html);
  for (const scriptUrl of scripts) {
    let script;
    try { script = responseText(await download(scriptUrl, { headers: baseHeaders })); } catch { continue; }
    script = unpackDeanEdwards(script) || script;
    if (!/\$\.ajax\s*\(/i.test(script)) continue;
    Object.assign(variables, scriptStaticValues(script, html));
    const replacements = declaredMediaReplacements(script);
    for (const request of scriptAjaxRequests(script, variables, chapterUrl)) {
      const headers = { ...baseHeaders, ...request.headers, "X-Requested-With": "XMLHttpRequest" };
      if (!sameOrigin(request.url, chapterUrl)) delete headers.Cookie;
      let response;
      try {
        response = await download(request.url, {
          headers,
          method: request.method,
          ...(request.body ? { body: request.body } : {}),
        });
      } catch {
        continue;
      }
      let payload = responseText(response);
      for (const replacement of replacements) {
        try { payload = payload.replace(new RegExp(replacement.pattern, "g"), replacement.value); } catch { /* skip */ }
      }
      const urls = extractPageMediaUrls(payload, request.url, plan);
      if (urls.length) return urls;
    }
  }
  return [];
}

/**
 * Execute a declarative MediaResolutionPlan.resolution block.
 * Transport is injected (`download`); no source/domain branches live here.
 */
export async function executeMediaResolution(html, chapterUrl, plan, download, chapterResponse = null) {
  const resolution = normalizeResolution(plan?.resolution);
  if (!resolution || typeof download !== "function") return [];
  const vars = collectExtractVars(html, chapterUrl, resolution.extract);
  if (resolution.extract.some((step) => !vars[step.name] && step.source !== "constant")) return [];

  vars.unixTime = String(Math.ceil(Date.now() / 1000));
  let url = interpolate(resolution.request.url, vars).trim();
  if (!url || /[<>\r\n]/.test(url) || !/^https?:\/\//i.test(url)) return [];
  const headers = {};
  for (const [name, template] of Object.entries(resolution.request.headers || {})) {
    const value = interpolate(template, vars).trim();
    if (value) headers[name] = value;
  }
  if (!headers.Referer && vars.chapterUrl) headers.Referer = vars.chapterUrl;
  const sessionCookies = chapterSessionCookies(chapterResponse);
  if (sessionCookies && !hasHeader(headers, "cookie") && sameOrigin(url, chapterUrl)) {
    headers.Cookie = sessionCookies;
  }
  let body = resolution.request.body ? interpolate(resolution.request.body, vars) : null;
  if (resolution.signature) {
    const params = {};
    for (const [name, template] of Object.entries(resolution.signature.params)) {
      params[name] = interpolate(template, vars);
    }
    const keys = Object.keys(params).sort();
    const signText = keys.map((name) => `${name}=${params[name]}`).join(resolution.signature.joiner);
    const signature = createHash("md5")
      .update(`${resolution.signature.secret}${signText}${resolution.signature.secret}`)
      .digest("hex");
    const query = new URLSearchParams(keys.map((name) => [name, params[name]]));
    query.set(resolution.signature.param, signature);
    url = `${url}${url.includes("?") ? "&" : "?"}${query}`;
    body = null;
  }
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

  let pagePromise;
  const loadPage = async () => {
    if (!pagePromise) {
      pagePromise = Promise.resolve(
        typeof htmlOrLoad === "function" ? htmlOrLoad() : htmlOrLoad,
      );
    }
    return pagePromise;
  };
  const loadHtml = async () => {
    const page = await loadPage();
    return responseText(page);
  };

  if (plan.resolution) {
    const page = await loadPage();
    const responseUrl = String(page?.read2xsggResponseUrl || chapterUrl);
    const resolved = await executeMediaResolution(responseText(page), responseUrl, plan, download, page);
    if (resolved.length) return resolved;
  }
  const page = await loadPage();
  const html = responseText(page);
  const responseUrl = String(page?.read2xsggResponseUrl || chapterUrl);
  const scraped = extractPageMediaUrls(html, responseUrl, plan);
  if (scraped.length) return scraped;
  return resolvePageScriptMedia(html, responseUrl, plan, download, page, extractPageMediaUrls);
}
