import { constants, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, publicDecrypt } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { decodeTextBuffer } from "./charset.js";
import { executeBridgeSelector, htmlToPlainText } from "./bridgePlan.js";
import { extractPixelKey } from "./imageDecoder.js";
import { convertRule } from "./selectors.js";
import { decryptQdChapterBytes, qdApiEndpoint, qdContentCryptoConfig, qdCryptoConfig, qdSignatureHeaders } from "./qdCrypto.js";

const MAX_PLAN_BYTES = 24 * 1024;
const MAX_TEMPLATE_LENGTH = 4_096;
const MAX_REGEX_LENGTH = 2_048;

const ALLOWED_HEADERS = /^(?:user-agent|referer|origin|accept|accept-language|content-type|x-requested-with|x-fingerprint|accept-encoding|cookie|app-version|platform|reg|authorization|application-id|net-env|channel|qm-params|sign)$/i;

function safeRegex(pattern, flags = "") {
  const value = String(pattern || "");
  if (!value || value.length > MAX_REGEX_LENGTH || !/^[dgimsuvy]*$/.test(String(flags || ""))) return null;
  // The plan is data-only but its expressions still execute against remote
  // input. Reject the common nested-quantifier shape that can pin a worker.
  if (/\((?:[^()]|\\.)*(?:\||[+*?{])(?:[^()]|\\.)*\)[+*?{]/.test(value)) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, flags);
    return { pattern: value, flags: String(flags || "") };
  } catch {
    return null;
  }
}

function decodeLiteral(quote, body) {
  try {
    if (quote === '"') return JSON.parse(`"${body}"`);
    return body.replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|['"\\/bfnrt])/g, (_match, value) => {
      if (value[0] === "u" || value[0] === "x") return String.fromCodePoint(Number.parseInt(value.slice(1), 16));
      return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[value] ?? value;
    });
  } catch {
    return null;
  }
}

function staticToken(source, start = 0) {
  const value = String(source || "").slice(start).match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
  if (!value) return null;
  const quote = value[0][0];
  const decoded = decodeLiteral(quote, value[0].slice(1, -1));
  return decoded === null ? null : { value: decoded, length: value[0].length };
}

function splitTopLevel(value, separator = "+") {
  const source = String(value || "");
  const parts = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
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
    if ("([{ ".includes(character)) {
      if (character !== " ") depth += 1;
      continue;
    }
    if (")] }".replace(/\s/g, "").includes(character)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function unwrapParentheses(value) {
  let source = String(value || "").trim();
  while (source.startsWith("(") && source.endsWith(")")) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    let complete = true;
    for (let index = 0; index < source.length; index += 1) {
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
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index !== source.length - 1) {
          complete = false;
          break;
        }
      }
    }
    if (!complete || depth !== 0) break;
    source = source.slice(1, -1).trim();
  }
  return source;
}

function normalizeBaseExpression(value) {
  let source = unwrapParentheses(value);
  // Legado's content rules often carry a fallback chain such as
  // `(params.responseUrl || queryInfo.chapterUrl || config.host || "")`.
  // It is a base URL lookup, not a site-specific algorithm.
  if (/(?:params\.)?responseUrl\b|\bbaseUrl\b|\bconfig\.host\b|\bqueryInfo\.chapterUrl\b/.test(source)) {
    return "{{baseUrl}}";
  }
  if (/^source\.(?:key|getKey\s*\(\s*\)|bookSourceUrl)$/i.test(source)) return "{{host}}";
  return source;
}

function templateFieldName(value, { fields = new Set(), fieldAliases = new Map(), allowBase = true } = {}) {
  const source = unwrapParentheses(value);
  const alias = fieldAliases instanceof Map ? fieldAliases.get(source) : undefined;
  if (alias) return alias;
  const encoded = source.match(/^(?:encodeURIComponent|encodeURI|String)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'][^"']+["']\s*\]))*)\s*\)$/);
  const name = encoded?.[1]?.replace(/\s+/g, "") || source.match(/^[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'][^"']+["']\s*\]))*$/)?.[0]?.replace(/\s+/g, "");
  if (!name) return "";
  if (fieldAliases instanceof Map && fieldAliases.has(name)) return fieldAliases.get(name);
  if (fields.has(name)) return name;
  if (allowBase && ["baseUrl", "backend", "host"].includes(name)) return name;
  return "";
}

function templateFromExpression(value, { fields = new Set(), fieldAliases = new Map(), allowBase = true } = {}) {
  let source = unwrapParentheses(value);
  if (!source || source.length > MAX_TEMPLATE_LENGTH) return "";
  if (/^buildRequest\s*\(/i.test(source)) {
    source = source.replace(/^buildRequest\s*\(/i, "").replace(/\)\s*$/, "").trim();
  }
  const templateLiteral = source.match(/^`([\s\S]*)`$/);
  if (templateLiteral) {
    const body = templateLiteral[1];
    let output = "";
    let last = 0;
    for (const match of body.matchAll(/\$\{\s*([^{}]+?)\s*\}/g)) {
      output += body.slice(last, match.index);
      const expression = String(match[1] || "").trim();
      const name = templateFieldName(expression, { fields, fieldAliases, allowBase });
      if (!name || (name === "baseUrl" && !allowBase)) return "";
      output += `{{${name}}}`;
      last = match.index + match[0].length;
    }
    output += body.slice(last);
    return output.length <= MAX_TEMPLATE_LENGTH ? output : "";
  }

  const parts = splitTopLevel(source);
  if (!parts.length) return "";
  let output = "";
  for (const part of parts) {
    const literal = staticToken(part);
    if (literal && literal.length === part.length) {
      output += literal.value;
      continue;
    }
    const normalized = normalizeBaseExpression(part);
    if (normalized === "{{baseUrl}}" || normalized === "{{host}}") {
      output += normalized;
      continue;
    }
    const name = templateFieldName(normalized, { fields, fieldAliases, allowBase });
    if (!name) return "";
    output += `{{${name}}}`;
  }
  return output.length <= MAX_TEMPLATE_LENGTH ? output : "";
}

function assignmentExpression(script, name) {
  const source = String(script || "");
  const match = source.match(new RegExp(`(?:^|[;\\n])\\s*(?:(?:var|let|const)\\s+)?${name}\\s*=\\s*`));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
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
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")] }".replace(/\s/g, "").includes(character)) depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) return source.slice(start, index).trim();
    else if (character === "\n" && depth === 0) {
      const before = source.slice(start, index).trimEnd();
      const after = source.slice(index + 1).trimStart();
      if (before.endsWith("+") || after.startsWith("+")) continue;
      return source.slice(start, index).trim();
    }
  }
  return source.slice(start).trim().replace(/;\s*$/, "");
}

function matchBindings(script) {
  const result = new Map();
  const pattern = /(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?(?:result|src)\s*\.\s*match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)\s*\[\s*(\d+)\s*\]/g;
  for (const match of String(script || "").matchAll(pattern)) {
    const regexText = match[0].match(/\.\s*match\s*\(\s*\/([\s\S]*?)\/([dgimsuvy]*)\s*\)/i);
    if (!regexText) continue;
    const safe = safeRegex(regexText[1], regexText[2]);
    if (!safe) continue;
    result.set(match[1], { ...safe, group: Math.max(1, Number(match[4]) || 1) });
  }
  return result;
}

function jsonMatchBinding(script) {
  const source = String(script || "");
  const regexes = new Map();
  const regexPattern = /(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*(?:;|$)/g;
  for (const match of source.matchAll(regexPattern)) {
    const safe = safeRegex(match[2], match[3]);
    if (safe) regexes.set(match[1], safe);
  }
  const matchCall = source.match(/(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?(?:result|src)\s*\.\s*match\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
  if (!matchCall) return null;
  const safe = regexes.get(matchCall[2]);
  if (!safe) return null;
  const objectMatch = source.match(new RegExp(
    `(?:^|[;\\n])\\s*(?:(?:var|let|const)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*JSON\\.parse\\(\\s*${matchCall[1].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\[\\s*0\\s*\\]\\s*\\)`,
    "i",
  ));
  if (!objectMatch) return null;
  return {
    name: objectMatch[1],
    pattern: safe.pattern,
    flags: safe.flags,
    group: 0,
  };
}

function directMatchPatterns(script) {
  const result = [];
  const pattern = /\.\s*match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)/g;
  for (const match of String(script || "").matchAll(pattern)) {
    const safe = safeRegex(match[1], match[2]);
    if (safe) result.push(safe);
  }
  return result;
}

function matchingCallEnd(source, start) {
  const open = String(source || "").indexOf("(", start);
  if (open < 0) return -1;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = open; index < String(source || "").length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function jsonPathFromScript(script) {
  const source = String(script || "");
  const paths = [];
  for (const match of source.matchAll(/JSON\.parse\s*\(/gi)) {
    if (match.index === undefined) continue;
    const end = matchingCallEnd(source, match.index);
    if (end < 0) continue;
    const suffix = source.slice(end + 1).match(/^\s*((?:(?:\.\s*[A-Za-z_$][\w$]*)|(?:\[\s*["'][^"']+["']\s*\]))+)/);
    if (!suffix) continue;
    const path = [...suffix[1].matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\]/g)]
      .map((item) => item[1] || item[2])
      .join(".");
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path)) paths.push(path);
  }
  return paths.sort((left, right) => right.length - left.length)[0] || "";
}

function normalizeHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!ALLOWED_HEADERS.test(name)) continue;
    if (typeof value !== "string") continue;
    result[name] = value.slice(0, 2_048);
  }
  return result;
}

