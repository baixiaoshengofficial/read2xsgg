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
    values.set(match[1], Number(match[2]));
  }
  return values;
}

function formFields(objectSource) {
  const fields = [];
  for (const match of String(objectSource || "").matchAll(/(?:^|,)\s*([A-Za-z_$][\w$-]{0,63})\s*:\s*([^,}\n]{1,300})/g)) {
    fields.push({ name: match[1], expression: match[2].trim() });
  }
  return fields;
}

function postCandidates(script, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const numbers = numericScriptValues(script);
  const candidates = [];
  const pattern = /(?:\$|jQuery)\.post\s*\(\s*(["'`])([^"'`]{1,500})\1\s*,\s*\{([\s\S]{1,3000}?)\}\s*,/g;
  for (const match of String(script || "").matchAll(pattern)) {
    let endpoint;
    try { endpoint = new URL(match[2].replace(/\\\//g, "/"), pageUrl); } catch { continue; }
    if (endpoint.origin !== origin || !API_PATH.test(endpoint.pathname) || !COMIC_PATH.test(endpoint.pathname)) continue;
    const fields = formFields(match[3]);
    if (!fields.length || !fields.some(({ name, expression }) => /(?:chapter|cid|id)/i.test(`${name} ${expression}`))) continue;
    candidates.push({
      endpoint: endpoint.toString(),
      fields,
      numbers,
      score: (/(?:pics?|images?|pictures?|pages?)/i.test(endpoint.pathname) ? 100 : 0)
        + (fields.some(({ name }) => /^(?:offset|start|skip)$/i.test(name)) ? 30 : 0)
        + (fields.some(({ name }) => /^(?:limit|size|count|batch)$/i.test(name)) ? 20 : 0),
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
    return String(variable && context.numbers.has(variable) ? context.numbers.get(variable) : 20);
  }
  const literal = expression.match(/^(["'])([^"']*)\1$/)?.[2]
    || expression.match(/^(\d{1,18})$/)?.[1];
  if (literal !== undefined) return literal;
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
  const context = {
    numbers: candidate.numbers,
    values: scalarPageValues(html),
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

async function postJson(candidate, html, pageUrl, download, headers, overrides = {}) {
  const body = requestBody(candidate, html, pageUrl, overrides);
  if (!body.size) return null;
  const response = await download(candidate.endpoint, {
    ...headers,
    Referer: pageUrl,
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
  probeOnly = false,
  maxImages = 2_000,
  maxRequests = 100,
  concurrency = 4,
} = {}) {
  if (typeof download !== "function") return { urls: [], candidate: null };
  const documents = [{ body: String(html || ""), url: pageUrl }];
  for (const scriptUrl of linkedScriptUrls(html, pageUrl)) {
    try {
      const response = await download(scriptUrl, headers);
      documents.push({
        body: decodeTextBuffer(response, { headers: response?.httpHeaders || {} }),
        url: String(response?.read2xsggResponseUrl || scriptUrl),
      });
    } catch {
      // Continue with the remaining same-origin scripts.
    }
  }
  const candidates = documents
    .flatMap((document) => postCandidates(document.body, document.url))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  for (const candidate of candidates) {
    let first;
    try { first = await postJson(candidate, html, pageUrl, download, headers); } catch { continue; }
    const firstUrls = imageSequence(first, candidate.endpoint);
    if (firstUrls.length < 2) continue;
    if (probeOnly) return { urls: firstUrls, candidate };
    const offsetField = candidate.fields.find(({ name }) => /^(?:offset|start|skip|from)$/i.test(name));
    const limitField = candidate.fields.find(({ name }) => /^(?:limit|size|count|batch|pagesize)$/i.test(name));
    const total = numericMetadata(first, /^(?:total|totalCount|count|picCount|imageCount)$/i);
    const firstOffset = numericMetadata(first, /^(?:offset|start|skip|from)$/i) || 0;
    const responseLimit = numericMetadata(first, /^(?:limit|size|pageSize|batch)$/i);
    const requestLimit = Number(requestBody(candidate, html, pageUrl).get(limitField?.name) || 0);
    const limit = responseLimit || requestLimit || firstUrls.length;
    if (!offsetField || !limitField || !total || total <= firstOffset + limit) {
      return { urls: firstUrls.slice(0, maxImages), candidate };
    }
    const offsets = [];
    for (let offset = firstOffset + limit; offset < total && offsets.length < maxRequests - 1; offset += limit) {
      offsets.push(offset);
    }
    const batches = Array.from({ length: offsets.length }, () => []);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), offsets.length) }, async () => {
      while (cursor < offsets.length) {
        const index = cursor;
        cursor += 1;
        try {
          const payload = await postJson(candidate, html, pageUrl, download, headers, {
            [offsetField.name]: offsets[index],
            [limitField.name]: limit,
          });
          batches[index] = imageSequence(payload, candidate.endpoint);
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
