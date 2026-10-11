import { decodeTextBuffer } from "../charset.js";

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i;
const IMAGE_PROPERTY = /(?:url|uri|src|source|image|img|pic|picture|file|path)/i;
const API_PATH = /(?:^|\/)api(?:\/|$)/i;
const COMIC_PATH = /(?:comic|chapter|reader|image|picture|pages?|pics?)/i;

function linkedScriptUrls(html, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const urls = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], pageUrl);
      if (url.origin !== origin || urls.includes(url.toString())) continue;
      if (/(?:jquery|bootstrap|cloudflare|analytics|signalr|sweetalert|vendor)(?:[.-]|\/)/i.test(url.pathname)) continue;
      urls.push(url.toString());
    } catch {
      // Optional malformed scripts do not invalidate the chapter page.
    }
  }
  return urls.slice(0, 8);
}

function scalarPageValues(html) {
  const values = new Map();
  const add = (name, value) => {
    const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const text = String(value ?? "").trim();
    if (key && text && text.length <= 256 && !values.has(key)) values.set(key, text);
  };
  for (const match of String(html || "").matchAll(/\bdata-([a-z][\w-]{0,63})\s*=\s*["']([^"']+)["']/gi)) {
    add(match[1], match[2]);
  }
  for (const match of String(html || "").matchAll(/\b([A-Za-z_$][\w$]{0,63})\s*:\s*(["'])([^"']+)\2/g)) {
    add(match[1], match[3]);
  }
  for (const match of String(html || "").matchAll(/\b([A-Za-z_$][\w$]{0,63})\s*:\s*(\d{1,18})\b/g)) {
    add(match[1], match[2]);
  }
  return values;
}

function numericScriptValues(script) {
  const values = new Map();
  for (const match of String(script || "").matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]{0,63})\s*=\s*(\d{1,6})\b/g)) {
    values.set(match[1].toLowerCase().replace(/[^a-z0-9]/g, ""), Number(match[2]));
  }
  return values;
}

function scriptScalarValues(script) {
  const values = new Map();
  const add = (name, value) => {
    const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const text = String(value ?? "").trim();
    if (key && text && text.length <= 512 && !values.has(key)) values.set(key, text);
  };
  for (const match of String(script || "").matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]{0,63})\s*=\s*(["'`])([\s\S]{1,512}?)\2/g,
  )) {
    if (!match[3].includes("${")) add(match[1], match[3].replace(/\\([\\/'"`])/g, "$1"));
  }
  for (const [key, value] of numericScriptValues(script)) add(key, value);
  return values;
}

function objectProperties(objectSource) {
  const properties = [];
  const source = String(objectSource || "");
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /[\s,]/.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;
    const keyStart = cursor;
    let name = "";
    if (/['"]/.test(source[cursor])) {
      const quote = source[cursor++];
      const end = source.indexOf(quote, cursor);
      if (end < 0) break;
      name = source.slice(cursor, end);
      cursor = end + 1;
    } else {
      const match = source.slice(cursor).match(/^[A-Za-z_$][\w$-]{0,63}/);
      if (!match) {
        cursor += 1;
        continue;
      }
      name = match[0];
      cursor += name.length;
    }
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== ":") {
      cursor = keyStart + 1;
      continue;
    }
    cursor += 1;
    const valueStart = cursor;
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === "," && depth === 0) break;
    }
    properties.push({ name, expression: source.slice(valueStart, cursor).trim() });
    if (source[cursor] === ",") cursor += 1;
  }
  return properties;
}

function formFields(objectSource) {
  return objectProperties(objectSource);
}

function balancedObject(source, start) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start + 1, cursor);
  }
  return "";
}

