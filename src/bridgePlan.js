import { JSDOM } from "jsdom";
import { isXiangseGbkEncode } from "./charset.js";
import { convertRule } from "./selectors.js";
import { normalizeXiangseItemRule } from "./xiangseRules.js";

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

function normalizeProjectedPaths(value) {
  const paths = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    const path = String(candidate || "").trim().replace(/^\$\.?/, "").replace(/\./g, "/");
    if (!path || path.length > 256 || paths.includes(path)) continue;
    const parts = path.split("/");
    if (!parts.every((part) => /^(?:[A-Za-z_$][\w$]*|\d{1,5})$/.test(part)
      && !["__proto__", "prototype", "constructor"].includes(part))) continue;
    paths.push(path);
    if (paths.length >= 24) break;
  }
  return paths;
}

function projectedPathValue(value, path) {
  let current = value;
  for (const part of String(path || "").split("/")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function setProjectedPath(target, path, value) {
  const parts = String(path || "").split("/");
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!Object.hasOwn(current, part)) current[part] = {};
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) return;
    current = current[part];
  }
  const leaf = parts.at(-1);
  if (leaf && !["__proto__", "prototype", "constructor"].includes(leaf)
    && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    current[leaf] = value;
  }
}

function projectPaths(value, paths) {
  const result = {};
  for (const path of paths || []) {
    const selected = projectedPathValue(value, path);
    if (selected !== undefined && selected !== null) setProjectedPath(result, path, selected);
  }
  return result;
}

