import { JSDOM } from "jsdom";
import { isXiangseGbkEncode } from "./charset.js";

const MAX_PLAN_BYTES = 24 * 1024;
const FIELD_NAMES = new Set([
  "name", "url", "author", "desc", "cat", "lastChapterTitle", "cover", "status", "wordCount",
  "tocUrl", "title", "updateTime", "content",
]);

function selectorOnly(rule) {
  const value = String(rule || "").trim();
  if (!value || /^@js:/i.test(value)) return "";
  return value.split(/\|\|?\s*@js:/i, 1)[0].trim().slice(0, 4096);
}

function safeRegexPattern(value) {
  const pattern = String(value || "");
  if (!pattern || pattern.length > 256) return "";
  // Reject the most common catastrophic nested-quantifier forms. Bridge plans
  // are public input and must never become an arbitrary regex execution API.
  if (/\((?:[^()]|\\.)*(?:\||[+*?{])(?:[^()]|\\.)*\)[+*?{]/.test(pattern)) return "";
  try { new RegExp(pattern); } catch { return ""; }
  return pattern;
}

function staticStringLiteral(token) {
  const source = String(token || "");
  if (source.length < 2 || !["\"", "'"].includes(source[0]) || source.at(-1) !== source[0]) {
    throw new TypeError("不是静态字符串");
  }
  if (source[0] === "\"") return JSON.parse(source);
  return source.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|['"\\/bfnrt])/g, (_match, escape) => {
    if (escape[0] === "u" || escape[0] === "x") {
      return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    }
    return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[escape] ?? escape;
  });
}

function splitTemplateTransform(script) {
  const literal = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;
  const direct = String(script || "").match(new RegExp(
    `return\\s+\\(?\\s*(${literal})\\s*\\+\\s*(?:String\\(\\s*)?result\\.split\\(\\s*(${literal})\\s*\\)\\s*\\[\\s*(\\d{1,2})\\s*\\]\\s*\\)?\\s*\\+\\s*(${literal})\\s*\\)?\\s*;`,
    "i",
  ));
  if (direct) {
    try {
      const delimiter = staticStringLiteral(direct[2]);
      const index = Number(direct[3]);
      if (delimiter.length !== 1 || !Number.isInteger(index) || index > 32) return null;
      const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const classDelimiter = delimiter.replace(/[\\\]^-]/g, "\\$&");
      const segments = Array.from({ length: index }, () => `[^${classDelimiter}]*${escapedDelimiter}`).join("");
      const pattern = safeRegexPattern(`^${segments}([^${classDelimiter}]*)`);
      if (!pattern) return null;
      const prefix = staticStringLiteral(direct[1]);
      return {
        pattern,
        prefix,
        suffix: staticStringLiteral(direct[4]),
        hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
      };
    } catch {
      return null;
    }
  }
  const split = String(script || "").match(
    /(?:\bvar\s+)?([A-Za-z_$][\w$]*)\s*=\s*result\.split\(\s*(["'])([\s\S]*?)\2\s*\)\s*\[\s*(\d{1,2})\s*\]/,
  );
  if (!split || split[3].length !== 1) return null;
  const index = Number(split[4]);
  if (!Number.isInteger(index) || index > 32) return null;
  const variable = split[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const template = String(script).match(new RegExp(
    `\`((?:\\\\.|[^\`])*)\\$\\{\\s*${variable}\\s*\\}((?:\\\\.|[^\`])*)\``,
  ));
  if (!template || template[1].includes("${") || template[2].includes("${")) return null;
  const delimiter = split[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classDelimiter = split[3].replace(/[\\\]^-]/g, "\\$&");
  const segments = Array.from({ length: index }, () => `[^${classDelimiter}]*${delimiter}`).join("");
  const pattern = safeRegexPattern(`^${segments}([^${classDelimiter}]*)`);
  if (!pattern) return null;
  return {
    pattern,
    prefix: template[1].replace(/\\`/g, "`").slice(0, 2048),
    suffix: template[2].replace(/\\`/g, "`").slice(0, 2048),
    hostPrefix: false,
  };
}

function hostResultTransform(script) {
  const template = String(script || "").match(
    /return\s+config\.host\s*\+\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result(?:\s*\|\|\s*"")?\)([\s\S]*?);/i,
  );
  if (!template) return null;
  try {
    return {
      pattern: /\[\^\\d\]/.test(template[2]) ? "^[\\s\\S]*?(\\d+)[\\s\\S]*$" : "^([\\s\\S]+)$",
      prefix: JSON.parse(template[1]),
      suffix: "",
      hostPrefix: true,
    };
  } catch {
    return null;
  }
}

function normalizeField(rule) {
  if (rule && typeof rule === "object" && !Array.isArray(rule)) {
    if (rule.currentUrl) {
      return { selector: ".", currentUrl: true, replacements: [], hostPrefix: false, matchTemplate: null };
    }
    if (Object.hasOwn(rule, "constant") && String(rule.constant || "").trim()) {
      return {
        selector: ".",
        constant: String(rule.constant).trim().slice(0, 2048),
        replacements: [],
        hostPrefix: false,
        matchTemplate: null,
      };
    }
    const urlTemplate = String(rule.urlTemplate || "").trim().slice(0, 2_048);
    const selector = selectorOnly(rule.selector) || (urlTemplate ? "id" : "");
    if (!selector) return null;
    const replacements = Array.isArray(rule.replacements) ? rule.replacements.map((item) => {
      const pattern = safeRegexPattern(item?.pattern);
      return pattern ? { pattern, replacement: String(item?.replacement || "").slice(0, 1024) } : null;
    }).filter(Boolean).slice(0, 8) : [];
    let matchTemplate = null;
    const matchPattern = safeRegexPattern(rule.matchTemplate?.pattern);
    if (matchPattern) {
      matchTemplate = {
        pattern: matchPattern,
        prefix: String(rule.matchTemplate?.prefix || "").slice(0, 2048),
        suffix: String(rule.matchTemplate?.suffix || "").slice(0, 2048),
        hostPrefix: Boolean(rule.matchTemplate?.hostPrefix),
      };
    }
    return {
      selector,
      replacements,
      hostPrefix: Boolean(rule.hostPrefix),
      matchTemplate,
      ...(String(rule.fallback || "").trim() ? { fallback: String(rule.fallback).trim().slice(0, 2048) } : {}),
      ...(urlTemplate && /^https?:\/\//i.test(urlTemplate) ? { urlTemplate } : {}),
    };
  }
  const source = String(rule || "").trim();
  if (/^https?:\/\//i.test(source) && !/[|@]|##/.test(source.split(/\s/, 1)[0])) {
    return {
      selector: ".",
      constant: source.slice(0, 2048),
      replacements: [],
      hostPrefix: false,
      matchTemplate: null,
    };
  }
  const selector = selectorOnly(source);
  if (!selector) return null;
  const replacements = [];
  const script = source.slice(selector.length);
  for (const match of script.matchAll(/\.replace\(new RegExp\(("(?:\\.|[^"\\])*")\s*,\s*"g"\)\s*,\s*("(?:\\.|[^"\\])*")\)/g)) {
    try {
      const pattern = safeRegexPattern(JSON.parse(match[1]));
      if (pattern) replacements.push({ pattern, replacement: JSON.parse(match[2]) });
    } catch {
      // Ignore non-generated postprocessors.
    }
  }
  if (/rows\s*\[\s*rows\.length\s*-\s*1\s*\]/.test(script)
    && /\.split\(\/\[\|/.test(script)) {
    replacements.push({
      pattern: "^[\\s\\S]*\\|([^|\\r\\n]+)\\|?\\s*$",
      replacement: "$1",
    });
  }
  let matchTemplate = null;
  const scalarTemplate = script.match(
    /return\s+\(?\s*(?:((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\+\s*)?(?:String\(\s*)?result(?:\s*\|\|\s*""\s*)?\)?(?:\s*\+\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')))?\s*\)?\s*;/i,
  );
  if (scalarTemplate && (scalarTemplate[1] || scalarTemplate[2])) {
    try {
      const prefix = scalarTemplate[1] ? staticStringLiteral(scalarTemplate[1]) : "";
      let suffix = scalarTemplate[2] ? staticStringLiteral(scalarTemplate[2]) : "";
      if (/^\s*,\s*\{\s*webView\s*:/i.test(suffix)) suffix = "";
      matchTemplate = {
        pattern: "^([\\s\\S]+)$",
        prefix,
        suffix,
        hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
      };
    } catch {
      matchTemplate = null;
    }
  }
  const template = script.match(/match\(\/((?:\\.|[^/])+)\/[gimuy]*\)[\s\S]*?return\s+m\s*\?\s*(config\.host\s*\+\s*)?("(?:\\.|[^"\\])*")\s*\+\s*m\[1\]\s*\+\s*("(?:\\.|[^"\\])*")/i);
  if (!matchTemplate && template) {
    try {
      const pattern = safeRegexPattern(template[1]);
      if (pattern) matchTemplate = {
        pattern,
        prefix: JSON.parse(template[3]),
        suffix: JSON.parse(template[4]),
        hostPrefix: Boolean(template[2]),
      };
    } catch {
      // Keep the base selector when the generated template is malformed.
    }
  }
  const directMatch = script.match(
    /result\.match\(\s*\/((?:\\.|[^/])+)\/[gimuy]*\s*\)\s*\[\s*1\s*\]/i,
  );
  if (!matchTemplate && directMatch) {
    const pattern = safeRegexPattern(directMatch[1]);
    if (pattern) matchTemplate = { pattern, prefix: "", suffix: "", hostPrefix: false };
  }
  if (!matchTemplate) matchTemplate = hostResultTransform(script);
  if (!matchTemplate) matchTemplate = splitTemplateTransform(script);
  return {
    selector,
    replacements: replacements.slice(0, 8),
    hostPrefix: /return\s+config\.host\s*\+/i.test(script),
    matchTemplate,
  };
}

function normalizeLatestField(rule) {
  const field = normalizeField(rule);
  if (!field || field.constant || field.currentUrl) return null;
  if (!field.replacements.length && !field.hostPrefix && !field.matchTemplate && !field.urlTemplate) {
    return field.selector;
  }
  return field;
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("规则桥接计划无效");
  const kind = ["books", "detail", "chapters", "text"].includes(value.kind) ? value.kind : "";
  if (!kind) throw new TypeError("规则桥接计划类型无效");
  const fields = {};
  for (const [name, rule] of Object.entries(value.fields || {})) {
    if (!FIELD_NAMES.has(name)) continue;
    const field = normalizeField(rule);
    if (field) {
      fields[name] = field.constant
        ? { constant: field.constant }
        : field.currentUrl
          ? { currentUrl: true }
        : field;
    }
  }
  const headers = {};
  for (const [name, headerValue] of Object.entries(value.headers || {})) {
    if (!/^(?:user-agent|referer|origin|accept|accept-language|content-type|x-requested-with|x-fingerprint)$/i.test(name)) continue;
    headers[name] = String(headerValue).slice(0, 2048);
  }
  let latestChapter = null;
  if (kind === "detail" && value.latestChapter && typeof value.latestChapter === "object") {
    const candidate = value.latestChapter;
    const urlTemplate = String(candidate.urlTemplate || "").trim().slice(0, 4096);
    const list = selectorOnly(candidate.list);
    const title = normalizeLatestField(candidate.title);
    const count = selectorOnly(candidate.count);
    const values = {};
    for (const [name, selector] of Object.entries(candidate.values || {}).slice(0, 16)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const normalized = selectorOnly(selector);
      if (normalized) values[name] = normalized;
    }
    const pageSize = Math.max(1, Math.min(200, Number(candidate.pageSize) || 50));
    if (/^https?:\/\//i.test(urlTemplate) && list && title && Object.keys(values).length) {
      latestChapter = {
        mode: "template",
        urlTemplate,
        responseType: candidate.responseType === "html" ? "html" : "json",
        list,
        title,
        count,
        countSource: candidate.countSource === "menu" ? "menu" : "detail",
        values,
        pageSize,
      };
    } else {
      const tocSelector = selectorOnly(candidate.tocSelector);
      const url = normalizeLatestField(candidate.url);
      if (candidate.mode === "direct" && candidate.responseType === "json" && list && title && url) {
        latestChapter = {
          mode: "direct",
          responseType: "json",
          list,
          title,
          url,
          reverse: Boolean(candidate.reverse),
          pageSize,
        };
      } else if (candidate.responseType === "html" && list && title && url
        && (tocSelector || candidate.samePage)) {
        latestChapter = {
          mode: "html-toc",
          responseType: "html",
          tocSelector,
          samePage: Boolean(candidate.samePage),
          dynamicHtml: Boolean(candidate.dynamicHtml),
          list,
          title,
          url,
          reverse: Boolean(candidate.reverse),
          pageSize,
        };
      }
    }
  }
  return {
    version: 1,
    kind,
    host: /^https?:\/\//i.test(String(value.host || "")) ? String(value.host).slice(0, 2048) : "",
    responseType: ["json", "embedded-json"].includes(value.responseType) ? value.responseType : "html",
    list: selectorOnly(value.list),
    tocSelector: selectorOnly(value.tocSelector),
    charset: /^(?:gbk|utf-8)$/i.test(String(value.charset || "").trim())
      ? String(value.charset).trim().toLowerCase()
      : "",
    // Legado chapterList leading "-" / reverseChapters → reverse before ascending sort.
    reverse: Boolean(value.reverse),
    preserveOrder: Boolean(value.preserveOrder),
    fields,
    headers,
    ...(latestChapter ? { latestChapter } : {}),
  };
}

export function encodeBridgePlan(plan) {
  const normalized = normalizePlan(plan);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > MAX_PLAN_BYTES) throw new TypeError("规则桥接计划过大");
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeBridgePlan(encoded) {
  const value = String(encoded || "");
  if (!value || value.length > MAX_PLAN_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("规则桥接计划编码无效");
  }
  try {
    return normalizePlan(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("规则桥接计划不是有效 JSON");
  }
}

function multiFieldResultUrlTemplate(script) {
  const returnMatch = String(script || "").match(/\breturn\b/i);
  if (!returnMatch) return null;
  const expression = String(script).slice(returnMatch.index + returnMatch[0].length);
  const parts = [];
  let cursor = 0;
  let depth = 0;
  let expectTerm = true;

  const whitespace = () => {
    while (/\s/.test(expression[cursor] || "")) cursor += 1;
  };
  while (cursor < expression.length) {
    whitespace();
    if (cursor >= expression.length) break;
    if (expression[cursor] === ";" && depth === 0 && !expectTerm) {
      cursor += 1;
      whitespace();
      if (cursor !== expression.length) return null;
      break;
    }
    if (expectTerm && expression[cursor] === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (!expectTerm && expression[cursor] === ")") {
      if (depth === 0) return null;
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (!expectTerm && expression[cursor] === "+") {
      expectTerm = true;
      cursor += 1;
      continue;
    }
    if (!expectTerm) return null;

    const field = expression.slice(cursor).match(
      /^String\s*\(\s*result\.([A-Za-z_$][\w$]*)\s*\)/,
    );
    if (field) {
      parts.push({ field: field[1] });
      cursor += field[0].length;
      expectTerm = false;
      continue;
    }
    const literal = expression.slice(cursor).match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
    if (!literal) return null;
    try {
      parts.push({ literal: staticStringLiteral(literal[0]) });
    } catch {
      return null;
    }
    cursor += literal[0].length;
    expectTerm = false;
  }

  if (expectTerm || depth !== 0) return null;
  const fields = parts.filter((part) => part.field).map((part) => part.field);
  if (fields.length < 2) return null;
  const urlTemplate = parts.map((part) => part.field ? `{{${part.field}}}` : part.literal).join("");
  if (!/^https?:\/\//i.test(urlTemplate) || urlTemplate.length > 2_048) return null;
  return { selector: fields[0], urlTemplate };
}

function jsonFieldUrlTemplate(rule) {
  const source = String(rule || "").trim();
  if (!/^https?:\/\//i.test(source)) return null;
  const fields = [];
  let urlTemplate = source.replace(
    /\{\{\s*\$\.(\.?)([A-Za-z_$][\w$]*)\s*\}\}/g,
    (_match, recursive, field) => {
      fields.push({ field, recursive: Boolean(recursive) });
      return `{{raw:${field}}}`;
    },
  );
  urlTemplate = urlTemplate.replace(
    /(?<!\{)\{\s*\$\.(\.?)([A-Za-z_$][\w$]*)\s*\}(?!\})/g,
    (_match, recursive, field) => {
      fields.push({ field, recursive: Boolean(recursive) });
      return `{{raw:${field}}}`;
    },
  );
  if (!fields.length || urlTemplate.length > 2_048) return null;
  const primary = fields[0];
  return {
    selector: primary.recursive ? `@json-recursive:${encodeURIComponent(primary.field)}` : primary.field,
    urlTemplate,
  };
}

function inferredScriptField(rule, preferredNames = []) {
  const source = String(rule || "").trim();
  if (!/^@js:/i.test(source)) return jsonFieldUrlTemplate(source) || rule;
  if (/return\s+String\(\s*\(?\s*params\.responseUrl\b/i.test(source)) {
    return { currentUrl: true };
  }
  const hostTemplate = source.match(
    /return\s+\(?\s*String\(\s*config\.host\s*\)\s*\+\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result\.([A-Za-z_$][\w$]*)\)(?:\s*\+\s*("(?:\\.|[^"\\])*"))?\s*\)?\s*;/i,
  );
  if (hostTemplate) {
    try {
      return {
        selector: hostTemplate[2],
        hostPrefix: true,
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix: JSON.parse(hostTemplate[1]),
          suffix: hostTemplate[3] ? JSON.parse(hostTemplate[3]) : "",
          hostPrefix: true,
        },
      };
    } catch {
      return "";
    }
  }
  const multiFieldUrl = multiFieldResultUrlTemplate(source);
  if (multiFieldUrl) return multiFieldUrl;
  const threePart = source.match(
    /return\s+\(?\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result\.([A-Za-z_$][\w$]*)\)\s*\+\s*("(?:\\.|[^"\\])*")\s*\)?\s*;/i,
  );
  if (threePart) {
    try {
      const prefix = JSON.parse(threePart[1]);
      const suffix = JSON.parse(threePart[3]);
      return {
        selector: threePart[2],
        hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix,
          suffix,
          hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
        },
      };
    } catch {
      return "";
    }
  }
  const prefixOnly = source.match(
    /return\s+\(?\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result\.([A-Za-z_$][\w$]*)\)\s*\)?\s*;/i,
  );
  if (prefixOnly) {
    try {
      const prefix = JSON.parse(prefixOnly[1]);
      return {
        selector: prefixOnly[2],
        hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix,
          suffix: "",
          hostPrefix: Boolean(prefix && !/^https?:\/\//i.test(prefix)),
        },
      };
    } catch {
      return "";
    }
  }
  const suffixOnly = source.match(
    /return\s+\(?\s*String\(result\.([A-Za-z_$][\w$]*)\)\s*\+\s*("(?:\\.|[^"\\])*")\s*\)?\s*;/i,
  );
  if (suffixOnly) {
    try {
      const suffix = JSON.parse(suffixOnly[2]);
      return {
        selector: suffixOnly[1],
        hostPrefix: false,
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix: "",
          suffix,
          hostPrefix: false,
        },
      };
    } catch {
      return "";
    }
  }
  const fields = [...source.matchAll(/\bresult\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  for (const preferred of preferredNames) {
    const field = fields.find((name) => preferred.test(name));
    if (field) return field;
  }
  return "";
}

function planCharset(action) {
  if (isXiangseGbkEncode(action)) return "gbk";
  const charset = String(action?.charset || "").trim().toLowerCase();
  return charset === "gbk" || charset === "utf-8" ? charset : "";
}

export function compileBookBridgePlan(action, headers = {}) {
  return normalizePlan({
    kind: "books",
    host: action.host,
    responseType: action.responseFormatType,
    charset: planCharset(action),
    list: action.list,
    fields: {
      name: inferredScriptField(action.bookName, [/^(?:book)?name$/i, /title/i, /username/i]),
      url: inferredScriptField(action.detailUrl, [/url/i, /id/i, /username/i]),
      author: action.author,
      desc: action.desc,
      cat: action.cat,
      lastChapterTitle: action.lastChapterTitle,
      cover: inferredScriptField(action.cover, [/cover/i, /pic/i, /img/i, /icon/i]) || action.cover,
      status: action.status,
      wordCount: action.wordCount,
    },
    headers,
  });
}

export function compileDetailBridgePlan(action, headers = {}) {
  return normalizePlan({
    kind: "detail",
    host: action.host,
    responseType: action.responseFormatType,
    charset: planCharset(action),
    fields: {
      name: action.bookName,
      author: action.author,
      desc: action.desc,
      cat: action.cat,
      lastChapterTitle: action.lastChapterTitle,
      cover: inferredScriptField(action.cover, [/cover/i, /pic/i, /img/i, /icon/i]) || action.cover,
      status: action.status,
      wordCount: action.wordCount,
      tocUrl: action.tocUrl,
    },
    headers,
  });
}

export function compileChapterBridgePlan(action, { tocSelector = "", headers = {}, reverse = false } = {}) {
  const urlRule = action?.url && typeof action.url === "object" && action.url.urlTemplate
    ? action.url
    : inferredScriptField(action.url, [/url/i, /id/i, /href/i]);
  return normalizePlan({
    kind: "chapters",
    host: action.host,
    responseType: action.responseFormatType,
    charset: planCharset(action),
    list: action.list,
    tocSelector,
    reverse: Boolean(reverse || action.reverseChapters || action.reverse),
    fields: {
      title: inferredScriptField(action.title, [/title/i, /name/i, /chapter/i])
        || (/queryInfo\.(?:bookName|name)/i.test(String(action.title || "")) ? { constant: "播放" } : ""),
      url: urlRule,
      updateTime: action.updateTime,
    },
    headers,
  });
}

export function compileTextBridgePlan(action, headers = {}) {
  return normalizePlan({
    kind: "text",
    host: action.host,
    responseType: action.responseFormatType,
    charset: planCharset(action),
    fields: { content: action.content },
    headers,
  });
}

function xpathValues(document, expression, context = document, { maxNodes = Infinity } = {}) {
  const view = document.defaultView;
  const type = /^\s*(?:string|normalize-space)\s*\(/.test(expression)
    ? view.XPathResult.STRING_TYPE : view.XPathResult.ANY_TYPE;
  const result = document.evaluate(expression, context, null, type, null);
  if (result.resultType === view.XPathResult.STRING_TYPE) return [result.stringValue];
  if (result.resultType === view.XPathResult.NUMBER_TYPE) return [String(result.numberValue)];
  if (result.resultType === view.XPathResult.BOOLEAN_TYPE) return [String(result.booleanValue)];
  const values = [];
  const cap = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : Infinity;
  let node;
  while ((node = result.iterateNext())) {
    values.push(node);
    if (values.length >= cap) break;
  }
  return values;
}

function htmlDocument(value) {
  // Prefer a lean parse: scripts/styles are irrelevant for selector extraction
  // and dominate CPU/memory on large catalogue pages.
  const source = String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, (tag) => (
      /\btype\s*=\s*["']application\/(?:ld\+)?json(?:\s*;[^"']*)?["']/i.test(tag) ? tag : ""
    ))
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, "");
  const xml = /^\s*(?:<\?xml\b|<(?:rss|feed)\b)/i.test(source);
  try {
    return new JSDOM(source, {
      contentType: xml ? "text/xml" : "text/html",
      pretendToBeVisual: false,
    }).window.document;
  } catch {
    return new JSDOM(source, {
      contentType: "text/html",
      pretendToBeVisual: false,
    }).window.document;
  }
}

function nodeText(node, content = false) {
  if (node == null) return "";
  if (typeof node === "string") return node.trim();
  if (node.nodeType === 2 || node.nodeType === 3) return String(node.nodeValue || "").trim();
  if (node.nodeType === 9) return String(node.documentElement?.textContent || "").trim();
  if (content && node.innerHTML !== undefined) return String(node.innerHTML || "").trim();
  return String(node.textContent || "").trim();
}

/**
 * Xiangse novel reader expects plain text. Keep paragraph breaks from common
 * block tags while dropping the rest of the markup.
 */
export function htmlToPlainText(value) {
  let text = String(value || "");
  if (!/<[a-z/!?]/i.test(text) && !/&(?:nbsp|lt|gt|amp|quot|apos|#)/i.test(text)) {
    return text.trim();
  }
  return text
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n")
    .replace(/<(?:p|div|h[1-6]|li|tr|blockquote|section|article)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#(\d+);/g, (_m, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCharCode(num) : "";
    })
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlSelect(rule, input, { list = false, content = false, maxNodes = Infinity } = {}) {
  if (!rule) return list ? [] : "";
  const itemInput = Boolean(input?.nodeType && input.nodeType !== 9);
  // List fields must be evaluated relative to the matched item. Reusing its
  // owner document avoids constructing a new JSDOM for every field of every
  // book/chapter (large catalogues commonly contain thousands of chapters).
  const document = itemInput
    ? (input.ownerDocument || input)
    : input?.nodeType === 9 ? input : htmlDocument(input);
  if (list && String(rule).trim() === "." && !itemInput) return document.documentElement ? [document.documentElement] : [];
  for (const alternative of String(rule).split(/\s*\|\|\s*/).filter(Boolean)) {
    try {
      let expression = alternative;
      if (itemInput) {
        // Converted Legado fields begin with document-style `//`, while their
        // semantics inside a book/chapter item are descendant-or-self. Bare
        // `/@attr` and `/text()` fields refer directly to the current item.
        if (expression.startsWith("//@")) expression = `descendant-or-self::*/${expression.slice(2)}`;
        else if (expression.startsWith("//")) expression = `descendant-or-self::${expression.slice(2)}`;
        else if (/^\/(?:@|text\(\)|node\(\))/.test(expression)) expression = `.${expression}`;
        else if (expression.startsWith("(.//")) expression = `(descendant-or-self::${expression.slice(4)}`;
      }
      const selected = xpathValues(document, expression, itemInput ? input : document, {
        maxNodes: list ? maxNodes : (itemInput ? 8 : 32),
      });
      if (!selected.length) continue;
      if (list) return selected.filter((item) => item?.nodeType === 1);
      const values = selected.map((item) => nodeText(item, content)).filter(Boolean);
      if (values.length) return content ? values.join("\n") : values[0];
    } catch {
      // Try the next declarative alternative.
    }
  }
  return list ? [] : "";
}

function jsonPathSingle(input, path) {
  const recursive = String(path || "").trim().match(/^@json-recursive:([^:]+)(?::(values))?$/);
  if (recursive) {
    let selector = "";
    try { selector = decodeURIComponent(recursive[1]); } catch { return []; }
    const [first, ...rest] = selector.split(/[/.]/).filter(Boolean);
    if (!first) return [];
    const found = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, first)) {
        const raw = typeof value[first] === "number" && !Number.isSafeInteger(value[first])
          && typeof value[`${first}Str`] === "string"
          ? value[`${first}Str`]
          : value[first];
        const selected = rest.length ? jsonPathSingle(raw, rest.join("/")) : raw;
        if (selected !== undefined && selected !== null) found.push(selected);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(input);
    if (!recursive[2]) return found.flatMap((value) => Array.isArray(value) ? value : [value]);
    return found.flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return Object.values(value);
      return value === undefined || value === null ? [] : [value];
    });
  }
  const union = String(path || "").trim().match(/^@json-union:(.+)$/);
  if (union) {
    const rows = [];
    for (const encoded of union[1].split(",").filter(Boolean)) {
      let selector = "";
      try { selector = decodeURIComponent(encoded); } catch { continue; }
      const value = jsonPathSingle(input, selector);
      if (Array.isArray(value)) rows.push(...value);
      else if (value !== undefined && value !== null && value !== "") rows.push(value);
    }
    return rows;
  }
  const filter = parseJsonFilter(path);
  if (filter) return executeJsonFilter(input, filter);
  let value = input;
  const normalized = String(path || "").trim().replace(/^@json:/i, "").replace(/^\$\.?/, "")
    .replace(/\[\*\]/g, "")
    .replace(/\[((?:\d+\s*,\s*)+\d+)\]/g, (_match, indices) => `/@indices:${indices.replace(/\s+/g, "")}`)
    .replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/");
  for (const key of normalized.split("/").filter(Boolean)) {
    if (Array.isArray(value) && /^@indices:(?:\d+,)+\d+$/.test(key)) {
      value = key.slice("@indices:".length).split(",")
        .map((index) => value[Number(index)])
        .filter((item) => item !== undefined && item !== null);
    } else if (Array.isArray(value) && !/^\d+$/.test(key)) {
      value = value.flatMap((item) => {
        const child = item?.[key];
        if (Array.isArray(child)) return child;
        return child === undefined || child === null ? [] : [child];
      });
    } else {
      const direct = value?.[key];
      value = typeof direct === "number" && !Number.isSafeInteger(direct)
        && typeof value?.[`${key}Str`] === "string"
        ? value[`${key}Str`]
        : direct;
    }
  }
  return value;
}

function parseJsonFilter(path) {
  const match = String(path || "").trim().match(/^@json-filter:(recursive|direct):([^:]*):([^:]+):(.+)$/);
  if (!match) return null;
  try {
    const values = match[4].split(",").map((value) => decodeURIComponent(value));
    if (!values.length) return null;
    return {
      recursive: match[1] === "recursive",
      base: decodeURIComponent(match[2]),
      field: decodeURIComponent(match[3]),
      values: new Set(values.map(String)),
    };
  } catch {
    return null;
  }
}

function executeJsonFilter(input, filter) {
  const root = filter.base ? jsonPathSingle(input, filter.base) : input;
  const candidates = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    candidates.push(value);
    if (filter.recursive) {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(root);
  return candidates.filter((candidate) => {
    const value = jsonPathSingle(candidate, filter.field);
    return value !== undefined && value !== null && filter.values.has(String(value));
  });
}

function jsonPath(input, path) {
  for (const alternative of String(path || "").split(/\s*\|\|\s*/).filter(Boolean)) {
    const value = jsonPathSingle(input, alternative);
    if (value !== undefined && value !== null && value !== ""
      && (!Array.isArray(value) || value.length)) return value;
  }
  return undefined;
}

function embeddedJsonArray(input, selector) {
  const name = String(selector || "").match(/^@embedded-json-array:([A-Za-z_$][\w$]*)$/)?.[1];
  if (!name) return [];
  const source = String(input || "");
  const assignment = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\[`, "g");
  const found = assignment.exec(source);
  if (!found) return [];
  const start = found.index + found[0].lastIndexOf("[");
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(source.slice(start, index + 1));
          return Array.isArray(value) ? value : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function select(plan, rule, input, options = {}) {
  const field = normalizeField(rule);
  if (!field) return options.list ? [] : "";
  if (field.constant) return field.constant;
  if (field.currentUrl) return String(options.baseUrl || "");
  if (plan.responseType === "json" || plan.responseType === "embedded-json") {
    const value = field.selector ? jsonPath(input, field.selector) : input;
    if (options.list) return Array.isArray(value) ? value : [];
    if (Array.isArray(value)) return value.map((item) => String(item ?? "")).filter(Boolean).join("\n");
    return value == null ? "" : String(value).trim();
  }
  return htmlSelect(field.selector, input, options);
}

function transformed(plan, rule, input, options = {}) {
  const field = normalizeField(rule);
  let value = select(plan, field, input, options);
  if (Array.isArray(value)) return value;
  for (const replacement of field?.replacements || []) {
    value = String(value).replace(new RegExp(replacement.pattern, "g"), replacement.replacement);
  }
  if (field?.matchTemplate) {
    const match = String(value).match(new RegExp(field.matchTemplate.pattern));
    if (match) value = `${field.matchTemplate.hostPrefix ? plan.host : ""}${field.matchTemplate.prefix}${match[1] || ""}${field.matchTemplate.suffix}`;
  }
  if (field?.hostPrefix && value && !/^https?:\/\//i.test(value)) value = `${plan.host}${value}`;
  return String(value || "").trim() || field?.fallback || "";
}

function expandUrlTemplate(template, item, baseUrl, selectedValue = "") {
  let bookId = "";
  let comicId = "";
  let entityId = "";
  try {
    const page = new URL(baseUrl);
    bookId = page.searchParams.get("bookId")
      || page.searchParams.get("albumId")
      || page.searchParams.get("id")
      || (page.pathname.match(/\/(?:book|album|comic)\/(\d+)/i)?.[1] || "")
      || (page.pathname.match(/\/(\d+)(?:\/|$)/)?.[1] || "");
    comicId = page.searchParams.get("comic_id") || page.searchParams.get("comicId") || "";
    entityId = page.searchParams.get("entityId") || page.searchParams.get("entity_id") || "";
  } catch {
    bookId = String(baseUrl || "").match(/[?&](?:bookId|albumId|id)=(\d+)/i)?.[1] || "";
    comicId = String(baseUrl || "").match(/[?&](?:comic_id|comicId)=(\d+)/i)?.[1] || "";
    entityId = String(baseUrl || "").match(/[?&](?:entityId|entity_id)=(\d+)/i)?.[1] || "";
  }
  const pageIds = {
    bookId,
    comic_id: comicId || bookId,
    comicId: comicId || bookId,
    entityId: entityId || bookId,
    entity_id: entityId || bookId,
  };
  const values = {
    ...pageIds,
    ...(item && typeof item === "object" && !Array.isArray(item) ? item : {}),
  };
  const selectedName = String(template || "").match(/\{\{(?:(?:raw):)?(?!base:)([A-Za-z_$][\w$]*)\}\}/)?.[1];
  if (selectedName && selectedValue && (values[selectedName] === undefined || values[selectedName] === null)) {
    values[selectedName] = selectedValue;
  }
  return String(template || "").replace(/\{\{(?:(base|raw):)?([A-Za-z_$][\w$]*)\}\}/g, (_, mode, name) => {
    if (mode === "base" || name === "bookId") return encodeURIComponent(String(values.bookId || bookId || ""));
    const value = values[name] ?? pageIds[name];
    if (mode === "raw") return String(value == null ? "" : value).split("/").map(encodeURIComponent).join("/");
    return encodeURIComponent(value == null ? "" : String(value));
  });
}

function siteDomain(hostname) {
  const parts = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const second = parts.at(-2);
  const countrySuffix = parts.at(-1)?.length === 2 && /^(?:ac|co|com|edu|gov|net|org)$/.test(second);
  return parts.slice(countrySuffix ? -3 : -2).join(".");
}

function absolute(value, baseUrl, preferredHost = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  let base = baseUrl;
  if (/^\/(?!\/)/.test(source) && /^https?:\/\//i.test(String(preferredHost || ""))) {
    try {
      const response = new URL(baseUrl);
      const preferred = new URL(preferredHost);
      if (response.origin !== preferred.origin
        && siteDomain(response.hostname) === siteDomain(preferred.hostname)) {
        base = preferred.toString();
      }
    } catch {
      // Resolve against the response URL below.
    }
  }
  try { return new URL(source, base).toString(); } catch { return ""; }
}

export function bridgeTocUrl(page, baseUrl, plan) {
  if (!plan.tocSelector || plan.responseType !== "html") return "";
  const document = htmlDocument(page);
  const selected = absolute(htmlSelect(plan.tocSelector, document), baseUrl);
  const candidates = [];
  let order = 0;
  for (const anchor of document.querySelectorAll("a[href]")) {
    const raw = String(anchor.getAttribute("href") || "").trim();
    if (!raw || /^(?:javascript|#)/i.test(raw)) continue;
    const url = absolute(raw, baseUrl);
    if (!url) continue;
    const text = String(anchor.textContent || "").replace(/\s+/g, " ").trim();
    let score = -order;
    if (selected && url === selected) score += 600;
    if (/(?:章节目录|全部章节|目录列表|目录|chapter\s*list|catalog|directory|table\s+of\s+contents)/i.test(text)) score += 1_000;
    if (/(?:mainindex|rcatalog|catalog|chapter[-_/]?list|chapters|directory|mulu|index\/?)\b/i.test(url)) score += 300;
    if (/(?:点击阅读|开始阅读|立即阅读|继续阅读|下一章|上一章|read\s*now|continue\s*reading)/i.test(text)) score -= 500;
    if (/(?:\/c\/\d+|\/chapter\/\d+|\/chapters?\/\d+|\/read\/\d+)(?:\/|$)/i.test(new URL(url).pathname)) score -= 250;
    candidates.push({ url, score });
    order += 1;
  }
  if (selected && !candidates.some((item) => item.url === selected)) {
    candidates.push({ url: selected, score: 600 });
  }
  const best = candidates.sort((left, right) => right.score - left.score)[0];
  // A caller may already be on the catalogue URL returned by bookDetail.
  // When the original toc selector no longer matches there, following an
  // arbitrary navigation link turns search/login pages into fake chapters.
  if (!selected && (!best || best.score < 300)) return "";
  return best?.url || selected;
}

/** Per-response defaults. Full catalogues are served via page/offset, not truncation. */
export const DEFAULT_BRIDGE_LIMITS = Object.freeze({
  books: 40,
  chapters: 100,
  scanMultiplier: 6,
  maxScanBooks: 2_000,
  maxScanChapters: 12_000,
  maxPageSize: 200,
});

function resolvePageSize(kind, limit, overrides = {}) {
  const defaults = { ...DEFAULT_BRIDGE_LIMITS, ...overrides };
  const hard = defaults.maxPageSize;
  if (Number.isFinite(limit)) return Math.max(0, Math.min(hard, Math.floor(limit)));
  if (kind === "books") return Math.min(hard, defaults.books);
  if (kind === "chapters") return Math.min(hard, defaults.chapters);
  return Math.min(hard, defaults.books);
}

function resolveBridgeScanCap(kind, needValid, overrides = {}) {
  const defaults = { ...DEFAULT_BRIDGE_LIMITS, ...overrides };
  if (!Number.isFinite(needValid)) {
    return kind === "books" ? defaults.maxScanBooks : defaults.maxScanChapters;
  }
  const scaled = needValid * defaults.scanMultiplier;
  const hard = kind === "books" ? defaults.maxScanBooks : defaults.maxScanChapters;
  return Math.min(hard, Math.max(needValid + 16, scaled));
}

/** Extract a reading-order chapter number from title or URL when possible. */
export function chapterSortKey(row) {
  const title = String(row?.title || "");
  const url = String(row?.url || "");
  const patterns = [
    /第\s*([0-9]+)\s*[章节回集话卷篇]/,
    /(?:chapter|chap|ep|episode|ch)\s*[.\-_#]?\s*([0-9]+)/i,
    /(?:^|[^\d])([0-9]{1,6})\s*(?:话|章|回|集)(?:$|[^\d])/,
    /^\s*([0-9]{1,6})(?:\s*[.、:：)\]]|\s+)/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return Number(match[1]);
  }
  const urlPatterns = [
    /\/(?:chapter|chapters|read|episode|ep|ch)\/([0-9]+)/i,
    /[_\-]([0-9]{1,6})(?:\.[A-Za-z0-9]+)?(?:[?#]|$)/,
    /\/([0-9]{1,6})\.html?(?:[?#]|$)/i,
  ];
  for (const pattern of urlPatterns) {
    const match = url.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Xiangse swipe-to-next expects ascending chapter order (1 → 2 → 3).
 * Sort by detected numbers when reliable; otherwise honour Legado reverse
 * (`-chapterList`) or auto-detect a descending DOM list.
 */
export function orderChaptersAscending(rows, { reverseHint = false } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const keyed = rows.map((row, index) => ({
    row,
    index,
    number: chapterSortKey(row),
  }));
  const numbered = keyed.filter((item) => Number.isFinite(item.number));
  if (numbered.length >= Math.ceil(rows.length * 0.5)) {
    return keyed
      .slice()
      .sort((left, right) => (
        (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ))
      .map((item) => item.row);
  }
  if (reverseHint) return rows.slice().reverse();
  if (numbered.length >= 4) {
    let decreases = 0;
    let increases = 0;
    for (let index = 1; index < numbered.length; index += 1) {
      if (numbered[index].number < numbered[index - 1].number) decreases += 1;
      else if (numbered[index].number > numbered[index - 1].number) increases += 1;
    }
    if (decreases > increases) return rows.slice().reverse();
  }
  return rows;
}

export function executeBridgePlan(body, baseUrl, rawPlan, { limit, offset = 0, limits } = {}) {
  const plan = normalizePlan(rawPlan);
  let input = body;
  if (plan.responseType === "json") {
    try { input = JSON.parse(String(body || "")); } catch { throw new TypeError("上游响应不是规则声明的 JSON"); }
  }
  const parsedInput = plan.responseType === "html" ? htmlDocument(input) : input;
  if (plan.kind === "text") {
    let content = transformed(plan, plan.fields.content, parsedInput, { content: plan.responseType === "html" });
    // Novel text adapters historically returned innerHTML; Xiangse shows tags
    // literally unless we normalize to plain text with paragraph breaks.
    if (plan.responseType === "html" || /<[a-z][\s\S]*>/i.test(String(content || ""))) {
      content = htmlToPlainText(content);
    }
    return { content };
  }
  if (plan.kind === "detail") {
    const result = {};
    for (const [name, rule] of Object.entries(plan.fields)) {
      result[name] = transformed(plan, rule, parsedInput, { content: false, baseUrl });
      const field = normalizeField(rule);
      if (field?.urlTemplate) result[name] = expandUrlTemplate(field.urlTemplate, input, baseUrl, result[name]);
    }
    if (result.cover) result.cover = absolute(result.cover, baseUrl);
    return result;
  }
  const pageSize = resolvePageSize(plan.kind, limit, limits);
  const start = Math.max(0, Math.floor(Number(offset)) || 0);
  // Chapters must be collected then sorted ascending before offset/limit so
  // swipe-to-next reads 第1章 → 第2章 instead of newest-first site order.
  const needValid = plan.kind === "chapters"
    ? undefined
    : start + Math.max(pageSize, 0) + 1;
  const scanCap = resolveBridgeScanCap(plan.kind, needValid, limits);
  const items = plan.responseType === "json" || plan.responseType === "embedded-json"
    ? (() => {
      const value = plan.responseType === "embedded-json"
        ? embeddedJsonArray(input, plan.list)
        : jsonPath(input, plan.list);
      const list = Array.isArray(value) ? value : [];
      return Number.isFinite(scanCap) ? list.slice(0, scanCap) : list;
    })()
    : htmlSelect(plan.list, parsedInput, { list: true, maxNodes: scanCap });
  if (pageSize === 0) {
    return { data: [], hasMore: false, offset: start, pageSize };
  }

  if (plan.kind === "chapters") {
    const rows = [];
    for (const item of items) {
      const row = {};
      for (const [name, rule] of Object.entries(plan.fields)) row[name] = transformed(plan, rule, item, { baseUrl });
      const urlField = normalizeField(plan.fields.url);
      if (urlField?.urlTemplate) {
        row.url = expandUrlTemplate(urlField.urlTemplate, item, baseUrl, row.url);
      } else {
        row.url = absolute(row.url, baseUrl, plan.host);
      }
      if (!row.title || !row.url) continue;
      rows.push(row);
    }
    const ordered = plan.preserveOrder
      ? rows
      : orderChaptersAscending(rows, { reverseHint: Boolean(plan.reverse) });
    const page = ordered.slice(start, start + pageSize);
    // Full page ⇒ assume more (upstream JSON menus like getBookMenu page by
    // pageNum). Previously hasMore stayed false when items.length < scanCap,
    // so Xiangse stopped after the first 50 chapters.
    return {
      data: page,
      hasMore: ordered.length > start + page.length || page.length >= pageSize,
      offset: start,
      pageSize,
    };
  }

  const page = [];
  let seenValid = 0;
  let hasMore = false;
  for (const item of items) {
    const row = {};
    for (const [name, rule] of Object.entries(plan.fields)) row[name] = transformed(plan, rule, item, { baseUrl });
    const urlField = normalizeField(plan.fields.url);
    row.url = urlField?.urlTemplate
      ? expandUrlTemplate(urlField.urlTemplate, item, baseUrl, row.url)
      : absolute(row.url, baseUrl, plan.host);
    const coverField = normalizeField(plan.fields.cover);
    if (coverField?.urlTemplate) row.cover = expandUrlTemplate(coverField.urlTemplate, item, baseUrl, row.cover);
    if (row.cover) row.cover = absolute(row.cover, baseUrl);
    if (!row.name || !row.url) continue;
    if (seenValid < start) {
      seenValid += 1;
      continue;
    }
    if (page.length < pageSize) {
      page.push(row);
      seenValid += 1;
      continue;
    }
    hasMore = true;
    break;
  }
  // Same full-page rule for upstream-paged book lists (search/category APIs).
  if (!hasMore && page.length >= pageSize) {
    hasMore = true;
  }
  return {
    data: page,
    hasMore,
    offset: start,
    pageSize,
  };
}

export function executeBridgeSelector(body, baseUrl, responseType, selector, { list = false } = {}) {
  const plan = normalizePlan({
    kind: "detail",
    host: baseUrl,
    responseType,
    fields: { name: selector },
  });
  let input = body;
  if (plan.responseType === "json") {
    try { input = JSON.parse(String(body || "")); } catch { throw new TypeError("上游响应不是规则声明的 JSON"); }
  }
  return select(plan, plan.fields.name, input, { baseUrl, list });
}