function staticExpressionValue(expression, values) {
  const source = String(expression || "").trim().replace(/;$/, "").trim();
  const literal = source.match(/^(["'`])([\s\S]*)\1$/)?.[2];
  if (literal !== undefined && !literal.includes("${")) {
    return literal.replace(/\\([\\/'"`])/g, "$1");
  }
  const variable = source.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  return variable ? pageValue(values, [variable]) : "";
}

function endpointForExpression(expression, pageUrl, values) {
  const value = staticExpressionValue(expression, values);
  if (!value) return null;
  try { return new URL(value.replace(/\\\//g, "/"), pageUrl); } catch { return null; }
}

function requestCandidateScore(endpoint, fields) {
  const endpointText = `${endpoint.pathname}${endpoint.search}`;
  return (/(?:pics?|images?|pictures?|pages?)/i.test(endpointText) ? 100 : 0)
    + (/(?:ajax|api|reader|comic|chapter|read)/i.test(endpointText) ? 50 : 0)
    + (fields.some(({ name }) => /^(?:offset|start|skip|from)$/i.test(name)) ? 30 : 0)
    + (fields.some(({ name }) => /^(?:limit|size|count|batch|pagesize)$/i.test(name)) ? 20 : 0)
    + (fields.some(({ name, expression }) => /(?:chapter|episode|section|comic|manga|book|album|zjid|kuid|cid|id)/i.test(`${name} ${expression}`)) ? 20 : 0);
}

function postCandidates(script, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const numbers = numericScriptValues(script);
  const values = scriptScalarValues(script);
  const candidates = [];
  const pattern = /(?:\$|jQuery)\.post\s*\(\s*(["'`])([^"'`]{1,500})\1\s*,\s*\{([\s\S]{1,3000}?)\}\s*,/g;
  for (const match of String(script || "").matchAll(pattern)) {
    let endpoint;
    try { endpoint = new URL(match[2].replace(/\\\//g, "/"), pageUrl); } catch { continue; }
    if (endpoint.origin !== origin) continue;
    const fields = formFields(match[3]);
    const endpointText = `${endpoint.pathname}${endpoint.search}`;
    const fieldText = fields.map(({ name, expression }) => `${name} ${expression}`).join(" ");
    const legacyApiHint = API_PATH.test(endpoint.pathname) && COMIC_PATH.test(endpoint.pathname);
    const genericApiHint = /(?:ajax|api|comic|chapter|reader|read|image|picture|page|pic)/i.test(`${endpointText} ${fieldText}`);
    const hasPageIdentity = fields.some(({ name, expression }) => /(?:chapter|episode|section|comic|manga|book|album|zjid|kuid|cid|id)/i.test(`${name} ${expression}`));
    if (!fields.length || (!legacyApiHint && !genericApiHint) || !hasPageIdentity) continue;
    candidates.push({
      endpoint: endpoint.toString(),
      fields,
      numbers,
      values,
      score: requestCandidateScore(endpoint, fields),
    });
  }
  return candidates;
}

function ajaxCandidates(script, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const numbers = numericScriptValues(script);
  const values = scriptScalarValues(script);
  const candidates = [];
  const source = String(script || "");
  for (const match of source.matchAll(/(?:\$|jQuery)\.ajax\s*\(\s*\{/g)) {
    const objectStart = source.indexOf("{", match.index);
    const objectSource = balancedObject(source, objectStart);
    if (!objectSource) continue;
    const properties = objectProperties(objectSource);
    const urlExpression = properties.find(({ name }) => /^url$/i.test(name))?.expression;
    const methodExpression = properties.find(({ name }) => /^(?:type|method)$/i.test(name))?.expression;
    const method = staticExpressionValue(methodExpression || "'POST'", values).toUpperCase();
    if (method !== "POST") continue;
    const endpoint = endpointForExpression(urlExpression, pageUrl, values);
    if (!endpoint || endpoint.origin !== origin) continue;
    const dataExpression = properties.find(({ name }) => /^data$/i.test(name))?.expression || "";
    const dataSource = dataExpression.trim().startsWith("{") && dataExpression.trim().endsWith("}")
      ? dataExpression.trim().slice(1, -1)
      : "";
    const fields = formFields(dataSource);
    const endpointText = `${endpoint.pathname}${endpoint.search}`;
    const hasImageApiHint = /(?:ajax|api|comic|chapter|reader|read|image|picture|page|pic)/i.test(endpointText);
    const hasPageIdentity = fields.some(({ name, expression }) => /(?:chapter|episode|section|comic|manga|book|album|zjid|kuid|cid|id)/i.test(`${name} ${expression}`));
    if (!fields.length || !hasImageApiHint || !hasPageIdentity) continue;
    candidates.push({
      endpoint: endpoint.toString(),
      fields,
      numbers,
      values,
      score: requestCandidateScore(endpoint, fields) + 10,
    });
  }
  return candidates;
}

function finalNumericPathValue(pageUrl) {
  try {
    return new URL(pageUrl).pathname.match(/\d+/g)?.at(-1) || "";
  } catch {
    return "";
  }
}

function pageValue(values, names) {
  for (const name of names) {
    const value = values.get(String(name).toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value) return value;
  }
  return "";
}

function resolvedFieldValue(field, context) {
  const name = field.name.toLowerCase();
  const expression = field.expression;
  const identity = `${name} ${expression}`;
  if (/^(?:offset|start|skip|from)$/i.test(name)) return "0";
  if (/^(?:page|pageindex|pageno|pagenum)$/i.test(name)) return "1";
  if (/^(?:limit|size|count|batch|pagesize)$/i.test(name)) {
    const variable = expression.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    const normalized = variable?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const value = variable && (pageValue(context.values, [variable])
      || (normalized ? context.numbers.get(normalized) : ""));
    return String(value || 20);
  }
  const literal = expression.match(/^(["'])([^"']*)\1$/)?.[2]
    || expression.match(/^(\d{1,18})$/)?.[1];
  if (literal !== undefined) return literal;
  const variable = expression.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  const declaredValue = variable && pageValue(context.values, [variable]);
  if (declaredValue) return declaredValue;
  if (/(?:\baid\b|album|book|comic|manga|work)/i.test(identity)) {
    return pageValue(context.values, [name, "aid", "albumId", "bookId", "comicId", "mangaId", "workId"]);
  }
  if (/(?:chapter|episode|section|apiCid|\bcid\b)/i.test(identity)) {
    return pageValue(context.values, [name, "chapterId", "apiCid", "cid", "episodeId", "sectionId"])
      || context.pathId;
  }
  return pageValue(context.values, [name])
    || (/^(?:id|cid)$/i.test(name) ? context.pathId : "");
}

function requestBody(candidate, html, pageUrl, overrides = {}) {
  const values = scalarPageValues(html);
  for (const [key, value] of candidate.values || []) values.set(key, value);
  const context = {
    numbers: candidate.numbers,
    values,
    pathId: finalNumericPathValue(pageUrl),
  };
  const body = new URLSearchParams();
  for (const field of candidate.fields) {
    const value = Object.hasOwn(overrides, field.name)
      ? overrides[field.name]
      : resolvedFieldValue(field, context);
    if (value !== "" && value !== undefined && value !== null) body.set(field.name, String(value));
  }
  return body;
}

function normalizedImage(value, baseUrl) {
  const raw = String(value || "").replace(/\\\//g, "/").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/.test(url.protocol) && IMAGE_EXTENSION.test(url.toString()) ? url.toString() : "";
  } catch {
    return "";
  }
}

function imageSequence(root, baseUrl) {
  let best = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 10) return;
    if (Array.isArray(value)) {
      const urls = [];
      for (const item of value) {
        let raw = typeof item === "string" ? item : "";
        if (item && typeof item === "object" && !Array.isArray(item)) {
          for (const [key, child] of Object.entries(item)) {
            if (IMAGE_PROPERTY.test(key) && typeof child === "string") {
              raw = child;
              if (normalizedImage(raw, baseUrl)) break;
            }
          }
        }
        const url = normalizedImage(raw, baseUrl);
        if (url && !urls.includes(url)) urls.push(url);
      }
      if (urls.length > best.length) best = urls;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(root);
  return best;
}

function numericMetadata(root, matcher) {
  let found = null;
  const visit = (value, depth = 0) => {
    if (found !== null || !value || typeof value !== "object" || depth > 8) return;
    if (!Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (!matcher.test(key)) continue;
        const number = Number(child);
        if (Number.isInteger(number) && number >= 0) {
          found = number;
          return;
        }
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(root);
  return found;
}

function responseCookieHeader(responseHeaders) {
  const raw = Object.entries(responseHeaders || {})
    .find(([key]) => key.toLowerCase() === "set-cookie")?.[1];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values
    .map((value) => String(value).split(";", 1)[0].trim())
    .filter((value) => /^[^=;\s]+=[^;]*$/.test(value))
    .join("; ");
}

async function postJson(candidate, html, pageUrl, download, headers, responseHeaders, overrides = {}) {
  const body = requestBody(candidate, html, pageUrl, overrides);
  if (!body.size) return null;
  const cookie = responseCookieHeader(responseHeaders);
  const hasCookie = Object.keys(headers || {}).some((key) => key.toLowerCase() === "cookie");
  const response = await download(candidate.endpoint, {
    ...headers,
    Referer: pageUrl,
    ...(!hasCookie && cookie ? { Cookie: cookie } : {}),
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
  }, { method: "POST", body: body.toString() });
  try {
    return JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
  } catch {
    return null;
  }
}

/**
 * Discover and execute a same-origin form POST image API declared by a chapter
 * page's own scripts. No remote JavaScript is evaluated.
 */
export async function dynamicComicApiImages(html, pageUrl, {
  download,
  headers = {},
  responseHeaders = {},
  probeOnly = false,
  maxImages = 2_000,
  maxRequests = 100,
  concurrency = 4,
} = {}) {
  if (typeof download !== "function") return { urls: [], candidate: null };
  const documents = [{ body: String(html || ""), url: pageUrl }];
  const scriptDocuments = await Promise.all(linkedScriptUrls(html, pageUrl).map(async (scriptUrl) => {
    try {
      const response = await download(scriptUrl, headers);
      return {
        body: decodeTextBuffer(response, { headers: response?.httpHeaders || {} }),
        url: String(response?.read2xsggResponseUrl || scriptUrl),
      };
    } catch {
      // Continue with the remaining same-origin scripts.
      return null;
    }
  }));
  documents.push(...scriptDocuments.filter(Boolean));
  const candidates = documents
    .flatMap((document) => [
      ...postCandidates(document.body, document.url),
      ...ajaxCandidates(document.body, document.url),
    ])
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  for (const candidate of candidates) {
    let first;
    try { first = await postJson(candidate, html, pageUrl, download, headers, responseHeaders); } catch { continue; }
    const firstUrls = imageSequence(first, candidate.endpoint);
    if (firstUrls.length < 2) continue;
    if (probeOnly) return { urls: firstUrls, candidate };
    const offsetField = candidate.fields.find(({ name }) => /^(?:offset|start|skip|from)$/i.test(name));
    const limitField = candidate.fields.find(({ name }) => /^(?:limit|size|count|batch|pagesize)$/i.test(name));
    const total = numericMetadata(first, /^(?:total|totalCount|picCount|imageCount)$/i);
    const firstOffset = numericMetadata(first, /^(?:offset|start|skip|from)$/i) || 0;
    const responseLimit = numericMetadata(first, /^(?:limit|size|pageSize|batch)$/i);
    const requestLimit = Number(requestBody(candidate, html, pageUrl).get(limitField?.name) || 0);
    const limit = responseLimit || requestLimit || firstUrls.length;
    if (!offsetField || !limitField) {
      return { urls: firstUrls.slice(0, maxImages), candidate };
    }
    const hasKnownMore = total !== null && total > firstOffset + limit;
    const hasUnknownMore = total === null && firstUrls.length >= limit;
    if (!hasKnownMore && !hasUnknownMore) {
      return { urls: firstUrls.slice(0, maxImages), candidate };
    }
    const offsets = [];
    const requestCount = Math.max(0, Math.floor(Number(maxRequests) || 0) - 1);
    const lastOffset = total === null ? Infinity : total;
    for (let offset = firstOffset + limit; offset < lastOffset && offsets.length < requestCount; offset += limit) {
      offsets.push(offset);
    }
    const batches = Array.from({ length: offsets.length }, () => []);
    let cursor = 0;
    let exhausted = false;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), offsets.length) }, async () => {
      while (cursor < offsets.length && !exhausted) {
        const index = cursor;
        cursor += 1;
        try {
          const payload = await postJson(candidate, html, pageUrl, download, headers, responseHeaders, {
            [offsetField.name]: offsets[index],
            [limitField.name]: limit,
          });
          batches[index] = imageSequence(payload, candidate.endpoint);
          if (total === null && batches[index].length < limit) exhausted = true;
        } catch {
          // Preserve all other successfully fetched image batches.
        }
      }
    });
    await Promise.all(workers);
    const urls = [];
    for (const url of [firstUrls, ...batches].flat()) {
      if (url && !urls.includes(url)) urls.push(url);
      if (urls.length >= maxImages) break;
    }
    return { urls, candidate };
  }
  return { urls: [], candidate: null };
}