function normalizeContextualRows(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const itemPaths = normalizeProjectedPaths(value.itemPaths);
  const contextPaths = normalizeProjectedPaths(value.contextPaths);
  return itemPaths.length && contextPaths.length ? { itemPaths, contextPaths } : null;
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
    const valueTemplate = String(rule.valueTemplate || "").trim().slice(0, 2_048);
    const selector = selectorOnly(normalizeXiangseItemRule(rule.selector))
      || (urlTemplate || valueTemplate ? "id" : "");
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
    const valueMaps = {};
    for (const [field, mapping] of Object.entries(rule.valueMaps || {}).slice(0, 8)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(field) || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
      const entries = Object.entries(mapping).slice(0, 24).map(([key, value]) => [
        String(key).slice(0, 128),
        String(value).slice(0, 512),
      ]);
      if (entries.length) valueMaps[field] = Object.fromEntries(entries);
    }
    const templateFields = {};
    for (const [name, fieldSelector] of Object.entries(rule.templateFields || {}).slice(0, 8)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const normalized = selectorOnly(normalizeXiangseItemRule(fieldSelector));
      if (normalized) templateFields[name] = normalized;
    }
    const rootTemplateFields = {};
    for (const [name, fieldSelector] of Object.entries(rule.rootTemplateFields || {}).slice(0, 8)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const normalized = String(fieldSelector || "").trim()
        .replace(/^@json:/i, "")
        .replace(/^\$\.?/, "")
        .replace(/\[(\*|\d+)\]/g, "/$1")
        .replace(/\./g, "/")
        .replace(/^\/+/, "");
      if (normalized && normalized.length <= 512) rootTemplateFields[name] = normalized;
    }
    return {
      selector,
      replacements,
      hostPrefix: Boolean(rule.hostPrefix),
      matchTemplate,
      ...(String(rule.fallback || "").trim() ? { fallback: String(rule.fallback).trim().slice(0, 2048) } : {}),
      ...(urlTemplate && /^https?:\/\//i.test(urlTemplate) ? { urlTemplate } : {}),
      ...(valueTemplate ? { valueTemplate } : {}),
      ...(Object.keys(valueMaps).length ? { valueMaps } : {}),
      ...(Object.keys(templateFields).length ? { templateFields } : {}),
      ...(Object.keys(rootTemplateFields).length ? { rootTemplateFields } : {}),
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
        hostPrefix: /^(?:\/|\.{1,2}\/)/.test(prefix),
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
  let filter = null;
  if (kind === "books" && value.filter && typeof value.filter === "object") {
    const field = selectorOnly(value.filter.field);
    const equals = String(value.filter.equals ?? "").slice(0, 512);
    if (field && equals) filter = { field, equals };
  }
  const contextualRows = kind === "chapters" ? normalizeContextualRows(value.contextualRows) : null;
  let tocRequest = null;
  if (kind === "chapters" && value.tocRequest && typeof value.tocRequest === "object") {
    const pattern = safeRegexPattern(value.tocRequest.pattern);
    const prefix = String(value.tocRequest.prefix || "").slice(0, 2048);
    const suffix = String(value.tocRequest.suffix || "").slice(0, 2048);
    const capture = Math.max(1, Math.min(8, Number(value.tocRequest.capture) || 1));
    if (pattern && (prefix || suffix)) tocRequest = { pattern, prefix, suffix, capture };
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
    ...(filter ? { filter } : {}),
    ...(tocRequest ? { tocRequest } : {}),
    ...(latestChapter ? { latestChapter } : {}),
    ...(contextualRows ? { contextualRows } : {}),
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

function domScriptUrlTemplate(script) {
  const source = String(script || "").trim();
  if (!/^@js:/i.test(source) || !/\bresult\.(?:attr|select)\s*\(/i.test(source)) return null;
  const templateFields = {};
  const declarationPrefix = String.raw`\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?`;
  const declarationSuffix = String.raw`\s*\)?\s*;`;
  for (const match of source.matchAll(new RegExp(
    declarationPrefix + String.raw`result\.attr\(\s*["']([A-Za-z_][\w:-]*)["']\s*\)` + declarationSuffix,
    "g",
  ))) {
    templateFields[match[1]] = `./@${match[2]}`;
  }
  for (const match of source.matchAll(new RegExp(
    declarationPrefix + String.raw`result\.select\(\s*["']([^'"\\\r\n]+)["']\s*\)(?:\.first\(\))?\.(text|ownText)\(\s*\)` + declarationSuffix,
    "g",
  ))) {
    const selector = convertRule(match[2], { responseType: "html" });
    if (selector && !/^@js:/i.test(selector)) templateFields[match[1]] = selector;
  }
  for (const match of source.matchAll(new RegExp(
    declarationPrefix + String.raw`result\.select\(\s*["']([^'"\\\r\n]+)["']\s*\)(?:\.first\(\))?\.attr\(\s*["']([A-Za-z_][\w:-]*)["']\s*\)` + declarationSuffix,
    "g",
  ))) {
    const selector = convertRule(`${match[2]}@${match[3]}`, { responseType: "html" });
    if (selector && !/^@js:/i.test(selector)) templateFields[match[1]] = selector;
  }
  const names = Object.keys(templateFields);
  if (!names.length) return null;

  const returned = source.match(/\breturn\s+([\s\S]+?)\s*;?\s*$/i);
  if (!returned) return null;
  let expression = returned[1].trim().replace(/;\s*$/, "");
  while (expression.startsWith("(") && expression.endsWith(")")) {
    expression = expression.slice(1, -1).trim();
  }
  const parts = [];
  let cursor = 0;
  while (cursor < expression.length) {
    const spacing = expression.slice(cursor).match(/^\s+/)?.[0] || "";
    cursor += spacing.length;
    const token = expression[cursor];
    if (!token) break;
    if (token === "+" || token === "(" || token === ")") {
      cursor += 1;
      continue;
    }
    const literal = expression.slice(cursor).match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
    if (literal) {
      try { parts.push(staticStringLiteral(literal[0])); } catch { return null; }
      cursor += literal[0].length;
      continue;
    }
    const call = expression.slice(cursor).match(/^(?:encodeURIComponent|encodeURI|String)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    const variable = call?.[1] || expression.slice(cursor).match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (!variable || !Object.hasOwn(templateFields, variable)) return null;
    parts.push(`{{${variable}}}`);
    cursor += call ? call[0].length : variable.length;
  }
  const urlTemplate = parts.join("");
  if (!/^https?:\/\//i.test(urlTemplate) || urlTemplate.length > 2_048 || !/\{\{/.test(urlTemplate)) return null;
  return { selector: templateFields[names[0]], urlTemplate, templateFields };
}

function mappedResultUrlTemplate(script) {
  const returned = String(script || "").match(/\breturn\s+([\s\S]+?)\s*;?\s*$/i);
  if (!returned) return null;
  let expression = returned[1].replace(/;\s*$/, "").trim();
  const valueMaps = {};
  expression = expression.replace(
    /\(\s*\{([^{}]{1,4096})\}\s*\[\s*result\.([A-Za-z_$][\w$]*)\s*\]\s*\|\|\s*result\.\2\s*\)/g,
    (whole, body, field) => {
      const mapping = {};
      let consumed = "";
      const entryPattern = /\s*(["'])([^"']+)\1\s*:\s*(["'])((?:\\.|(?!\3)[\s\S])*)\3\s*(,|$)/gy;
      let cursor = 0;
      while (cursor < body.length) {
        entryPattern.lastIndex = cursor;
        const entry = entryPattern.exec(body);
        if (!entry) return whole;
        let value;
        try { value = staticStringLiteral(`${entry[3]}${entry[4]}${entry[3]}`); } catch { return whole; }
        mapping[entry[2]] = value;
        cursor = entryPattern.lastIndex;
        consumed += entry[0];
      }
      if (!Object.keys(mapping).length || consumed.trim().length !== body.trim().length) return whole;
      valueMaps[field] = mapping;
      return JSON.stringify(`<READ2XSGG:${field}>`);
    },
  );
  // Leave ordinary prefix/suffix concatenation to the older matchTemplate
  // compiler. This path exists specifically for object-lookup value maps.
  if (!Object.keys(valueMaps).length) return null;
  expression = expression
    .replace(/String\(\s*result\.([A-Za-z_$][\w$]*)\s*\)/g, (_match, field) => (
      JSON.stringify(`<READ2XSGG:${field}>`)
    ))
    .replace(/\bresult\.([A-Za-z_$][\w$]*)\b/g, (_match, field) => (
      JSON.stringify(`<READ2XSGG:${field}>`)
    ));

  const parts = [];
  let cursor = 0;
  while (cursor < expression.length) {
    const rest = expression.slice(cursor);
    const spacing = rest.match(/^\s+/)?.[0] || "";
    cursor += spacing.length;
    const token = expression[cursor];
    if (!token) break;
    if (token === "+" || token === "(" || token === ")") {
      cursor += 1;
      continue;
    }
    const literal = expression.slice(cursor).match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
    if (!literal) return null;
    let value;
    try { value = staticStringLiteral(literal[0]); } catch { return null; }
    parts.push(value);
    cursor += literal[0].length;
  }
  const combined = parts.join("");
  const fields = [...combined.matchAll(/<READ2XSGG:([A-Za-z_$][\w$]*)>/g)].map((match) => match[1]);
  if (!fields.length) return null;
  const httpTemplate = /^https?:\/\//i.test(combined);
  const template = combined.replace(
    /<READ2XSGG:([A-Za-z_$][\w$]*)>/g,
    httpTemplate ? "{{$1}}" : "{{text:$1}}",
  );
  if (template.length > 2048) return null;
  return httpTemplate
    ? { selector: fields[0], urlTemplate: template, valueMaps }
    : { selector: fields[0], valueTemplate: template, valueMaps };
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
    /return\s+\(?\s*String\(\s*config\.host\s*\)\s*\+\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\)(?:\s*\+\s*("(?:\\.|[^"\\])*"))?\s*\)?\s*;/i,
  );
  if (hostTemplate) {
    try {
      return {
        selector: hostTemplate[2].replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/"),
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
  const domUrl = domScriptUrlTemplate(source);
  if (domUrl) return domUrl;
  const mappedUrl = mappedResultUrlTemplate(source);
  if (mappedUrl) return mappedUrl;
  const stringLiteral = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;
  const threePart = source.match(new RegExp(
    `return\\s+\\(?\\s*(${stringLiteral})\\s*\\+\\s*(?:String\\(\\s*result\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\])*)\\s*\\)|result\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\])*))\\s*\\+\\s*(${stringLiteral})\\s*\\)?\\s*;`,
    "i",
  ));
  if (threePart) {
    try {
      const prefix = staticStringLiteral(threePart[1]);
      const suffix = staticStringLiteral(threePart[4]);
      const hostPrefix = /^(?:\/|\.{1,2}\/)/.test(prefix);
      return {
        selector: (threePart[2] || threePart[3]).replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/"),
        hostPrefix,
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix,
          suffix,
          hostPrefix,
        },
      };
    } catch {
      return "";
    }
  }
  const prefixOnly = source.match(
    /return\s+\(?\s*("(?:\\.|[^"\\])*")\s*\+\s*String\(result\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\)\s*\)?\s*;/i,
  );
  if (prefixOnly) {
    try {
      const prefix = JSON.parse(prefixOnly[1]);
      const hostPrefix = /^(?:\/|\.{1,2}\/)/.test(prefix);
      return {
        selector: prefixOnly[2].replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/"),
        hostPrefix,
        matchTemplate: {
          pattern: "^([\\s\\S]+)$",
          prefix,
          suffix: "",
          hostPrefix,
        },
      };
    } catch {
      return "";
    }
  }
  const suffixOnly = source.match(
    /return\s+\(?\s*String\(result\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\)\s*\+\s*("(?:\\.|[^"\\])*")\s*\)?\s*;/i,
  );
  if (suffixOnly) {
    try {
      const suffix = JSON.parse(suffixOnly[2]);
      return {
        selector: suffixOnly[1].replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/"),
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
  // Property reads such as result.id are JSON fields. Method calls such as
  // result.attr('href') are DOM operations and must be handled by
  // inferredDomScriptSelector; treating `attr` as a field drops every row.
  const fields = [...source.matchAll(/\bresult\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\b(?!\s*\()/g)]
    .map((match) => match[1].replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/"));
  for (const preferred of preferredNames) {
    const field = fields.find((name) => preferred.test(name));
    if (field) return field;
  }
  const uniqueFields = [...new Set(fields)];
  if (uniqueFields.length === 1) return uniqueFields[0];
  return "";
}

function inferredJsonEqualityFilter(rule) {
  const source = String(rule || "");
  const match = source.match(
    /\bif\s*\(\s*\(*\s*(?:String\(\s*)?result\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)*\s*={2,3}\s*(["'])((?:\\.|(?!\2)[\s\S])*)\2\s*\)*\s*\)/i,
  );
  if (!match) return null;
  let equals;
  try { equals = staticStringLiteral(`${match[2]}${match[3]}${match[2]}`); } catch { return null; }
  return { field: match[1].replace(/\./g, "/"), equals };
}

function inferredDomScriptSelector(rule, preferredNames = []) {
  const source = String(rule || "").trim();
  if (!/^@js:/i.test(source)) return rule;
  const attributes = [...source.matchAll(
    /\.attr\s*\(\s*(['"])([A-Za-z_][\w:-]*)\1\s*\)/gi,
  )].map((match) => match[2]);
  // When a script reads both a child element and its href, the URL attribute
  // is the authoritative detail target. Resolve it before the broader
  // `.select(...).text()` fallback, which would otherwise duplicate the title
  // as the URL.
  if (preferredNames.some((pattern) => pattern.test("href") || pattern.test("url"))) {
    for (const attribute of [...new Set(attributes)]) {
      if (preferredNames.some((pattern) => pattern.test(attribute))) return "//@" + attribute;
    }
  }
  const selectors = [];
  const patterns = [
    /\bjava\.getString(?:List)?\s*\(\s*(['"])([^'"\\\r\n]+)\1/gi,
    /\bjava\.getElements?\s*\(\s*(['"])([^'"\\\r\n]+)\1/gi,
    /\.select\s*\(\s*(['"])([^'"\\\r\n]+)\1\s*\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const selector = String(match[2] || "").trim();
      if (!selector || selector.includes("{{") || selector.includes("${")) continue;
      selectors.push(selector);
    }
  }
  const ranked = [...new Set(selectors)].sort((left, right) => {
    const score = (value) => preferredNames.reduce((total, pattern, index) => (
      total + (pattern.test(value) ? preferredNames.length - index : 0)
    ), 0);
    return score(right) - score(left);
  });
  for (const selector of ranked) {
    const converted = convertRule(selector, { responseType: "html" });
    if (converted && !/^@js:/i.test(converted)) return converted;
  }
  for (const attribute of [...new Set(attributes)]) {
    const wanted = preferredNames.some((pattern) => pattern.test(attribute));
    if (!wanted) continue;
    return "//@" + attribute;
  }
  if (preferredNames.some((pattern) => pattern.test("text") || pattern.test("title") || pattern.test("name"))
    && /\bresult\.(?:text|ownText)\s*\(\s*\)/i.test(source)) {
    return ".";
  }
  // Some list fields parse the serialized item with a regex instead of using
  // Legado's DOM helpers. Preserve the referenced attribute declaratively.
  if (preferredNames.some((pattern) => pattern.test("href") || pattern.test("url"))
    && /(?:getAttribute\s*\(\s*['"]href['"]|\bhref\\?=[\\]?['"])/i.test(source)) {
    return "//a[@href]/@href";
  }
  if (preferredNames.some((pattern) => pattern.test("src") || pattern.test("img") || pattern.test("cover"))
    && /(?:getAttribute\s*\(\s*['"](?:src|data-src|data-original)['"]|\b(?:src|data-src|data-original)\\?=[\\]?['"])/i.test(source)) {
    return "//img/@src||//img/@data-src||//img/@data-original";
  }
  if (preferredNames.some((pattern) => pattern.test("title") || pattern.test("name"))
    && /(?:getAttribute\s*\(\s*['"]title['"]|\btitle\\?=[\\]?['"])/i.test(source)) {
    return "//@title";
  }
  return "";
}

function directDomAttributeGuard(rule) {
  const source = String(rule || "");
  if (!/^@js:/i.test(source) || !/\b(?:java\.ajax|java\.connect)\s*\(/i.test(source)) return "";
  const variables = new Map();
  for (const match of source.matchAll(
    /(?:\bvar\s+|\blet\s+|\bconst\s+)?([A-Za-z_$][\w$]*)\s*=\s*result\.attr\s*\(\s*(['"])([A-Za-z_][\w:-]*)\2\s*\)/gi,
  )) variables.set(match[1], match[3]);
  for (const [variable, attribute] of variables) {
    if (/^(?:href|src|url)$/i.test(attribute)) continue;
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\bif\\s*\\(\\s*!\\s*${escaped}\\s*\\)`).test(source)) return attribute;
  }
  return "";
}

function requireListAttribute(list, attribute) {
  const source = String(list || "").trim();
  if (!source || !attribute || !/^[A-Za-z_][\w:-]*$/.test(attribute)) return source;
  if (new RegExp(`@${attribute}(?:\\b|\\])`, "i").test(source)) return source;
  return `(${source})[@${attribute}]`;
}

function domListProjection(rule, field) {
  const source = String(rule || "");
  if (!/^@js:/i.test(source)
    || !/(?:\b(?:Packages\.)?org\.jsoup\.Jsoup|__xsJsoup)/i.test(source)
    || !/\.parse\s*\(/i.test(source)
    || !/\.select\s*\(/i.test(source)) return "";
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (field === "title" && new RegExp(
    `\\b${escapedField}\\s*:\\s*[^,}\\r\\n]*\\.(?:text|ownText)\\s*\\(`,
    "i",
  ).test(source)) return ".";
  const attribute = source.match(new RegExp(
    `\\b${escapedField}\\s*:\\s*[^,}\\r\\n]*\\.attr\\s*\\(\\s*(['"])([A-Za-z_][\\w:-]*)\\1`,
    "i",
  ))?.[2];
  return attribute ? "//@" + attribute : "";
}

function isDomListProjection(rule) {
  const source = String(rule || "");
  return /^@js:/i.test(source)
    && /(?:\b(?:Packages\.)?org\.jsoup\.Jsoup|__xsJsoup)/i.test(source)
    && /\.parse\s*\(/i.test(source)
    && /\.select\s*\(/i.test(source)
    && /(?:\.push\s*\(|\.add\s*\()/i.test(source);
}

function splitDomProjectionTernary(source) {
  const value = String(source || "");
  let quote = "";
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  let question = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    if (round || square || curly) continue;
    if (character === "?" && question < 0) {
      question = index;
      continue;
    }
    if (character === ":" && question >= 0) {
      return [value.slice(question + 1, index).trim(), value.slice(index + 1).trim()];
    }
  }
  return null;
}

function stripDomProjectionTransforms(value) {
  let source = unwrapProjectionExpression(value);
  for (let count = 0; count < 8; count += 1) {
    const before = source;
    source = source
      .replace(/\.(?:trim|toString)\s*\(\s*\)\s*$/i, "")
      .replace(/\.(?:replace|split|join)\s*\([\s\S]*\)\s*(?:\[\s*\d+\s*\])?\s*$/i, "");
    const wrapper = source.match(/^(?:String|Number|Boolean|E)\s*\(([\s\S]*)\)$/i);
    if (wrapper) source = unwrapProjectionExpression(wrapper[1]);
    if (source === before) break;
  }
  return source.trim();
}

function domProjectionRelativeSelector(value) {
  const converted = convertRule(value, { responseType: "html" });
  if (!converted || /^@js:|^<js>/i.test(converted)) return "";
  const first = String(converted).split(/\s*\|\|\s*/, 1)[0].trim();
  if (!first) return "";
  if (first.startsWith("//")) return `.${first}`;
  if (first.startsWith("/")) return `.${first}`;
  return first;
}

function domProjectionAppendIndex(selector, index) {
  const base = String(selector || ".").trim() || ".";
  // Keep the predicate on the final XPath step. normalizeXiangseItemRule
  // intentionally removes a leading `.//` from item rules; wrapping the path
  // in parentheses would hide that prefix and turn it back into a document-
  // global XPath inside the bridge.
  if (base === ".") return ".";
  return `${base}[${Number(index) + 1}]`;
}

function domProjectionAppendDescendant(selector, child) {
  const path = String(selector || "").trim();
  const relative = String(child || "").trim();
  if (!relative) return "";
  const suffix = relative.startsWith(".//")
    ? relative.slice(3)
    : relative.startsWith("//")
      ? relative.slice(2)
      : relative.replace(/^\.\//, "");
  if (!suffix) return path || ".";
  if (!path || path === ".") return `.//${suffix}`;
  return `${path}//${suffix}`;
}

function collectDomProjectionAssignments(source) {
  const assignments = new Map();
  const pattern = /\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!=)([^;]{1,4096})(?:;|$)/g;
  for (const match of String(source || "").matchAll(pattern)) {
    const initialName = match[1];
    if (["if", "for", "while", "switch", "return", "function"].includes(initialName)) continue;
    const chunks = splitProjectionProperties(String(match[2] || ""));
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex].trim();
      const pair = chunkIndex === 0
        ? { name: initialName, expression: chunk }
        : chunk.match(/^([A-Za-z_$][\w$]*)\s*=\s*(?!=)([\s\S]+)$/)
          ? { name: chunk.match(/^([A-Za-z_$][\w$]*)\s*=\s*(?!=)([\s\S]+)$/)[1], expression: chunk.match(/^([A-Za-z_$][\w$]*)\s*=\s*(?!=)([\s\S]+)$/)[2] }
          : null;
      if (!pair?.expression) continue;
      const entries = assignments.get(pair.name) || [];
      entries.push({ expression: pair.expression.trim(), index: (match.index || 0) + chunkIndex });
      assignments.set(pair.name, entries);
    }
  }
  return assignments;
}

function extractDomProjectionObjects(source) {
  const input = String(source || "");
  const objects = [];
  for (const match of input.matchAll(/\.(?:push|add)\s*\(/g)) {
    const start = (match.index || 0) + match[0].length;
    const open = input.indexOf("{", start);
    if (open < 0 || open > start + 128) continue;
    let quote = "";
    let escaped = false;
    let depth = 0;
    for (let index = open; index < input.length; index += 1) {
      const character = input[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push({ body: input.slice(open + 1, index), index: open });
          break;
        }
      }
    }
  }
  return objects;
}

function compileDomProjectionExpression(expression, position, state, resolving = new Set()) {
  let source = stripDomProjectionTransforms(expression);
  const ternary = splitDomProjectionTernary(source);
  if (ternary) {
    return compileDomProjectionExpression(ternary[0], position, state, resolving)
      || compileDomProjectionExpression(ternary[1], position, state, resolving);
  }
  const plusParts = splitTopLevelPlus(source);
  if (plusParts.length > 1) {
    let dynamic = null;
    for (const part of plusParts) {
      const result = compileDomProjectionExpression(part, position, state, resolving);
      if (result?.path) dynamic ||= result;
      else if (result?.constant !== undefined) continue;
    }
    return dynamic;
  }
  const literal = projectionLiteral(source);
  if (literal !== null) return { constant: literal };
  const wrapperCall = source.match(/^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/);
  const wrapperDefinition = wrapperCall && state.wrapperBodies?.get?.(wrapperCall[1]);
  if (wrapperDefinition) {
    if (resolving.has(wrapperCall[1])) return null;
    const parameter = String(wrapperDefinition.parameter || "").trim();
    const argument = String(wrapperCall[2] || "").trim();
    if (!parameter || !argument) return null;
    const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const substituted = String(wrapperDefinition.expression || "")
      .replace(new RegExp(`\\b${escaped}\\b`, "g"), argument);
    return compileDomProjectionExpression(
      substituted,
      position,
      state,
      new Set(resolving).add(wrapperCall[1]),
    );
  }
  if (wrapperCall && state.wrappers?.has(wrapperCall[1])) {
    return compileDomProjectionExpression(wrapperCall[2], position, state, resolving);
  }
  const javaWrapper = source.match(
    /^java\.(?:t2s|s2t|toSimplified|toTraditional|trim|unescape|urlDecode|decode)\s*\(([\s\S]*)\)$/i,
  );
  if (javaWrapper) {
    return compileDomProjectionExpression(javaWrapper[1], position, state, resolving);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(source)) {
    if (resolving.has(source)) return null;
    const root = state.rootFor(source, position);
    if (root) return { path: ".", rootName: source, rootSelector: root.selector };
    const candidates = (state.assignments.get(source) || [])
      .filter((item) => item.index <= position)
      .slice()
      .reverse();
    for (const assignment of candidates) {
      const nextResolving = new Set(resolving).add(source);
      const result = compileDomProjectionExpression(assignment.expression, assignment.index, state, nextResolving);
      if (result?.selector || result?.constant || result?.path) return result;
    }
    return null;
  }

  const baseMatch = source.match(/^([A-Za-z_$][\w$]*)/);
  if (!baseMatch) return null;
  const baseName = baseMatch[1];
  const root = state.rootFor(baseName, position);
  let current = root
    ? { path: "", rootName: baseName, rootSelector: root.selector }
    : compileDomProjectionExpression(baseName, position, state, resolving);
  if (!current || current.constant) return null;
  let rest = source.slice(baseName.length).trim();
  while (rest) {
    let match = rest.match(/^\.get\s*\(\s*([A-Za-z_$][\w$]*|\d+)\s*\)/);
    if (match) {
      const token = match[1];
      if (/^\d+$/.test(token)) current.path = domProjectionAppendIndex(current.path || ".", Number(token));
      else if (!current.path) current.path = ".";
      rest = rest.slice(match[0].length).trim();
      continue;
    }
    match = rest.match(/^\.first\s*\(\s*\)/);
    if (match) {
      current.path = domProjectionAppendIndex(current.path || ".", 0);
      rest = rest.slice(match[0].length).trim();
      continue;
    }
    match = rest.match(/^\.select\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/);
    if (match) {
      let selector = match[2];
      try { selector = staticStringLiteral(`${match[1]}${selector}${match[1]}`); } catch { return null; }
      const converted = domProjectionRelativeSelector(selector);
      if (!converted) return null;
      current.path = domProjectionAppendDescendant(current.path, converted);
      rest = rest.slice(match[0].length).trim();
      continue;
    }
    match = rest.match(/^\.attr\s*\(\s*(['"])([A-Za-z_][\w:-]*)\1\s*\)/i);
    if (match) {
      const path = current.path || ".";
      current.path = `${path}/@${match[2]}`;
      rest = rest.slice(match[0].length).trim();
      continue;
    }
    match = rest.match(/^\.(?:text|ownText|html)\s*\(\s*\)/i);
    if (match) {
      current.path ||= ".";
      rest = rest.slice(match[0].length).trim();
      continue;
    }
    return null;
  }
  return current;
}

/**
 * Compile a bounded Jsoup/DOM list projection into relative XPath fields.
 * Legado scripts frequently parse HTML, build JSON-shaped rows, and then use
 * `$.name`/`$.bookUrl` rules. The server deliberately does not execute that
 * arbitrary JavaScript; this recognises only DOM selection chains and emits a
 * data-only bridge plan that is reusable by every site and media category.
 */
export function compileDomBookProjection(rule) {
  const source = String(rule || "").trim();
  if (!isDomListProjection(source)) return null;
  const assignments = collectDomProjectionAssignments(source);
  const roots = new Map();
  const parserOwners = new Set(["doc", "document", "root", "html"]);
  for (const [name, entries] of assignments) {
    if (entries.some((entry) => /(?:\.parse\s*\(|\bJsoup\b|__xsJsoup)/i.test(entry.expression))) {
      parserOwners.add(name);
    }
  }
  for (const match of source.matchAll(
    /\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.select\s*\(\s*(['"])((?:\\.|(?!\3)[^\\])*)\3\s*\)/g,
  )) {
    if (!parserOwners.has(match[2])) continue;
    let selector = match[4];
    try { selector = staticStringLiteral(`${match[3]}${match[4]}${match[3]}`); } catch { /* keep raw */ }
    if (!selector) continue;
    const entries = roots.get(match[1]) || [];
    entries.push({ selector, index: match.index || 0 });
    roots.set(match[1], entries);
  }
  if (!roots.size) return null;
  const wrappers = new Set(["String", "Number", "Boolean", "E"]);
  for (const match of source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\}/g,
  )) {
    if (new RegExp(`\\breturn\\b[\\s\\S]*\\b${match[2].replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`).test(match[3])) {
      wrappers.add(match[1]);
    }
  }
  const state = {
    assignments,
    wrappers,
    rootFor(name, position) {
      return (roots.get(name) || [])
        .filter((item) => item.index <= position)
        .at(-1) || null;
    },
  };
  const canonical = {
    name: "name",
    title: "name",
    bookName: "name",
    n: "name",
    bookUrl: "bookUrl",
    detailUrl: "bookUrl",
    url: "bookUrl",
    href: "bookUrl",
    link: "bookUrl",
    u: "bookUrl",
    author: "author",
    intro: "intro",
    desc: "intro",
    description: "intro",
    kind: "kind",
    cat: "kind",
    category: "kind",
    lastChapter: "lastChapter",
    lastChapterTitle: "lastChapter",
    coverUrl: "coverUrl",
    cover: "coverUrl",
    image: "coverUrl",
    pic: "coverUrl",
    wordCount: "wordCount",
    status: "status",
  };
  const candidates = [];
  for (const object of extractDomProjectionObjects(source)) {
    const properties = new Map();
    for (const property of splitProjectionProperties(object.body)) {
      const pair = property.match(/^([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*([\s\S]+)$/);
      if (!pair) continue;
      const key = pair[1].replace(/^['"]|['"]$/g, "");
      const target = canonical[key];
      if (target) properties.set(target, pair[2].trim());
    }
    const nameExpression = properties.get("name");
    const urlExpression = properties.get("bookUrl");
    if (!nameExpression || !urlExpression) continue;
    const name = compileDomProjectionExpression(nameExpression, object.index, state);
    const url = compileDomProjectionExpression(urlExpression, object.index, state);
    if (!name?.path || !url?.path || name.rootName !== url.rootName || !name.rootSelector) continue;
    const list = domProjectionRelativeSelector(name.rootSelector).replace(/^\.\/\//, "//");
    if (!list) continue;
    const fields = {};
    for (const [target, expression] of properties) {
      const compiled = compileDomProjectionExpression(expression, object.index, state);
      if (compiled?.path) fields[target] = compiled.path;
      else if (compiled?.constant) fields[target] = { constant: compiled.constant };
    }
    if (fields.name && fields.bookUrl) candidates.push({ list, fields });
  }
  if (!candidates.length) return null;
  const result = { list: "", fields: {} };
  for (const candidate of candidates.slice(0, 8)) {
    result.list = result.list ? `${result.list}||${candidate.list}` : candidate.list;
    for (const [field, value] of Object.entries(candidate.fields)) {
      if (value && typeof value === "object") {
        if (!result.fields[field]) result.fields[field] = value;
        continue;
      }
      if (!result.fields[field]) result.fields[field] = value;
      else if (result.fields[field] !== value) result.fields[field] = `${result.fields[field]}||${value}`;
    }
  }
  return result.list && result.fields.name && result.fields.bookUrl ? result : null;
}

function extractDomProjectionObjectLiterals(source) {
  const input = String(source || "");
  const markers = [
    ...input.matchAll(/JSON\.stringify\s*\(/gi),
    ...input.matchAll(/\breturn\s*(?=\{)/gi),
  ].sort((left, right) => (left.index || 0) - (right.index || 0));
  const objects = [];
  for (const match of markers) {
    const start = (match.index || 0) + match[0].length;
    const open = input.indexOf("{", start);
    if (open < 0 || open > start + 128) continue;
    let quote = "";
    let escaped = false;
    let depth = 0;
    for (let index = open; index < input.length; index += 1) {
      const character = input[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push({ body: input.slice(open + 1, index), index: open });
          break;
        }
      }
    }
  }
  return objects;
}

function domProjectionGlobalSelector(value) {
  const path = String(value || "").trim();
  if (!path || path === ".") return path;
  if (path.startsWith(".//")) return path.slice(1);
  if (path.startsWith("./")) return path.slice(1);
  return path;
}

/**
 * Compile a bounded DOM object returned by a detail init script. A common
 * Legado pattern parses HTML with Jsoup, projects fields into JSON, and then
 * applies `$.field` rules. The object is data-shaped, so its DOM chains can be
 * represented by the same declarative bridge used for lists without running
 * arbitrary source JavaScript.
 */
export function compileDomDetailProjection(rule) {
  const source = String(rule || "").trim();
  if (!/^@js:/i.test(source)
    || !/(?:\b(?:Packages\.)?org\.jsoup\.Jsoup|__xsJsoup)/i.test(source)
    || !/\.parse\s*\(/i.test(source)
    || !/\.select\s*\(/i.test(source)) return null;
  const assignments = collectDomProjectionAssignments(source);
  const documentOwners = new Set(["doc", "document", "root", "html"]);
  for (const [name, entries] of assignments) {
    if (entries.some((entry) => /(?:\.parse\s*\(|\bJsoup\b|__xsJsoup)/i.test(entry.expression))) {
      documentOwners.add(name);
    }
  }
  const wrappers = new Map();
  for (const match of source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\}/g,
  )) {
    const returnIndex = match[3].search(/\breturn\b/);
    if (returnIndex < 0) continue;
    const expression = match[3].slice(returnIndex + "return".length).replace(/;\s*$/, "").trim();
    if (expression) wrappers.set(match[1], { parameter: match[2], expression });
  }
  const state = {
    assignments,
    wrappers: new Set(["String", "Number", "Boolean", "E"]),
    wrapperBodies: wrappers,
    rootFor(name, position) {
      if (documentOwners.has(name)) return { selector: "", index: -1 };
      return null;
    },
  };
  const canonical = {
    name: "name",
    title: "name",
    bookName: "name",
    n: "name",
    author: "author",
    a: "author",
    intro: "intro",
    desc: "intro",
    description: "intro",
    o: "intro",
    kind: "kind",
    cat: "kind",
    category: "kind",
    k: "kind",
    lastChapter: "lastChapter",
    lastChapterTitle: "lastChapter",
    l: "lastChapter",
    coverUrl: "coverUrl",
    cover: "coverUrl",
    image: "coverUrl",
    pic: "coverUrl",
    c: "coverUrl",
    wordCount: "wordCount",
    words: "wordCount",
    w: "wordCount",
    status: "status",
  };
  for (const object of extractDomProjectionObjectLiterals(source)) {
    const properties = new Map();
    for (const property of splitProjectionProperties(object.body)) {
      const pair = property.match(/^([A-Za-z_$][\w$]*|(['"])(.*?)\2)\s*:\s*([\s\S]+)$/);
      if (!pair) continue;
      const key = pair[1].replace(/^['"]|['"]$/g, "");
      const target = canonical[key];
      if (target) properties.set(target, pair[4].trim());
    }
    const fields = {};
    for (const [target, expression] of properties) {
      const compiled = compileDomProjectionExpression(expression, object.index, state);
      if (compiled?.path) fields[target] = domProjectionGlobalSelector(compiled.path);
    }
    if (fields.name) return { fields };
  }
  return null;
}

function splitTopLevelPlus(source) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (const character of String(source || "")) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    if (character === "+" && round === 0 && square === 0 && curly === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitProjectionProperties(source) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (const character of String(source || "")) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    if (character === "," && round === 0 && square === 0 && curly === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function extractProjectionObjects(source) {
  const input = String(source || "");
  const objects = [];
  for (const match of input.matchAll(/\.push\s*\(/g)) {
    const start = (match.index || 0) + match[0].length;
    const open = input.indexOf("{", start);
    if (open < 0 || open > start + 64) continue;
    let quote = "";
    let escaped = false;
    let depth = 0;
    for (let index = open; index < input.length; index += 1) {
      const character = input[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(input.slice(open + 1, index));
          break;
        }
      }
    }
  }
  return objects;
}

function unwrapProjectionExpression(value) {
  let source = String(value || "").trim();
  while (source.startsWith("(") && source.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") depth -= 1;
      if (depth === 0 && index < source.length - 1) balanced = false;
    }
    if (!balanced) break;
    source = source.slice(1, -1).trim();
  }
  return source;
}

function encodeProjectionMetadata(prefix, value) {
  try {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    return `${prefix}${encoded}`.slice(0, 8_192);
  } catch {
    return "";
  }
}

function decodeProjectionMetadata(selector, prefix) {
  const encoded = String(selector || "").slice(prefix.length);
  if (!encoded || encoded.length > 8_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function projectionLiteral(value) {
  const literal = String(value || "").trim();
  if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(literal)) return null;
  try { return staticStringLiteral(literal); } catch { return null; }
}

function projectionItemPath(value, itemName, arrayName) {
  const source = unwrapProjectionExpression(value)
    .replace(/^(?:String|Number|Boolean)\s*\(\s*/, "")
    .replace(/\)\s*$/, "")
    .trim();
  const match = source.match(new RegExp(
    `^${itemName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)$`,
  ));
  if (match) return match[1];
  const indexed = source.match(new RegExp(
    `^${arrayName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\[${itemName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\]$`,
  ));
  return indexed?.[1] || "";
}

function compileHydrationProjectionValue(value, { itemName, arrayName, responseName }) {
  const parts = splitTopLevelPlus(unwrapProjectionExpression(value));
  if (!parts.length) return "";
  return parts.map((part) => {
    const literal = projectionLiteral(part);
    if (literal !== null) return literal;
    const response = String(part).trim();
    if (response === responseName) return "{{response:id}}";
    const item = response.match(new RegExp(
      `^(?:String\\s*\\(\\s*)?${itemName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\s*\\)?$`,
    ));
    if (item) return `{{item:${item[1]}}}`;
    const indexed = response.match(new RegExp(
      `^(?:String\\s*\\(\\s*)?${arrayName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\[${itemName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\]\\s*\\)?$`,
    ));
    if (indexed) return `{{item:${indexed[1]}}}`;
    return "";
  }).join("");
}

function hydrationChapterProjection(rule) {
  const source = String(rule || "").replace(/^@js:\s*/i, "").trim();
  if (!source || !/JSON\.parse\s*\(/i.test(source) || !/\.push\s*\(/i.test(source)
    || !/__NUXT_DATA__|__NEXT_DATA__|hydration/i.test(source)) return null;
  const rootAssignment = source.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]\s*;?[\s\S]{0,512}?\b\1\s*=\s*JSON\.parse\s*\(\s*([A-Za-z_$][\w$]*)\s*\[\s*1\s*\]\s*\)/i,
  );
  if (!rootAssignment) return null;
  const [, arrayName, matchName] = rootAssignment;
  const collection = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${arrayName}\\[[^\\]]+\\]\\.([A-Za-z_$][\\w$]*)`,
  ));
  if (!collection) return null;
  const [, refsName, collectionField] = collection;
  const resolvedRefs = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(\\s*typeof\\s+${refsName}\\s*===?\\s*["']number["']\\s*\\)\\s*\\?\\s*${arrayName}\\[${refsName}\\]\\s*:\\s*${refsName}`,
    "i",
  ));
  if (!resolvedRefs) return null;
  const items = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${arrayName}\\[${resolvedRefs[1]}\\[[^\\]]+\\]\\]`,
  ));
  if (!items) return null;
  const [, itemName] = items;
  const objects = extractProjectionObjects(source);
  let title = "";
  let urlExpression = "";
  for (const body of objects.reverse()) {
    const properties = splitProjectionProperties(body);
    const parsed = new Map();
    for (const property of properties) {
      const match = property.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
      if (match) parsed.set(match[1], match[2].trim());
    }
    const titleExpression = parsed.get("name") || parsed.get("title");
    const candidateUrl = parsed.get("url");
    const titlePath = titleExpression && projectionItemPath(titleExpression, itemName, arrayName);
    if (titlePath && candidateUrl) {
      title = titlePath;
      urlExpression = candidateUrl;
      break;
    }
  }
  if (!title || !urlExpression) return null;
  const responseMatch = [...source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*[^;]*\.match\s*\(\s*\/((?:\\.|[^/])+)\/\s*\)/g,
  )].reverse().find((match) => !/(?:NUXT|NEXT|script|hydration)/i.test(match[2])) || null;
  const responseName = responseMatch
    ? source.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${responseMatch[1]}\\s*\\?`))?.[1]
      || responseMatch[1]
    : "";
  const responsePattern = responseMatch?.[2]?.replace(/\\\//g, "/") || "";
  const urlTemplate = compileHydrationProjectionValue(urlExpression, {
    itemName,
    arrayName,
    responseName,
  });
  if (!urlTemplate || !/^https?:\/\//i.test(urlTemplate)) return null;
  const list = encodeProjectionMetadata("@hydration-chapters:", {
    marker: source.match(/__(?:NUXT|NEXT)_DATA__/i)?.[0] || "",
    arrayName,
    matchName,
    collectionField,
    responsePattern,
    title,
    urlTemplate,
  });
  if (!list) return null;
  return { list, title: "name", url: "url", responseType: "html" };
}

function hydrationBookValue(value, { itemName, arrayName, bindings }) {
  const parts = splitTopLevelPlus(unwrapProjectionExpression(value));
  if (!parts.length) return "";
  const escapeRegExp = (input) => String(input).replace(/[\^$.*+?()[\]{}|]/g, "\\$&");
  return parts.map((part) => {
    const literal = projectionLiteral(part);
    if (literal !== null) return literal;
    let expression = unwrapProjectionExpression(part);
    const call = expression.match(/^(?:String|Number|Boolean|encodeURIComponent|encodeURI)\s*\(([\s\S]*)\)$/);
    if (call) expression = unwrapProjectionExpression(call[1]);
    const direct = expression.match(new RegExp(
      "^" + escapeRegExp(itemName) + "\\.([A-Za-z_$][\\w$]*)$",
    ));
    if (direct) return "{{item:" + direct[1] + "}}";
    const indexed = expression.match(new RegExp(
      "^" + escapeRegExp(arrayName) + "\\[" + escapeRegExp(itemName)
        + "\\.([A-Za-z_$][\\w$]*)\\]$",
    ));
    if (indexed) return "{{item:" + indexed[1] + "}}";
    if (bindings.has(expression)) return "{{item:" + bindings.get(expression) + "}}";
    return "";
  }).join("");
}

/**
 * SSR frameworks commonly serialize search/category data as a reference
 * array. A Legado @js rule can project that array in a WebView, but the
 * server bridge cannot execute arbitrary JavaScript. Compile the bounded
 * object projection into a declarative adapter instead.
 *
 * The metadata describes only the hydration data shape, never a host or a
 * site name, so it is reusable across text, comic, audio and video sources.
 */
function hydrationBookProjection(rule) {
  const source = String(rule || "").replace(/^@js:\s*/i, "").trim();
  if (!source || !/JSON\.parse\s*\(/i.test(source) || !/\.push\s*\(/i.test(source)
    || !/__NUXT_DATA__|__NEXT_DATA__|hydration/i.test(source)) return null;
  const root = source.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\.parse\s*\(/i,
  )?.[1];
  if (!root) return null;
  const escapeRegExp = (input) => String(input).replace(/[\^$.*+?()[\]{}|]/g, "\\$&");
  const itemReference = source.match(new RegExp(
    escapeRegExp(root) + "\\[([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\]",
  ));
  if (!itemReference) return null;
  const itemName = itemReference[1];
  const bindings = new Map();
  const bindingPattern = new RegExp(
    "\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*"
      + escapeRegExp(root) + "\\[" + escapeRegExp(itemName)
      + "\\.([A-Za-z_$][\\w$]*)\\]",
    "g",
  );
  for (const match of source.matchAll(bindingPattern)) bindings.set(match[1], match[2]);
  if (!bindings.size) return null;

  const containerMatch = source.match(
    /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*!==?\s*undefined/i,
  );
  const containerField = containerMatch?.[2] || "";
  const containerName = containerMatch?.[1] || "";
  const listCandidates = [];
  const memberPattern = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*;/g;
  for (const match of source.matchAll(memberPattern)) {
    const candidate = { name: match[1], owner: match[2], field: match[3] };
    if (containerName && candidate.owner === containerName) listCandidates.unshift(candidate);
    else listCandidates.push(candidate);
  }
  const listMatch = listCandidates.find((candidate) => (
    candidate.field !== containerField
      && /(?:^list$|items|results|books|albums|data)/i.test(candidate.field)
  ));
  if (!listMatch || !containerField) return null;

  const objects = extractProjectionObjects(source);
  let nameTemplate = "";
  let urlTemplate = "";
  let coverTemplate = "";
  for (const body of objects.reverse()) {
    const properties = new Map();
    for (const property of splitProjectionProperties(body)) {
      const match = property.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
      if (match) properties.set(match[1], match[2].trim());
    }
    const nameExpression = properties.get("name") || properties.get("title");
    const candidateUrl = properties.get("url") || properties.get("href");
    if (!nameExpression || !candidateUrl) continue;
    const candidateName = hydrationBookValue(nameExpression, { itemName, arrayName: root, bindings });
    const candidateUrlTemplate = hydrationBookValue(candidateUrl, { itemName, arrayName: root, bindings });
    if (!candidateName || !candidateUrlTemplate || !/^https?:\/\//i.test(candidateUrlTemplate)
      || !/\{\{item:[A-Za-z_$][\w$]*\}\}/.test(candidateUrlTemplate)) continue;
    nameTemplate = candidateName;
    urlTemplate = candidateUrlTemplate;
    const candidateCover = properties.get("cover") || properties.get("image") || properties.get("pic");
    coverTemplate = candidateCover
      ? hydrationBookValue(candidateCover, { itemName, arrayName: root, bindings })
      : "";
    break;
  }
  if (!nameTemplate || !urlTemplate) return null;
  const list = encodeProjectionMetadata("@hydration-books:", {
    marker: source.match(/__(?:NUXT|NEXT)_DATA__/i)?.[0] || "",
    arrayName: root,
    containerField,
    listField: listMatch.field,
    nameTemplate,
    urlTemplate,
    ...(coverTemplate ? { coverTemplate } : {}),
  });
  return list ? { list, name: "name", url: "url", cover: "cover", responseType: "html" } : null;
}

function splitJsonChapterProjection(rule) {
  const source = String(rule || "").replace(/^@js:\s*/i, "").trim();
  if (!source || !/JSON\.parse\s*\(\s*result\s*\)/i.test(source)
    || !/\.split\s*\(/i.test(source) || !/\.push\s*\(/i.test(source)) return null;
  const rootName = source.match(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(?\s*typeof\s+result\s*===?\s*["']string["']\s*\)?\s*\?\s*)?JSON\.parse\s*\(\s*result\s*\)/i,
  )?.[1];
  if (!rootName) return null;
  const vod = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]{0,256}?\\b${rootName}(\\.[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\[\\d+\\])`,
  ));
  if (!vod) return null;
  const vodName = vod[1];
  const vodPath = vod[2].replace(/^\./, "").replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/");
  const splitFields = [];
  for (const match of source.matchAll(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(?\\s*${vodName}\\.([A-Za-z_$][\\w$]*)\\s*\\|\\|\\s*['"][^'"]*['"]\\s*\\)?\\.split\\(\\s*(['"])([^'"]+)\\3\\s*\\)`,
    "g",
  ))) {
    splitFields.push({ name: match[1], field: match[2], separator: match[4] });
  }
  const playUrl = splitFields.find((item) => /(?:url|link)/i.test(item.name) || /(?:url|link)/i.test(item.field))
    || splitFields.find((item) => /play/i.test(item.name) || /play/i.test(item.field));
  const playFrom = splitFields.find((item) => item !== playUrl
    && (/(?:from|line|source|site)/i.test(item.name) || /(?:from|line|source|site)/i.test(item.field)));
  if (!playUrl) return null;
  const episodeSplit = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${playUrl.name}\\[[^\\]]+\\]\\.split\\(\\s*(['"])([^'"]+)\\2\\s*\\)`,
  ));
  const pairSplit = source.match(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${episodeSplit?.[1] || "__missing__"}\\[[^\\]]+\\]\\.split\\(\\s*(['"])([^'"]+)\\2\\s*\\)`,
  ));
  if (!episodeSplit || !pairSplit) return null;
  if (!/\b(?:name|title)\s*:/i.test(source) || !/\burl\s*:/i.test(source)) return null;
  const list = encodeProjectionMetadata("@split-json-chapters:", {
    rootPath: vodPath,
    urlField: playUrl.field,
    fromField: playFrom?.field || "",
    groupSeparator: playFrom?.separator || "$$$",
    episodeSeparator: episodeSplit[3],
    pairSeparator: pairSplit[3],
    fallbackCurrent: /\/art\//i.test(source),
  });
  return list ? { list, title: "name", url: "url", responseType: "json" } : null;
}

function dereferenceProjectionValue(value, array, depth = 0) {
  let current = value;
  let remaining = depth;
  while (remaining < 8 && typeof current === "number" && Array.isArray(array)) {
    const next = array[current];
    if (next === undefined || next === current) break;
    current = next;
    remaining += 1;
  }
  return current;
}

function dereferenceProjectionField(value, array) {
  if (typeof value !== "number" || !Array.isArray(array)) return value;
  const next = array[value];
  return next === undefined || next === value ? value : next;
}

function hydrationChapterRows(body, baseUrl, metadata) {
  const html = String(body || "");
  const marker = String(metadata?.marker || "");
  if (!marker || !metadata?.arrayName || !metadata?.collectionField) return [];
  let pattern = null;
  if (metadata.responsePattern) {
    const safePattern = safeRegexPattern(metadata.responsePattern);
    if (safePattern) {
      try { pattern = new RegExp(safePattern); } catch { pattern = null; }
    }
  }
  let responseId = "";
  if (pattern) responseId = String(baseUrl || "").match(pattern)?.[1] || "";
  for (const match of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    if (!String(match[1] || "").includes(marker) && !String(match[2] || "").includes(marker)) continue;
    let array;
    try { array = JSON.parse(match[2]); } catch { continue; }
    if (!Array.isArray(array)) continue;
    const entry = array.find((value) => value && typeof value === "object"
      && !Array.isArray(value) && Object.hasOwn(value, metadata.collectionField));
    if (!entry) continue;
    const rawRefs = dereferenceProjectionValue(entry[metadata.collectionField], array);
    if (!Array.isArray(rawRefs)) continue;
    const rows = [];
    for (const rawRef of rawRefs) {
      const item = dereferenceProjectionValue(rawRef, array);
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const titleValue = dereferenceProjectionField(item[metadata.title], array);
      const title = String(titleValue == null ? "" : titleValue).trim();
      let url = String(metadata.urlTemplate || "")
        .replace(/\{\{response:id\}\}/g, encodeURIComponent(responseId));
      url = url.replace(/\{\{item:([A-Za-z_$][\w$]*)\}\}/g, (_match, field) => (
        encodeURIComponent(String(dereferenceProjectionField(item[field], array) ?? ""))
      ));
      if (title && /^https?:\/\//i.test(url) && !/[{}]/.test(url)) rows.push({ name: title, url });
    }
    if (rows.length) return rows;
  }
  return [];
}

function hydrationBookRows(body, metadata) {
  const html = String(body || "");
  const marker = String(metadata?.marker || "");
  if (!marker || !metadata?.containerField || !metadata?.listField) return [];
  for (const match of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    if (!String(match[1] || "").includes(marker) && !String(match[2] || "").includes(marker)) continue;
    let array;
    try { array = JSON.parse(match[2]); } catch { continue; }
    if (!Array.isArray(array)) continue;
    const entry = array.find((value) => value && typeof value === "object"
      && !Array.isArray(value) && Object.hasOwn(value, metadata.containerField));
    if (!entry) continue;
    const container = dereferenceProjectionValue(entry[metadata.containerField], array);
    const rawRefs = Array.isArray(container)
      ? container
      : dereferenceProjectionValue(container?.[metadata.listField], array);
    if (!Array.isArray(rawRefs)) continue;
    const render = (template, item, encode = false) => String(template || "").replace(
      /\{\{item:([A-Za-z_$][\w$]*)\}\}/g,
      (_match, field) => {
        const value = String(dereferenceProjectionField(item?.[field], array) ?? "");
        return encode ? encodeURIComponent(value) : value;
      },
    );
    const rows = [];
    const seen = new Set();
    for (const rawRef of rawRefs) {
      const item = dereferenceProjectionValue(rawRef, array);
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const name = render(metadata.nameTemplate, item).trim();
      const url = render(metadata.urlTemplate, item, true).trim();
      const cover = render(metadata.coverTemplate, item).trim();
      if (!name || !/^https?:\/\//i.test(url) || /[{}]/.test(url) || seen.has(url)) continue;
      seen.add(url);
      rows.push({ name, url, ...(cover ? { cover } : {}) });
    }
    if (rows.length) return rows;
  }
  return [];
}

function splitJsonChapterRows(input, baseUrl, metadata) {
  if (!metadata?.rootPath || !metadata?.urlField) return [];
  const root = jsonPathSingle(input, metadata.rootPath);
  if (!root || typeof root !== "object") {
    if (metadata.fallbackCurrent && /\/art\//i.test(String(baseUrl || ""))) {
      return [{ name: "正文浏览", url: String(baseUrl || "") }];
    }
    return [];
  }
  const urls = String(root[metadata.urlField] || "").split(String(metadata.groupSeparator || "$$$"));
  const from = String(root[metadata.fromField] || "").split(String(metadata.groupSeparator || "$$$"));
  const rows = [];
  for (let groupIndex = 0; groupIndex < urls.length; groupIndex += 1) {
    const group = String(from[groupIndex] || `线路${groupIndex + 1}`).trim();
    const episodes = String(urls[groupIndex] || "").split(String(metadata.episodeSeparator || "#"));
    for (let episodeIndex = 0; episodeIndex < episodes.length; episodeIndex += 1) {
      const episode = String(episodes[episodeIndex] || "").trim();
      if (!episode) continue;
      const separator = String(metadata.pairSeparator || "$");
      const pairIndex = episode.indexOf(separator);
      const url = pairIndex > 0 ? episode.slice(pairIndex + separator.length).trim() : episode;
      if (!url) continue;
      const label = pairIndex > 0
        ? episode.slice(0, pairIndex).trim()
        : episodes.length > 1 ? `第${episodeIndex + 1}集` : "播放";
      const name = [group, label].filter(Boolean).join(" - ");
      if (name && url) rows.push({ name, url });
    }
  }
  if (!rows.length && metadata.fallbackCurrent && /\/art\//i.test(String(baseUrl || ""))) {
    return [{ name: "正文浏览", url: String(baseUrl || "") }];
  }
  return rows;
}

function chapterProjectionItems(selector, input, baseUrl) {
  const value = String(selector || "");
  if (value.startsWith("@hydration-chapters:")) {
    return hydrationChapterRows(input, baseUrl, decodeProjectionMetadata(value, "@hydration-chapters:"));
  }
  if (value.startsWith("@split-json-chapters:")) {
    return splitJsonChapterRows(input, baseUrl, decodeProjectionMetadata(value, "@split-json-chapters:"));
  }
  return null;
}

function bookProjectionItems(selector, input) {
  const value = String(selector || "");
  if (value.startsWith("@hydration-books:")) {
    return hydrationBookRows(input, decodeProjectionMetadata(value, "@hydration-books:"));
  }
  return null;
}

function nestedJsonChapterProjection(rule) {
  const source = String(rule || "").replace(/^@js:\s*/i, "").trim();
  if (!source || !/JSON\.parse\s*\(\s*result\s*\)/i.test(source) || !/\.push\s*\(/i.test(source)) {
    return null;
  }
  const assignments = new Map();
  for (const match of source.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)) {
    assignments.set(match[1], match[2].trim());
  }
  const rootName = [...assignments.entries()]
    .find(([, expression]) => /JSON\.parse\s*\(\s*result\s*\)/i.test(expression))?.[0];
  if (!rootName) return null;
  const pathMemo = new Map([[rootName, ""]]);
  const resolving = new Set();
  const pathFor = (name) => {
    if (pathMemo.has(name)) return pathMemo.get(name);
    if (resolving.has(name)) return null;
    const expression = assignments.get(name);
    if (!expression) return null;
    resolving.add(name);
    let value = unwrapProjectionExpression(expression).split(/\s*\|\|\s*/, 1)[0].trim();
    value = value.replace(/^\?\s*.*?:\s*/, "");
    const member = value.match(/^([A-Za-z_$][\w$]*)([\s\S]*)$/);
    if (!member) {
      resolving.delete(name);
      return null;
    }
    const base = pathFor(member[1]);
    if (base === null || base === undefined) {
      resolving.delete(name);
      return null;
    }
    const suffix = member[2]
      .replace(/\[[A-Za-z_$][\w$]*\]/g, "")
      .replace(/^\./, "")
      .replace(/\./g, "/")
      .replace(/^\/+|\/+$/g, "");
    const path = [base, suffix].filter(Boolean).join("/");
    pathMemo.set(name, path);
    resolving.delete(name);
    return path;
  };

  const itemAssignments = [...assignments.entries()]
    .map(([name, expression]) => ({ name, expression: unwrapProjectionExpression(expression) }))
    .filter(({ expression }) => /^[A-Za-z_$][\w$]*\s*\[[A-Za-z_$][\w$]*\]$/.test(expression));
  if (!itemAssignments.length) return null;
  const objects = extractProjectionObjects(source);
  for (const body of objects.reverse()) {
    const properties = splitProjectionProperties(body);
    const parsed = new Map();
    for (const property of properties) {
      const match = property.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
      if (match) parsed.set(match[1], match[2].trim());
    }
    const titleExpression = parsed.get("name") || parsed.get("title");
    const urlExpression = parsed.get("url");
    if (!titleExpression || !urlExpression) continue;
    const item = itemAssignments.find(({ name }) => (
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(`${titleExpression} ${urlExpression}`)
    ));
    if (!item) continue;
    const itemBase = item.expression.match(/^([A-Za-z_$][\w$]*)\s*\[/)?.[1];
    const listPath = itemBase ? pathFor(itemBase) : null;
    if (!listPath) continue;
    const rootTemplateFields = {};
    let itemField = "";
    const compileValue = (expression, seen = new Set()) => {
      let value = unwrapProjectionExpression(expression);
      if (/^[A-Za-z_$][\w$]*$/.test(value) && assignments.has(value) && !seen.has(value)) {
        seen.add(value);
        return compileValue(assignments.get(value), seen);
      }
      if (/^(?:String|encodeURIComponent|encodeURI)\s*\(([\s\S]*)\)$/.test(value)) {
        return compileValue(value.replace(/^(?:String|encodeURIComponent|encodeURI)\s*\(/, "").replace(/\)$/, ""), seen);
      }
      const parts = splitTopLevelPlus(value);
      if (!parts.length) return null;
      const output = [];
      for (const part of parts) {
        const literal = part.match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/);
        if (literal) {
          try { output.push(staticStringLiteral(literal[0])); } catch { return null; }
          continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(part) && assignments.has(part) && !seen.has(part)) {
          const rootPath = pathFor(part);
          if (rootPath === null || rootPath === undefined) return null;
          const fieldName = part;
          rootTemplateFields[fieldName] = rootPath;
          output.push(`{{root:${fieldName}}}`);
          continue;
        }
        const member = part.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
        if (!member) return null;
        if (member[1] === item.name) {
          const field = member[2].replace(/\./g, "/");
          itemField ||= field.split("/")[0];
          output.push(`{{${field}}}`);
          continue;
        }
        const rootPath = pathFor(member[1]);
        if (rootPath === null || rootPath === undefined) return null;
        const fieldName = member[1];
        rootTemplateFields[fieldName] = [rootPath, member[2].replace(/\./g, "/")].filter(Boolean).join("/");
        output.push(`{{root:${fieldName}}}`);
      }
      return output.join("");
    };
    const urlTemplate = compileValue(urlExpression);
    const titleMember = unwrapProjectionExpression(titleExpression).match(
      new RegExp(`^${item.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)$`),
    );
    const titleField = titleMember?.[1]?.replace(/\./g, "/") || "";
    if (!urlTemplate || !/^https?:\/\//i.test(urlTemplate) || !titleField) continue;
    return {
      list: listPath,
      title: titleField,
      url: {
        selector: itemField || titleField,
        urlTemplate,
        rootTemplateFields,
      },
    };
  }
  return null;
}

function planCharset(action) {
  if (isXiangseGbkEncode(action)) return "gbk";
  const charset = String(action?.charset || "").trim().toLowerCase();
  return charset === "gbk" || charset === "utf-8" ? charset : "";
}

export function compileBookBridgePlan(action, headers = {}) {
  const bookName = normalizeXiangseItemRule(action.bookName);
  const detailUrl = normalizeXiangseItemRule(action.detailUrl);
  const author = normalizeXiangseItemRule(action.author);
  const desc = normalizeXiangseItemRule(action.desc);
  const cat = normalizeXiangseItemRule(action.cat);
  const lastChapterTitle = normalizeXiangseItemRule(action.lastChapterTitle);
  const cover = normalizeXiangseItemRule(action.cover);
  const status = normalizeXiangseItemRule(action.status);
  const wordCount = normalizeXiangseItemRule(action.wordCount);
  const scriptProjection = action.responseFormatType === "html"
    ? hydrationBookProjection(action.list)
    : null;
  const guardedList = scriptProjection?.list || (action.responseFormatType === "html"
    ? requireListAttribute(
      inferredDomScriptSelector(action.list, [/book/i, /item/i, /list/i, /article/i]),
      directDomAttributeGuard(detailUrl),
    )
    : inferredDomScriptSelector(action.list, [/book/i, /item/i, /list/i, /article/i]));
  return normalizePlan({
    kind: "books",
    host: action.host,
    responseType: scriptProjection?.responseType || action.responseFormatType,
    charset: planCharset(action),
    list: guardedList,
    filter: inferredJsonEqualityFilter(bookName),
    fields: {
      name: scriptProjection?.name || inferredScriptField(bookName, [/^(?:book)?name$/i, /title/i, /username/i])
        || normalizeXiangseItemRule(inferredDomScriptSelector(bookName, [/name/i, /title/i, /text/i])),
      url: scriptProjection?.url || inferredScriptField(detailUrl, [/url/i, /id/i, /username/i])
        || normalizeXiangseItemRule(inferredDomScriptSelector(detailUrl, [/url/i, /href/i, /id/i])),
      author,
      desc,
      cat,
      lastChapterTitle,
      cover: scriptProjection?.cover || inferredScriptField(cover, [/cover/i, /pic/i, /img/i, /icon/i])
        || normalizeXiangseItemRule(inferredDomScriptSelector(cover, [/cover/i, /pic/i, /img/i, /src/i]))
        || cover,
      status,
      wordCount,
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

export function compileChapterBridgePlan(action, {
  tocSelector = "", tocRequest = null, headers = {}, reverse = false, contextualRows = null,
} = {}) {
  const title = normalizeXiangseItemRule(action?.title);
  const url = normalizeXiangseItemRule(action?.url);
  const updateTime = normalizeXiangseItemRule(action?.updateTime);
  const scriptProjection = nestedJsonChapterProjection(action?.list)
    || splitJsonChapterProjection(action?.list)
    || hydrationChapterProjection(action?.list);
  const projectedDomList = isDomListProjection(action?.list);
  const urlRule = scriptProjection?.url
    || (projectedDomList
    ? domListProjection(action.list, "url")
    : url && typeof url === "object" && url.urlTemplate
    ? url
    : inferredScriptField(url, [/url/i, /id/i, /href/i]));
  return normalizePlan({
    kind: "chapters",
    host: action.host,
    responseType: scriptProjection?.responseType || (projectedDomList ? "html" : action.responseFormatType),
    charset: planCharset(action),
    list: scriptProjection?.list
      || inferredDomScriptSelector(action.list, [/chapter/i, /catalog/i, /directory/i, /content/i, /list/i]),
    tocSelector,
    tocRequest,
    contextualRows,
    reverse: Boolean(reverse || action.reverseChapters || action.reverse),
    fields: {
      title: (scriptProjection?.title || (projectedDomList ? domListProjection(action.list, "title") : ""))
        || inferredScriptField(title, [/title/i, /name/i, /chapter/i])
        || normalizeXiangseItemRule(inferredDomScriptSelector(title, [/title/i, /name/i, /text/i, /alt/i]))
        || (/queryInfo\.(?:bookName|name)/i.test(String(title || "")) ? { constant: "播放" } : ""),
      url: urlRule || normalizeXiangseItemRule(inferredDomScriptSelector(url, [/href/i, /url/i, /src/i])),
      updateTime,
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
    fields: {
      content: inferredDomScriptSelector(
        action.content,
        [/content/i, /chapter/i, /article/i, /read/i, /text/i, /txt/i, /body/i],
      ),
    },
    headers,
  });
}

function splitXPathUnion(expression) {
  const parts = [];
  let start = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "|" && brackets === 0 && parentheses === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (!parts.length) return [expression.trim()];
  parts.push(expression.slice(start).trim());
  return parts.filter(Boolean);
}

function unwrapXPathGroup(expression) {
  const source = String(expression || "").trim();
  if (!source.startsWith("(") || !source.endsWith(")")) return source;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index !== source.length - 1) return source;
    }
  }
  return depth === 0 ? source.slice(1, -1).trim() : source;
}

function capped(values, maxNodes) {
  const cap = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : Infinity;
  return cap === Infinity ? values : values.slice(0, cap);
}

function terminalValues(elements, terminal, maxNodes) {
  const values = [];
  for (const element of elements) {
    if (terminal === "text()") {
      for (const child of element.childNodes || []) {
        if (child.nodeType === 3 && String(child.nodeValue || "").trim()) values.push(child);
      }
    } else if (terminal?.startsWith("@")) {
      const value = element.getAttribute?.(terminal.slice(1));
      if (value != null) values.push(value);
    } else {
      values.push(element);
    }
    if (Number.isFinite(maxNodes) && values.length >= maxNodes) break;
  }
  return capped(values, maxNodes);
}

/**
 * jsdom's XPath evaluator becomes extremely slow on large documents even for
 * simple global attribute lookups. Converted Legado rules mostly use a small,
 * predictable XPath subset, which native DOM traversal can evaluate linearly.
 */
function fastXPathValues(document, rawExpression, context, { maxNodes = Infinity } = {}) {
  const expression = unwrapXPathGroup(rawExpression);
  // List field rules are evaluated relative to every matched item. The
  // generic XPath evaluator is needlessly expensive for the overwhelmingly
  // common `.//tag`, `.//tag/@attr`, and `.//tag/text()` forms: a large list
  // would otherwise invoke the evaluator once per field and once per item.
  // Resolve this small, semantics-preserving subset through the DOM API so
  // the parsed document is traversed directly and only once per field.
  const relative = expression.match(
    /^(\.)(\/\/|\/)([A-Za-z][\w:-]*|\*)(?:\[([\s\S]+)\])?(?:\/(\@[\w:-]+|text\(\)))?$/,
  );
  if (relative && context?.nodeType && context.nodeType !== 9) {
    const [, , axis, tag, predicate = "", terminal = ""] = relative;
    let selector = tag;
    const exact = predicate.match(/^@([\w:-]+)\s*=\s*(['"])(.*?)\2$/);
    const classContains = predicate.match(
      /^contains\(\s*@class\s*,\s*(['"])(.*?)\1\s*\)$/i,
    );
    if (exact) selector += `[${exact[1]}="${exact[3].replace(/"/g, '\\"')}"]`;
    else if (classContains) selector += `[class*="${classContains[2].replace(/"/g, '\\"')}"]`;
    else if (predicate) return null;
    const query = axis === "\/" ? `:scope > ${selector}` : selector;
    let elements;
    try {
      elements = Array.from(context.querySelectorAll?.(query) || []);
    } catch {
      return null;
    }
    return terminalValues(elements, terminal, maxNodes);
  }
  if (expression === "." && context?.nodeType && context.nodeType !== 9) {
    return [context];
  }
  const linkedItemFilter = expression.match(/^\(([\s\S]+)\)\[self::a\[@href\] or \.\/\/a\[@href\]\]$/);
  if (linkedItemFilter) {
    const selected = fastXPathValues(document, linkedItemFilter[1], context, { maxNodes: Infinity });
    if (selected === null) return null;
    return capped(selected.filter((element) => (
      element?.nodeType === 1
      && ((element.localName === "a" && element.hasAttribute("href")) || element.querySelector?.("a[href]"))
    )), maxNodes);
  }
  const union = splitXPathUnion(expression);
  if (union.length > 1) {
    const values = [];
    for (const part of union) {
      const selected = fastXPathValues(document, part, context, {
        maxNodes: Number.isFinite(maxNodes) ? Math.max(0, maxNodes - values.length) : Infinity,
      });
      if (selected === null) return null;
      values.push(...selected);
      if (Number.isFinite(maxNodes) && values.length >= maxNodes) break;
    }
    return capped(values, maxNodes);
  }

  const scope = context?.nodeType ? context : document;
  const simpleGlobal = expression.match(
    /^\/\/([A-Za-z][\w:-]*|\*)(?:\/(\@[\w:-]+|text\(\)))?$/,
  );
  if (simpleGlobal) {
    const [, tag, terminal = ""] = simpleGlobal;
    return terminalValues(
      Array.from(scope.querySelectorAll?.(tag) || []),
      terminal,
      maxNodes,
    );
  }
  const exactAttribute = expression.match(
    /^\/\/([A-Za-z][\w:-]*|\*)\[@([\w:-]+)=(['"])(.*?)\3\](?:\/(@[\w:-]+|text\(\)))?$/,
  );
  if (exactAttribute) {
    const [, tag, attribute, , expected, terminal = ""] = exactAttribute;
    const candidates = scope.querySelectorAll?.(`${tag}[${attribute}]`) || [];
    const matched = [];
    for (const element of candidates) {
      if (element.getAttribute?.(attribute) === expected) matched.push(element);
    }
    return terminalValues(matched, terminal, maxNodes);
  }

  const anchorConditions = expression.match(/^\/\/a\[([\s\S]+)\]$/i);
  if (anchorConditions) {
    const hrefParts = [...anchorConditions[1].matchAll(
      /contains\(\s*@href\s*,\s*(['"])(.*?)\1\s*\)/gi,
    )].map((match) => match[2]);
    const requiresText = /normalize-space\(\.\)\s*!=\s*(['"])\1/i.test(anchorConditions[1]);
    const remainder = anchorConditions[1]
      .replace(/contains\(\s*@href\s*,\s*(['"])(.*?)\1\s*\)/gi, "")
      .replace(/normalize-space\(\.\)\s*!=\s*(['"])\1/gi, "")
      .replace(/\band\b|[()\s]/gi, "");
    if (hrefParts.length && !remainder) {
      const matched = [];
      for (const anchor of scope.querySelectorAll?.("a[href]") || []) {
        const href = String(anchor.getAttribute("href") || "");
        if (!hrefParts.every((part) => href.includes(part))) continue;
        if (requiresText && !String(anchor.textContent || "").trim()) continue;
        matched.push(anchor);
        if (Number.isFinite(maxNodes) && matched.length >= maxNodes) break;
      }
      return matched;
    }
  }

  const classMatch = expression.match(
    /^\/\/([A-Za-z][\w:-]*|\*)\[contains\(concat\(' ', normalize-space\(@class\), ' '\), ' ([^']+) '\)\](.*)$/,
  );
  if (classMatch) {
    const [, rootTag, className, tail] = classMatch;
    let roots = Array.from(scope.querySelectorAll?.(`${rootTag}[class]`) || [])
      .filter((element) => element.classList?.contains(className));
    if (!tail) return capped(roots, maxNodes);
    const terminalMatch = tail.match(/\/(text\(\)|@[\w:-]+)$/);
    const terminal = terminalMatch?.[1] || "";
    const path = terminalMatch ? tail.slice(0, -terminalMatch[0].length) : tail;
    const segments = path.split("//").filter(Boolean);
    if (!segments.length || segments.some((segment) => !/^(?:[A-Za-z][\w:-]*|\*)(?:\[\d+\])?$/.test(segment))) {
      return null;
    }
    let elements = roots;
    for (const segment of segments) {
      const parsed = segment.match(/^([A-Za-z][\w:-]*|\*)(?:\[(\d+)\])?$/);
      const [, tag, rawPosition] = parsed;
      const descendants = [];
      for (const root of elements) {
        const found = Array.from(root.querySelectorAll?.(tag) || []);
        if (rawPosition) {
          const selected = found[Number(rawPosition) - 1];
          if (selected) descendants.push(selected);
        } else {
          descendants.push(...found);
        }
      }
      elements = descendants;
    }
    return terminalValues(elements, terminal, maxNodes);
  }

  const containsText = expression.match(
    /^\/\/([A-Za-z][\w:-]*|\*)\[contains\(normalize-space\(\.\), (['"])(.*?)\2\)\](?:\/(@[\w:-]+|text\(\)))?$/,
  );
  if (containsText) {
    const [, tag, , expected, terminal = ""] = containsText;
    const elements = Array.from(scope.querySelectorAll?.(tag) || []).filter((element) => (
      String(element.textContent || "").replace(/\s+/g, " ").trim().includes(expected)
    ));
    return terminalValues(elements, terminal, maxNodes);
  }
  return null;
}

function xpathValues(document, expression, context = document, { maxNodes = Infinity } = {}) {
  const fast = fastXPathValues(document, expression, context, { maxNodes });
  if (fast !== null) return fast;
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
        else if (expression.startsWith("(//")) expression = `(.${expression.slice(1)}`;
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
  const mediaPairs = String(path || "").trim().match(/^@json-media-pairs:([^:]+):([^:]+):([^:]+):([^:]+)$/);
  if (mediaPairs) {
    let field;
    let groupSeparator;
    let entrySeparator;
    let pairSeparator;
    try {
      [, field, groupSeparator, entrySeparator, pairSeparator] = mediaPairs.map((value) => decodeURIComponent(value));
    } catch {
      return [];
    }
    let encoded = "";
    const visit = (value) => {
      if (encoded || !value || typeof value !== "object") return;
      if (Object.hasOwn(value, field) && typeof value[field] === "string") encoded = value[field];
      if (!encoded) for (const child of Object.values(value)) visit(child);
    };
    visit(input);
    if (!encoded) return [];
    const groups = encoded.split(groupSeparator).map((group) => group.split(entrySeparator).flatMap((entry) => {
      const index = entry.indexOf(pairSeparator);
      if (index <= 0) return [];
      const title = entry.slice(0, index).trim();
      const href = entry.slice(index + pairSeparator.length).trim();
      return title && href ? [{ text: title, href }] : [];
    }));
    return groups.sort((left, right) => right.length - left.length)[0] || [];
  }
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
  const interleave = String(path || "").trim().match(/^@json-interleave:(.+)$/);
  if (interleave) {
    const lists = [];
    for (const encoded of interleave[1].split(",").filter(Boolean)) {
      let selector = "";
      try { selector = decodeURIComponent(encoded); } catch { continue; }
      const value = jsonPathSingle(input, selector);
      if (Array.isArray(value) && value.length) lists.push(value);
      else if (value !== undefined && value !== null && value !== "") lists.push([value]);
    }
    const rows = [];
    const length = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < length; index += 1) {
      for (const list of lists) {
        if (index < list.length) rows.push(list[index]);
      }
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
  const projectedSelector = String(field.selector || "").trim();
  if (options.projected && projectedSelector && !/^(?:\.|\/|@)/.test(projectedSelector)) {
    const value = jsonPath(input, projectedSelector);
    if (value !== undefined && value !== null) {
      if (options.list) return Array.isArray(value) ? value : [value];
      if (Array.isArray(value)) return value.map((item) => String(item ?? "")).filter(Boolean).join("\n");
      return String(value).trim();
    }
  }
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
  if (field?.valueTemplate) {
    value = expandUrlTemplate(
      field.valueTemplate,
      input,
      options.baseUrl || "",
      value,
      field.valueMaps,
      field.templateFields,
      options.rootInput,
      field.rootTemplateFields,
    );
  }
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

export function applyDetailSemanticFallbacks(result, fields) {
  const comparable = (value) => String(value || "")
    .replace(/[\s·・|｜:：,，/\\_-]+/g, "")
    .toLocaleLowerCase();
  const category = comparable(result.cat);
  const categoryFallback = normalizeField(fields?.cat)?.fallback;
  if (category && categoryFallback && [result.name, result.author, result.lastChapterTitle]
    .some((value) => category === comparable(value))) {
    result.cat = categoryFallback;
  }
  const author = comparable(result.author);
  const authorFallback = normalizeField(fields?.author)?.fallback;
  if (author && authorFallback && author === comparable(result.name)) result.author = authorFallback;
  return result;
}

function expandUrlTemplate(
  template,
  item,
  baseUrl,
  selectedValue = "",
  valueMaps = {},
  templateFields = {},
  rootInput = null,
  rootTemplateFields = {},
) {
  let bookId = "";
  let comicId = "";
  let entityId = "";
  try {
    const page = new URL(baseUrl);
    bookId = page.searchParams.get("bookId")
      || page.searchParams.get("book_id")
      || page.searchParams.get("albumId")
      || page.searchParams.get("album_id")
      || page.searchParams.get("itemId")
      || page.searchParams.get("item_id")
      || page.searchParams.get("mid")
      || page.searchParams.get("id")
      || (page.pathname.match(/\/(?:book|album|comic)\/(\d+)/i)?.[1] || "")
      || (page.pathname.match(/\/(\d+)(?:\/|$)/)?.[1] || "");
    comicId = page.searchParams.get("comic_id") || page.searchParams.get("comicId") || "";
    entityId = page.searchParams.get("entityId") || page.searchParams.get("entity_id") || "";
  } catch {
    bookId = String(baseUrl || "").match(/[?&](?:book_?id|album_?id|item_?id|mid|id)=(\d+)/i)?.[1] || "";
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
  if (item?.nodeType) {
    for (const [name, selector] of Object.entries(templateFields || {})) {
      values[name] = htmlSelect(selector, item);
    }
  }
  const selectedName = String(template || "").match(/\{\{(?:(?:raw|text):)?(?!base:)([A-Za-z_$][\w$]*)\}\}/)?.[1];
  if (selectedName && selectedValue && (values[selectedName] === undefined || values[selectedName] === null)) {
    values[selectedName] = selectedValue;
  }
  return String(template || "").replace(/\{\{(?:(base|raw|text|root|rootPath):)?([A-Za-z_$][\w$]*)\}\}/g, (_, mode, name) => {
    if (mode === "base" || name === "bookId") return encodeURIComponent(String(values.bookId || bookId || ""));
    const rootSelector = mode === "root" || mode === "rootPath" ? rootTemplateFields?.[name] : "";
    let rawValue = mode === "root" || mode === "rootPath"
      ? (rootSelector ? jsonPathSingle(rootInput, rootSelector) : "")
      : values[name] ?? pageIds[name];
    if (mode === "rootPath") {
      const source = String(rawValue == null ? "" : rawValue).trim();
      if (/^https?:\/\//i.test(source)) {
        try {
          const url = new URL(source);
          rawValue = `${url.pathname}${url.search}`.replace(/^\/+/, "");
        } catch {
          rawValue = source.replace(/^https?:\/\/[^/]+/i, "");
        }
      } else {
        rawValue = source.replace(/^(?:\.\/|\/)+/, "");
      }
    }
    const mapping = valueMaps?.[name];
    const value = mapping && Object.hasOwn(mapping, String(rawValue)) ? mapping[String(rawValue)] : rawValue;
    if (mode === "text") return String(value == null ? "" : value);
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
  const projectionMetadata = plan.kind === "chapters" && plan.responseType === "json"
    && String(plan.list || "").startsWith("@split-json-chapters:")
    ? decodeProjectionMetadata(plan.list, "@split-json-chapters:")
    : null;
  if (plan.responseType === "json") {
    try {
      input = JSON.parse(String(body || ""));
    } catch {
      if (!projectionMetadata?.fallbackCurrent || !/\/art\//i.test(String(baseUrl || ""))) {
        throw new TypeError("上游响应不是规则声明的 JSON");
      }
      // Some mixed media sources use the same chapter action for JSON video
      // records and HTML art pages. Keep the generic current-page fallback
      // available for the latter without weakening JSON validation elsewhere.
      input = String(body || "");
    }
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
      if (field?.urlTemplate) {
        result[name] = expandUrlTemplate(
          field.urlTemplate,
          input,
          baseUrl,
          result[name],
          field.valueMaps,
          field.templateFields,
          input,
          field.rootTemplateFields,
        );
      }
    }
    if (result.cover) result.cover = absolute(result.cover, baseUrl);
    return applyDetailSemanticFallbacks(result, plan.fields);
  }
  const pageSize = resolvePageSize(plan.kind, limit, limits);
  const start = Math.max(0, Math.floor(Number(offset)) || 0);
  // Chapters must be collected then sorted ascending before offset/limit so
  // swipe-to-next reads 第1章 → 第2章 instead of newest-first site order.
  const needValid = plan.kind === "chapters"
    ? undefined
    : start + Math.max(pageSize, 0) + 1;
  const scanCap = resolveBridgeScanCap(plan.kind, needValid, limits);
  const projectedChapterItems = plan.kind === "chapters"
    ? chapterProjectionItems(plan.list, input, baseUrl)
    : null;
  const projectedBookItems = plan.kind === "books"
    ? bookProjectionItems(plan.list, input)
    : null;
  let items = projectedChapterItems
    ? (Number.isFinite(scanCap) ? projectedChapterItems.slice(0, scanCap) : projectedChapterItems)
    : projectedBookItems
    ? (Number.isFinite(scanCap) ? projectedBookItems.slice(0, scanCap) : projectedBookItems)
    : plan.responseType === "json" || plan.responseType === "embedded-json"
    ? (() => {
      const value = plan.responseType === "embedded-json"
        ? embeddedJsonArray(input, plan.list)
        : jsonPath(input, plan.list);
      // JSON catalogues commonly group rows by volume/season. A list action
      // always consumes leaf rows, so nested arrays must be flattened before
      // fields are evaluated against each item.
      const list = Array.isArray(value) ? value.flat(Infinity) : [];
      return Number.isFinite(scanCap) ? list.slice(0, scanCap) : list;
    })()
    : htmlSelect(plan.list, parsedInput, { list: true, maxNodes: scanCap });
  if (plan.filter && plan.responseType === "json") {
    items = items.filter((item) => String(jsonPathSingle(item, plan.filter.field) ?? "") === plan.filter.equals);
  }
  if (pageSize === 0) {
    return { data: [], hasMore: false, offset: start, pageSize };
  }

  if (plan.kind === "chapters") {
    const rows = [];
    for (const item of items) {
      const row = {};
      for (const [name, rule] of Object.entries(plan.fields)) {
        row[name] = transformed(plan, rule, item, {
          baseUrl,
          rootInput: input,
          projected: projectedChapterItems !== null,
        });
      }
      if (plan.contextualRows) {
        row.url = "";
        row.__read2xsggItem = projectPaths(item, plan.contextualRows.itemPaths);
        row.__read2xsggContext = {
          requestUrl: String(baseUrl || ""),
          payload: projectPaths(input, plan.contextualRows.contextPaths),
          state: "",
        };
      } else {
        const urlField = normalizeField(plan.fields.url);
        if (urlField?.urlTemplate) {
        row.url = expandUrlTemplate(
          urlField.urlTemplate,
          item,
          baseUrl,
          row.url,
          urlField.valueMaps,
          urlField.templateFields,
          input,
          urlField.rootTemplateFields,
        );
        } else {
          row.url = absolute(row.url, baseUrl, plan.host);
        }
      }
      if (!row.title || (!row.url && !plan.contextualRows)) continue;
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
    for (const [name, rule] of Object.entries(plan.fields)) {
      row[name] = transformed(plan, rule, item, {
        baseUrl,
        rootInput: input,
        projected: projectedBookItems !== null,
      });
    }
    const urlField = normalizeField(plan.fields.url);
    row.url = urlField?.urlTemplate
      ? expandUrlTemplate(
        urlField.urlTemplate,
        item,
        baseUrl,
        row.url,
        urlField.valueMaps,
        urlField.templateFields,
        input,
        urlField.rootTemplateFields,
      )
      : absolute(row.url, baseUrl, plan.host);
    const coverField = normalizeField(plan.fields.cover);
    if (coverField?.urlTemplate) {
      row.cover = expandUrlTemplate(
        coverField.urlTemplate,
        item,
        baseUrl,
        row.cover,
        coverField.valueMaps,
        coverField.templateFields,
        input,
        coverField.rootTemplateFields,
      );
    }
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
