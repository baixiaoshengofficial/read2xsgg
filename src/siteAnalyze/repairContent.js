import {
  classContainsXPath,
  loadDocument,
  visibleText,
  xpathForElement,
} from "./domUtil.js";
import { withNovelHtmlStripped } from "./toXiangse.js";
import { decodeTextBuffer } from "../charset.js";
import { compileComicExtractionPlan, encodeComicExtractionPlan } from "../comicPlan.js";
import { dynamicComicApiImages } from "./dynamicComic.js";

const SEMANTIC_TOKEN = /(?:content|chapter|article|read|正文|内容)/i;
const NOISE_TOKEN = /(?:nav|menu|footer|header|comment|recommend|related|广告|推荐|目录)/i;

function stableContentSelector(element, document) {
  const id = String(element.id || "").trim();
  if (id && !/["']/.test(id)
    && document.querySelectorAll(`[id="${id.replace(/(["\\])/g, "\\$1")}"]`).length === 1) {
    return `//*[@id='${id}']`;
  }
  for (const token of String(element.className || "").split(/\s+/).filter(Boolean)) {
    if (!SEMANTIC_TOKEN.test(token) || NOISE_TOKEN.test(token) || /\d{4,}|^[a-f0-9]{8,}$/i.test(token)) continue;
    if (document.getElementsByClassName(token).length === 1) return classContainsXPath(token);
  }
  const tag = String(element.tagName || "").toLowerCase();
  if (["article", "main"].includes(tag) && document.querySelectorAll(tag).length === 1) return `//${tag}`;
  return xpathForElement(element, document);
}

function contentScore(element) {
  const text = visibleText(element);
  if (text.length < 80) return -Infinity;
  const linkText = [...element.querySelectorAll("a")]
    .reduce((size, link) => size + visibleText(link).length, 0);
  const linkRatio = linkText / Math.max(1, text.length);
  if (linkRatio > 0.45) return -Infinity;
  const paragraphs = element.querySelectorAll("p,br,blockquote").length;
  const identity = `${element.id || ""} ${element.className || ""}`;
  const tag = String(element.tagName || "").toLowerCase();
  return text.length
    + Math.min(paragraphs, 30) * 35
    + (SEMANTIC_TOKEN.test(identity) ? 600 : 0)
    + (["article", "main"].includes(tag) ? 400 : 0)
    - (NOISE_TOKEN.test(identity) ? 900 : 0)
    - linkRatio * text.length * 3
    - Math.max(0, element.children.length - 80) * 4;
}

export function discoverContentRule(html, pageUrl) {
  const document = loadDocument(html, pageUrl);
  for (const node of document.querySelectorAll("nav,header,footer,form,aside")) node.remove();
  const candidates = [...document.querySelectorAll([
    "article",
    "main",
    "section",
    "td",
    "div[id*='content' i]",
    "div[class*='content' i]",
    "div[id*='chapter' i]",
    "div[class*='chapter' i]",
    "div[id*='read' i]",
    "div[class*='read' i]",
    "div",
  ].join(","))].slice(0, 3_000);
  let best = null;
  for (const element of candidates) {
    const score = contentScore(element);
    if (!Number.isFinite(score)) continue;
    if (!best || score > best.score) best = { element, score };
  }
  return best ? stableContentSelector(best.element, document) : "";
}

/** Repair only a text source's chapterContent action from a real chapter URL. */
function comicAdapterRequestInfo(endpoint) {
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var u = (typeof result == "string" && result && result != "%@result") ? result : "";',
    'if (!u) u = q.chapterUrl || q.url || q.detailUrl || "";',
    'if (!u && result && typeof result == "object") u = result.url || result.detailUrl || "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(u) + "&referer=" + encodeURIComponent(u);`,
  ].join("\n");
}

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
      // Ignore malformed and cross-origin script references.
    }
  }
  return urls.slice(0, 8);
}

