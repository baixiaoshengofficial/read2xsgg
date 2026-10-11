import { randomUUID } from "node:crypto";
import { decodeBridgePlan, encodeBridgePlan } from "../bridgePlan.js";
import { encodeMediaExtractionPlan } from "../mediaPlan.js";

const SAFE_FIELD = /^[A-Za-z_$][\w$-]{0,63}$/;
const MEDIA_URL = /\.(?:mp3|m4a|aac|ogg|oga|wav|flac|opus|mp4|m3u8|webm)(?:[?#]|$)/i;

function adapterOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return ""; }
}

function bridgeDetailTemplate(source) {
  const actions = [...Object.values(source?.bookWorld || {}), source?.searchBook].filter(Boolean);
  for (const action of actions) {
    const token = String(action?.requestInfo || "").match(/\/adapter\/books\?plan=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) continue;
    try {
      const field = decodeBridgePlan(token).fields?.url;
      const template = field?.matchTemplate;
      if (template?.prefix && !template?.suffix && /^https?:\/\//i.test(template.prefix)) {
        return { prefix: template.prefix, idField: String(field.selector || "").split("/").at(-1) || "id" };
      }
      if (field?.urlTemplate && /^https?:\/\//i.test(field.urlTemplate)) {
        const idField = field.urlTemplate.match(/\{\{([A-Za-z_$][\w$-]*)\}\}/)?.[1];
        if (idField) return { prefix: field.urlTemplate.split("{{", 1)[0], idField };
      }
    } catch {
      // Try another converted entry action.
    }
  }
  return null;
}