function commonPlan({ kind, host, headers, responseType = "html", input = "url" }) {
  return {
    version: 1,
    kind,
    host: /^https?:\/\//i.test(String(host || "")) ? String(host).slice(0, 2_048) : "",
    responseType,
    input,
    headers: normalizeHeaders(headers),
  };
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("正文桥接计划无效");
  const kind = ["html-post-json", "html-challenge", "html-jsonp", "html-image-key-aes", "encoded-id-json", "html-aes", "json-rsa", "encrypted-json", "signed-aes-json", "path-aes-json", "download-text", "data-text", "qd-json-content"].includes(value.kind) ? value.kind : "";
  if (!kind) throw new TypeError("正文桥接计划类型无效");
  const host = /^https?:\/\//i.test(String(value.host || "")) ? String(value.host).slice(0, 2_048) : "";
  const input = value.input === "value" ? "value" : "url";
  const output = value.output && typeof value.output === "object" ? value.output : {};
  const outputPattern = safeRegex(output.pattern, output.flags);
  const outputPath = String(output.path || "").trim();
  if (!["html-challenge", "html-jsonp", "html-image-key-aes", "html-aes", "signed-aes-json", "download-text", "qd-json-content"].includes(kind) && !outputPath && !outputPattern) throw new TypeError("正文桥接计划缺少结果字段");
  const request = value.request && typeof value.request === "object" ? value.request : {};
  const urlTemplate = String(request.urlTemplate || (kind === "download-text" ? "{{baseUrl}}" : "")).trim();
  if (!urlTemplate || urlTemplate.length > MAX_TEMPLATE_LENGTH) throw new TypeError("正文桥接计划请求地址无效");
  const method = String(request.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new TypeError("正文桥接计划请求方法无效");
  const bodyTemplate = String(request.bodyTemplate || "");
  if (bodyTemplate.length > MAX_TEMPLATE_LENGTH) throw new TypeError("正文桥接计划请求体过大");
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
    ? Object.fromEntries(Object.entries(request.payload)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const query = request.query && typeof request.query === "object" && !Array.isArray(request.query)
    ? Object.fromEntries(Object.entries(request.query)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const headers = normalizeHeaders(value.headers);
  const extractors = Array.isArray(value.extractors)
    ? value.extractors.map((item) => {
      const pattern = safeRegex(item?.pattern, item?.flags);
      const name = String(item?.name || "");
      const numericGroup = Number(item?.group);
      const group = Number.isFinite(numericGroup) ? numericGroup : 1;
      const transform = item?.transform === "json" ? "json" : "";
      const jsonFields = Array.isArray(item?.jsonFields)
        ? item.jsonFields.filter((field) => /^[A-Za-z_$][\w$]*$/.test(String(field))).slice(0, 32)
        : [];
      const validGroup = transform === "json" ? group >= 0 && group <= 8 : group >= 1 && group <= 8;
      return pattern && /^[A-Za-z_$][\w$]*$/.test(name) && validGroup
        ? { name, pattern: pattern.pattern, flags: pattern.flags, group, ...(transform ? { transform, jsonFields } : {}) }
        : null;
    }).filter(Boolean).slice(0, 16)
    : [];
  const sourceExtractors = Array.isArray(value.sourceExtractors)
    ? value.sourceExtractors.map((item) => {
      const pattern = safeRegex(item?.pattern, item?.flags);
      const name = String(item?.name || "");
      const numericGroup = Number(item?.group);
      const group = Number.isFinite(numericGroup) ? numericGroup : 1;
      return pattern && /^[A-Za-z_$][\w$]*$/.test(name) && group >= 1 && group <= 8
        ? { name, pattern: pattern.pattern, flags: pattern.flags, group }
        : null;
    }).filter(Boolean).slice(0, 16)
    : [];
  const steps = kind === "download-text" && Array.isArray(value.steps)
    ? value.steps.map((item) => {
      const selector = String(item?.selector || "").trim().slice(0, 4_096);
      const pattern = safeRegex(item?.pattern, item?.flags);
      const group = Math.max(1, Math.min(8, Number(item?.group) || 1));
      const prefix = String(item?.prefix || "").trim().slice(0, 2_048);
      const suffix = String(item?.suffix || "").trim().slice(0, 2_048);
      if ((!selector && !pattern) || (selector && pattern)) return null;
      return {
        ...(selector ? { selector } : {}),
        ...(pattern ? { pattern: pattern.pattern, flags: pattern.flags, group } : {}),
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {}),
      };
    }).filter(Boolean).slice(0, 6)
    : [];
  if (kind === "download-text" && !steps.length) throw new TypeError("正文下载链计划缺少提取步骤");
  if (kind === "html-post-json" && (method !== "POST" || !outputPath || !extractors.length)) throw new TypeError("正文 POST 计划不完整");
  if (kind === "encoded-id-json" && (!outputPath || !["hex", "base64"].includes(value.decode))) {
    throw new TypeError("正文编码计划不完整");
  }
  if (kind === "html-challenge" && (!outputPattern || Number(output.group) < 1)) {
    throw new TypeError("正文令牌计划不完整");
  }
  const jsonpToken = kind === "html-jsonp" ? safeRegex(value.token?.pattern, value.token?.flags) : null;
  const jsonpReplacementPath = kind === "html-jsonp"
    ? String(output.replacementPath || "").trim()
    : "";
  if (kind === "html-jsonp" && (!outputPattern || !outputPath
    || Number(output.group) < 1 || !jsonpToken
    || (jsonpReplacementPath && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(jsonpReplacementPath)))) {
    throw new TypeError("正文 JSONP 计划不完整");
  }
  const imageKey = kind === "html-image-key-aes" && value.imageKey && typeof value.imageKey === "object"
    ? value.imageKey
    : null;
  const imageManifest = kind === "html-image-key-aes" ? safeRegex(value.manifest?.pattern, value.manifest?.flags) : null;
  const imageCid = kind === "html-image-key-aes" ? safeRegex(value.cid?.pattern, value.cid?.flags) : null;
  const imageKeyUrl = kind === "html-image-key-aes" ? String(value.keyUrlTemplate || "").trim() : "";
  const imageVersion = kind === "html-image-key-aes" ? Number(value.crypto?.version) : 0;
  const imageSkipPrefixes = kind === "html-image-key-aes" && Array.isArray(value.skipPrefixes)
    ? value.skipPrefixes.filter((item) => typeof item === "string" && item.length <= 256).slice(0, 8)
    : [];
  const imageSkipContains = kind === "html-image-key-aes" && Array.isArray(value.skipAllContains)
    ? value.skipAllContains.filter((item) => typeof item === "string" && item.length <= 256).slice(0, 8)
    : [];
  if (kind === "html-image-key-aes" && (!imageKey || !imageManifest || !imageCid
    || !imageKeyUrl || imageKeyUrl.length > MAX_TEMPLATE_LENGTH
    || ![2, 3].includes(imageVersion)
    || !Number.isInteger(Number(imageKey.width)) || Number(imageKey.width) < 1 || Number(imageKey.width) > 4096
    || !Number.isInteger(Number(imageKey.height)) || Number(imageKey.height) < 1 || Number(imageKey.height) > 4096
    || !Number.isInteger(Number(imageKey.gridWidth)) || Number(imageKey.gridWidth) < 1 || Number(imageKey.gridWidth) > 4096
    || !Number.isInteger(Number(imageKey.count)) || Number(imageKey.count) < 1 || Number(imageKey.count) > 4096
    || !Number.isInteger(Number(imageKey.skip)) || Number(imageKey.skip) < 0 || Number(imageKey.skip) > 4096
    || !Number.isInteger(Number(imageKey.magic)) || Number(imageKey.magic) < 0 || Number(imageKey.magic) > 255
    || !["r", "g", "b", "a"].includes(String(imageKey.channel || "r").toLowerCase()))) {
    throw new TypeError("正文像素密钥 AES 计划不完整");
  }
  const signedCrypto = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  if (kind === "signed-aes-json") {
    const responseCrypto = signedCrypto?.response;
    const validResponse = responseCrypto && typeof responseCrypto === "object"
      && typeof responseCrypto.key === "string" && responseCrypto.key.length > 0 && responseCrypto.key.length <= 512
      && ["raw", "sha256"].includes(String(responseCrypto.keyMode || "raw"))
      && ["fixed", "prefix"].includes(String(responseCrypto.ivMode || "fixed"))
      && (String(responseCrypto.ivMode || "fixed") === "prefix"
        || (typeof responseCrypto.iv === "string" && responseCrypto.iv.length <= 256
          && ["hex", "base64", "utf8"].includes(String(responseCrypto.ivEncoding || "hex"))))
      && ["pkcs5", "zero"].includes(String(responseCrypto.padding || "pkcs5"))
      && ["base64", "hex"].includes(String(responseCrypto.encoding || "base64"));
    const sign = request.sign && typeof request.sign === "object" ? request.sign : null;
    if (method !== "GET" || !Object.keys(query).length || !validResponse
      || typeof sign?.key !== "string" || !sign.key || sign.key.length > 512
      || String(sign.mode || "sorted-concat") !== "sorted-concat"
      || !/^[A-Za-z_$][\w$]*$/.test(String(sign.field || "sign"))) {
      throw new TypeError("正文加签 AES 计划不完整");
    }
    responseCrypto.keyMode = String(responseCrypto.keyMode || "raw");
    responseCrypto.ivMode = String(responseCrypto.ivMode || "fixed");
    responseCrypto.ivEncoding = String(responseCrypto.ivEncoding || "hex");
    responseCrypto.padding = String(responseCrypto.padding || "pkcs5");
    responseCrypto.encoding = String(responseCrypto.encoding || "base64");
    responseCrypto.outerPath = String(responseCrypto.outerPath || "");
    sign.field = String(sign.field || "sign");
    sign.mode = "sorted-concat";
  }
  const retry = value.retry && typeof value.retry === "object" ? value.retry : null;
  const normalizedRetry = kind === "signed-aes-json" && retry
    && /^[A-Za-z_$][\w$]*$/.test(String(retry.field || ""))
    && Array.isArray(retry.alternates)
    ? {
      field: String(retry.field),
      alternates: retry.alternates
        .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .map((item) => String(item).slice(0, 128))
        .slice(0, 4),
    }
    : null;
  const decodedFields = kind === "signed-aes-json" && value.decodedFields && typeof value.decodedFields === "object"
    ? Object.fromEntries(Object.entries(value.decodedFields)
      .filter(([name, index]) => /^[A-Za-z_$][\w$]*$/.test(name) && Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 8)
      .map(([name, index]) => [name, Number(index)]))
    : {};
  const encryptedCrypto = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  if (["encrypted-json", "path-aes-json"].includes(kind)) {
    const requestCrypto = encryptedCrypto?.request;
    const responseCrypto = encryptedCrypto?.response;
    const validCrypto = (item) => item && typeof item === "object"
      && typeof item.key === "string" && item.key.length > 0 && item.key.length <= 512
      && ["raw", "sha256"].includes(String(item.keyMode || "raw"))
      && typeof item.iv === "string" && item.iv.length <= 256
      && ["hex", "base64", "utf8"].includes(String(item.ivEncoding || "hex"))
      && ["pkcs5", "zero"].includes(String(item.padding || "pkcs5"))
      && ["base64", "hex"].includes(String(item.encoding || "base64"));
    if (!Object.keys(payload).length || !validCrypto(requestCrypto) || !validCrypto(responseCrypto)) {
      throw new TypeError("正文加密 JSON 计划不完整");
    }
    const envelope = String(requestCrypto.envelope || "form");
    const envelopeField = String(requestCrypto.envelopeField || "secret_content");
    if (!["form", "json", "raw"].includes(envelope) || !/^[A-Za-z_$][\w$]*$/.test(envelopeField)) {
      throw new TypeError("正文加密请求封装无效");
    }
    requestCrypto.keyMode = String(requestCrypto.keyMode || "raw");
    responseCrypto.keyMode = String(responseCrypto.keyMode || "raw");
    requestCrypto.ivEncoding = String(requestCrypto.ivEncoding || "hex");
    responseCrypto.ivEncoding = String(responseCrypto.ivEncoding || "hex");
    requestCrypto.padding = String(requestCrypto.padding || "pkcs5");
    responseCrypto.padding = String(responseCrypto.padding || "pkcs5");
    requestCrypto.encoding = String(requestCrypto.encoding || "base64");
    responseCrypto.encoding = String(responseCrypto.encoding || "base64");
    requestCrypto.envelope = envelope;
    requestCrypto.envelopeField = envelopeField;
    responseCrypto.outerPath = String(responseCrypto.outerPath || "");
  }
  const rsa = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  if (kind === "json-rsa") {
    if (!outputPath || typeof rsa?.publicKey !== "string" || rsa.publicKey.length > 8_192
      || !/^[A-Za-z0-9+/=\s]+$/.test(rsa.publicKey) || String(rsa.padding || "pkcs1").toLowerCase() !== "pkcs1") {
      throw new TypeError("正文 RSA 计划不完整");
    }
    try { createPublicKey({ key: Buffer.from(rsa.publicKey.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" }); }
    catch { throw new TypeError("正文 RSA 公钥无效"); }
    rsa.publicKey = rsa.publicKey.replace(/\s+/g, "");
    rsa.padding = "pkcs1";
  }
  const crypto = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  const qd = kind === "qd-json-content" && value.qd && typeof value.qd === "object" ? value.qd : null;
  const qdEndpoint = String(qd?.endpoint || "").trim();
  const qdPath = String(qd?.path || "").trim();
  const qdVipUrl = String(qd?.vipUrlTemplate || "").trim();
  const qdSignKey = String(qd?.signKey || "");
  const qdSignIv = String(qd?.signIv || "");
  const qdInfoKey = String(qd?.infoKey || "");
  const qdKey1 = String(qd?.key1 || "");
  const qdKey3Prefix = String(qd?.key3Prefix || "");
  const qdSalt = String(qd?.salt || "");
  if (kind === "qd-json-content" && (!qd
    || !/^https?:\/\/[^/]+\/argus\/api\/?$/i.test(qdEndpoint)
    || !/^[A-Za-z0-9._/-]+$/.test(qdPath)
    || (qdVipUrl && !/^https?:\/\/[^/]+\/api\/[A-Za-z0-9._~/-]+(?:\?[A-Za-z0-9_.~%=&{}-]+)?$/i.test(qdVipUrl))
    || qdSignKey.length !== 24
    || qdSignIv.length !== 8
    || qdInfoKey.length !== 24
    || !/^[A-Za-z0-9+/=]+$/.test(qdKey1)
    || !/^(?:[0-9a-f]{2})+$/i.test(qdKey3Prefix)
    || !qdSalt || qdSalt.length > 128)) {
    throw new TypeError("QD 正文计划不完整");
  }
  if (kind === "html-aes") {
    const payloadPattern = safeRegex(crypto?.pattern, crypto?.flags);
    const payloadGroup = Number(crypto?.payloadGroup) || 1;
    const keyGroup = Number(crypto?.keyGroup) || 0;
    const ivGroup = Number(crypto?.ivGroup) || 0;
    const padding = String(crypto?.padding || "").toLowerCase();
    const keyMode = String(crypto?.keyMode || "").toLowerCase();
    const encoding = String(crypto?.encoding || "").toLowerCase();
    if (!payloadPattern || payloadGroup < 1 || payloadGroup > 8
      || keyGroup < 1 || keyGroup > 8
      || (ivGroup && (ivGroup < 1 || ivGroup > 8))
      || !["pkcs5", "zero"].includes(padding)
      || !["md5-split", "raw"].includes(keyMode)
      || !["base64"].includes(encoding)) {
      throw new TypeError("正文 AES 计划不完整");
    }
    if (keyMode === "raw" && !ivGroup) throw new TypeError("正文 AES 计划缺少 IV");
    crypto.pattern = payloadPattern.pattern;
    crypto.flags = payloadPattern.flags;
    crypto.payloadGroup = payloadGroup;
    crypto.keyGroup = keyGroup;
    crypto.ivGroup = ivGroup;
    crypto.padding = padding;
    crypto.keyMode = keyMode;
    crypto.encoding = encoding;
  }
  return {
    version: 1,
    kind,
    host,
    input,
    responseType: ["json-rsa", "encrypted-json", "signed-aes-json", "path-aes-json", "qd-json-content"].includes(kind) ? "json" : "html",
    headers,
    request: {
      method,
      urlTemplate,
      ...(bodyTemplate ? { bodyTemplate } : {}),
      ...(Object.keys(query).length ? { query } : {}),
      ...(["encrypted-json", "path-aes-json"].includes(kind) ? { payload } : {}),
      ...(kind === "signed-aes-json" ? {
        sign: {
          key: String(request.sign.key),
          field: String(request.sign.field || "sign"),
          mode: "sorted-concat",
        },
        ...(request.optionalQuery && Array.isArray(request.optionalQuery)
          ? { optionalQuery: request.optionalQuery.filter((name) => /^[A-Za-z_$][\w$]*$/.test(String(name))).slice(0, 16) }
          : {}),
        ...(request.headerSign && typeof request.headerSign === "object"
          && /^[A-Za-z_$][\w$]*$/.test(String(request.headerSign.field || ""))
          ? { headerSign: { field: String(request.headerSign.field) } }
          : {}),
      } : {}),
      headers: normalizeHeaders(request.headers || headers),
    },
    ...(extractors.length ? { extractors } : {}),
    ...(sourceExtractors.length ? { sourceExtractors } : {}),
    ...(Object.keys(decodedFields).length ? { decodedFields } : {}),
    output: {
      ...(outputPath ? { path: outputPath } : {}),
      ...(outputPattern ? { pattern: outputPattern.pattern, flags: outputPattern.flags } : {}),
      ...(Number(output.group) > 0 ? { group: Math.min(8, Number(output.group)) } : {}),
      ...(jsonpReplacementPath ? { replacementPath: jsonpReplacementPath } : {}),
      plainText: output.plainText !== false,
    },
    ...(value.token && typeof value.token === "object" ? {
      token: (() => {
        const tokenPattern = safeRegex(value.token.pattern, value.token.flags);
        return tokenPattern ? {
          pattern: tokenPattern.pattern,
          flags: tokenPattern.flags,
          group: Math.max(1, Math.min(8, Number(value.token.group) || 1)),
        } : null;
      })(),
    } : {}),
    ...(value.decode ? { decode: value.decode } : {}),
    ...(kind === "html-aes" ? { crypto } : {}),
    ...(kind === "html-image-key-aes" ? {
      manifest: { pattern: imageManifest.pattern, flags: imageManifest.flags, group: Math.max(1, Math.min(8, Number(value.manifest.group) || 1)) },
      cid: { pattern: imageCid.pattern, flags: imageCid.flags, group: Math.max(1, Math.min(8, Number(value.cid.group) || 1)) },
      keyUrlTemplate: imageKeyUrl,
      imageKey: {
        width: Number(imageKey.width),
        height: Number(imageKey.height),
        magic: Number(imageKey.magic),
        gridWidth: Number(imageKey.gridWidth),
        count: Number(imageKey.count),
        skip: Number(imageKey.skip),
        channel: String(imageKey.channel || "r").toLowerCase(),
      },
      crypto: { version: imageVersion },
      ...(imageSkipPrefixes.length ? { skipPrefixes: imageSkipPrefixes } : {}),
      ...(imageSkipContains.length ? { skipAllContains: imageSkipContains } : {}),
    } : {}),
    ...(kind === "json-rsa" ? { crypto: rsa } : {}),
    ...(["encrypted-json", "path-aes-json"].includes(kind) ? { crypto: encryptedCrypto } : {}),
    ...(kind === "signed-aes-json" ? { crypto: signedCrypto } : {}),
    ...(kind === "download-text" ? { steps } : {}),
    ...(kind === "qd-json-content" ? {
      qd: {
        endpoint: qdEndpoint.slice(0, MAX_TEMPLATE_LENGTH),
        path: qdPath.slice(0, MAX_TEMPLATE_LENGTH),
        ...(qdVipUrl ? { vipUrlTemplate: qdVipUrl.slice(0, MAX_TEMPLATE_LENGTH) } : {}),
        signKey: qdSignKey,
        signIv: qdSignIv,
        infoKey: qdInfoKey,
        infoIv: "",
        ...(qdKey1 ? { key1: qdKey1.slice(0, 2_048) } : {}),
        ...(qdKey3Prefix ? { key3Prefix: qdKey3Prefix.slice(0, 2_048) } : {}),
        ...(qdSalt ? { salt: qdSalt.slice(0, 128) } : {}),
      },
    } : {}),
    ...(normalizedRetry ? { retry: normalizedRetry } : {}),
    ...(value.idFields && typeof value.idFields === "object"
      ? { idFields: Object.fromEntries(Object.entries(value.idFields).filter(([name, index]) => /^[A-Za-z_$][\w$]*$/.test(name) && Number(index) >= 0 && Number(index) < 8).slice(0, 8)) }
      : {}),
  };
}

export function createDataTextContentPlan({ host = "", headers = {} } = {}) {
  return normalizePlan({
    kind: "data-text",
    host,
    input: "value",
    headers,
    request: { method: "GET", urlTemplate: "data:text/plain" },
    output: { path: "content", plainText: true },
  });
}

export function createQdContentPlan({ host = "", headers = {}, jsLib = "", contentRule = "" } = {}) {
  const script = String(contentRule || "");
  if (!/\bQDSign\s*\(/i.test(script)
    || !/bookcontent\/safegetcontent/i.test(script)
    || !/\bdContentQD\s*\(/i.test(script)) return null;
  const config = qdCryptoConfig(jsLib);
  const contentCrypto = qdContentCryptoConfig(jsLib);
  if (!config || !contentCrypto) return null;
  const endpoint = qdApiEndpoint(jsLib);
  const vipBase = script.match(/(https?:\/\/[^"'\s]+\/api\/content1\.php)/i)?.[1] || "";
  try {
    return normalizePlan({
      kind: "qd-json-content",
      host,
      input: "value",
      headers,
      request: { method: "GET", urlTemplate: endpoint, headers },
      output: { path: "content", plainText: false },
      qd: {
        endpoint,
        path: "v2/bookcontent/safegetcontent",
        ...(vipBase ? { vipUrlTemplate: vipBase + "?bookId={{bookId}}&chapterId={{chapterId}}" } : {}),
        ...config,
        ...contentCrypto,
      },
    });
  } catch {
    return null;
  }
}

function downloadRuleTokens(rule) {
  const source = String(rule || "").trim();
  if (!source) return [];
  const tokens = [];
  const appendPlain = (value) => {
    for (const line of String(value || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^##(?:\$|\^)##/.test(trimmed)) continue;
      tokens.push({ kind: "selector", value: trimmed });
    }
  };
  const blockPattern = /<js>([\s\S]*?)<\/js>/gi;
  let cursor = 0;
  for (const match of source.matchAll(blockPattern)) {
    appendPlain(source.slice(cursor, match.index));
    tokens.push({ kind: "script", value: match[1] });
    cursor = (match.index || 0) + match[0].length;
  }
  appendPlain(source.slice(cursor));
  return tokens;
}

function downloadSelectorStep(rule) {
  let source = String(rule || "").trim();
  let prefix = "";
  const template = source.match(/^(.*?)\{\{\s*@@([\s\S]*?)\s*\}\}$/);
  if (template) {
    prefix = String(template[1] || "").trim();
    source = String(template[2] || "").trim();
  }
  source = source.split(/##(?:\^|\$)?##/, 1)[0].trim();
  if (!source) return null;
  const selector = String(convertRule(source, { responseType: "html" }) || "").trim();
  if (!selector || /^@(?:js|json):/i.test(selector)) return null;
  return {
    selector,
    ...(prefix && !/\{\{|\}\}/.test(prefix) ? { prefix } : {}),
  };
}

function downloadRegexSteps(script) {
  const steps = [];
  const pattern = /\.match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)\s*\[\s*(\d{1,2})\s*\]/g;
  for (const match of String(script || "").matchAll(pattern)) {
    const safe = safeRegex(match[1], match[2]);
    const group = Number(match[3]);
    if (safe && Number.isInteger(group) && group >= 1 && group <= 8) {
      steps.push({ pattern: safe.pattern, flags: safe.flags, group });
    }
  }
  return steps;
}

/**
 * Compile the common file-source chain (detail page → download page(s) →
 * final TXT response) without evaluating Legado JavaScript. Selectors and
 * regular expressions are extracted from the source's declared download rule;
 * the adapter only follows the resulting URLs and returns the final body.
 */
export function compileDownloadTextPlan(rule, { host = "", headers = {} } = {}) {
  const steps = [];
  for (const token of downloadRuleTokens(rule)) {
    if (token.kind === "selector") {
      const step = downloadSelectorStep(token.value);
      if (step) steps.push(step);
    } else {
      steps.push(...downloadRegexSteps(token.value));
    }
  }
  if (!steps.length || steps.length > 6) return null;
  try {
    return normalizePlan({
      ...commonPlan({ kind: "download-text", host, headers, responseType: "html", input: "url" }),
      request: { method: "GET", urlTemplate: "{{baseUrl}}", headers },
      steps,
    });
  } catch {
    return null;
  }
}

function normalizedScript(value) {
  return String(value || "")
    .replace(/^\s*(?:@js:|<js>)\s*/i, "")
    .replace(/\s*<\/js>\s*$/i, "")
    .trim();
}

function requestTemplateFrom(script, requestCall, fields, host) {
  const call = String(requestCall || "");
  const urlExpression = call.match(/\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/)?.[1] || "";
  const named = urlExpression ? assignmentExpression(script, urlExpression) : "";
  const directExpression = named || (call.match(/\(\s*([^,\)]+(?:\([^)]*\))?)\s*,/)?.[1] || "");
  let template = templateFromExpression(directExpression, { fields, allowBase: true });
  if (!template && directExpression) {
    const base = normalizeBaseExpression(directExpression);
    template = templateFromExpression(base, { fields, allowBase: true });
  }
  if (!template) return "";
  if (!/^https?:\/\//i.test(template) && !/^\{\{(?:baseUrl|backend|host)\}\}/.test(template)) {
    if (!host) return "";
    template = `${host.replace(/\/$/, "")}/${template.replace(/^\/+/, "")}`;
  }
  return template;
}

function decodeJsString(value) {
  return String(value || "").replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g, (_match, token) => {
    if (/^u/i.test(token) || /^x/i.test(token)) return String.fromCodePoint(Number.parseInt(token.slice(1), 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "'": "'", '"': '"' })[token] ?? token;
  });
}

function compileImageKeyContentPlan(script, { host = "", headers = {} } = {}) {
  const source = String(script || "");
  if (!/data-crypto|crypto-content/i.test(source)
    || !/data-cid/i.test(source)
    || !/BitmapFactory|Jimp|decodeStream|getPixel/i.test(source)
    || !/AES\/CBC\/PKCS5Padding/i.test(source)
    || !/order|shuffled/i.test(source)) return null;
  const manifestPattern = safeRegex("data-crypto\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']", "i");
  const cidPattern = safeRegex("data-cid\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']", "i");
  const keyPath = source.match(
    /\bkeyUrl\s*=\s*[^;\n]*?([\"'])(\/[^\"']*)\1\s*\+\s*(?:encodeURIComponent\s*\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*\+\s*([\"'])(\/[^\"']*)\4/i,
  );
  if (!manifestPattern || !cidPattern || !keyPath) return null;
  const width = Number(source.match(/\bw\s*!==\s*(\d+)/i)?.[1] || 0);
  const height = Number(source.match(/\bh\s*!==\s*(\d+)/i)?.[1] || 0);
  const magicToken = source.match(/(?:px0r|magic)[^\n]{0,80}?!==\s*(0x[\da-f]+|\d+)/i)?.[1] || "";
  const magic = magicToken ? Number.parseInt(magicToken, /^0x/i.test(magicToken) ? 16 : 10) : NaN;
  const gridWidth = Number(source.match(/\bpx\s*=\s*i\s*%\s*(\d+)/i)?.[1] || 0);
  const count = Number(source.match(/\bi\s*<=\s*(\d+)/i)?.[1] || 0);
  const skip = Number(source.match(/\bfor\s*\(\s*(?:var|let|const)\s+i\s*=\s*(\d+)/i)?.[1] || 0);
  const version = /HmacSHA256|xoredContent|contentKey/i.test(source) ? 3 : 2;
  if (!width || !height || !Number.isInteger(magic) || !gridWidth || !count || !Number.isInteger(skip)) return null;
  const keyUrlTemplate = "{{host}}" + keyPath[2] + "{{cid}}" + keyPath[5];
  const imageKey = {
    width,
    height,
    magic,
    gridWidth,
    count,
    skip,
    channel: /getPixel|px0r|\bb\s*=\s*\(.*>>\s*16/i.test(source) ? "r" : "r",
  };
  const skipPrefixes = [];
  const watermark = source.match(/\b(?:var|let|const)\s+WM\s*=\s*([\"'])([\s\S]*?)\1/);
  if (watermark) skipPrefixes.push(decodeJsString(watermark[2]));
  const skipAllContains = [];
  for (const condition of source.matchAll(/\bif\s*\(([\s\S]{0,512}?)\)\s*\{?\s*continue\b/gi)) {
    const values = [...condition[1].matchAll(/\.indexOf\s*\(\s*([\"'])([^\"']+)\1\s*\)/g)].map((item) => decodeJsString(item[2]));
    if (values.length > 1 && values.length <= 8) skipAllContains.push(...values);
  }
  try {
    return normalizePlan({
      ...commonPlan({ kind: "html-image-key-aes", host, headers, responseType: "html", input: "url" }),
      request: { method: "GET", urlTemplate: "{{baseUrl}}", headers },
      manifest: { pattern: manifestPattern.pattern, flags: manifestPattern.flags, group: 1 },
      cid: { pattern: cidPattern.pattern, flags: cidPattern.flags, group: 1 },
      keyUrlTemplate,
      imageKey,
      crypto: { version },
      output: { plainText: true },
      ...(skipPrefixes.length ? { skipPrefixes } : {}),
      ...(skipAllContains.length ? { skipAllContains: [...new Set(skipAllContains)] } : {}),
    });
  } catch {
    return null;
  }
}

export function compileContentBridgePlan(rule, {
  host = "",
  headers = {},
  jsLib = "",
  searchRule = "",
} = {}) {
  const script = normalizedScript(rule);
  if (!script || script.length > 64 * 1024) return null;

  const staticHeaders = (source) => {
    const text = String(source || "");
    const object = text.match(/\b(?:var|let|const)\s+(?:headers|h)\s*=\s*\{([\s\S]{0,4096}?)\}/i)?.[1] || "";
    const result = {};
    for (const match of object.matchAll(/['"]([A-Za-z][\w-]{0,63})['"]\s*:\s*(['"])((?:\\.|(?!\2)[\s\S])*?)\2/g)) {
      const value = decodeLiteral(match[2], match[3]);
      if (value !== null && typeof value === "string") result[match[1]] = value;
    }
    return result;
  };

  const imageKeyPlan = compileImageKeyContentPlan(script, { host, headers });
  if (imageKeyPlan) return imageKeyPlan;
  const staticApiHeaders = {
    ...staticHeaders(searchRule),
    ...staticHeaders(jsLib),
  };
  const signedAesBase = (endpoint, signKey, aesKey, options = {}) => {
    const {
      query = {},
      input = "value",
      decode = "",
      decodedFields = {},
      extractors = [],
      sourceExtractors = [],
      retry = null,
      headerSign = true,
      outputPath = "",
    } = options;
    if (!endpoint || !signKey || !aesKey || !Object.keys(query).length) return null;
    try {
      return normalizePlan({
        ...commonPlan({ kind: "signed-aes-json", host, headers: { ...headers, ...staticApiHeaders }, responseType: "json", input }),
        input,
        ...(decode ? { decode } : {}),
        ...(Object.keys(decodedFields).length ? { decodedFields } : {}),
        ...(extractors.length ? { extractors } : {}),
        ...(sourceExtractors.length ? { sourceExtractors } : {}),
        request: {
          method: "GET",
          urlTemplate: endpoint,
          query,
          sign: { key: signKey, field: "sign", mode: "sorted-concat" },
          ...(headerSign ? { headerSign: { field: "sign" } } : {}),
          optionalQuery: Object.entries(query)
            .filter(([, value]) => String(value).includes("{{"))
            .map(([name]) => name)
            .filter((name) => name === "reader_agent"),
          headers: { ...headers, ...staticApiHeaders },
        },
        output: { ...(outputPath ? { path: outputPath } : {}), plainText: true },
        crypto: {
          response: {
            key: aesKey,
            keyMode: "raw",
            ivMode: "prefix",
            padding: "pkcs5",
            encoding: "base64",
            outerPath: "data.content",
          },
        },
        ...(retry ? { retry } : {}),
      });
    } catch {
      return null;
    }
  };

  const qmEndpoint = jsLib.match(
    /\bfunction\s+qmContent\s*\([\s\S]{0,4096}?\bqmUrl\s*\(\s*QM_KS\s*,\s*["']([^"']+)["']/i,
  );
  const qmBase = jsLib.match(/\bQM_KS\s*=\s*["'](https?:\/\/[^"']+)["']/i)?.[1] || "";
  const qmSignKey = jsLib.match(/\bQM_KEY\s*=\s*["']([^"']{8,512})["']/i)?.[1] || "";
  const qmAesKey = jsLib.match(/\bQM_AES\s*=\s*["']([^"']{8,64})["']/i)?.[1] || "";
  if (qmEndpoint && qmBase && qmSignKey && qmAesKey
    && /\bqmContent\s*\(/i.test(script) && /\bqmDecode\s*\(/i.test(script)) {
    const plan = signedAesBase(
      qmBase.replace(/\/$/, "") + qmEndpoint[1],
      qmSignKey,
      qmAesKey,
      {
        query: {
          id: "{{bid}}",
          chapterId: "{{chapterId}}",
          reader_agent: "{{agent}}",
        },
        decode: "base64-segments",
        decodedFields: { chapterId: 0, agent: 2 },
        sourceExtractors: [{
          name: "bid",
          pattern: "[?&](?:id|bookId|book_id)=([^&#,]+)",
          flags: "i",
          group: 1,
        }],
        retry: { field: "agent", alternates: ["", "1"] },
      },
    );
    if (plan) return plan;
  }

  const signedEndpoint = script.match(
    /\b(?:requestUrl|url)\s*=\s*["'](https?:\/\/[^"']+(?:chapter|content)[^"']*)["']\s*\+/i,
  )?.[1] || "";
  const signedKey = script.match(/\b(?:signKey|sign_key)\s*=\s*["']([^"']{8,512})["']/i)?.[1] || "";
  const signedAesKey = script.match(
    /\b(?:SecretKeySpec\s*\(\s*String\s*\(|secretKey\s*=\s*|AES_KEY\s*=\s*)["']([^"']{8,64})["']/i,
  )?.[1] || "";
  const signedParams = script.match(/\b(?:var|let|const)\s+params\s*=\s*\{([\s\S]{0,4096}?)\}/i)?.[1] || "";
  const signedQuery = {};
  for (const match of signedParams.matchAll(/["']([A-Za-z_$][\w$]*)["']\s*:\s*([^,\n}]+)/g)) {
    const expression = match[2].trim();
    if (/\bjava\.get\s*\(\s*["']bid["']\s*\)/i.test(expression)) signedQuery[match[1]] = "{{bid}}";
    else if (/\bbaseUrl\b[\s\S]*?split\s*\(/i.test(expression)) signedQuery[match[1]] = "{{chapterId}}";
    else {
      const literal = staticToken(expression);
      if (literal && literal.length === expression.length) signedQuery[match[1]] = literal.value;
    }
  }
  const prefixIv = /copyOfRange\s*\([\s\S]*?0\s*,\s*16\s*\)/i.test(script)
    && /copyOfRange\s*\([\s\S]*?16\s*\)/i.test(script);
  if (signedEndpoint && signedKey && signedAesKey && prefixIv && Object.keys(signedQuery).length) {
    const plan = signedAesBase(
      signedEndpoint,
      signedKey,
      signedAesKey,
      {
        query: signedQuery,
        extractors: [{
          name: "chapterId",
          pattern: "(?:^|/)([^/?#]+)$",
          flags: "",
          group: 1,
        }],
        sourceExtractors: [{
          name: "bid",
          pattern: "[?&](?:id|bookId|book_id)=([^&#,]+)",
          flags: "i",
          group: 1,
        }],
      },
    );
    if (plan) return plan;
  }

  // Some client APIs encrypt a JSON object into a hexadecimal POST body and
  // put the command number in the URL path. This is the same declarative
  // request shape as the encrypted JSON bridge, with a raw body rather than a
  // form envelope; keep the cipher and field projection inside the plan.
  const pathCommand = script.match(/\bbuildRequestUrl\s*\(\s*(\d+)\s*,/i)?.[1] || "";
  const pathPrefix = jsLib.match(/(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*\/client\/)/i)?.[1]
    || jsLib.match(/(["'])(\/[^"']*\/client\/)[^"']*\1/i)?.[2]
    || jsLib.match(/(\/client\/)/i)?.[1]
    || "";
  const pathKey = jsLib.match(/\bAES_KEY\s*=\s*['"]([^'"]{8,64})['"]/i)?.[1] || "";
  const pathIv = jsLib.match(/\bAES_IV\s*=\s*['"]([^'"]{8,64})['"]/i)?.[1] || "";
  const pathPayload = script.match(/\bbuildRequestUrl\s*\(\s*\d+\s*,\s*\{([\s\S]{0,4096}?)\}\s*\)/i)?.[1] || "";
  const pathOutput = script.match(/\)\s*\)\s*\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/i);
  const pathFields = {};
  for (const match of pathPayload.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([^,}\n]+)/g)) {
    const expression = match[2].trim();
    if (/\bjava\.get\s*\(\s*["']bid["']\s*\)/i.test(expression)) pathFields[match[1]] = "{{bid}}";
    else if (/\bbaseUrl\b[\s\S]*?split\s*\(/i.test(expression)) pathFields[match[1]] = "{{chapterId}}";
  }
  if (pathCommand && pathPrefix && pathKey && pathIv && Object.keys(pathFields).length
    && /\bdecrypt\s*\(\s*java\.ajax\s*\(/i.test(script)
    && /(?:chapterInfo|content)/i.test(script)) {
    const endpoint = String(host).replace(/\/$/, "") + pathPrefix + pathCommand;
    const crypto = {
      request: {
        key: pathKey,
        keyMode: "raw",
        iv: pathIv,
        ivEncoding: "utf8",
        padding: "pkcs5",
        encoding: "hex",
        envelope: "raw",
        envelopeField: "body",
      },
      response: {
        key: pathKey,
        keyMode: "raw",
        iv: pathIv,
        ivEncoding: "utf8",
        padding: "pkcs5",
        encoding: "hex",
        outerPath: "data",
      },
    };
    try {
      return normalizePlan({
        ...commonPlan({ kind: "path-aes-json", host, headers, responseType: "json", input: "value" }),
        input: "value",
        extractors: [{ name: "chapterId", pattern: "(?:^|/)([^/?#]+)$", flags: "", group: 1 }],
        sourceExtractors: [{ name: "bid", pattern: "[?&](?:id|bookId|book_id)=([^&#,]+)", flags: "i", group: 1 }],
        request: {
          method: "POST",
          urlTemplate: endpoint,
          payload: pathFields,
          headers: { ...headers, "Content-Type": "text/plain" },
        },
        output: { path: pathOutput ? `${pathOutput[1]}.${pathOutput[2]}` : "content", plainText: true },
        crypto,
      });
    } catch { /* continue with other bounded recognizers */ }
  }

  // A common declarative API wrapper decodes a data: URL containing a JSON
  // chapter id, encrypts a small JSON payload with AES-CBC, and decrypts the
  // JSON response with the same static client key.  Compile the data flow and
  // keep the cryptographic operation inside the server-side plan; never run
  // the source's Java/Android implementation.
  const encryptedApi = /java\.hexDecodeToString\s*\(\s*result\s*\)/i.test(script)
    && /\bURL\s*\(\s*["'`][^"'`]+["'`]\s*,\s*\{[\s\S]*\}\s*\)/i.test(script)
    && /decrypt\s*\(\s*java\.ajax\s*\(\s*URL\s*\(/i.test(script)
    && /\bsecretKey\s*=\s*["'][^"']+["']/i.test(jsLib)
    && /\bBASEURL\s*:\s*["']https?:\/\//i.test(jsLib);
  if (encryptedApi) {
    const api = script.match(/\bURL\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*\)/i);
    const outputField = script.match(/\bresult\s*=\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*;/i)?.[1] || "";
    const outputParent = script.match(/\bdecrypt\s*\([\s\S]*?\)\.data\.([A-Za-z_$][\w$]*)/i)?.[1] || "";
    const base = jsLib.match(/\bBASEURL\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1] || host;
    const key = jsLib.match(/\bsecretKey\s*=\s*["']([^"']{8,512})["']/i)?.[1] || "";
    const appSignature = jsLib.match(/\bapp_signature_md5\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const appVersion = jsLib.match(/\bapp_version\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const channel = jsLib.match(/\bchannel\s*:\s*["']([^"']*)["']/i)?.[1] || "";
    const userAgent = jsLib.match(/\bUserAgent\s*:\s*["']([^"']*)["']/i)?.[1] || "Android";
    if (api && outputField && base && key) {
      const endpoint = /^https?:\/\//i.test(api[1]) ? api[1] : `${String(base).replace(/\/$/, "")}/${api[1].replace(/^\/+/, "")}`;
      const payload = {
        app_signature_md5: appSignature,
        app_version: appVersion,
        channel,
        account: "",
        login_token: "",
        [api[2]]: `{{${api[3]}}}`,
      };
      const crypto = {
        request: {
          key,
          keyMode: "sha256",
          iv: "00000000000000000000000000000000",
          ivEncoding: "hex",
          padding: "pkcs5",
          encoding: "base64",
          envelope: "form",
          envelopeField: "secret_content",
        },
        response: {
          key,
          keyMode: "sha256",
          iv: "00000000000000000000000000000000",
          ivEncoding: "hex",
          padding: "pkcs5",
          encoding: "base64",
          outerPath: "data",
        },
      };
      try {
        return normalizePlan({
          ...commonPlan({ kind: "encrypted-json", host: base, headers, responseType: "json", input: "value" }),
          input: "value",
          decode: "base64-json",
          request: {
            method: "POST",
            urlTemplate: endpoint,
            payload,
            headers: { ...headers, "User-Agent": userAgent, "Content-Type": "application/x-www-form-urlencoded" },
          },
          output: { path: `data.${outputParent ? `${outputParent}.` : ""}${outputField}`, plainText: true },
          crypto,
        });
      } catch { /* continue with other bounded recognizers */ }
    }
  }

  // A number of public sources wrap the chapter body in a small, repeated
  // AES helper: `d(ciphertext, key)` derives a 16-byte key and IV from
  // md5(key), while another common form is `x(ciphertext, key, iv)` with a
  // base64 IV.  Compile only the call shape and cipher parameters.  The
  // bridge never evaluates the source helper or accepts an arbitrary cipher
  // name, so this remains a bounded data transform shared by every domain.
  const usesMd5Aes = /java\.md5Encode\s*\(/i.test(script)
    && /(?:aesBase64DecodeToString|createSymmetricCrypto)\s*\(/i.test(script)
    && /(?:substring|slice)\s*\(\s*0\s*,\s*16\s*\)/i.test(script)
    && /(?:substring|slice)\s*\(\s*16\s*\)/i.test(script);
  const usesRawAes = !usesMd5Aes
    && /(?:aesBase64DecodeToString|createSymmetricCrypto)\s*\(/i.test(script)
    && /base64DecodeToByteArray\s*\(/i.test(script)
    && /(?:AES\/CBC|aes\/cbc)/i.test(script);
  if (usesMd5Aes || usesRawAes) {
    const functionName = script.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1]
      || script.match(/\b([A-Za-z_$][\w$]*)\\?\(\s*["'][^"']+["']\s*,\s*["']/)?.[1]
      || "d";
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = usesRawAes
      ? `\\b${escapedName}\\s*\\(\\s*\"([^\"\\r\\n]+)\"\\s*,\\s*\"([^\"\\r\\n]+)\"\\s*,\\s*\"([^\"\\r\\n]+)\"\\s*\\)`
      : `\\b(?:${escapedName}|decryptFunc)\\s*\\(\\s*\"([^\"\\r\\n]+)\"\\s*,\\s*\"([^\"\\r\\n]+)\"\\s*\\)`;
    if (pattern) {
      const padding = /ZeroPadding/i.test(script) ? "zero" : "pkcs5";
      const plan = {
        ...commonPlan({ kind: "html-aes", host, headers }),
        request: { method: "GET", urlTemplate: "{{baseUrl}}", headers },
        output: { plainText: true },
        crypto: {
          pattern,
          flags: "i",
          payloadGroup: 1,
          keyGroup: 2,
          ...(usesRawAes ? { ivGroup: 3 } : {}),
          padding,
          keyMode: usesMd5Aes ? "md5-split" : "raw",
          encoding: "base64",
        },
      };
      try { return normalizePlan(plan); } catch { /* continue with other safe recognizers */ }
    }
  }

  // Some APIs return a JSON body encrypted with a declared RSA public key.
  // Recognize only the data flow (JSON field -> base64 bytes -> RSA decrypt)
  // and keep the key/cipher operation inside the bounded bridge plan.
  if (/createAsymmetricCrypto\s*\(\s*["']RSA["']/i.test(script)
    && /base64DecodeToByteArray\s*\(/i.test(script)) {
    const key = script.match(/\b(?:jmkey|publicKey|rsaKey)\s*=\s*["']([A-Za-z0-9+/=\s]{128,8192})["']/i)?.[1]?.replace(/\s+/g, "") || "";
    const bodyName = script.match(/\b([A-Za-z_$][\w$]*)\s*=\s*\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/i)?.[1] || "";
    const bodyPath = bodyName
      ? script.match(new RegExp(`\\b${bodyName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*\\$\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`, "i"))?.[1] || ""
      : "";
    if (key && bodyPath) {
      try {
        return normalizePlan({
          ...commonPlan({ kind: "json-rsa", host, headers, responseType: "json" }),
          request: { method: "GET", urlTemplate: "{{baseUrl}}", headers },
          output: { path: bodyPath, plainText: true },
          crypto: { publicKey: key, padding: "pkcs1" },
        });
      } catch { /* continue with other safe recognizers */ }
    }
  }

  // A declarative HTML page may expose ids/hash values, then submit those
  // fields to a JSON endpoint. This recognizer follows the data flow rather
  // than a host or source name.
  if (/\bjava\.post\s*\(/i.test(script)) {
    const bindings = matchBindings(script);
    const jsonBinding = jsonMatchBinding(script);
    const post = script.match(/java\.post\s*\(\s*([^,]+?)\s*,\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/i);
    const postArgs = post ? `${post[1]},${post[2]}` : "";
    const args = splitTopLevel(postArgs, ",");
    const urlName = args[0]?.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0] || "";
    const bodyName = args[1]?.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0] || "";
    const fields = new Set([...bindings.keys()]);
    const bodyExpression = bodyName ? assignmentExpression(script, bodyName) : "";
    const fieldAliases = new Map();
    const jsonFields = [];
    if (jsonBinding && bodyExpression) {
      const escapedObject = jsonBinding.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const memberPattern = new RegExp(`\\b${escapedObject}\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*["']([^"']+)["']\\s*\\])`, "g");
      for (const match of bodyExpression.matchAll(memberPattern)) {
        const field = match[1] || match[2] || "";
        if (!/^[A-Za-z_$][\w$]*$/.test(field) || jsonFields.includes(field)) continue;
        jsonFields.push(field);
        fieldAliases.set(`${jsonBinding.name}.${field}`, field);
        fieldAliases.set(`${jsonBinding.name}["${field}"]`, field);
        fieldAliases.set(`${jsonBinding.name}['${field}']`, field);
      }
    }
    const bodyTemplate = bodyExpression
      ? templateFromExpression(bodyExpression, { fields: new Set([...fields, ...jsonFields]), fieldAliases, allowBase: false })
      : "";
    const urlTemplate = requestTemplateFrom(script, `java.post(${postArgs})`, new Set([...fields, ...jsonFields]), host);
    const outputPath = jsonPathFromScript(script);
    const usedBindings = [...new Set([
      ...[...bindings.keys()].filter((name) => bodyTemplate.includes(`{{${name}}}`)),
      ...jsonFields.filter((name) => bodyTemplate.includes(`{{${name}}}`)),
    ])];
    const complete = urlTemplate && bodyTemplate && outputPath && usedBindings.length
      && usedBindings.every((name) => bindings.has(name) || jsonFields.includes(name));
    if (complete) {
      return normalizePlan({
        ...commonPlan({ kind: "html-post-json", host, headers }),
        extractors: [
          ...[...bindings.entries()].map(([name, item]) => ({
            name,
            pattern: item.pattern,
            flags: item.flags,
            group: item.group,
          })),
          ...(jsonBinding ? [{
            name: "jsonPayload",
            pattern: jsonBinding.pattern,
            flags: jsonBinding.flags,
            group: jsonBinding.group,
            transform: "json",
            jsonFields,
          }] : []),
        ],
        request: { method: "POST", urlTemplate, bodyTemplate, headers },
        output: { path: outputPath, plainText: true },
      });
    }
  }

  // A common anti-hotlink page places a short token in HTML and requires one
  // same-origin GET before exposing the article section. Only a bounded regex
  // and a URL made of the current page plus captured token are accepted.
  if (/\bjava\.ajax\s*\(/i.test(script)) {
    // A JSONP/JSON body is another common bounded chain: the chapter HTML
    // exposes a URL, that URL returns an object, and one object field is the
    // readable content. Compile this data flow instead of carrying the
    // original JavaScript into the XBS rule.
    const htmlCapture = script.match(
      /(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?[A-Za-z_$][\w$]*\s*\.\s*match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)/i,
    );
    const jsonpOutput = directMatchPatterns(script)
      .slice()
      .reverse()
      .find((candidate) => candidate.pattern.includes("\\{")
        && candidate.pattern.includes("[\\s\\S]"));
    const jsonpContent = /["']content["'][^:\r\n]{0,32}:/.test(script)
      || /\bcontent\b/i.test(script);
    if (htmlCapture && jsonpOutput && jsonpContent) {
      const captureName = htmlCapture[1];
      const capturePattern = safeRegex(htmlCapture[2], htmlCapture[3]);
      const captureEscaped = captureName.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
      const tokenReference = script.match(new RegExp(
        "\\b([A-Za-z_$][\\w$]*)\\s*=\\s*" + captureEscaped + "\\s*\\[\\s*(\\d+)\\s*\\]",
      ));
      const requestCall = script.match(/\bjava\.ajax\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
      const requestName = requestCall?.[1] || "";
      const requestExpression = requestName ? assignmentExpression(script, requestName) : "";
      const aliases = new Map();
      if (tokenReference) aliases.set(captureName + "[" + tokenReference[2] + "]", "token");
      const urlTemplate = requestExpression
        ? templateFromExpression(requestExpression, {
          fields: new Set(["token"]),
          fieldAliases: aliases,
          allowBase: true,
        })
        : "";
      const contentPath = /["']content["'][^:\r\n]{0,32}:/.test(script) ? "content" : "";
      const replacementPath = /["']replace["']/.test(script) ? "replace" : "";
      if (capturePattern && tokenReference && requestName && urlTemplate && contentPath) {
        try {
          return normalizePlan({
            ...commonPlan({ kind: "html-jsonp", host, headers }),
            request: {
              method: "GET",
              urlTemplate: urlTemplate.replace(/\{\{token\}\}/g, "{{raw:token}}"),
              headers,
            },
            output: {
              pattern: jsonpOutput.pattern,
              flags: jsonpOutput.flags,
              group: 1,
              path: contentPath,
              ...(replacementPath ? { replacementPath } : {}),
              plainText: true,
            },
            token: {
              pattern: capturePattern.pattern,
              flags: capturePattern.flags,
              group: Number(tokenReference[2]) || 1,
            },
          });
        } catch { /* continue with the ordinary challenge recognizer */ }
      }
    }
    const bindings = matchBindings(script);
    const matchAssignments = [...String(script).matchAll(
      /(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?(?:src|result)\s*\.\s*match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)/g,
    )];
    const tokenMatch = matchAssignments.find((match) => /token|challenge|nonce|key/i.test(match[2])) || matchAssignments[0];
    const tokenAlias = script.match(
      /(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:!=?=?\s*null\s*\?\s*)?\s*[A-Za-z_$][\w$]*\s*\[\s*(\d+)\s*\]/,
    );
    const tokenName = tokenAlias?.[1] || tokenMatch?.[1] || "";
    const tokenRegex = tokenMatch ? safeRegex(tokenMatch[2], tokenMatch[3]) : null;
    const tokenGroup = 1;
    const tokenUse = tokenName && new RegExp(`\\b${tokenName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`).test(script);
    const ajaxCall = script.match(/java\.ajax\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
    const requestName = ajaxCall?.[1] || "";
    const requestExpression = requestName ? assignmentExpression(script, requestName) : "";
    let urlTemplate = requestExpression
      ? templateFromExpression(requestExpression, { fields: new Set([tokenName]), allowBase: true })
      : "";
    if (urlTemplate && !urlTemplate.includes(`{{${tokenName}}}`) && tokenName) {
      // The expression may contain a parenthesized base fallback. Normalize
      // it once more while keeping the captured field.
      urlTemplate = templateFromExpression(
        requestExpression.replace(/^\([^)]*(?:responseUrl|chapterUrl|config\.host)[^)]*\)/i, "baseUrl"),
        { fields: new Set([tokenName]), allowBase: true },
      );
    }
    const responsePatterns = directMatchPatterns(script);
    let responseMatch = responsePatterns.slice().reverse()
      .find((candidate) => /(?:section|article|content|body)/i.test(candidate.pattern)) || null;
    // Prefer a linear section capture over a source regex that repeats a
    // nested `.*?` group (for example `(<p>.*?</p>)+`). The HTML-to-text
    // stage can remove the surrounding tags after the safe capture.
    if (!responseMatch && /<section\b/i.test(script)) {
      responseMatch = safeRegex("<section\\b[^>]*>([\\s\\S]*?)<\\/section>", "i");
    }
    const outputGroup = responseMatch ? Number(script.match(/\.match\s*\([^)]*\)\s*\[\s*(\d+)\s*\]/g)?.at(-1)?.match(/\[(\d+)\]/)?.[1] || 1) : 1;
    if (tokenRegex && tokenUse && urlTemplate && urlTemplate.includes(`{{${tokenName}}}`) && responseMatch) {
      if (!/^https?:\/\//i.test(urlTemplate) && !/^\{\{baseUrl\}\}/.test(urlTemplate)) {
        urlTemplate = `${String(host).replace(/\/$/, "")}/${urlTemplate.replace(/^\/+/, "")}`;
      }
      return normalizePlan({
        ...commonPlan({ kind: "html-challenge", host, headers }),
        request: { method: "GET", urlTemplate, headers },
        output: {
          pattern: responseMatch.pattern,
          flags: responseMatch.flags,
          group: outputGroup,
          plainText: true,
        },
        token: { pattern: tokenRegex.pattern, flags: tokenRegex.flags, group: tokenGroup },
      });
    }
  }

  // JSON APIs used by source collections sometimes encode chapter ids in the
  // catalogue URL. Decode only the declared hex/base64 payload, then use those
  // ids as URL-template fields; no source code is evaluated.
  const decode = /java\.hexDecodeToString\s*\(/i.test(script)
    ? "hex"
    : /java\.base64Decode(?:ToString)?\s*\(/i.test(script)
      ? "base64"
      : "";
  if (decode && /JSON\.parse\s*\(\s*result\s*\)/i.test(script) && /java\.ajax\s*\(/i.test(script)) {
    const decodedName = script.match(/(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*java\.(?:hexDecodeToString|base64Decode(?:ToString)?)\s*\(/i)?.[1] || "result";
    const escapedDecodedName = decodedName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    const splitMatch = script.match(new RegExp(`\\b${escapedDecodedName}\\s*\\.split\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1\\s*\\)`))
      || script.match(/java\.(?:hexDecodeToString|base64Decode(?:ToString)?)\s*\([\s\S]*?\)\s*\.split\s*\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)/i);
    const ids = {};
    if (splitMatch) {
      for (const match of script.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\[\s*(\d+)\s*\]/g)) {
        if (match[2] === decodedName) ids[match[1]] = Number(match[3]);
      }
    }
    const ajax = script.match(/java\.ajax\s*\(\s*(?:buildRequest\s*\(\s*)?([`"'][\s\S]*?)(?:\s*\))?\s*\)/i);
    const requestExpression = ajax?.[1] || "";
    const urlTemplate = requestExpression
      ? templateFromExpression(requestExpression, { fields: new Set(Object.keys(ids)), allowBase: true })
      : "";
    const outputPath = jsonPathFromScript(script);
    if (splitMatch && urlTemplate && outputPath && Object.keys(ids).length) {
      return normalizePlan({
        ...commonPlan({ kind: "encoded-id-json", host, headers, input: "value" }),
        decode,
        idFields: ids,
        request: { method: "GET", urlTemplate, headers },
        output: { path: outputPath, plainText: true },
      });
    }
  }
  return null;
}

function base64Decode(value) {
  const source = String(value || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  try { return Buffer.from(source, "base64").toString("utf8"); } catch { return ""; }
}

function hexDecode(value) {
  const source = String(value || "").replace(/[^\da-f]/gi, "");
  if (!source || source.length % 2) return "";
  try { return Buffer.from(source, "hex").toString("utf8"); } catch { return ""; }
}

function decodeValueJson(value, mode) {
  let encoded = String(value || "");
  if (/^data:[^,]*,/i.test(encoded)) encoded = encoded.slice(encoded.indexOf(",") + 1).split(",", 1)[0];
  const decoded = mode === "base64-json" ? base64Decode(encoded) : hexDecode(encoded);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeBase64Segments(value) {
  let encoded = String(value || "");
  if (/^data:[^,]*,/i.test(encoded)) encoded = encoded.slice(encoded.indexOf(",") + 1);
  encoded = encoded.split(",", 1)[0].replace(/\s+/g, "");
  const decoded = base64Decode(encoded);
  return decoded || "";
}

function cryptoBytes(value, encoding) {
  const source = String(value || "");
  try {
    if (encoding === "hex" && /^[\da-f]+$/i.test(source) && source.length % 2 === 0) return Buffer.from(source, "hex");
    if (encoding === "base64") return decodeBase64Bytes(source);
    if (encoding === "utf8") return Buffer.from(source, "utf8");
  } catch { /* invalid remote/source configuration */ }
  return null;
}

function aesConfigBytes(config) {
  let key = Buffer.from(String(config.key || ""), "utf8");
  if (config.keyMode === "sha256") key = createHash("sha256").update(key).digest();
  const iv = cryptoBytes(config.iv, config.ivEncoding);
  if (!iv || iv.length !== 16 || ![16, 24, 32].includes(key.length)) return null;
  return { key, iv };
}

function aesEncryptText(value, config) {
  const bytes = aesConfigBytes(config);
  if (!bytes) return "";
  try {
    const cipher = createCipheriv(`aes-${bytes.key.length * 8}-cbc`, bytes.key, bytes.iv);
    if (config.padding === "zero") {
      cipher.setAutoPadding(false);
      const plain = Buffer.from(String(value || ""), "utf8");
      const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
      return Buffer.concat([cipher.update(padded), cipher.final()]).toString(config.encoding === "hex" ? "hex" : "base64");
    }
    return Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]).toString(config.encoding === "hex" ? "hex" : "base64");
  } catch { return ""; }
}

function aesDecryptText(value, config) {
  const bytes = aesConfigBytes(config);
  const encrypted = config.encoding === "hex"
    ? cryptoBytes(value, "hex")
    : decodeBase64Bytes(value);
  if (!bytes || !encrypted) return "";
  try {
    const decipher = createDecipheriv(`aes-${bytes.key.length * 8}-cbc`, bytes.key, bytes.iv);
    if (config.padding === "zero") decipher.setAutoPadding(false);
    let plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (config.padding === "zero") {
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end -= 1;
      plain = plain.subarray(0, end);
    }
    return plain.toString("utf8");
  } catch { return ""; }
}

function aesDecryptPrefixed(value, config) {
  const encoded = config.encoding === "hex" ? cryptoBytes(value, "hex") : decodeBase64Bytes(value);
  if (!encoded || encoded.length <= 16) return "";
  const keyText = Buffer.from(String(config.key || ""), "utf8");
  const key = config.keyMode === "sha256" ? createHash("sha256").update(keyText).digest() : keyText;
  if (![16, 24, 32].includes(key.length)) return "";
  const iv = encoded.subarray(0, 16);
  try {
    const decipher = createDecipheriv("aes-" + (key.length * 8) + "-cbc", key, iv);
    if (config.padding === "zero") decipher.setAutoPadding(false);
    let plain = Buffer.concat([decipher.update(encoded.subarray(16)), decipher.final()]);
    if (config.padding === "zero") {
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end -= 1;
      plain = plain.subarray(0, end);
    }
    if (plain[0] === 0x50 && plain[1] === 0x4b) {
      const chunks = [];
      let offset = 0;
      while (offset + 30 <= plain.length && plain[offset] === 0x50 && plain[offset + 1] === 0x4b
        && plain[offset + 2] === 0x03 && plain[offset + 3] === 0x04) {
        const method = plain.readUInt16LE(offset + 8);
        const compressedSize = plain.readUInt32LE(offset + 18);
        const nameLength = plain.readUInt16LE(offset + 26);
        const extraLength = plain.readUInt16LE(offset + 28);
        const start = offset + 30 + nameLength + extraLength;
        const end = start + compressedSize;
        if (end > plain.length) break;
        let data = plain.subarray(start, end);
        if (method === 8) data = inflateRawSync(data);
        if (method === 0 || method === 8) chunks.push(data.toString("utf8"));
        offset = end;
      }
      if (chunks.length) return chunks.join("\n");
    }
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

function signedQueryUrl(endpoint, query, sign) {
  const values = {};
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    values[name] = String(value);
  }
  const signField = String(sign?.field || "sign");
  const signKey = String(sign?.key || "");
  const canonical = Object.keys(values).sort().map((name) => name + "=" + values[name]).join("") + signKey;
  values[signField] = createHash("md5").update(canonical, "utf8").digest("hex");
  const queryText = Object.entries(values)
    .map(([name, value]) => encodeURIComponent(name) + "=" + encodeURIComponent(value))
    .join("&");
  return String(endpoint || "").replace(/[?&]+$/, "") + "?" + queryText;
}

function signedHeaderValue(headers, sign) {
  const values = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() === String(sign?.field || "sign").toLowerCase()) continue;
    values[name] = String(value);
  }
  const canonical = Object.keys(values).sort((left, right) => left.localeCompare(right))
    .map((name) => name + "=" + values[name]).join("") + String(sign?.key || "");
  return createHash("md5").update(canonical, "utf8").digest("hex");
}

function expandPayload(value, fields) {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Za-z_$][\w$]*)\}\}/g, (_match, name) => String(fields[name] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => expandPayload(item, fields));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expandPayload(item, fields)]));
  }
  return value;
}

function decodeBase64Bytes(value) {
  const source = String(value || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!source) return null;
  try {
    const padding = source.length % 4 ? "=".repeat(4 - (source.length % 4)) : "";
    const bytes = Buffer.from(source + padding, "base64");
    return bytes.length ? bytes : null;
  } catch { return null; }
}

function decodeEscapedCapture(value) {
  const source = String(value || "");
  try {
    return JSON.parse(`"${source.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"')}"`);
  } catch { return source; }
}

function decryptAesContent(responseText, crypto) {
  const matched = String(responseText || "").match(new RegExp(crypto.pattern, crypto.flags));
  if (!matched?.[crypto.payloadGroup] || !matched?.[crypto.keyGroup]) return "";
  const encrypted = decodeBase64Bytes(decodeEscapedCapture(matched[crypto.payloadGroup]));
  if (!encrypted) return "";
  let key;
  let iv;
  if (crypto.keyMode === "md5-split") {
    const digest = createHash("md5").update(decodeEscapedCapture(matched[crypto.keyGroup]), "utf8").digest("hex");
    key = Buffer.from(digest.slice(16), "utf8");
    iv = Buffer.from(digest.slice(0, 16), "utf8");
  } else {
    key = Buffer.from(decodeEscapedCapture(matched[crypto.keyGroup]), "utf8");
    iv = decodeBase64Bytes(decodeEscapedCapture(matched[crypto.ivGroup]));
  }
  if (!key || !iv || ![16, 24, 32].includes(key.length) || iv.length !== 16) return "";
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  if (crypto.padding === "zero") decipher.setAutoPadding(false);
  try {
    let plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (crypto.padding === "zero") plain = plain.subarray(0, plain.findLastIndex((byte) => byte !== 0) + 1);
    return plain.toString("utf8");
  } catch { return ""; }
}

function decryptRsaContent(value, crypto) {
  const encrypted = decodeBase64Bytes(value);
  if (!encrypted) return "";
  try {
    const key = createPublicKey({
      key: Buffer.from(String(crypto.publicKey || ""), "base64"),
      format: "der",
      type: "spki",
    });
    const modulusLength = Number(key.asymmetricKeyDetails?.modulusLength || 0);
    const blockSize = modulusLength > 0 ? Math.ceil(modulusLength / 8) : encrypted.length;
    if (!blockSize || encrypted.length % blockSize !== 0 || encrypted.length > blockSize * 256) return "";
    const chunks = [];
    for (let offset = 0; offset < encrypted.length; offset += blockSize) {
      chunks.push(publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, encrypted.subarray(offset, offset + blockSize)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

function jsonPathValue(input, path) {
  let value = input;
  for (const key of String(path || "").split(".").filter(Boolean)) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

function expandTemplate(template, values, baseUrl) {
  return String(template || "").replace(/\{\{(raw:)?([A-Za-z_$][\w$]*)\}\}/g, (_match, raw, name) => {
    const value = name === "baseUrl" ? baseUrl : values[name] ?? "";
    return raw || ["baseUrl", "host", "backend"].includes(name)
      ? String(value)
      : encodeURIComponent(String(value));
  });
}

function resolveUrl(template, baseUrl, host) {
  const value = String(template || "");
  try { return new URL(value, baseUrl || host || undefined).toString(); } catch { return ""; }
}

function outputText(value, plainText = true) {
  if (value === undefined || value === null) return "";
  const text = Array.isArray(value) ? value.join("\n") : String(value);
  return plainText ? htmlToPlainText(text) : text.trim();
}

function applyTextReplacements(value, replacements) {
  let output = String(value || "");
  if (!replacements || typeof replacements !== "object" || Array.isArray(replacements)) return output;
  const entries = Object.entries(replacements)
    .filter(([from, to]) => from && (typeof to === "string" || typeof to === "number" || typeof to === "boolean"))
    .sort(([left], [right]) => right.length - left.length);
  for (const [from, to] of entries) output = output.split(from).join(String(to));
  return output;
}

function mergeResponseCookies(current, response) {
  const cookies = new Map();
  for (const part of String(current || "").split(/;\s*/)) {
    const match = part.match(/^([^=;\s]+)=([^;]*)$/);
    if (match) cookies.set(match[1], match[2]);
  }
  const headers = response?.httpHeaders || {};
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"] ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  for (const item of values) {
    const match = String(item || "").match(/^([^=;\s]+)=([^;]*)/);
    if (match) cookies.set(match[1], match[2]);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function withoutQuery(value) {
  try {
    const url = new URL(String(value || ""));
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
}

export function encodeContentPlan(plan) {
  const normalized = normalizePlan(plan);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_PLAN_BYTES) throw new TypeError("正文桥接计划过大");
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeContentPlan(encoded) {
  const value = String(encoded || "");
  if (!value || value.length > MAX_PLAN_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("正文桥接计划编码无效");
  }
  try { return normalizePlan(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("正文桥接计划不是有效 JSON");
  }
}

function decodeQdChapterInfo(value) {
  let source = String(value || "").trim();
  if (!source) return null;
  if (/^data:/i.test(source)) {
    const comma = source.indexOf(",");
    if (comma < 0) return null;
    const metadata = source.slice(0, comma);
    const payload = source.slice(comma + 1).split(",", 1)[0];
    try {
      source = /;base64(?:;|$)/i.test(metadata)
        ? Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
        : decodeURIComponent(payload);
    } catch {
      return null;
    }
  } else if (/^(?:[0-9a-f]{2})+$/i.test(source)) {
    const decoded = Buffer.from(source, "hex").toString("utf8").trim();
    if (decoded.startsWith("{")) source = decoded;
  }
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function executeQdContent(plan, input, { download, signal } = {}) {
  const info = decodeQdChapterInfo(input);
  const bookId = String(info?.bookId || info?.book_id || "");
  const chapterId = String(info?.cid || info?.chapterId || info?.chapter_id || "");
  if (!/^\d+$/.test(bookId) || !chapterId || chapterId.length > 128) {
    throw new Error("QD 正文章节参数无效");
  }
  const commonHeaders = {
    ...plan.headers,
    ...(plan.request.headers || {}),
    Referer: plan.headers.Referer || plan.host,
  };
  if (info.isVip === true || Number(info.isVip) === 1) {
    if (!plan.qd.vipUrlTemplate) throw new Error("QD VIP 正文地址未配置");
    const vipUrl = plan.qd.vipUrlTemplate
      .replaceAll("{{bookId}}", encodeURIComponent(bookId))
      .replaceAll("{{chapterId}}", encodeURIComponent(chapterId));
    const requestUrl = resolveUrl(vipUrl, plan.host, plan.host);
    if (!requestUrl) throw new Error("QD VIP 正文地址无效");
    const response = await download(requestUrl, commonHeaders, { method: "GET", ...(signal ? { signal } : {}) });
    let parsed;
    try {
      parsed = JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
    } catch {
      throw new Error("QD VIP 正文响应不是有效 JSON");
    }
    const content = parsed?.content ?? parsed?.data?.content ?? parsed?.Data?.Content;
    if (content === undefined || content === null || String(content).trim() === "") {
      throw new Error("QD VIP 正文响应没有内容");
    }
    return String(content);
  }
  const params = ["bookId=" + bookId, "chapterId=" + chapterId];
  const signature = qdSignatureHeaders(params, { host: plan.host, config: plan.qd });
  if (!signature) throw new Error("QD 正文签名生成失败");
  const endpoint = plan.qd.endpoint.replace(/\/+$/, "") + "/" + plan.qd.path.replace(/^\/+/, "");
  const query = signature.query.split("&").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return encodeURIComponent(part);
    return encodeURIComponent(part.slice(0, separator)) + "=" + encodeURIComponent(part.slice(separator + 1));
  }).join("&");
  const requestUrl = resolveUrl(endpoint + "?" + query, plan.host, plan.host);
  if (!requestUrl) throw new Error("QD 正文请求地址无效");
  const response = await download(requestUrl, {
    ...commonHeaders,
    QDSign: signature.QDSign,
    QDInfo: signature.QDInfo,
    tstamp: signature.tstamp,
  }, { method: "GET", ...(signal ? { signal } : {}) });
  const decrypted = decryptQdChapterBytes(response, {
    host: plan.host,
    chapterId,
    key1: plan.qd.key1,
    key3Prefix: plan.qd.key3Prefix,
    salt: plan.qd.salt,
  });
  if (!decrypted) throw new Error("QD 正文双层 DES 解密失败");
  let chapter;
  try {
    chapter = JSON.parse(decrypted);
  } catch {
    throw new Error("QD 正文解密结果不是 JSON");
  }
  const lines = String(chapter?.Content || "").split("\r\n");
  const blocks = new Map((Array.isArray(chapter?.Blocks) ? chapter.Blocks : [])
    .map((block) => [Number(block?.Sort), block]));
  let content = "";
  for (let index = 0; index < lines.length; index += 1) {
    content += lines[index] + "\n";
    const block = blocks.get(index + 1);
    if (block?.Type === "image" && block.Url) content += "<img src=\"" + String(block.Url) + "\">\n";
  }
  if (!content.trim()) throw new Error("QD 正文内容为空");
  return content;
}

/** Execute a compiled two-step content plan with an injected downloader. */
export async function executeContentPlan(planValue, {
  sourceUrl = "",
  value = "",
  download,
  signal,
} = {}) {
  const plan = normalizePlan(planValue);
  if (typeof download !== "function") throw new TypeError("正文桥接计划需要下载器");
  const inputValue = String(value || sourceUrl || "");
  let baseUrl = String(sourceUrl || plan.host || "");
  let fields = { host: plan.host, backend: plan.host };
  let cookieHeader = "";
  if (plan.kind === "qd-json-content") {
    return executeQdContent(plan, inputValue, { download, signal });
  }
  if (plan.kind === "data-text") {
    let text = inputValue;
    if (/^data:/i.test(text)) {
      const comma = text.indexOf(",");
      if (comma < 0) throw new Error("正文 data 地址无效");
      const metadata = text.slice(0, comma);
      const payload = text.slice(comma + 1).split(",", 1)[0];
      try {
        text = /;base64(?:;|$)/i.test(metadata)
          ? Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
          : decodeURIComponent(payload);
      } catch {
        throw new Error("正文 data 内容解码失败");
      }
    }
    const output = outputText(text, plan.output.plainText);
    if (!output) throw new Error("正文 data 内容为空");
    return output;
  }
  if (plan.kind === "download-text") {
    let currentUrl = resolveUrl(inputValue, plan.host, plan.host);
    if (!currentUrl) throw new Error("正文下载链起始地址无效");
    let referer = "";
    for (const step of plan.steps || []) {
      const response = await download(currentUrl, {
        ...plan.headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(referer ? { Referer: referer } : {}),
      }, { method: "GET", ...(signal ? { signal } : {}) });
      cookieHeader = mergeResponseCookies(cookieHeader, response);
      const responseUrl = String(response?.read2xsggResponseUrl || currentUrl);
      const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
      let selected = step.selector
        ? executeBridgeSelector(responseText, responseUrl, "html", step.selector)
        : String(responseText).match(new RegExp(step.pattern, step.flags))?.[step.group] || "";
      selected = String(selected || "").trim().replace(/&amp;/gi, "&");
      if (!selected) throw new Error("正文下载链没有提取到下一跳地址");
      if (step.prefix && !/^https?:\/\//i.test(selected)) selected = step.prefix + selected;
      if (step.suffix) selected += step.suffix;
      const nextUrl = resolveUrl(selected, responseUrl, plan.host);
      if (!nextUrl) throw new Error("正文下载链下一跳地址无效");
      referer = responseUrl;
      currentUrl = nextUrl;
    }
    const finalResponse = await download(currentUrl, {
      ...plan.headers,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(referer ? { Referer: referer } : {}),
    }, { method: "GET", ...(signal ? { signal } : {}) });
    const finalText = decodeTextBuffer(finalResponse, { headers: finalResponse?.httpHeaders || {} });
    const output = outputText(finalText, true);
    if (!output) throw new Error("正文下载链最终响应为空");
    return output;
  }
  if (plan.kind === "signed-aes-json") {
    if (plan.decode === "base64-segments") {
      const decoded = decodeBase64Segments(inputValue);
      const segments = decoded.split("/");
      for (const [name, index] of Object.entries(plan.decodedFields || {})) {
        fields[name] = segments[Number(index)] || "";
      }
    } else {
      for (const extractor of plan.extractors || []) {
        const found = inputValue.match(new RegExp(extractor.pattern, extractor.flags));
        fields[extractor.name] = found?.[extractor.group] || "";
      }
    }
    for (const extractor of plan.sourceExtractors || []) {
      const found = String(sourceUrl || "").match(new RegExp(extractor.pattern, extractor.flags));
      if (found?.[extractor.group]) fields[extractor.name] = found[extractor.group];
    }
    if (fields.agent === "0") fields.agent = "";
    const requestQuery = plan.request.query || {};
    const makeQuery = (retryValue) => Object.fromEntries(Object.entries(requestQuery).map(([name, template]) => [
      name,
      String(template || "").replace(/\{\{([A-Za-z_$][\w$]*)\}\}/g, (_match, field) => (
        field === plan.retry?.field && retryValue !== undefined
          ? String(retryValue)
          : String(fields[field] ?? "")
      )),
    ]).filter(([name, item]) => !(plan.request.optionalQuery || []).includes(name) || item !== ""));
    const baseHeaders = { ...plan.headers, ...(plan.request.headers || {}) };
    const retryValues = [fields[plan.retry?.field], ...(plan.retry?.alternates || [])]
      .filter((item, index, values) => item !== undefined && values.indexOf(item) === index);
    const attempts = retryValues.length ? retryValues : [undefined];
    for (const retryValue of attempts) {
      const query = makeQuery(retryValue);
      const requestUrl = signedQueryUrl(plan.request.urlTemplate, query, plan.request.sign);
      const requestHeaders = { ...baseHeaders };
      if (plan.request.headerSign) {
        requestHeaders[plan.request.headerSign.field] = signedHeaderValue(requestHeaders, plan.request.sign);
      }
      const response = await download(requestUrl, requestHeaders, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
      let outer = responseText;
      if (plan.crypto.response.outerPath) {
        try { outer = jsonPathValue(JSON.parse(responseText), plan.crypto.response.outerPath); } catch { outer = ""; }
      }
      const decrypted = aesDecryptPrefixed(outer, plan.crypto.response);
      if (!decrypted) continue;
      let parsed = decrypted;
      try { parsed = JSON.parse(decrypted); } catch { /*正文可能直接是 HTML/纯文本*/ }
      const result = plan.output.path && parsed && typeof parsed === "object"
        ? jsonPathValue(parsed, plan.output.path)
        : parsed;
      const output = outputText(result, plan.output.plainText);
      if (output) return output;
    }
    throw new Error("正文加签 AES 响应解析为空");
  }
  if (plan.kind === "path-aes-json") {
    for (const extractor of plan.extractors || []) {
      const found = inputValue.match(new RegExp(extractor.pattern, extractor.flags));
      fields[extractor.name] = found?.[extractor.group] || "";
    }
    for (const extractor of plan.sourceExtractors || []) {
      const found = String(sourceUrl || "").match(new RegExp(extractor.pattern, extractor.flags));
      if (found?.[extractor.group]) fields[extractor.name] = found[extractor.group];
    }
    const payload = expandPayload(plan.request.payload, fields);
    const encrypted = aesEncryptText(JSON.stringify(payload), plan.crypto.request);
    if (!encrypted) throw new Error("正文路径 AES 请求加密失败");
    const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, fields, plan.host), plan.host, plan.host);
    if (!requestUrl) throw new Error("正文路径 AES 请求地址无效");
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
    }, {
      method: "POST",
      body: encrypted,
      ...(signal ? { signal } : {}),
    });
    const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
    let outer;
    try { outer = JSON.parse(responseText); } catch { throw new Error("正文路径 AES 外层响应不是 JSON"); }
    const encryptedResponse = plan.crypto.response.outerPath
      ? jsonPathValue(outer, plan.crypto.response.outerPath)
      : outer;
    const decrypted = aesDecryptText(encryptedResponse, plan.crypto.response);
    if (!decrypted) throw new Error("正文路径 AES 响应解密为空");
    let parsed = decrypted;
    try { parsed = JSON.parse(decrypted); } catch { /*正文可直接返回文本*/ }
    const result = parsed && typeof parsed === "object" ? jsonPathValue(parsed, plan.output.path) : parsed;
    const output = outputText(result, plan.output.plainText);
    if (!output) throw new Error("正文路径 AES 响应解析为空");
    return output;
  }
  if (plan.kind === "encrypted-json") {
    const decoded = decodeValueJson(inputValue, plan.input === "value" ? plan.decode : "");
    if (!decoded) throw new Error("正文章节参数 JSON 解码为空");
    fields = { ...fields, ...Object.fromEntries(Object.entries(decoded).map(([name, item]) => [name, item == null ? "" : String(item)])) };
    const payload = expandPayload(plan.request.payload, fields);
    const encrypted = aesEncryptText(JSON.stringify(payload), plan.crypto.request);
    if (!encrypted) throw new Error("正文请求加密失败");
    const envelopeField = plan.crypto.request.envelopeField;
    const body = plan.crypto.request.envelope === "json"
      ? JSON.stringify({ [envelopeField]: encrypted })
      : `${encodeURIComponent(envelopeField)}=${encodeURIComponent(encrypted)}`;
    const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, fields, plan.host), plan.host, plan.host);
    if (!requestUrl) throw new Error("正文加密请求地址无效");
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
      ...(body !== undefined ? {
        "Content-Type": plan.request.headers?.["Content-Type"]
          || (plan.crypto.request.envelope === "json" ? "application/json" : "application/x-www-form-urlencoded"),
      } : {}),
    }, {
      method: plan.request.method,
      body,
      ...(signal ? { signal } : {}),
    });
    const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
    let outer = responseText;
    if (plan.crypto.response.outerPath) {
      try { outer = jsonPathValue(JSON.parse(responseText), plan.crypto.response.outerPath); } catch { outer = ""; }
    }
    const decrypted = aesDecryptText(outer, plan.crypto.response);
    if (!decrypted) throw new Error("正文响应解密为空");
    let parsed;
    try { parsed = JSON.parse(decrypted); } catch { parsed = decrypted; }
    const result = typeof parsed === "string" ? parsed : jsonPathValue(parsed, plan.output.path);
    const output = outputText(result, plan.output.plainText);
    if (!output) throw new Error("正文加密响应解析为空");
    return output;
  }
  if (plan.kind === "encoded-id-json") {
    let encoded = inputValue;
    if (/^data:[^,]*,/i.test(encoded)) encoded = encoded.slice(encoded.indexOf(",") + 1).split(",", 1)[0];
    const decoded = plan.decode === "base64" ? base64Decode(encoded) : hexDecode(encoded);
    if (!decoded) throw new Error("正文章节参数解码为空");
    for (const [name, index] of Object.entries(plan.idFields || {})) fields[name] = decoded.split("/")[Number(index)] || "";
  } else {
    if (!/^https?:\/\//i.test(inputValue)) throw new Error("正文章节地址无效");
    const initial = await download(inputValue, plan.headers, { method: "GET", ...(signal ? { signal } : {}) });
    baseUrl = String(initial?.read2xsggResponseUrl || inputValue);
    cookieHeader = mergeResponseCookies(plan.headers.Cookie || "", initial);
    const initialText = decodeTextBuffer(initial, { headers: initial?.httpHeaders || {} });
    if (plan.kind === "html-image-key-aes") {
      const manifestMatch = initialText.match(new RegExp(plan.manifest.pattern, plan.manifest.flags));
      const cidMatch = initialText.match(new RegExp(plan.cid.pattern, plan.cid.flags));
      if (!manifestMatch?.[plan.manifest.group] || !cidMatch?.[plan.cid.group]) {
        throw new Error("正文页面没有发现加密清单或章节 ID");
      }
      const manifestText = String(manifestMatch[plan.manifest.group])
        .replace(/&quot;|&#34;|&#x22;/gi, "\"")
        .replace(/&amp;|&#38;|&#x26;/gi, "&")
        .replace(/&lt;|&#60;|&#x3c;/gi, "<")
        .replace(/&gt;|&#62;|&#x3e;/gi, ">");
      let manifest;
      try { manifest = JSON.parse(manifestText); } catch { throw new Error("正文加密清单不是有效 JSON"); }
      const keyUrl = resolveUrl(
        expandTemplate(plan.keyUrlTemplate, { host: plan.host, cid: cidMatch[plan.cid.group] }, baseUrl),
        baseUrl,
        plan.host,
      );
      if (!keyUrl) throw new Error("正文像素密钥地址无效");
      const keyImage = await download(keyUrl, {
        ...plan.headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        Referer: baseUrl,
      }, { method: "GET", ...(signal ? { signal } : {}) });
      cookieHeader = mergeResponseCookies(cookieHeader, keyImage);
      const key = await extractPixelKey(keyImage, plan.imageKey);
      if (![16, 24, 32].includes(key.length)) throw new Error("正文像素密钥长度无效");
      const decodeManifestBytes = (value) => decodeBase64Bytes(value);
      const iv = decodeManifestBytes(manifest.iv);
      if (!iv || iv.length !== 16) throw new Error("正文加密清单 IV 无效");
      const decryptBytes = (encrypted, decryptIv) => {
        if (!encrypted || !decryptIv || decryptIv.length !== 16) return null;
        try {
          const decipher = createDecipheriv("aes-" + (key.length * 8) + "-cbc", key, decryptIv);
          return Buffer.concat([decipher.update(encrypted), decipher.final()]);
        } catch {
          return null;
        }
      };
      const payload = decodeManifestBytes(manifest.payload);
      if (!payload) throw new Error("正文加密清单 payload 无效");
      let shuffled;
      if (Number(manifest.v) === 3 || plan.crypto.version === 3) {
        if (payload.length <= 48) throw new Error("正文 v3 payload 长度不足");
        const contentKey = decryptBytes(payload.subarray(0, 48), iv);
        if (!contentKey?.length) throw new Error("正文 v3 内容密钥解密失败");
        const streamKey = createHmac("sha256", key).update(contentKey).digest();
        const plain = Buffer.alloc(payload.length - 48);
        for (let index = 0; index < plain.length; index += 1) {
          plain[index] = payload[index + 48] ^ streamKey[index % streamKey.length];
        }
        shuffled = plain.toString("utf8").split("\x02");
      } else {
        const plain = decryptBytes(payload, iv);
        if (!plain) throw new Error("正文 v2 payload 解密失败");
        try { shuffled = JSON.parse(plain.toString("utf8")); } catch { throw new Error("正文 v2 payload 不是 JSON"); }
      }
      const orderIv = decodeManifestBytes(manifest.order?.i);
      const orderData = decodeManifestBytes(manifest.order?.d);
      const orderPlain = decryptBytes(orderData, orderIv);
      if (!orderPlain) throw new Error("正文段落顺序解密失败");
      let order;
      try {
        order = JSON.parse(orderPlain.toString("utf8").replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, "").trim());
      } catch {
        throw new Error("正文段落顺序不是 JSON");
      }
      if (!Array.isArray(shuffled) || !Array.isArray(order)) throw new Error("正文段落数据格式无效");
      const restored = [];
      for (let index = 0; index < order.length && index < shuffled.length; index += 1) {
        const target = Number(order[index]);
        if (Number.isInteger(target) && target >= 0 && target < 100000) restored[target] = shuffled[index];
      }
      const parts = restored.filter((item) => item !== undefined && item !== null).map((item) => String(item))
        .filter((item) => !(plan.skipPrefixes || []).some((prefix) => prefix && item.startsWith(prefix)))
        .filter((item) => !(plan.skipAllContains || []).length
          || !(plan.skipAllContains || []).every((needle) => needle && item.includes(needle)));
      const output = outputText(parts.map((item) => "<p>" + item + "</p>").join(""), plan.output.plainText);
      if (!output) throw new Error("正文像素密钥 AES 解密结果为空");
      return output;
    }
    if (plan.kind === "html-aes") {
      const output = outputText(decryptAesContent(initialText, plan.crypto), plan.output.plainText);
      if (!output) throw new Error("正文 AES 解密结果为空");
      return output;
    }
    if (plan.kind === "json-rsa") {
      let parsed;
      try { parsed = JSON.parse(initialText); } catch { throw new Error("正文 RSA 响应不是有效 JSON"); }
      const encrypted = jsonPathValue(parsed, plan.output.path);
      const output = outputText(decryptRsaContent(encrypted, plan.crypto), plan.output.plainText);
      if (!output) throw new Error("正文 RSA 解密结果为空");
      return output;
    }
    if (plan.kind === "html-post-json") {
      for (const extractor of plan.extractors || []) {
        const found = String(initialText).match(new RegExp(extractor.pattern, extractor.flags));
        const value = found?.[extractor.group] || "";
        if (extractor.transform === "json") {
          try {
            const parsed = JSON.parse(value);
            fields[extractor.name] = parsed;
            for (const field of extractor.jsonFields || []) {
              const fieldValue = parsed && typeof parsed === "object" ? parsed[field] : undefined;
              fields[field] = fieldValue === undefined || fieldValue === null ? "" : String(fieldValue);
            }
          } catch {
            fields[extractor.name] = {};
          }
        } else {
          fields[extractor.name] = value;
        }
      }
    } else {
      const tokenPattern = safeRegex(plan.token?.pattern, plan.token?.flags);
      const token = tokenPattern ? String(initialText).match(new RegExp(tokenPattern.pattern, tokenPattern.flags))?.[Number(plan.token.group) || 1] || "" : "";
      fields.token = token;
      baseUrl = withoutQuery(baseUrl);
    }
  }
  const body = plan.request.bodyTemplate
    ? expandTemplate(plan.request.bodyTemplate, fields, baseUrl)
    : undefined;
  const attempts = plan.kind === "html-challenge" ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, fields, baseUrl), baseUrl, plan.host);
    if (!requestUrl) throw new Error("正文二次请求地址无效");
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
      ...(body !== undefined ? { "Content-Type": plan.request.headers?.["Content-Type"] || "application/x-www-form-urlencoded" } : {}),
      Referer: plan.headers.Referer || baseUrl,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    }, {
      method: plan.request.method,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    cookieHeader = mergeResponseCookies(cookieHeader, response);
    const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
    let result;
    if (plan.kind === "html-jsonp") {
      const matcher = new RegExp(plan.output.pattern, plan.output.flags);
      const captured = responseText.match(matcher)?.[Number(plan.output.group) || 1] || "";
      let parsed;
      try { parsed = JSON.parse(captured); } catch { parsed = null; }
      result = parsed && typeof parsed === "object"
        ? jsonPathValue(parsed, plan.output.path)
        : "";
      if (plan.output.replacementPath && parsed && typeof parsed === "object") {
        result = applyTextReplacements(
          result,
          jsonPathValue(parsed, plan.output.replacementPath),
        );
      }
      const output = outputText(result, plan.output.plainText);
      if (output) return output;
      throw new Error("正文 JSONP 响应解析为空");
    }
    if (plan.kind === "html-challenge") {
      const matcher = new RegExp(plan.output.pattern, plan.output.flags);
      result = responseText.match(matcher)?.[Number(plan.output.group) || 1] || "";
      const output = outputText(result, plan.output.plainText);
      if (output) return output;
      const tokenPattern = safeRegex(plan.token?.pattern, plan.token?.flags);
      const nextToken = tokenPattern
        ? responseText.match(new RegExp(tokenPattern.pattern, tokenPattern.flags))?.[Number(plan.token.group) || 1] || ""
        : "";
      if (!nextToken || attempt + 1 >= attempts) break;
      fields.token = nextToken;
      baseUrl = withoutQuery(response?.read2xsggResponseUrl || baseUrl);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(responseText); } catch { throw new Error("正文二次响应不是有效 JSON"); }
    result = jsonPathValue(parsed, plan.output.path);
    const output = outputText(result, plan.output.plainText);
    if (!output) throw new Error("正文二次请求解析为空");
    return output;
  }
  throw new Error("正文二次请求解析为空");
}