function compileComicApiCandidate(raw, baseUrl) {
  const source = String(raw || "").replace(/\\\//g, "/").trim();
  if (!/(?:^|\/)api\//i.test(source) || !/(?:image|images|picture|pictures|pages?)/i.test(source)) return null;
  let origin;
  let pathAndQuery;
  try { origin = new URL(baseUrl).origin; } catch { return null; }
  const absolute = source.match(/^(https?:\/\/[^/]+)(\/[^\s]*)$/i);
  if (absolute) {
    origin = absolute[1];
    pathAndQuery = absolute[2];
  } else if (source.startsWith("/")) {
    pathAndQuery = source;
  } else {
    return null;
  }
  const queryIndex = pathAndQuery.indexOf("?");
  const pathname = queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery;
  const rawQuery = queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : "";
  const expressions = [...pathname.matchAll(/\$\{([^}]+)\}/g)];
  const chapterExpression = expressions.find((match) => (
    /(?:chapter|episode|section|comic|clean).{0,24}id|id.{0,24}(?:chapter|episode|section|comic)/i.test(match[1])
  ));
  if (!chapterExpression || expressions.length !== 1) return null;
  const prefix = pathname.slice(0, chapterExpression.index);
  const suffix = pathname.slice(chapterExpression.index + chapterExpression[0].length);
  if (!/^\/[A-Za-z0-9_./-]*$/.test(prefix) || !/^[A-Za-z0-9_./-]*$/.test(suffix)) return null;
  const query = [];
  let sourceKey = "";
  for (const pair of rawQuery.split("&").filter(Boolean)) {
    const separator = pair.indexOf("=");
    const key = separator >= 0 ? pair.slice(0, separator) : pair;
    const value = separator >= 0 ? pair.slice(separator + 1) : "";
    if (!/^[A-Za-z_][\w-]{0,63}$/.test(key)) continue;
    if (!value.includes("${") && /^[A-Za-z0-9_.%+-]{0,100}$/.test(value)) {
      query.push(`${key}=${value}`);
    } else if (/(?:pageSize|page_size|perPage|limit)/i.test(value)) {
      query.push(`${key}=25`);
    } else if (/(?:currentPage|pageIndex|pageNo|pageNum|nextPage|\bpage\b)/i.test(value)) {
      query.push(`${key}=1`);
    } else if (/(?:image|img|pic).*(?:source|server|host|cdn)|^(?:source|server|cdn)$/i.test(key)) {
      sourceKey = key;
    }
  }
  return {
    origin,
    prefix,
    suffix,
    query: query.length ? `?${query.join("&")}` : "",
    sourceKey,
    score: (/\/api\//i.test(pathname) ? 100 : 0)
      + (/(?:image|images|picture|pictures)/i.test(pathname) ? 80 : 0)
      + (query.some((item) => /^(?:page|pageIndex|pageNo|pageNum)=/i.test(item)) ? 20 : 0)
      + (sourceKey ? 30 : 0),
  };
}

function declaredImageSources(html, pageUrl) {
  const output = [];
  const add = (value) => {
    try {
      const url = new URL(String(value || ""), pageUrl);
      if (!/^https?:$/.test(url.protocol) || output.includes(url.origin)) return;
      output.push(url.origin);
    } catch {
      // Ignore malformed optional image-source values.
    }
  };
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /(?:url|host|server|source|cdn)/i.test(key)) add(child);
      else visit(child, depth + 1);
    }
  };
  for (const match of String(html || "").matchAll(
    /\b(?=[\w$]*(?:image|img|pic))(?=[\w$]*(?:source|server|host|cdn))[A-Za-z_$][\w$]*\s*=\s*(\[[\s\S]{2,12000}?\])\s*;/gi,
  )) {
    try { visit(JSON.parse(match[1])); } catch {
      // Only literal JSON arrays are accepted; remote JavaScript is never evaluated.
    }
  }
  return output.slice(0, 12);
}