function sameOriginScriptUrl(value, baseUrl, allowedOrigin) {
  try {
    const url = new URL(String(value || "").replace(/&amp;/gi, "&"), baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.origin !== allowedOrigin || url.username || url.password) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function scriptUrls(html, baseUrl) {
  let allowedOrigin;
  try { allowedOrigin = new URL(baseUrl).origin; } catch { return []; }
  const urls = [];
  const tags = String(html || "").matchAll(/<(script|link)\b[^>]*>/gi);
  for (const match of tags) {
    const tag = match[0];
    const type = match[1].toLowerCase();
    if (type === "link") {
      const rel = tag.match(/\brel\s*=\s*(["'])([^"']+)\1/i)?.[2] || "";
      const as = tag.match(/\bas\s*=\s*(["'])([^"']+)\1/i)?.[2] || "";
      if (!/(?:^|\s)modulepreload(?:\s|$)/i.test(rel)
        && !(/(?:^|\s)preload(?:\s|$)/i.test(rel) && as.toLowerCase() === "script")) continue;
    }
    const attribute = type === "script" ? "src" : "href";
    const raw = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, "i"))?.[2];
    const url = sameOriginScriptUrl(raw, baseUrl, allowedOrigin);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 32) break;
  }
  return urls;
}

function importedScriptUrls(script, scriptUrl, allowedOrigin) {
  const candidates = [];
  const source = String(script || "");
  const patterns = [
    /\bimport\s*\(\s*(["'])([^"']{1,2048})\1\s*\)/g,
    /\b(?:import|export)\b[^;'"\n]{0,512}?\bfrom\s*(["'])([^"']{1,2048})\1/g,
    /\bimport\s*(["'])([^"']{1,2048})\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[2] || "";
      if (!/^(?:\.{1,2}\/|\/|https?:\/\/)/i.test(raw)) continue;
      const url = sameOriginScriptUrl(raw, scriptUrl, allowedOrigin);
      if (url && !candidates.includes(url)) candidates.push(url);
    }
  }
  return candidates;
}

async function loadScriptTree(html, baseUrl, download) {
  let allowedOrigin;
  try { allowedOrigin = new URL(baseUrl).origin; } catch { return []; }
  const pending = scriptUrls(html, baseUrl);
  const scheduled = new Set(pending);
  const loaded = [];
  let totalBytes = 0;
  while (pending.length && loaded.length < 32 && totalBytes < 12 * 1024 * 1024) {
    const batch = pending.splice(0, 4);
    const results = await Promise.allSettled(batch.map(async (url) => {
      const body = await download(url);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
      if (bytes.length > 2 * 1024 * 1024) return null;
      return { url, text: bytes.toString("utf8"), size: bytes.length };
    }));
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const record = result.value;
      if (totalBytes + record.size > 12 * 1024 * 1024) continue;
      totalBytes += record.size;
      loaded.push(record);
      for (const url of importedScriptUrls(record.text, record.url, allowedOrigin)) {
        if (scheduled.has(url) || scheduled.size >= 32) continue;
        scheduled.add(url);
        pending.push(url);
      }
    }
  }
  return loaded;
}

function parseLiteral(value) {
  const source = String(value || "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return source;
  const quote = source[0];
  if ((quote === '"' || quote === "'") && source.at(-1) === quote) {
    try {
      return quote === '"' ? JSON.parse(source) : source.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } catch { return ""; }
  }
  return "";
}

function staticRequestBase(script, expression, pageUrl, depth = 0) {
  let value = String(expression || "").trim();
  let pageOrigin;
  try { pageOrigin = new URL(pageUrl).origin; } catch { return ""; }
  if (!value || depth > 2 || /^(?:config\.host|(?:window\.)?location\.(?:origin|host))$/i.test(value)) {
    return pageOrigin;
  }
  const locationSuffix = value.match(/^(?:window\.)?location\.origin\s*\+\s*(["'])([^"']*)\1$/i);
  if (locationSuffix) value = locationSuffix[2];
  else if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = String(script || "").match(new RegExp(
      `(?:^|[;{}\\n])\\s*(?:var|let|const)\\s+${escaped}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)`,
    ));
    if (!assignment) return pageOrigin;
    value = assignment[1];
    if (/^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?$/.test(value)) {
      return staticRequestBase(script, value, pageUrl, depth + 1);
    }
  }
  if (/^["']/.test(value)) value = parseLiteral(value);
  if (!value) return pageOrigin;
  try {
    const url = new URL(value, pageOrigin);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return pageOrigin;
    return url.toString();
  } catch {
    return pageOrigin;
  }
}

function matchingObject(source, start, maxLength = 4_096) {
  if (source[start] !== "{") return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length && index - start < maxLength; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return "";
}

function objectEntries(source) {
  const body = String(source || "").trim().replace(/^\{|\}$/g, "");
  const entries = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index] || ",";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if ("{[(".includes(character)) depth += 1;
    else if ("}])".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      const item = body.slice(start, index).trim();
      const pair = item.match(/^(?:["']?)([A-Za-z_$][\w$-]*)(?:["']?)\s*:\s*([\s\S]+)$/);
      if (pair) entries.push([pair[1], pair[2].trim()]);
      start = index + 1;
    }
  }
  return entries;
}

function apiBaseUrls(script, pageUrl) {
  const bases = [];
  const source = String(script || "");
  const creates = /\b([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.create\s*\(\s*\{/g;
  for (const match of source.matchAll(creates)) {
    const open = match.index + match[0].lastIndexOf("{");
    const options = matchingObject(source, open, 8_192);
    const base = options.match(/(?:^|[,\{])\s*baseURL\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/);
    if (!base) continue;
    const value = staticRequestBase(source, base[1], pageUrl);
    if (value && !bases.includes(value)) bases.push(value);
  }
  if (!bases.length) {
    try { bases.push(new URL(pageUrl).origin); } catch { /* Invalid pages are ignored. */ }
  }
  return bases;
}

function combineRequestUrl(origin, baseUrl, endpoint) {
  const raw = String(endpoint || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) return new URL(raw, baseUrl || origin).toString();
    const base = new URL(baseUrl || origin);
    const output = new URL(base.origin);
    if (raw.startsWith("?")) {
      output.pathname = base.pathname || "/";
      output.search = raw;
      return output.toString();
    }
    const endpointUrl = new URL(raw, `${base.origin}/`);
    const basePath = base.pathname.replace(/\/+$/, "");
    const endpointPath = endpointUrl.pathname.replace(/^\/+/, "");
    output.pathname = `${basePath}/${endpointPath}`.replace(/\/{2,}/g, "/") || "/";
    output.search = endpointUrl.search;
    output.hash = endpointUrl.hash;
    return output.toString();
  } catch {
    return "";
  }
}

function getRequestOptions(source, end) {
  let cursor = end;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  if (source[cursor] !== ",") return { query: {}, categoryParams: [], searchParams: [], pageField: "" };
  cursor += 1;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  const options = matchingObject(source, cursor, 4_096);
  const paramsMatch = options.match(/(?:^|[,\{])\s*params\s*:\s*\{/);
  if (!paramsMatch) return { query: {}, categoryParams: [], searchParams: [], pageField: "" };
  const paramsStart = paramsMatch.index + paramsMatch[0].lastIndexOf("{");
  const params = matchingObject(options, paramsStart, 2_048);
  const query = {};
  const categoryParams = [];
  let pageField = "";
  for (const [name, expression] of objectEntries(params)) {
    const literal = parseLiteral(expression);
    if (literal !== "") {
      query[name] = literal;
    } else if (/^(?:page|pageNo|pageIndex|pageNum|offset)$/i.test(name)) {
      query[name] = "1";
      pageField ||= name;
    } else if (/^(?:size|limit|pageSize|page_size)$/i.test(name)) {
      query[name] = "20";
    } else if (/^(?:category|class|type|genre|catalog)(?:[_-]?(?:id|code|key))?$/i.test(name)) {
      categoryParams.push(name);
    }
  }
  const searchParams = objectEntries(params)
    .filter(([name, expression]) => parseLiteral(expression) === ""
      && /^(?:q|query|keyword|keyWord|search|wd)$/i.test(name))
    .map(([name]) => name);
  return { query, categoryParams, searchParams, pageField };
}

function staticDetailTemplates(script, kind, pageUrl) {
  const templates = [];
  const baseUrl = apiBaseUrls(script, pageUrl)[0] || pageUrl;
  const calls = /\.\s*get\s*\(\s*`([^`]{1,512})`/g;
  for (const match of String(script || "").matchAll(calls)) {
    const endpoint = match[1].replace(/\\`/g, "`");
    const placeholders = [...endpoint.matchAll(/\$\{([^{}]+)\}/g)];
    if (placeholders.length !== 1 || !endpointHintFor(kind).test(endpoint)) continue;
    if (/\/(?:related|recommend|search|list|category|categories)(?:\/|\?|$)/i.test(endpoint)) continue;
    const marker = "__READ2XSGG_ITEM__";
    const template = endpoint.replace(/\$\{[^{}]+\}/, marker);
    const absolute = combineRequestUrl(pageUrl, baseUrl, template);
    const markerIndex = absolute.indexOf(marker);
    if (markerIndex < 0) continue;
    templates.push({
      prefix: absolute.slice(0, markerIndex),
      suffix: absolute.slice(markerIndex + marker.length),
      idField: "id",
      score: (/(?:detail|video|movie|vod|episode|audio|track|voice)/i.test(endpoint) ? 10 : 0)
        + (/\/(?:videos?|movies?|vod|episodes?|tracks?|voices?)\//i.test(endpoint) ? 5 : 0),
    });
  }
  return templates.sort((left, right) => right.score - left.score);
}

function staticMediaProxyTemplates(scripts, pageUrl) {
  let pageOrigin;
  try { pageOrigin = new URL(pageUrl).origin; } catch { return []; }
  const templates = [];
  for (const script of scripts) {
    for (const match of String(script || "").matchAll(/`([^`]{1,2048})`/g)) {
      const source = match[1].replace(/\\`/g, "`");
      const interpolations = [...source.matchAll(/\$\{\s*encodeURIComponent\s*\(([^{}]*)\)\s*\}/g)];
      if (interpolations.length !== 1) continue;
      const marker = "READ2XSGG_MEDIA_VALUE";
      const template = source.replace(interpolations[0][0], marker);
      let target;
      try { target = new URL(template, pageUrl); } catch { continue; }
      if (!/^https?:$/.test(target.protocol) || target.origin !== pageOrigin || target.username || target.password) continue;
      const route = target.pathname.toLowerCase();
      if (!/(?:proxy|stream|media|m3u8|playlist|play)/i.test(route)) continue;
      const field = [...target.searchParams.entries()].find(([, value]) => value === marker)?.[0] || "";
      if (!field) continue;
      const absolute = target.toString();
      const markerIndex = absolute.indexOf(marker);
      if (markerIndex < 0) continue;
      templates.push({
        prefix: absolute.slice(0, markerIndex),
        suffix: absolute.slice(markerIndex + marker.length),
        valueMode: /^(?:path|pathname)$/i.test(field) ? "rootPath" : "root",
        score: (/(?:^|\/)m3u8(?:\/|$)/i.test(route) ? 30 : 0)
          + (/proxy|stream/i.test(route) ? 20 : 0)
          + (/^(?:path|pathname)$/i.test(field) ? 15 : 0),
      });
    }
  }
  return templates.sort((left, right) => right.score - left.score);
}

function endpointHintFor(kind) {
  return kind === "video"
    ? /(?:api|topic|home|recommend|list|catalog|directory|categor(?:y|ies)|class(?:es)?|type(?:s)?|search|index|discover|video|vod|movie|film|tv|drama|series|show|player|play|playlist|episode)/i
    : /(?:api|topic|home|recommend|list|catalog|directory|categor(?:y|ies)|class(?:es)?|type(?:s)?|search|index|discover|audio|voice|radio|podcast|music|track|album|episode)/i;
}

function requestDescriptors(script, kind, pageUrl) {
  const descriptors = [];
  const endpointHint = endpointHintFor(kind);
  for (const match of String(script || "").matchAll(
    /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(([^)]{1,256})\)\s*=>\s*await\s*[\s\S]{0,256}?\.get\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])([^"']{3,256})\4\s*,\s*\{([^}]{1,2048})\}\s*\)/g,
  )) {
    const [functionName, rawParams, baseParam, endpoint, requestObject] = [
      match[1], match[2], match[3], match[5], match[6],
    ];
    if (!endpointHint.test(endpoint)) continue;
    const params = rawParams.split(",").map((item) => item.trim());
    const callPattern = new RegExp(`\\b${functionName}\\s*\\(\\s*([^,]{1,256})\\s*,\\s*(\\{[^{}]{1,1024}\\})\\s*,\\s*([^)]{1,256})\\)`, "g");
    const call = [...String(script || "").matchAll(callPattern)]
      .find((item) => item.index !== match.index);
    if (!call) continue;
    const callArgs = [call[1], call[2], call[3]];
    const query = {};
    for (const pair of requestObject.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$-]*)\s*:\s*([^,]+)(?=,|$)/g)) {
      const name = pair[1];
      const expression = pair[2].trim();
      const jsonParam = expression.match(/^JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)$/)?.[1];
      if (jsonParam) {
        const index = params.indexOf(jsonParam);
        if (index >= 0 && /^\{[^{}]+\}$/.test(callArgs[index] || "")) {
          query[name] = callArgs[index].replace(/([,{]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
        }
        continue;
      }
      const parameterIndex = params.indexOf(expression);
      if (parameterIndex >= 0) {
        const literal = parseLiteral(callArgs[parameterIndex]);
        if (literal !== "") query[name] = literal;
        continue;
      }
      const literal = parseLiteral(expression);
      if (literal !== "") query[name] = literal;
      else if (/device|visitor|fingerprint|uuid/i.test(name)) query[name] = randomUUID();
    }
    if (!Object.keys(query).length) continue;
    const baseExpression = callArgs[params.indexOf(baseParam)] || "";
    descriptors.push({
      endpoint,
      query,
      baseParam,
      baseUrl: staticRequestBase(script, baseExpression, pageUrl),
      pageField: "",
    });
    if (descriptors.length >= 8) break;
  }
  const seenEndpoints = new Set(descriptors.map((item) => item.endpoint));
  const apiBaseUrl = apiBaseUrls(script, pageUrl)[0] || pageUrl;
  const apiGetCalls = /\.\s*get\s*\(\s*(["'])([^"'\\\s]{3,512})\1/g;
  for (const match of String(script || "").matchAll(apiGetCalls)) {
    const endpoint = match[2].replace(/\\\//g, "/");
    if (!endpointHint.test(endpoint) || seenEndpoints.has(endpoint)) continue;
    const options = getRequestOptions(script, match.index + match[0].length);
    seenEndpoints.add(endpoint);
    descriptors.push({
      endpoint,
      query: options.query,
      categoryParams: options.categoryParams,
      searchParams: options.searchParams,
      baseParam: "",
      baseUrl: apiBaseUrl,
      pageField: options.pageField,
    });
  }
  const staticCalls = [
    /\bfetch\s*\(\s*(["'])([^"'\\\s]{3,1024})\1/gi,
    /\.\s*get\s*\(\s*(["'])([^"'\\\s]{3,1024})\1/gi,
    /\.\s*get\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(["'])([^"'\\\s]{3,1024})\1/gi,
    /\.open\s*\(\s*(["'])GET\1\s*,\s*(["'])([^"'\\\s]{3,1024})\2/gi,
  ];
  const staticEndpoints = [];
  for (const pattern of staticCalls) {
    for (const match of String(script || "").matchAll(pattern)) {
      const raw = String(match.at(-1) || "").replace(/\\\//g, "/").trim();
      if (!raw || /\$\{|\{\{|[<>]/.test(raw)) continue;
      let parsed;
      try { parsed = new URL(raw, "https://same-origin.invalid/"); } catch { continue; }
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue;
      if (parsed.origin !== "https://same-origin.invalid"
        || !endpointHint.test(`${parsed.pathname}${parsed.search}`)
        || (parsed.pathname === "/" && !parsed.search)
        || [...parsed.searchParams.keys()].some((key) => /token|auth|sign|secret|password|api[_-]?key/i.test(key))) continue;
      const endpoint = parsed.pathname + parsed.search;
      if (seenEndpoints.has(endpoint)) continue;
      seenEndpoints.add(endpoint);
      const score = (/(?:list|catalog|home|recommend|category|class|search)/i.test(endpoint) ? 10 : 0)
        + (kind === "video"
          ? (/(?:video|vod|movie|film|tv|drama|series)/i.test(endpoint) ? 5 : 0)
          : (/(?:audio|voice|radio|podcast|music|track|album)/i.test(endpoint) ? 5 : 0));
      staticEndpoints.push({
        endpoint,
        query: {},
        baseParam: "",
        baseUrl: staticRequestBase(script, "", pageUrl),
        pageField: "",
        score,
      });
    }
  }
  const scoreDescriptor = (descriptor) => {
    const endpoint = String(descriptor.endpoint || "").split(/[?#]/, 1)[0];
    let score = Number(descriptor.score) || 0;
    if (/(?:^|\/)(?:categories|category|classes|class|types|type)(?:\/|$)/i.test(endpoint)) score += 100;
    if (/(?:^|\/)(?:videos?|movies?|vod|audio|voices?|tracks?|albums?|episodes?)(?:\/|$)/i.test(endpoint)) score += 35;
    if (/(?:list|catalog|directory|recommend|home|discover)/i.test(endpoint)) score += 20;
    if (descriptor.categoryParams?.length) score += 12;
    if (descriptor.searchParams?.length || /(?:^|\/)search(?:\/|$)/i.test(endpoint)) score += 8;
    if (/(?:auth|login|register|comment|track\/|analytics|config|related)/i.test(endpoint)) score -= 80;
    return score;
  };
  const ranked = [...descriptors, ...staticEndpoints]
    .map((descriptor) => ({ ...descriptor, score: scoreDescriptor(descriptor) }))
    .sort((left, right) => right.score - left.score);
  const unique = [];
  const seen = new Set();
  for (const descriptor of ranked) {
    const identity = `${descriptor.baseUrl || ""}\n${descriptor.endpoint}\n${JSON.stringify(descriptor.query || {})}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(descriptor);
  }
  return unique.slice(0, 12);
}

function arraysOfObjects(value, output = [], depth = 0, key = "") {
  if (!value || typeof value !== "object" || depth > 8) return output;
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (rows.length && key) output.push({ key, rows });
    for (const item of value.slice(0, 32)) arraysOfObjects(item, output, depth + 1, key);
    return output;
  }
  for (const [childKey, child] of Object.entries(value)) {
    arraysOfObjects(child, output, depth + 1, childKey);
  }
  return output;
}

function fieldFor(rows, patterns, predicate = () => true) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row || {})).filter((key) => SAFE_FIELD.test(key)));
  for (const pattern of patterns) {
    const key = [...keys].find((candidate) => pattern.test(candidate)
      && rows.some((row) => predicate(String(row?.[candidate] ?? ""))));
    if (key) return key;
  }
  return "";
}

function fieldsFor(rows, patterns, predicate = () => true) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row || {})).filter((key) => SAFE_FIELD.test(key)));
  const output = [];
  for (const pattern of patterns) {
    for (const candidate of keys) {
      if (output.includes(candidate) || !pattern.test(candidate)) continue;
      if (rows.some((row) => predicate(String(row?.[candidate] ?? "")))) output.push(candidate);
    }
  }
  return output;
}

function inferLists(payload, preferredId = "") {
  const grouped = new Map();
  for (const candidate of arraysOfObjects(payload)) {
    const { key, rows } = candidate;
    const names = fieldsFor(rows, [/^title$/i, /^name$/i, /name|title/i], (value) => value.length >= 2 && value.length <= 200);
    const ids = fieldsFor(rows, [
      ...(preferredId ? [new RegExp(`^${preferredId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")] : []),
      /^(?:voice|audio|episode|track|radio|item|target)?id$/i,
      /id$/i,
    ], (value) => /^[A-Za-z0-9_-]{1,100}$/.test(value));
    for (const name of names.slice(0, 3)) {
      for (const id of ids.slice(0, 6)) {
        const valid = rows.filter((row) => String(row?.[name] ?? "").trim() && String(row?.[id] ?? "").trim());
        if (!valid.length) continue;
        const groupKey = `${key}\n${name}\n${id}`;
        const existing = grouped.get(groupKey);
        if (existing) {
          existing.rows.push(...valid);
          continue;
        }
        grouped.set(groupKey, {
          listKey: key,
          rows: [...valid],
          name,
          id,
          cover: fieldFor(rows, [/imageUrl|cover|image|pic|thumb/i], (value) => /^(?:https?:)?\/\//i.test(value)),
          author: fieldFor(rows, [/author|creator|anchor|userName|imageRBText/i], (value) => value.length > 0 && value.length <= 100),
        });
      }
    }
  }
  return [...grouped.values()]
    .map((candidate) => ({
      ...candidate,
      detailUrl: fieldFor(candidate.rows, [
        /^(?:detailurl|detailhref|detaillink|url|href|link)$/i,
      ], (value) => /^(?:https?:\/\/|\/|\.\.\/|\.\/)/i.test(value.trim()) && value.length <= 2_048),
      rows: candidate.rows.filter((row, index, all) => (
        all.findIndex((item) => String(item[candidate.id]) === String(row[candidate.id])) === index
      )),
      score: candidate.rows.length * 20
        + (preferredId && candidate.id.toLowerCase() === preferredId.toLowerCase() ? 10_000 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

function representativeRows(rows, limit = 6) {
  if (rows.length <= limit) return rows;
  const indexes = [0, 1, 2, Math.floor(rows.length / 2), rows.length - 2, rows.length - 1];
  return [...new Set(indexes)].slice(0, limit).map((index) => rows[index]);
}

function leaves(value, path = "", output = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return output;
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_FIELD.test(key)) continue;
    const next = path ? `${path}/${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) leaves(child, next, output, depth + 1);
    else if (["string", "number"].includes(typeof child)) output.push({ path: next, key, value: String(child) });
  }
  return output;
}

function inferDetail(payload, preferredId = "") {
  let best = null;
  const visit = (value, propertyPath = [], depth = 0) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 7) return;
    const property = propertyPath.at(-1) || "";
    const values = leaves(value);
    const media = values.find((item) => MEDIA_URL.test(item.value));
    const id = values.find((item) => item.key === preferredId)
      || values.find((item) => /^(?:voice|audio|episode|track|radio|item)?id$/i.test(item.key));
    const name = values
      .filter((item) => !/(?:btn|button)/i.test(item.key)
        && (/^(?:name|title)$/i.test(item.key) || /name|title/i.test(item.key))
        && item.value.length >= 2)
      .sort((left, right) => {
        const idParent = String(id?.path || "").split("/").slice(0, -1).join("/");
        const score = (item) => {
          const parent = item.path.split("/").slice(0, -1).join("/");
          return (parent && parent === idParent ? 100 : 0)
            + (/^(?:name|title)$/i.test(item.key) ? 20 : 0)
            + (/(?:voice|audio|episode|track|radio)/i.test(item.path) ? 5 : 0);
        };
        return score(right) - score(left);
      })[0];
    if (property && media && name && id) {
      // Prefer the smallest nested object that still contains identity,
      // metadata and playable media. Parent response envelopes also contain
      // those leaves, but make unstable chapter containers.
      const score = depth;
      if (!best || score > best.score) {
        best = {
          score,
          container: propertyPath.join("/"),
          name: name.path,
          id: id.path,
          media: media.path,
          mediaProperty: media.key,
          cover: values.find((item) => /imageUrl|cover|image|pic|thumb/i.test(item.key) && /^https?:\/\//i.test(item.value))?.path || "",
          author: values.find((item) => /author|creator|anchor|user.*name/i.test(item.path) && item.value.length <= 100)?.path || "",
          cat: values.find((item) => /^(?:label|lable|category|class|genre|kind)name$/i.test(item.key)
            && item.value.length <= 100)?.path
            || values.find((item) => !/id$/i.test(item.key)
              && /label|lable|category|class|genre|kind/i.test(item.key)
              && item.value.length <= 100)?.path || "",
        };
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...propertyPath, key], depth + 1);
  };
  visit(payload, []);
  return best;
}

function requestUrl(origin, descriptor, pageIndex = 1) {
  let url;
  try { url = new URL(combineRequestUrl(origin, descriptor.baseUrl, descriptor.endpoint)); } catch { return ""; }
  let pageField = descriptor.pageField || "";
  for (const [name, raw] of Object.entries(descriptor.query || {})) {
    let value = String(raw);
    if (/^\{/.test(value) && /"page(?:No|Index)?"\s*:\s*\d+/i.test(value)) {
      value = value.replace(/("page(?:No|Index)?"\s*:\s*)\d+/i, `$1${pageIndex}`);
      pageField ||= name;
    } else if (name === pageField && /^\d+$/.test(value)) {
      value = String(pageIndex);
    }
    url.searchParams.set(name, value);
  }
  if (!pageField) {
    for (const name of url.searchParams.keys()) {
      if (/^(?:page|pageNo|pageIndex|pageNum)$/i.test(name) && /^\d+$/.test(url.searchParams.get(name) || "")) {
        url.searchParams.set(name, String(pageIndex));
        break;
      }
    }
  }
  return url.toString();
}

function pageTemplateUrl(pageUrl, descriptor) {
  try {
    const url = new URL(pageUrl);
    let pageField = descriptor.pageField || [...url.searchParams.keys()].find((name) => (
      /^(?:page|pageNo|pageIndex|pageNum)$/i.test(name)
    ));
    if (!pageField) {
      pageField = [...url.searchParams.keys()].find((name) => {
        try {
          const value = JSON.parse(url.searchParams.get(name) || "null");
          return value && typeof value === "object"
            && Object.keys(value).some((key) => /^(?:page|pageNo|pageIndex|pageNum)$/i.test(key));
        } catch {
          return false;
        }
      });
    }
    if (pageField && url.searchParams.has(pageField)) {
      const value = url.searchParams.get(pageField) || "";
      if (/^\d+$/.test(value)) url.searchParams.set(pageField, "%@pageIndex");
      else {
        try {
          const parsed = JSON.parse(value);
          const nestedPage = Object.keys(parsed || {}).find((name) => /^(?:page|pageNo|pageIndex|pageNum)$/i.test(name));
          if (nestedPage) {
            parsed[nestedPage] = "__PAGE__";
            const json = JSON.stringify(parsed).replace('"__PAGE__"', "%@pageIndex");
            url.searchParams.set(pageField, json);
          }
        } catch {
          // Keep non-JSON paging values unchanged.
        }
      }
    }
    return url.toString()
      .replace(/%25%40pageIndex/gi, "%@pageIndex")
      .replace(/%25%40keyWord/gi, "%@keyWord");
  } catch {
    return pageUrl;
  }
}

function actionRequest(adapterBase, endpoint, plan, extra = "", { keywordParam = "" } = {}) {
  const prefix = `${adapterBase}${endpoint}?plan=${encodeBridgePlan(plan)}${extra}&url=`;
  const source = [
    "@js:",
    'var p = String((params && params.pageIndex) || 1);',
    `var u = ${JSON.stringify(plan.upstreamTemplate)};`,
    'u = u.replace(/%@pageIndex/g, p);',
  ];
  if (keywordParam) {
    source.push('var k = String((params && params.keyWord) || "").trim();');
    source.push('u = u.replace(/%@keyWord/g, encodeURIComponent(k));');
  }
  source.push(`return ${JSON.stringify(prefix)}.replace(/%@pageIndex/g, p) + encodeURIComponent(u);`);
  return source.join("\n");
}

function itemRequest(adapterBase, endpoint, plan) {
  const prefix = `${adapterBase}${endpoint}?plan=${encodeBridgePlan(plan)}&url=`;
  return [
    "@js:",
    'var q = (params && params.queryInfo) || {};',
    'var u = String(result || q.chapterUrl || q.detailUrl || q.url || "").trim();',
    `return ${JSON.stringify(prefix)} + encodeURIComponent(u);`,
  ].join("\n");
}

function shell(actionID, host, responseFormatType = "json") {
  return { actionID, validConfig: "", host, responseFormatType, parserID: "DOM" };
}

export async function discoverSpaMedia(originUrl, kind, {
  download,
  homeHtml,
  homeResponseUrl = "",
  adapterBase = "",
  repairSource = null,
  diagnostics = [],
} = {}) {
  if (!["audio", "video"].includes(kind) || typeof download !== "function") return null;
  const adapter = adapterOrigin(adapterBase);
  if (!adapter) return null;
  const originalOrigin = new URL(originUrl).origin;
  const pageUrl = homeResponseUrl || originUrl;
  const scriptRecords = await loadScriptTree(homeHtml, pageUrl, download);
  const scripts = scriptRecords.map((record) => record.text);
  const combinedScript = scripts.join("\n");
  const descriptors = requestDescriptors(combinedScript, kind, pageUrl);
  const detailTemplate = bridgeDetailTemplate(repairSource)
    || staticDetailTemplates(combinedScript, kind, pageUrl)[0]
    || null;
  const mediaProxyTemplate = staticMediaProxyTemplates(scripts, pageUrl)[0] || null;
  if (!descriptors.length) {
    diagnostics.push(`spa-api: ${scripts.length} 个脚本中未发现静态 JSON 目录请求`);
    return null;
  }
  const candidateOrigins = [...new Set([originalOrigin, new URL(pageUrl).origin])];
  const headers = { "X-Fingerprint": randomUUID() };
  let payloadCount = 0;
  let listCount = 0;
  let detailCount = 0;
  let mediaDetailCount = 0;
  const attemptedIdFields = new Set();
  const categoryCatalog = [];
  const endpointUrl = (descriptor) => requestUrl(originalOrigin, descriptor, 1);
  const isCategoryEndpoint = (descriptor) => {
    try {
      return /(?:^|\/)(?:categories|category|classes|class|types|type)(?:\/|$)/i
        .test(new URL(endpointUrl(descriptor)).pathname);
    } catch {
      return false;
    }
  };

  // Category APIs are metadata, not book/video lists. Discover their IDs and
  // labels first so dynamic category query parameters can be populated below.
  for (const descriptor of descriptors.filter(isCategoryEndpoint)) {
    for (const apiOrigin of candidateOrigins) {
      let payload;
      try {
        const url = endpointUrl(descriptor);
        if (new URL(url).origin !== apiOrigin) continue;
        payload = JSON.parse((await download(url, headers)).toString("utf8"));
        payloadCount += 1;
      } catch {
        continue;
      }
      for (const list of inferLists(payload)) {
        for (const row of list.rows) {
          const id = String(row?.[list.id] ?? "").trim();
          const name = String(row?.[list.name] ?? "").trim();
          if (!id || !name || name.length > 100 || row?.enabled === false || row?.enabled === 0) continue;
          if (!categoryCatalog.some((item) => item.id === id)) categoryCatalog.push({ id, name });
        }
      }
    }
  }

  for (const descriptor of descriptors) {
    if (isCategoryEndpoint(descriptor)) continue;
    const categoryVariants = descriptor.categoryParams?.length && categoryCatalog.length
      ? categoryCatalog
      : [null];
    for (const categoryVariant of categoryVariants) {
      const variantDescriptor = {
        ...descriptor,
        query: { ...(descriptor.query || {}) },
      };
      if (categoryVariant) {
        for (const name of descriptor.categoryParams) variantDescriptor.query[name] = categoryVariant.id;
      }
    for (const apiOrigin of candidateOrigins) {
      let listPayload;
      let page1Url;
      try {
        page1Url = requestUrl(apiOrigin, variantDescriptor, 1);
        if (new URL(page1Url).origin !== apiOrigin) continue;
        listPayload = JSON.parse((await download(page1Url, headers)).toString("utf8"));
        payloadCount += 1;
      } catch {
        continue;
      }
      const lists = inferLists(listPayload, detailTemplate?.idField || "");
      if (!lists.length) continue;
      listCount += lists.length;
      for (const list of lists) {
        attemptedIdFields.add(list.id);
        const rows = list.rows;
        for (const sample of representativeRows(rows)) {
          let detailUrl = "";
          let detailPayload;
          try {
            if (detailTemplate) {
              detailUrl = `${detailTemplate.prefix}${encodeURIComponent(String(sample[list.id]))}${detailTemplate.suffix || ""}`;
            } else if (list.detailUrl) {
              detailUrl = new URL(String(sample[list.detailUrl] || ""), apiOrigin).toString();
              if (!candidateOrigins.includes(new URL(detailUrl).origin)) continue;
            } else {
              continue;
            }
            detailPayload = JSON.parse((await download(detailUrl, headers)).toString("utf8"));
            detailCount += 1;
            if (leaves(detailPayload).some((item) => MEDIA_URL.test(item.value))) mediaDetailCount += 1;
          } catch {
            continue;
          }
          const detail = inferDetail(detailPayload, list.id);
          if (!detail?.container) continue;

      const page2Url = requestUrl(apiOrigin, variantDescriptor, 2);
      let page2Count = 0;
      try {
        const page2 = JSON.parse((await download(page2Url, headers)).toString("utf8"));
        const second = arraysOfObjects(page2)
          .filter((candidate) => candidate.key === list.listKey)
          .flatMap((candidate) => candidate.rows)
          .filter((row) => row?.[list.name] && row?.[list.id]);
        const firstIds = new Set(rows.map((row) => String(row[list.id])));
        if (second.some((row) => !firstIds.has(String(row[list.id])))) page2Count = second.length;
      } catch {
        // A valid first page still provides a usable category.
      }

      const listPlan = {
        version: 1,
        kind: "books",
        host: apiOrigin,
        responseType: "json",
        list: `@json-recursive:${encodeURIComponent(list.listKey)}`,
        fields: {
          name: { selector: list.name },
          url: detailTemplate
            ? {
              selector: list.id,
              matchTemplate: { pattern: "^([\\s\\S]+)$", prefix: detailTemplate.prefix, suffix: detailTemplate.suffix || "", hostPrefix: false },
            }
            : {
              selector: list.detailUrl,
              hostPrefix: /^\/(?!\/)/.test(String(sample[list.detailUrl] || "")),
            },
          ...(list.cover ? { cover: { selector: list.cover } } : {}),
          ...(list.author ? { author: { selector: list.author } } : {}),
        },
        headers,
      };
      const categoryDefinitions = descriptor.categoryParams?.length && categoryCatalog.length
        ? categoryCatalog
        : [{ name: "站点推荐", id: "" }];

      const detailPlan = {
        version: 1,
        kind: "detail",
        host: new URL(detailUrl).origin,
        responseType: "json",
        fields: {
          name: { selector: `@json-recursive:${encodeURIComponent(detail.name)}` },
          ...(detail.cover ? { cover: { selector: `@json-recursive:${encodeURIComponent(detail.cover)}` } } : {}),
          ...(detail.author ? { author: { selector: `@json-recursive:${encodeURIComponent(detail.author)}` } } : {}),
          ...(detail.cat ? { cat: { selector: `@json-recursive:${encodeURIComponent(detail.cat)}` } } : {}),
        },
        headers,
      };
      const chapterPlan = {
        version: 1,
        kind: "chapters",
        host: new URL(detailUrl).origin,
        responseType: "json",
        list: `@json-recursive:${encodeURIComponent(detail.container)}`,
        fields: {
          title: { selector: detail.name },
          url: mediaProxyTemplate
            ? {
              selector: detail.media,
              urlTemplate: `${mediaProxyTemplate.prefix}{{${mediaProxyTemplate.valueMode}:media}}${mediaProxyTemplate.suffix}`,
              rootTemplateFields: { media: [detail.container, detail.media].filter(Boolean).join("/") },
            }
            : { selector: detail.media },
        },
        headers,
      };
      const mediaPlan = encodeMediaExtractionPlan({
        kind,
        properties: [detail.mediaProperty],
        attributes: ["src"],
        urlHints: [],
        headers,
      });
      const bookWorld = {};
      for (const [index, categoryDefinition] of categoryDefinitions.entries()) {
        const categoryName = String(categoryDefinition.name || `站点推荐${index ? ` ${index + 1}` : ""}`).trim().slice(0, 100);
        const uniqueName = bookWorld[categoryName]
          ? `${categoryName} (${index + 1})`
          : categoryName;
        const categoryDescriptor = {
          ...descriptor,
          query: { ...(descriptor.query || {}) },
        };
        if (categoryDefinition.id) {
          for (const name of descriptor.categoryParams) categoryDescriptor.query[name] = categoryDefinition.id;
        }
        const categoryPlan = {
          ...listPlan,
          upstreamTemplate: pageTemplateUrl(requestUrl(apiOrigin, categoryDescriptor, 1), categoryDescriptor),
        };
        bookWorld[uniqueName] = {
          ...shell("bookWorld", apiOrigin),
          requestInfo: actionRequest(adapter, "/adapter/books", categoryPlan, "&page=%@pageIndex&pageSize=20"),
          list: "$.data",
          bookName: "name",
          detailUrl: "url",
          author: "author",
          cover: "cover",
          moreKeys: { pageSize: 20, ...(page2Count ? { maxPage: 200 } : { maxPage: 1 }) },
          _sIndex: index,
        };
      }
      const searchDescriptor = descriptors.find((item) => item.searchParams?.length
        && /search/i.test(item.endpoint));
      let searchBook = { ...Object.values(bookWorld)[0], actionID: "searchBook" };
      if (searchDescriptor) {
        const keywordParam = searchDescriptor.searchParams[0];
        const searchRequestDescriptor = {
          ...searchDescriptor,
          query: { ...(searchDescriptor.query || {}), [keywordParam]: "%@keyWord" },
        };
        const searchPlan = {
          ...listPlan,
          upstreamTemplate: pageTemplateUrl(requestUrl(apiOrigin, searchRequestDescriptor, 1), searchRequestDescriptor),
        };
        searchBook = {
          ...Object.values(bookWorld)[0],
          ...shell("searchBook", apiOrigin),
          requestInfo: actionRequest(
            adapter,
            "/adapter/books",
            searchPlan,
            "&page=%@pageIndex&pageSize=20",
            { keywordParam },
          ),
        };
      }
      const source = {
        sourceName: repairSource?.sourceName || new URL(originUrl).hostname,
        sourceUrl: originalOrigin,
        weight: "100",
        enable: 1,
        miniAppVersion: "2.56.1",
        authorId: "",
        sourceType: kind,
        httpHeaders: headers,
        bookWorld,
        searchBook,
        bookDetail: {
          ...shell("bookDetail", new URL(detailUrl).origin),
          requestInfo: itemRequest(adapter, "/adapter/detail", detailPlan),
          bookName: "$.name",
          author: "$.author",
          cat: "$.cat",
          cover: "$.cover",
        },
        chapterList: {
          ...shell("chapterList", new URL(detailUrl).origin),
          requestInfo: itemRequest(adapter, "/adapter/chapters", chapterPlan),
          list: "$.data",
          title: "title",
          url: "url",
        },
        chapterContent: {
          ...shell("chapterContent", new URL(detailUrl).origin),
          requestInfo: [
            "@js:",
            'var q = (params && params.queryInfo) || {};',
            'var u = String(result || q.chapterUrl || "").trim();',
            'var ref = String(q.detailUrl || q.url || "").trim();',
            `return ${JSON.stringify(`${adapter}/adapter/media?kind=${kind}&plan=${mediaPlan}&url=`)} + encodeURIComponent(u) + (ref ? "&referer=" + encodeURIComponent(ref) : "");`,
          ].join("\n"),
          content: [
            "@js:",
            'var item = result || {};',
            'if (typeof item === "string") { try { item = JSON.parse(item); } catch (e) { item = { url: item }; } }',
            'var url = String(item.url || "").trim();',
            'if (!url) return "";',
            'var headers = {}; var baseHeaders = (config && config.httpHeaders) || {}; var mediaHeaders = item.httpHeaders || item.headers || {};',
            'for (var key in baseHeaders) headers[key] = baseHeaders[key];',
            'for (var name in mediaHeaders) headers[name] = mediaHeaders[name];',
            'return JSON.stringify({url: (function () { try { return encodeURI(decodeURI(url)); } catch (e) { return encodeURI(url); } })(), httpHeaders: headers, forbidCache: true});',
          ].join("\n"),
        },
      };
      return {
        kind,
        host: originalOrigin,
        title: source.sourceName,
        source,
        bookCount: rows.length,
        chapterCount: 1,
        mediaSampleUrl: leaves(detailPayload).find((item) => MEDIA_URL.test(item.value))?.value || "",
      };
        }
      }
    }
    }
  }
  diagnostics.push(`spa-api: 未发现可执行的 JSON 媒体目录（请求 ${descriptors.length}，响应 ${payloadCount}，列表 ${listCount}，详情 ${detailCount}，含媒体 ${mediaDetailCount}，ID ${[...attemptedIdFields].join("/") || "无"}）`);
  return null;
}