function comicApiCandidates(script, baseUrl) {
  const candidates = [];
  for (const match of String(script || "").matchAll(/([`"'])((?:https?:\/\/|\/)(?:(?!\1)[\s\S]){1,500})\1/g)) {
    const candidate = compileComicApiCandidate(match[2], baseUrl);
    if (!candidate) continue;
    const key = `${candidate.origin}${candidate.prefix}{id}${candidate.suffix}${candidate.query}|${candidate.sourceKey}`;
    if (!candidates.some((item) => item.key === key)) candidates.push({ ...candidate, key });
  }
  return candidates;
}

function numericChapterId(chapterUrl) {
  try {
    const matches = new URL(chapterUrl).pathname.match(/\d+/g) || [];
    return matches.at(-1) || "";
  } catch {
    return "";
  }
}

function jsonComicImageUrls(text) {
  let root;
  try { root = JSON.parse(String(text || "")); } catch { return []; }
  let best = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) {
      const urls = value.map((item) => {
        const raw = typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? Object.entries(item).find(([key]) => /(?:url|src|image|img|pic|path|file)/i.test(key))?.[1]
            : "";
        return /^https?:\/\//i.test(String(raw || ""))
          && /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(String(raw)) ? String(raw) : "";
      }).filter(Boolean);
      if (urls.length > best.length) best = urls;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(root);
  return best;
}

function probableImageResponse(response) {
  const type = String(Object.entries(response?.httpHeaders || {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1] || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  const bytes = Buffer.isBuffer(response) ? response : Buffer.from(response || "");
  if (bytes.length < 4) return false;
  return (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG")
    || bytes.subarray(0, 4).toString("ascii") === "GIF8"
    || bytes.subarray(0, 4).toString("ascii") === "RIFF";
}

async function discoverComicApiTemplate(html, pageUrl, download, headers) {
  const documents = [{ body: String(html || ""), url: pageUrl }];
  for (const scriptUrl of linkedScriptUrls(html, pageUrl)) {
    try {
      const page = await download(scriptUrl, headers);
      documents.push({
        body: decodeTextBuffer(page, { headers: page.httpHeaders || {} }),
        url: String(page.read2xsggResponseUrl || scriptUrl),
      });
    } catch {
      // A failed optional script leaves other declarative candidates available.
    }
  }
  const candidates = documents
    .flatMap((document) => comicApiCandidates(document.body, document.url))
    .sort((left, right) => right.score - left.score);
  const id = numericChapterId(pageUrl);
  if (!id) return null;
  for (const candidate of candidates.slice(0, 8)) {
    const sourceValues = candidate.sourceKey ? ["", ...declaredImageSources(html, pageUrl)] : [""];
    for (const sourceValue of sourceValues) {
      const sample = new URL(`${candidate.origin}${candidate.prefix}${encodeURIComponent(id)}${candidate.suffix}${candidate.query}`);
      if (candidate.sourceKey && sourceValue) sample.searchParams.set(candidate.sourceKey, sourceValue);
      try {
        const response = await download(sample.toString(), headers);
        const urls = jsonComicImageUrls(decodeTextBuffer(response, { headers: response.httpHeaders || {} }));
        if (urls.length < 2) continue;
        const image = await download(urls[0], { ...headers, Referer: pageUrl });
        if (probableImageResponse(image)) {
          return {
            ...candidate,
            query: sample.search,
          };
        }
      } catch {
        // Try the next API or declared image source until a real image succeeds.
      }
    }
  }
  const dynamic = await dynamicComicApiImages(html, pageUrl, {
    download,
    headers,
    probeOnly: true,
  });
  if (dynamic.urls.length >= 2) return { mode: "post-form" };
  return null;
}

function comicApiAdapterRequestInfo(endpoint, template) {
  if (!template || template.mode === "post-form") return comicAdapterRequestInfo(endpoint);
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var u = (typeof result == "string" && result && result != "%@result") ? result : "";',
    'if (!u) u = q.chapterUrl || q.url || q.detailUrl || "";',
    'if (!u && result && typeof result == "object") u = result.url || result.detailUrl || "";',
    'u = String(u || "").trim();',
    'var ids = u.replace(/[?#][\\s\\S]*$/, "").match(/\\d+/g) || [];',
    'var id = ids.length ? ids[ids.length - 1] : "";',
    `var api = ${JSON.stringify(`${template.origin}${template.prefix}`)} + encodeURIComponent(id) + ${JSON.stringify(`${template.suffix}${template.query}`)};`,
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(api) + "&referer=" + encodeURIComponent(u);`,
  ].join("\n");
}

function repairedComicContent(source, host, adapterBase, apiTemplate = null) {
  if (!/^https?:\/\//i.test(String(adapterBase || ""))) return null;
  const headers = {
    ...(source?.httpHeaders || {}),
    ...(source?.chapterContent?.httpHeaders || {}),
  };
  const plan = compileComicExtractionPlan(source?.chapterContent?.content || "", headers);
  const encoded = encodeComicExtractionPlan(plan);
  const base = String(adapterBase).replace(/\/$/, "");
  const endpoint = `${base}/adapter/images?${encoded ? `plan=${encoded}&` : ""}v=2&url=`;
  const imageEndpoint = `${base}/image/auto?url=`;
  return {
    ...source,
    chapterContent: {
      ...(source?.chapterContent || {}),
      actionID: "chapterContent",
      host,
      responseFormatType: "json",
      parserID: "DOM",
      requestInfo: comicApiAdapterRequestInfo(endpoint, apiTemplate),
      content: apiTemplate && /\$\.urls/i.test(String(source?.chapterContent?.content || ""))
        ? source.chapterContent.content
        : [
        "$.proxyUrls||$.urls||@js:",
        "var images = Array.isArray(result) ? result : [];",
        "var q = (params && params.queryInfo) || {};",
        'var referer = String(q.chapterUrl || q.url || q.detailUrl || "");',
        'var suffix = referer ? "&referer=" + encodeURIComponent(referer) : "";',
        `var endpoint = ${JSON.stringify(imageEndpoint)};`,
        'var urls = images.map(function (url) { var value = String(url || ""); return /\\/image\\/[A-Za-z0-9_-]+\\?url=/.test(value) ? value : endpoint + encodeURIComponent(value) + suffix; }).filter(Boolean);',
        "return JSON.stringify({urls: urls, httpHeaders: {}});",
      ].join("\n"),
    },
  };
}

export async function repairContentFromChapter(source, chapterUrl, { download, adapterBase = "" } = {}) {
  if (!["text", "comic"].includes(source?.sourceType) || typeof download !== "function") return null;
  let host;
  try {
    host = new URL(chapterUrl).origin;
  } catch {
    return null;
  }
  let page;
  try {
    page = await download(chapterUrl, {
      ...(source?.httpHeaders || {}),
      ...(source?.chapterContent?.httpHeaders || {}),
    });
  } catch {
    return null;
  }
  const responseUrl = String(page.read2xsggResponseUrl || chapterUrl);
  if (source.sourceType === "comic") {
    const headers = {
      ...(source?.httpHeaders || {}),
      ...(source?.chapterContent?.httpHeaders || {}),
    };
    const apiTemplate = await discoverComicApiTemplate(
      decodeTextBuffer(page, { headers: page.httpHeaders || {} }),
      responseUrl,
      download,
      headers,
    );
    return repairedComicContent(source, new URL(responseUrl).origin, adapterBase, apiTemplate);
  }
  const selector = discoverContentRule(
    decodeTextBuffer(page, { headers: page.httpHeaders || {} }),
    responseUrl,
  );
  if (!selector) return null;
  return {
    ...source,
    chapterContent: {
      ...(source?.chapterContent || {}),
      actionID: "chapterContent",
      host,
      responseFormatType: "html",
      parserID: "DOM",
      requestInfo: "%@result",
      content: withNovelHtmlStripped(selector),
    },
  };
}
