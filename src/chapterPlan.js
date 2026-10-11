import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { decodeTextBuffer } from "./charset.js";
import { qdApiEndpoint, qdBookIdFromInput, qdCryptoConfig, qdSignatureHeaders } from "./qdCrypto.js";

const MAX_PLAN_BYTES = 24 * 1024;
const MAX_TEMPLATE_LENGTH = 4_096;
const MAX_REGEX_LENGTH = 2_048;
const MAX_ROWS = 12_000;
const MAX_BATCH_REQUESTS = 1_024;
const BATCH_CONCURRENCY = 16;
const SAFE_HEADER = /^(?:user-agent|referer|origin|accept|accept-language|content-type|x-requested-with|x-fingerprint|client-device|authorization)$/i;

function safeRegex(pattern, flags = "") {
  const value = String(pattern || "");
  if (!value || value.length > MAX_REGEX_LENGTH || !/^[dgimsuvy]*$/.test(String(flags || ""))) return null;
  if (/\((?:[^()]|\\.)*(?:\||[+*?{])(?:[^()]|\\.)*\)[+*?{]/.test(value)) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, flags);
    return { pattern: value, flags: String(flags || "") };
  } catch {
    return null;
  }
}

function safeHeaders(value) {
  const output = {};
  for (const [name, raw] of Object.entries(value || {})) {
    if (!SAFE_HEADER.test(name) || typeof raw !== "string") continue;
    const text = raw.replace(/[\r\n]+/g, " ").trim();
    if (text && text.length <= 2_048) output[name] = text;
  }
  return output;
}

function splitTopLevel(value, separator = ",") {
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
    if ("([{".includes(character)) depth += 1;
    else if (")] }".replace(/\s/g, "").includes(character)) depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function matchingCall(source, index) {
  const open = String(source || "").indexOf("(", index);
  if (open < 0) return "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let cursor = open; cursor < String(source || "").length; cursor += 1) {
    const character = source[cursor];
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
      if (depth === 0) return source.slice(open + 1, cursor);
    }
  }
  return "";
}

function callEnd(source, index) {
  const open = String(source || "").indexOf("(", index);
  if (open < 0) return -1;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let cursor = open; cursor < String(source || "").length; cursor += 1) {
    const character = source[cursor];
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
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function literalValue(value) {
  const source = String(value || "").trim();
  if (!/^['"]/.test(source) || source[source.length - 1] !== source[0]) return null;
  try {
    if (source[0] === '"') return JSON.parse(source);
    return source.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|['"\\/bfnrt])/g, (_match, token) => {
      if (token[0] === "u" || token[0] === "x") return String.fromCodePoint(Number.parseInt(token.slice(1), 16));
      return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[token] ?? token;
    });
  } catch {
    return null;
  }
}

function trimExpression(value) {
  let source = String(value || "").trim().replace(/;\s*$/, "");
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
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index !== source.length - 1) complete = false;
      }
      if (!complete) break;
    }
    if (!complete || depth !== 0) break;
    source = source.slice(1, -1).trim();
  }
  return source;
}

function staticConstants(jsLib) {
  const output = {};
  for (const match of String(jsLib || "").matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(https?:\/\/[^"']+)\2/g)) {
    output[match[1]] = match[3];
  }
  return output;
}

function expressionTemplate(value, allowed = new Set(), constants = {}) {
  let source = trimExpression(value);
  if (!source || source.length > MAX_TEMPLATE_LENGTH) return "";
  if (/^buildRequest\s*\(/i.test(source)) {
    source = trimExpression(source.replace(/^buildRequest\s*\(/i, "").replace(/\)\s*$/, ""));
  }
  const template = source.match(/^`([\s\S]*)`$/);
  if (template) {
    let output = "";
    let last = 0;
    for (const match of template[1].matchAll(/\$\{\s*([^{}]+?)\s*\}/g)) {
      output += template[1].slice(last, match.index);
      const expression = trimExpression(match[1]);
      const member = expression.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
      const name = member ? member[2] : expression.match(/^[A-Za-z_$][\w$]*$/)?.[0];
      if (!name || (!allowed.has(name) && !["baseUrl", "host", "backend"].includes(name))) return "";
      output += `{{${name}}}`;
      last = match.index + match[0].length;
    }
    output += template[1].slice(last);
    return output.length <= MAX_TEMPLATE_LENGTH ? output : "";
  }

  const parts = splitTopLevel(source, "+");
  if (!parts.length) return "";
  let output = "";
  for (const part of parts) {
    const literal = literalValue(part);
    if (literal !== null) {
      output += literal;
      continue;
    }
    const member = part.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (member && (allowed.has(member[2]) || !["source", "java", "config", "params"].includes(member[1]))) {
      output += `{{${member[2]}}}`;
      continue;
    }
    if (/^source\.(?:key|bookSourceUrl|getKey\s*\(\s*\))$/i.test(part)) {
      output += "{{host}}";
      continue;
    }
    const encoded = part.match(/^(?:String|encodeURIComponent|encodeURI)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)$/);
    const name = encoded?.[1] || part.match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (!name) return "";
    if (Object.hasOwn(constants, name)) output += `{{${name}}}`;
    else if (name === "host" || name === "backend" || name === "baseUrl") output += `{{${name}}}`;
    else if (allowed.has(name)) output += `{{${name}}}`;
    else return "";
  }
  return output.length <= MAX_TEMPLATE_LENGTH ? output : "";
}

function fieldPath(value) {
  let source = String(value || "").trim().replace(/^@json:\s*/i, "");
  source = source.replace(/^\$\.?/, "").replace(/\[\*\]/g, "").replace(/^\.+/, "");
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(source)) return "";
  return source;
}

function jsonPathValue(value, path) {
  const segments = String(path || "")
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let values = [value];
  for (const key of segments) {
    const next = [];
    for (const current of values) {
      if (current === null || current === undefined || typeof current !== "object") continue;
      if (key === "*") {
        if (Array.isArray(current)) next.push(...current);
        else next.push(...Object.values(current));
      } else if (Array.isArray(current) && /^\d+$/.test(key)) {
        if (current[Number(key)] !== undefined) next.push(current[Number(key)]);
      } else if (current[key] !== undefined) {
        next.push(current[key]);
      }
    }
    values = next;
    if (!values.length) return undefined;
  }
  return values.length === 1 ? values[0] : values;
}

function jsonPathFromScript(script) {
  const source = String(script || "");
  const matches = [];
  for (const match of source.matchAll(/JSON\.parse\s*\(/gi)) {
    if (match.index === undefined) continue;
    const end = callEnd(source, match.index);
    if (end < 0) continue;
    const suffix = source.slice(end + 1).match(/^\s*(?:\.\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*))?/);
    matches.push(String(suffix?.[1] || "")
      .replace(/\s+/g, "")
      .replace(/\.(?:reduce|map|forEach|filter|slice)$/, ""));
  }
  return matches.sort((left, right) => right.length - left.length)[0] || "";
}

function inputExtractors(script) {
  const extractors = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:String\s*\(\s*)?baseUrl\s*\.\s*match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)\s*\[\s*(\d+)\s*\]/g;
  for (const match of String(script || "").matchAll(pattern)) {
    const safe = safeRegex(match[2], match[3]);
    if (safe) extractors.push({ name: match[1], ...safe, group: Number(match[4]) });
  }
  return extractors;
}

function rowAliases(script) {
  const aliases = {};
  for (const match of String(script || "").matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\[\s*i\s*\]\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g)) {
    aliases[match[1]] = match[2];
  }
  return aliases;
}

function requestPlan(script, allowed, constants, headers) {
  const source = String(script || "");
  const call = source.match(/\bjava\.(post|ajax|get)\s*\(/i);
  if (!call || call.index === undefined) return null;
  const args = splitTopLevel(matchingCall(source, call.index));
  if (!args.length) return null;
  const methodName = call[1].toLowerCase();
  const urlTemplate = expressionTemplate(args[0], allowed, constants);
  if (!urlTemplate) return null;
  const request = { method: methodName === "post" ? "POST" : "GET", urlTemplate };
  if (methodName === "post") {
    const body = expressionTemplate(args[1], allowed, constants);
    if (!body) return null;
    request.bodyTemplate = body;
    request.headers = {
      ...headers,
      "Content-Type": /^\s*\{/.test(body) ? "application/json" : "application/x-www-form-urlencoded",
    };
  } else {
    request.headers = { ...headers };
  }
  return request;
}

function generatedUrlField(script, allowed, constants, aliases) {
  const source = String(script || "");
  const encoded = source.match(/\burl\s*:\s*`([\s\S]*?)\$\{\s*(?:java\.)?base64Encode\s*\(\s*([^{}]+?)\s*\)\s*\}([\s\S]*?)`/i);
  if (encoded) {
    let expression = encoded[2];
    const name = expression.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (name) {
      const assignment = source.match(new RegExp(`\\b${name}\\s*=\\s*([^;\\n]+)`));
      if (assignment) expression = assignment[1];
    }
    const template = expressionTemplate(expression, new Set([...allowed, ...Object.keys(aliases), "url"]), constants);
    if (template) return { transform: "base64", prefix: encoded[1], template, suffix: encoded[3] };
  }

  const direct = source.match(/(?:\b[A-Za-z_$][\w$]*\s*\[\s*i\s*\]\s*(?:\[\s*['"]url['"]\s*\]|\.\s*url)|\b[A-Za-z_$][\w$]*\.url)\s*=\s*([^;\n]+)/i);
  if (direct) {
    const template = expressionTemplate(direct[1], new Set([...allowed, ...Object.keys(aliases)]), constants);
    if (template) return { template };
  }

  const objectUrl = source.match(/\burl\s*:\s*([^,}\n]+)/i);
  if (objectUrl) {
    const template = expressionTemplate(objectUrl[1], new Set([...allowed, ...Object.keys(aliases)]), constants);
    if (template) return { template };
  }
  return null;
}

function simpleMemberField(expression, variable) {
  const match = String(expression || "").match(
    new RegExp(`^\\s*(?:String\\s*\\(\\s*)?${String(variable || "").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.([A-Za-z_$][\\w$]*)(?:\\s*\\))?\\s*$`),
  );
  return match?.[1] || "";
}

function propertyExpression(source, property) {
  const escaped = String(property || "").replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
  return String(source || "").match(
    new RegExp(`(?:^|[,\\{\\n])\\s*["']?${escaped}["']?\\s*:\\s*([^,\\}\\n]+)`, "i"),
  )?.[1]?.trim() || "";
}

function nestedJsonMapShape(script) {
  const source = String(script || "");
  const match = source.match(
    /JSON\.parse\s*\(\s*result\s*\)((?:\.[A-Za-z_$][\w$]*)+)\.map\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\{([\s\S]*?)\b\2\.([A-Za-z_$][\w$]*)\.map\s*\(\s*([A-Za-z_$][\w$]*)\s*=>/i,
  );
  if (!match) return null;
  const responsePath = `${match[1].slice(1).replace(/\./g, ".")}[*].${match[4]}[*]`;
  const row = match[5];
  const titleExpression = propertyExpression(source, "title");
  const title = simpleMemberField(titleExpression, row);
  if (!title) return null;
  const conditionExpression = propertyExpression(source, "v");
  const condition = conditionExpression.match(
    new RegExp(`^${row}\\.([A-Za-z_$][\\w$]*)\\s*(===?|!==?)\\s*([0-9]+|true|false|["'][^"']*["'])$`, "i"),
  );
  const updateExpression = propertyExpression(source, "t");
  return {
    responsePath,
    row,
    title: { path: title },
    condition: condition ? {
      path: condition[1],
      operator: /^!/.test(condition[2]) ? "notEquals" : "equals",
      value: condition[3].replace(/^["']|["']$/g, ""),
    } : null,
    updateTime: updateExpression ? { expression: updateExpression } : null,
  };
}

function nestedUrlAssignment(script, row, allowed, constants) {
  const source = String(script || "");
  const ifMatch = source.match(
    /\bif\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/i,
  );
  if (!ifMatch) return null;
  const assignment = (body) => body.match(/(?:[A-Za-z_$][\w$]*\.)?url\s*=\s*([^;\n}]+)(?:;|(?=\s*})|(?=\s*$))/i)?.[1]?.trim() || "";
  const trueExpression = assignment(ifMatch[2]);
  const falseExpression = assignment(ifMatch[3]);
  if (!trueExpression || !falseExpression) return null;
  const normalize = (expression) => expressionTemplate(
    String(expression || "")
      .replace(/\b(?:java\.)?androidId\s*\(\s*\)/gi, '"read2xsgg"'),
    new Set([...allowed, row]),
    constants,
  );
  const whenTrue = normalize(trueExpression);
  const whenFalse = normalize(falseExpression);
  if (!whenTrue || !whenFalse) return null;
  const conditionField = propertyExpression(source, "v").match(
    new RegExp(`^${row}\\.([A-Za-z_$][\\w$]*)\\s*(?:===?|!==?)\\s*([0-9]+|true|false|["'][^"']*["'])$`, "i"),
  );
  if (!conditionField) return null;
  return {
    conditional: {
      condition: {
        path: conditionField[1],
        operator: /^!/.test(conditionField[0].match(/(!==?)/)?.[1] || "") ? "notEquals" : "equals",
        value: conditionField[2].replace(/^["']|["']$/g, ""),
      },
      whenTrue: { template: whenTrue },
      whenFalse: { template: whenFalse },
    },
  };
}

function encodedObjectUrlField(script, row) {
  const source = String(script || "");
  const object = source.match(
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\}\s*\n?\s*\1\s*=\s*(?:java\.)?base64Encode\s*\(\s*JSON\.stringify\s*\(\s*\1\s*\)\s*\)/i,
  );
  if (!object) return null;
  const template = source.match(/\burl\s*=\s*`([\s\S]*?)`/);
  if (!template) return null;
  const marker = `\\$\\{\\s*${object[1]}\\s*\\}`;
  const markerMatch = template[1].match(new RegExp(marker));
  if (!markerMatch) return null;
  const prefix = template[1].slice(0, markerMatch.index);
  const suffix = template[1].slice(markerMatch.index + markerMatch[0].length);
  const fields = {};
  for (const property of splitTopLevel(object[2])) {
    const pair = property.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (!pair) continue;
    const expression = pair[2].trim();
    const member = simpleMemberField(expression, row);
    if (member) {
      fields[pair[1]] = { path: member };
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
      fields[pair[1]] = { variable: expression };
      continue;
    }
    const condition = expression.match(
      new RegExp(`^${row}\\.([A-Za-z_$][\\w$]*)\\s*(===?|!==?)\\s*([0-9]+|true|false|["'][^"']*["'])$`, "i"),
    );
    if (condition) {
      fields[pair[1]] = {
        condition: {
          path: condition[1],
          operator: /^!/.test(condition[2]) ? "notEquals" : "equals",
          value: condition[3].replace(/^["']|["']$/g, ""),
        },
        trueValue: true,
        falseValue: false,
      };
    }
  }
  return Object.keys(fields).length
    ? { transform: "base64-json", prefix, suffix, fields }
    : null;
}

function normalizeCondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = fieldPath(value.path);
  if (!path) return null;
  const operator = value.operator === "notEquals" ? "notEquals" : "equals";
  const expected = String(value.value ?? "").slice(0, 256);
  if (!expected) return null;
  return { path, operator, value: expected };
}

function normalizeValueSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = fieldPath(value.path);
  const variable = /^[A-Za-z_$][\w$]*$/.test(String(value.variable || ""))
    ? String(value.variable)
    : "";
  const condition = normalizeCondition(value.condition);
  const trueValue = value.trueValue;
  const falseValue = value.falseValue;
  if (!path && !variable && !Object.hasOwn(value, "constant") && !condition) return null;
  if (condition && (!Object.hasOwn(value, "trueValue") || !Object.hasOwn(value, "falseValue"))) return null;
  return {
    ...(path ? { path } : {}),
    ...(variable ? { variable } : {}),
    ...(Object.hasOwn(value, "constant") ? { constant: String(value.constant ?? "").slice(0, 512) } : {}),
    ...(condition ? { condition, trueValue, falseValue } : {}),
  };
}

function normalizeEncodedFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
    .map(([name, field]) => [name, normalizeValueSpec(field)])
    .filter(([, field]) => field)
    .slice(0, 16));
}

function titleField(rule, script) {
  const path = fieldPath(rule);
  if (path) {
    const field = path.split(".").at(-1);
    const assignment = String(script || "").match(new RegExp(`\\b${field}\\s*=\\s*[A-Za-z_$][\\w$]*\\.([A-Za-z_$][\\w$]*)`));
    return { path: assignment?.[1] || path };
  }
  const match = String(script || "").match(/\b(?:title|name)\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/);
  return match ? { path: match[2] } : null;
}

function filterFromScript(script) {
  const match = String(script || "").match(/\b[A-Za-z_$][\w$]*\s*\[\s*i\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*===?\s*['"]([^'"]*)['"]/);
  if (!match) return null;
  return { path: match[1], operator: "notEquals", value: match[2] };
}

function normalizeField(value, fallback = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  if (value.path && !fieldPath(value.path)) return fallback;
  const output = { ...value };
  if (output.template && String(output.template).length > MAX_TEMPLATE_LENGTH) return fallback;
  if (output.prefix && String(output.prefix).length > MAX_TEMPLATE_LENGTH) return fallback;
  if (output.suffix && String(output.suffix).length > MAX_TEMPLATE_LENGTH) return fallback;
  if (output.transform && !["base64", "base64-json", "aes-base64", "aes-base64-data"].includes(String(output.transform))) return fallback;
  if (["aes-base64", "aes-base64-data"].includes(String(output.transform))) {
    if (typeof output.key !== "string" || output.key.length < 8 || output.key.length > 64
      || typeof output.iv !== "string" || output.iv.length < 8 || output.iv.length > 64
      || output.keyMode !== "raw" || output.ivEncoding !== "utf8") return fallback;
    output.key = output.key.slice(0, 64);
    output.iv = output.iv.slice(0, 64);
    output.padding = "pkcs5";
    output.encoding = "base64";
  }
  if (output.transform === "aes-base64-data") {
    if (output.prefix && String(output.prefix).length > MAX_TEMPLATE_LENGTH) return fallback;
    if (output.suffix && String(output.suffix).length > MAX_TEMPLATE_LENGTH) return fallback;
    output.stripOrigin = output.stripOrigin === true;
  }
  if (output.transform === "base64-json") {
    output.fields = normalizeEncodedFields(output.fields);
    if (!Object.keys(output.fields).length) return fallback;
  }
  if (output.conditional) {
    const condition = normalizeCondition(output.conditional.condition);
    const whenTrue = normalizeField(output.conditional.whenTrue);
    const whenFalse = normalizeField(output.conditional.whenFalse);
    if (!condition || !whenTrue || !whenFalse) return fallback;
    output.conditional = { condition, whenTrue, whenFalse };
  }
  return output;
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["json-chapters", "encrypted-json-chapters", "json-chapters-batch", "json-chapters-pages", "json-chapters-hosts", "des-json-chapters", "qd-json-chapters"].includes(value.kind)) {
    throw new TypeError("章节目录计划无效");
  }
  const kind = value.kind;
  const input = value.input === "value" ? "value" : "url";
  const request = value.request && typeof value.request === "object" ? value.request : {};
  const method = String(request.method || "GET").toUpperCase();
  if (!/^(?:GET|POST)$/.test(method) || !String(request.urlTemplate || "")) throw new TypeError("章节目录请求无效");
  const output = value.output && typeof value.output === "object" ? value.output : {};
  const title = normalizeField(output.title);
  const url = normalizeField(output.url);
  const grouped = output.grouped && typeof output.grouped === "object" ? output.grouped : null;
  if (["json-chapters", "json-chapters-batch", "json-chapters-pages", "json-chapters-hosts", "des-json-chapters"].includes(kind) && (!title || !url)) throw new TypeError("章节目录字段无效");
  if (kind === "encrypted-json-chapters" && (!grouped || !fieldPath(grouped.groupPath)
    || !fieldPath(grouped.chapterPath) || !fieldPath(grouped.chapterTitlePath)
    || !fieldPath(grouped.chapterIdPath))) throw new TypeError("加密章节目录字段无效");
  const host = /^https?:\/\//i.test(String(value.host || "")) ? String(value.host).slice(0, 2_048) : "";
  const variables = {};
  for (const [name, variable] of Object.entries(value.variables || {})) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || typeof variable !== "string") continue;
    if (kind === "encrypted-json-chapters" || /^https?:\/\//i.test(variable)) variables[name] = variable.slice(0, 2_048);
  }
  const extractors = Array.isArray(value.extractors)
    ? value.extractors.map((item) => {
      const safe = safeRegex(item?.pattern, item?.flags);
      return safe && /^[A-Za-z_$][\w$]*$/.test(String(item?.name || ""))
        ? { name: item.name, ...safe, group: Math.max(1, Number(item.group) || 1) }
        : null;
    }).filter(Boolean)
    : [];
  const decodedFields = {};
  for (const [name, mode] of Object.entries(value.decodedFields || {})) {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && ["whole", "first", "json"].includes(mode)) decodedFields[name] = mode;
  }
  const filter = value.filter && fieldPath(value.filter.path)
    ? { path: fieldPath(value.filter.path), operator: value.filter.operator === "equals" ? "equals" : "notEquals", value: String(value.filter.value ?? "") }
    : null;
  const batchSource = kind === "json-chapters-batch" && value.batch && typeof value.batch === "object"
    ? value.batch
    : null;
  const batchUrlTemplate = String(batchSource?.urlTemplate || "").trim();
  const batchInputPath = fieldPath(batchSource?.inputPath);
  const batchResponsePath = String(batchSource?.responsePath || "").trim().replace(/\s+/g, "");
  const batchIdRegex = safeRegex(batchSource?.idPattern || "");
  const batchIdGroup = Math.max(0, Math.min(8, Number(batchSource?.idGroup) || 0));
  if (kind === "json-chapters-batch" && (!batchSource || !batchUrlTemplate || !batchInputPath || !batchIdRegex)) {
    throw new TypeError("批量章节目录请求不完整");
  }
  const paginationSource = kind === "json-chapters-pages" && value.pagination && typeof value.pagination === "object"
    ? value.pagination
    : null;
  const paginationResponsePath = fieldPath(paginationSource?.responsePath);
  const paginationTotalPath = fieldPath(paginationSource?.totalPath);
  const paginationMaxPages = Math.max(1, Math.min(500, Number(paginationSource?.maxPages) || 200));
  if (kind === "json-chapters-pages" && (!paginationSource || !paginationResponsePath || !paginationTotalPath)) {
    throw new TypeError("分页章节目录请求不完整");
  }
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
    ? Object.fromEntries(Object.entries(request.payload)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const qd = kind === "qd-json-chapters" && value.qd && typeof value.qd === "object" ? value.qd : null;
  const qdEndpoint = String(qd?.endpoint || "").trim();
  const qdPath = String(qd?.path || "").trim();
  const qdSignKey = String(qd?.signKey || "");
  const qdSignIv = String(qd?.signIv || "");
  const qdInfoKey = String(qd?.infoKey || "");
  if (kind === "qd-json-chapters" && (!qd
    || !/^https?:\/\/[^/]+\/argus\/api\/?$/i.test(qdEndpoint)
    || !/^[A-Za-z0-9._/-]+$/.test(qdPath)
    || qdSignKey.length !== 24
    || qdSignIv.length !== 8
    || qdInfoKey.length !== 24)) {
    throw new TypeError("QD 章节目录计划不完整");
  }
  const desCrypto = kind === "des-json-chapters" && value.crypto && typeof value.crypto === "object"
    ? value.crypto
    : null;
  const desResponsePath = kind === "des-json-chapters" ? fieldPath(value.responsePath) : "";
  const desNestedPath = kind === "des-json-chapters" ? fieldPath(value.nestedPath || "") : "";
  const desContentPath = kind === "des-json-chapters" ? fieldPath(value.contentPath) : "";
  if (kind === "des-json-chapters") {
    if (!desCrypto
      || typeof desCrypto.key !== "string" || desCrypto.key.length !== 8
      || typeof desCrypto.md5Key !== "string" || desCrypto.md5Key.length < 1 || desCrypto.md5Key.length > 512
      || !/^[A-Za-z_$][\w$]*$/.test(String(desCrypto.command || ""))
      || !desResponsePath || !desContentPath || !Object.keys(payload).length) {
      throw new TypeError("DES 章节目录计划不完整");
    }
    if (method !== "POST") throw new TypeError("DES 章节目录必须使用 POST");
    desCrypto.command = String(desCrypto.command);
    desCrypto.key = desCrypto.key.slice(0, 8);
    desCrypto.md5Key = desCrypto.md5Key.slice(0, 512);
  }
  const candidateSource = kind === "json-chapters-hosts" && Array.isArray(value.candidates)
    ? value.candidates
    : [];
  const candidates = candidateSource.map((item) => {
    const urlTemplate = String(item?.urlTemplate || "").trim();
    const key = typeof item?.key === "string" ? item.key.slice(0, 64) : "";
    if (!urlTemplate || urlTemplate.length > MAX_TEMPLATE_LENGTH || key.length < 8) return null;
    return {
      urlTemplate,
      key,
      headers: safeHeaders(item?.headers || {}),
    };
  }).filter(Boolean).slice(0, 32);
  if (kind === "json-chapters-hosts" && !candidates.length) throw new TypeError("章节目录候选地址无效");
  const encryptedCrypto = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  if (kind === "encrypted-json-chapters") {
    const validCrypto = (item) => item && typeof item === "object"
      && typeof item.key === "string" && item.key.length > 0 && item.key.length <= 512
      && ["raw", "sha256"].includes(String(item.keyMode || "raw"))
      && typeof item.iv === "string" && ["hex", "base64", "utf8"].includes(String(item.ivEncoding || "hex"))
      && ["pkcs5", "zero"].includes(String(item.padding || "pkcs5"))
      && ["base64", "hex"].includes(String(item.encoding || "base64"));
    if (!Object.keys(payload).length || !validCrypto(encryptedCrypto?.request) || !validCrypto(encryptedCrypto?.response)) {
      throw new TypeError("加密章节目录请求不完整");
    }
    encryptedCrypto.request.keyMode = String(encryptedCrypto.request.keyMode || "raw");
    encryptedCrypto.response.keyMode = String(encryptedCrypto.response.keyMode || "raw");
    encryptedCrypto.request.ivEncoding = String(encryptedCrypto.request.ivEncoding || "hex");
    encryptedCrypto.response.ivEncoding = String(encryptedCrypto.response.ivEncoding || "hex");
    encryptedCrypto.request.padding = String(encryptedCrypto.request.padding || "pkcs5");
    encryptedCrypto.response.padding = String(encryptedCrypto.response.padding || "pkcs5");
    encryptedCrypto.request.encoding = String(encryptedCrypto.request.encoding || "base64");
    encryptedCrypto.response.encoding = String(encryptedCrypto.response.encoding || "base64");
    encryptedCrypto.request.envelope = ["form", "json"].includes(String(encryptedCrypto.request.envelope || "form"))
      ? String(encryptedCrypto.request.envelope || "form") : "form";
    encryptedCrypto.request.envelopeField = /^[A-Za-z_$][\w$]*$/.test(String(encryptedCrypto.request.envelopeField || "secret_content"))
      ? String(encryptedCrypto.request.envelopeField || "secret_content") : "secret_content";
  }
  return {
    version: 1,
    kind,
    host,
    input,
    decode: ["base64", "hex"].includes(value.decode) ? value.decode : "",
    variables,
    extractors,
    decodedFields,
    rowFields: Object.fromEntries(Object.entries(value.rowFields || {})
      .filter(([name, path]) => /^[A-Za-z_$][\w$]*$/.test(name) && fieldPath(path))
      .map(([name, path]) => [name, fieldPath(path)])),
    headers: safeHeaders({ ...(value.headers || {}), ...(request.headers || {}) }),
    request: {
      method,
      urlTemplate: String(request.urlTemplate).slice(0, MAX_TEMPLATE_LENGTH),
      ...(request.bodyTemplate ? { bodyTemplate: String(request.bodyTemplate).slice(0, MAX_TEMPLATE_LENGTH) } : {}),
      ...(kind === "encrypted-json-chapters" || kind === "des-json-chapters" ? { payload } : {}),
    },
    responsePath: String(value.responsePath || "").replace(/\s+/g, ""),
    output: {
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(output.updateTime ? { updateTime: normalizeField(output.updateTime) } : {}),
      ...(grouped ? {
        grouped: {
          groupPath: fieldPath(grouped.groupPath),
          chapterPath: fieldPath(grouped.chapterPath),
          chapterTitlePath: fieldPath(grouped.chapterTitlePath),
          chapterIdPath: fieldPath(grouped.chapterIdPath),
          divisionPath: fieldPath(grouped.divisionPath || ""),
          divisionIdPath: fieldPath(grouped.divisionIdPath || ""),
          divisionNamePath: fieldPath(grouped.divisionNamePath || ""),
        },
      } : {}),
    },
    ...(filter ? { filter } : {}),
    ...(kind === "json-chapters-batch" ? {
      batch: {
        urlTemplate: batchUrlTemplate.slice(0, MAX_TEMPLATE_LENGTH),
        inputPath: batchInputPath,
        ...(batchResponsePath ? { responsePath: batchResponsePath } : {}),
        idPattern: batchIdRegex.pattern,
        idFlags: batchIdRegex.flags,
        idGroup: batchIdGroup,
      },
    } : {}),
    ...(kind === "json-chapters-pages" ? {
      pagination: {
        responsePath: paginationResponsePath,
        totalPath: paginationTotalPath,
        maxPages: paginationMaxPages,
      },
    } : {}),
    ...(kind === "json-chapters-hosts" ? { candidates } : {}),
    ...(kind === "encrypted-json-chapters" ? { crypto: encryptedCrypto } : {}),
    ...(kind === "des-json-chapters" ? {
      crypto: {
        key: desCrypto.key,
        md5Key: desCrypto.md5Key,
        command: desCrypto.command,
      },
      responsePath: desResponsePath,
      ...(desNestedPath ? { nestedPath: desNestedPath } : {}),
      contentPath: desContentPath,
    } : {}),
    ...(kind === "qd-json-chapters" ? {
      qd: {
        endpoint: qdEndpoint.slice(0, MAX_TEMPLATE_LENGTH),
        path: qdPath.slice(0, MAX_TEMPLATE_LENGTH),
        signKey: qdSignKey,
        signIv: qdSignIv,
        infoKey: qdInfoKey,
        infoIv: "",
      },
    } : {}),
  };
}

function desLiteral(source, name, fallback = "") {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source || "").match(new RegExp(
    `\\b(?:var|let|const)\\s+${escaped}\\s*=\\s*(?:[^;\\n]*?\\|\\|\\s*)?(["'])([^"']*)\\1`,
    "i",
  ));
  return match ? match[2] : fallback;
}

function desRequestFieldValue(expression) {
  const source = String(expression || "").trim();
  if (/^Date\.now\s*\(\s*\)$/i.test(source)) return "{{timeStamp}}";
  if (/^(?:result|baseUrl|url|bookId|resourceId)$/i.test(source)) return "{{resourceId}}";
  if (/^(?:true|false)$/i.test(source)) return source.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return Number(source);
  const quoted = literalValue(source);
  return quoted === null ? "" : quoted;
}

function desRequestPayload(script) {
  const match = String(script || "").match(
    /\b(?:var|let|const)\s+data\s*=\s*\{([\s\S]*?)\}\s*;\s*getPostUrl\s*\(/i,
  );
  if (!match) return null;
  const payload = {};
  for (const part of splitTopLevel(match[1])) {
    const pair = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+?)\s*$/);
    if (!pair) return null;
    const value = desRequestFieldValue(pair[2]);
    if (value === "") return null;
    payload[pair[1]] = value;
  }
  return payload.timeStamp === "{{timeStamp}}" && payload.resourceId === "{{resourceId}}"
    ? payload
    : null;
}

function compileQdChapterCatalog(rules, { host = "", headers = {}, jsLib = "" } = {}) {
  const script = embeddedScriptRule(rules?.chapterList);
  if (!script || !/\bQDSign\s*\(/i.test(script) || !/chapterlist\/chapterlist/i.test(script)) return null;
  const path = script.match(/\bQDSign\s*\(\s*(["'])([^"']+)\1\s*,/i)?.[2] || "";
  const config = qdCryptoConfig(jsLib);
  if (!path || !config) return null;
  const endpoint = qdApiEndpoint(jsLib);
  try {
    return normalizePlan({
      kind: "qd-json-chapters",
      host,
      input: "value",
      headers,
      request: { method: "GET", urlTemplate: endpoint, headers },
      responsePath: "Data",
      qd: { endpoint, path, ...config },
    });
  } catch {
    return null;
  }
}

function compileDesChapterCatalog(rules, { host = "", headers = "", contentRule = "", requestRule = "" } = {}) {
  const rawCatalogue = String(rules?.chapterList || "");
  const cataloguePrefix = rawCatalogue.split(/(?:<js>|@js:)/i, 1)[0];
  const catalogueScript = embeddedScriptRule(rules?.chapterList);
  const requestScript = embeddedScriptRule(requestRule);
  const script = [catalogueScript, requestScript].filter(Boolean).join("\n");
  if (!catalogueScript || !requestScript
    || !/CryptoJS\.DES\.encrypt\s*\(/i.test(script)
    || !/CryptoJS\.mode\.ECB/i.test(script)
    || !/CryptoJS\.pad\.Pkcs7/i.test(script)
    || !/\bfunction\s+getPostUrl\s*\(/i.test(script)
    || !/\bgetPostUrl\s*\(\s*data\s*,/i.test(script)) return null;
  const endpoint = script.match(/\b(?:var|let|const)\s+url\s*=\s*(["'])(https?:\/\/[^"']+)\1/i)?.[2]
    ?.replace(/,+$/, "") || "";
  const key = desLiteral(script, "deskey");
  const md5Key = script.match(/\bmd5Key\s*=\s*(["'])([^"']+)\1/i)?.[2] || "";
  const command = script.match(/\bgetPostUrl\s*\(\s*data\s*,\s*(["'])([A-Za-z_$][\w$]*)\1/i)?.[2] || "";
  const payload = desRequestPayload(script);
  const title = actionFieldRule(rules?.chapterName);
  const contentSource = String(contentRule || "").split(/@js:/i, 1)[0];
  const contentMembers = [...contentSource.matchAll(/(?:^|\.)\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  const contentPath = contentMembers.at(-1) || "content";
  const responsePath = cataloguePrefix.match(/\$\.([A-Za-z_$][\w$]*)\s*\[\s*\d+\s*\]/)?.[1] || "returnObject";
  const nestedPath = /\$\.[A-Za-z_$][\w$]*\s*\[\s*\d+\s*\]\s*\.([A-Za-z_$][\w$]*)/i.test(cataloguePrefix)
    ? cataloguePrefix.match(/\$\.[A-Za-z_$][\w$]*\s*\[\s*\d+\s*\]\s*\.([A-Za-z_$][\w$]*)/i)?.[1] || ""
    : "";
  if (!endpoint || !key || !md5Key || !command || !payload || !title) return null;
  try {
    return normalizePlan({
      kind: "des-json-chapters",
      host,
      input: "value",
      request: {
        method: "POST",
        urlTemplate: endpoint,
        payload,
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      },
      responsePath,
      ...(nestedPath ? { nestedPath } : {}),
      contentPath,
      output: {
        title,
        url: { path: contentPath },
      },
      crypto: { key, md5Key, command },
    });
  } catch {
    return null;
  }
}

export function compileChapterCatalogPlan(rules, {
  host = "",
  headers = {},
  jsLib = "",
  tocUrl = "",
  sourceComment = "",
  contentRule = "",
  requestRule = "",
} = {}) {
  const script = String(rules?.chapterList || "").replace(/^\s*(?:@js:|<js>)\s*/i, "").replace(/\s*<\/js>\s*$/i, "");
  const pagedPlan = compilePagedChapterCatalog(rules, { host, headers });
  if (pagedPlan) return pagedPlan;
  const batchPlan = compileBatchChapterCatalog(rules, { host, headers, tocUrl });
  if (batchPlan) return batchPlan;
  const hostPlan = compileHostCandidateChapterCatalog(rules, { host, headers, sourceComment });
  if (hostPlan) return hostPlan;
  const qdPlan = compileQdChapterCatalog(rules, { host, headers, jsLib });
  if (qdPlan) return qdPlan;
  const desPlan = compileDesChapterCatalog(rules, { host, headers, contentRule, requestRule });
  if (desPlan) return desPlan;
  // A JSON catalogue can be completely declarative while its chapter URL is
  // still produced by a bounded Android helper (for example AES-CBC Base64
  // decoding). Compile that combination before requiring a java.ajax call;
  // the catalogue request itself is simply the current detail/toc URL.
  const simpleList = actionListPath(rules?.chapterList).replace(/\[\*\]$/, "");
  const simpleTitle = actionFieldRule(rules?.chapterName);
  const simpleUrl = actionFieldRule(rules?.chapterUrl, { url: true });
  if (simpleList && simpleTitle && simpleUrl && simpleUrl.transform === "aes-base64") {
    try {
      return normalizePlan({
        kind: "json-chapters",
        host,
        input: "url",
        headers,
        request: { method: "GET", urlTemplate: "{{baseUrl}}", headers },
        responsePath: simpleList,
        output: { title: simpleTitle, url: simpleUrl },
      });
    } catch { /* continue with the script recognizers below */ }
  }
  if (!script || !/\bjava\.(?:post|ajax|get)\s*\(/i.test(script)) {
    return null;
  }

  // The API wrapper used by several public sources sends an encrypted JSON
  // request and returns encrypted grouped chapters.  Recognize the stable
  // data flow (hex/base64 book id -> URL(path, params) -> AES response) and
  // expose it as a bounded grouped catalogue plan.
  const encryptedApi = /java\.hexDecodeToString\s*\(\s*result\s*\)/i.test(script)
    && /\bURL\s*\(\s*["'`][^"'`]+["'`]/i.test(script)
    && /decrypt\s*\(\s*java\.ajax\s*\(/i.test(script)
    && /\bsecretKey\s*=\s*["'][^"']+["']/i.test(jsLib)
    && /\bBASEURL\s*:\s*["']https?:\/\//i.test(jsLib)
    && /chapter_list_group/i.test(script);
  if (encryptedApi) {
    const path = script.match(/\bURL\s*\(\s*["'`]([^"'`]+)["'`]/i)?.[1] || "";
    const base = jsLib.match(/\bBASEURL\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1] || host;
    const key = jsLib.match(/\bsecretKey\s*=\s*["']([^"']{8,512})["']/i)?.[1] || "";
    const appSignature = jsLib.match(/\bapp_signature_md5\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const appVersion = jsLib.match(/\bapp_version\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const channel = jsLib.match(/\bchannel\s*:\s*["']([^"']*)["']/i)?.[1] || "";
    const userAgent = jsLib.match(/\bUserAgent\s*:\s*["']([^"']*)["']/i)?.[1] || "Android";
    if (path && base && key) {
      const endpoint = /^https?:\/\//i.test(path) ? path : `${String(base).replace(/\/$/, "")}/${path.replace(/^\/+/, "")}`;
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
          kind: "encrypted-json-chapters",
          host: base,
          input: "value",
          decode: "base64",
          decodedFields: { bookid: "whole" },
          request: {
            method: "POST",
            urlTemplate: endpoint,
            payload: {
              app_signature_md5: appSignature,
              app_version: appVersion,
              channel,
              account: "",
              login_token: "",
              last_update_time: "0",
              book_id: "{{bookid}}",
            },
            headers: { ...headers, "User-Agent": userAgent, "Content-Type": "application/x-www-form-urlencoded" },
          },
          responsePath: "data.chapter_list_group",
          output: {
            grouped: {
              groupPath: "data.chapter_list_group",
              chapterPath: "chapter_list",
              chapterTitlePath: "chapter_title",
              chapterIdPath: "chapter_id",
              divisionPath: "data.division_list",
              divisionIdPath: "division_id",
              divisionNamePath: "division_name",
            },
          },
          crypto,
        });
      } catch { /* continue with ordinary JSON recognizers */ }
    }
  }
  const constants = staticConstants(jsLib);
  const extractors = inputExtractors(script);
  const decode = /(?:java\.)?base64Decode(?:ToString)?\s*\(\s*baseUrl\s*\.\s*split\s*\(/i.test(script)
    ? "base64"
    : /(?:java\.)?hexDecodeToString\s*\(/i.test(script) ? "hex" : "";
  const input = decode ? "value" : "url";
  const aliases = rowAliases(script);
  const allowed = new Set([
    ...extractors.map((item) => item.name),
    ...Object.keys(aliases),
    "bid", "bookId", "cid", "chapterId", "page", "id", "entityId",
  ]);
  const request = requestPlan(script, allowed, constants, headers);
  if (!request) {
    return null;
  }
  const nested = nestedJsonMapShape(script);
  const responsePath = nested?.responsePath || jsonPathFromScript(script);
  if (!responsePath) {
    return null;
  }
  if (!/^(?:https?:\/\/|\/|\{\{(?:host|backend|baseUrl)\}\})/i.test(request.urlTemplate)
    || /,\s*[{'\"]/.test(request.urlTemplate)) return null;
  const title = nested?.title || titleField(rules?.chapterName, script);
  const directUrl = fieldPath(rules?.chapterUrl);
  const generatedUrl = nested
    ? encodedObjectUrlField(script, nested.row)
      || nestedUrlAssignment(script, nested.row, allowed, constants)
    : generatedUrlField(script, allowed, constants, aliases);
  if (!generatedUrl && /\.(?:map|reduce|forEach)\s*\(/i.test(script)) return null;
  const url = generatedUrl || (directUrl ? { path: directUrl } : null);
  if (!title || !url) {
    return null;
  }
  const decodedFields = {};
  if (decode) {
    for (const match of script.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:java\.)?(?:base64Decode(?:ToString)?|hexDecodeToString)\s*\(/gi)) {
      decodedFields[match[1]] = "whole";
    }
    if (!Object.keys(decodedFields).length) return null;
  }
  const plan = {
    kind: "json-chapters",
    host,
    input,
    decode,
    variables: Object.fromEntries(Object.entries(constants)),
    extractors,
    decodedFields,
    rowFields: aliases,
    headers,
    request,
    responsePath,
    output: {
      title,
      url,
      ...(nested?.updateTime
        ? (() => {
          const template = expressionTemplate(nested.updateTime.expression, new Set([nested.row]), constants);
          return template ? { updateTime: { template } } : {};
        })()
        : fieldPath(rules?.chapterUpdateTime || rules?.updateTime)
          ? { updateTime: { path: fieldPath(rules.chapterUpdateTime || rules.updateTime) } }
          : {}),
    },
    filter: filterFromScript(script),
  };
  try { return normalizePlan(plan); } catch { return null; }
}

function stripScriptRule(value) {
  return String(value || "")
    .trim()
    .replace(/^\s*(?:@js:|<js>)\s*/i, "")
    .replace(/\s*<\/js>\s*$/i, "")
    .trim();
}

function embeddedScriptRule(value) {
  const source = String(value || "").trim();
  const marker = source.search(/(?:<js>|@js:)/i);
  return stripScriptRule(marker >= 0 ? source.slice(marker) : source);
}

function assignedExpression(script, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(script || "").match(new RegExp(`\\b${escaped}\\s*=\\s*([\\s\\S]*?)(?:;|\\r?\\n|$)`, "i"))?.[1]?.trim() || "";
}

function staticUrlTemplate(expression, variable, replacement) {
  const template = expressionTemplate(expression, new Set([variable]), {});
  const marker = `{{${variable}}}`;
  if (!template || !/^https?:\/\//i.test(template) || !template.includes(marker)) return "";
  return template.replaceAll(marker, `{{${replacement}}}`);
}

function chapterUrlAssignment(script, field) {
  const escaped = String(field || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:\\b[A-Za-z_$][\\w$]*\\s*\\[\\s*i\\s*\\]|\\b[A-Za-z_$][\\w$]*)\\s*(?:\\.\\s*${escaped}|\\[\\s*["']${escaped}["']\\s*\\])\\s*=\\s*([^;\\n]+)`,
    "gi",
  );
  for (const match of String(script || "").matchAll(pattern)) {
    const parts = splitTopLevel(match[1], "+");
    const prefix = literalValue(parts[0]);
    const rest = parts.slice(1).join("+");
    const dynamic = rest.match(/(?:\.\s*([A-Za-z_$][\w$]*)\b|\[\s*["']([A-Za-z_$][\w$]*)["']\s*\])/);
    if (typeof prefix === "string" && /^https?:\/\//i.test(prefix) && dynamic) {
      return `${prefix}{{${dynamic[1] || dynamic[2]}}}`;
    }
    if (typeof prefix === "string" && /^https?:\/\//i.test(prefix)
      && (new RegExp(`(?:\\.${escaped}\\b|\\[\\s*["']${escaped}["']\\s*\\])`)).test(rest)) {
      return `${prefix}{{${field}}}`;
    }
  }
  return "";
}

function batchRequestDescriptor(script) {
  const source = String(script || "");
  for (const match of source.matchAll(/\bjava\.ajax\s*\(/gi)) {
    if (match.index === undefined) continue;
    const args = splitTopLevel(matchingCall(source, match.index));
    const parts = splitTopLevel(args[0], "+");
    const prefix = literalValue(parts[0]);
    const expression = parts.slice(1).join("+");
    if (typeof prefix !== "string" || !/^https?:\/\//i.test(prefix) || !/\bresult\s*\[/.test(expression)) continue;
    const idField = expression.match(/(?:\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]|\.\s*([A-Za-z_$][\w$]*))\s*\.\s*match\s*\(/i);
    const idMatch = expression.match(/\.\s*match\s*\(\s*\/(.*)\/([dgimsuvy]*)\s*\)\s*\[\s*(\d+)\s*\]/i);
    const safe = safeRegex(idMatch?.[1], idMatch?.[2]);
    if (!idField || !idMatch || !safe) continue;
    return {
      urlTemplate: `${prefix}{{collectionId}}`,
      inputPath: idField[1] || idField[2],
      idPattern: safe.pattern,
      idFlags: safe.flags,
      idGroup: Number(idMatch[3]),
    };
  }
  return null;
}

function pagedRequestDescriptor(script) {
  const source = String(script || "");
  const postIndex = source.search(/\bjava\.post\s*\(/i);
  if (postIndex < 0) return null;
  const args = splitTopLevel(matchingCall(source, postIndex));
  const endpoint = literalValue(args[0]);
  const object = String(args[1] || "").match(/JSON\.stringify\s*\(\s*\{([\s\S]*)\}\s*\)/i)?.[1] || "";
  if (!endpoint || !/^https?:\/\//i.test(endpoint) || !object) return null;
  const fields = [];
  for (const part of splitTopLevel(object)) {
    const pair = part.match(/^(?:["']?)([A-Za-z_$][\w$]*)(?:["']?)\s*:\s*([\s\S]+)$/);
    if (!pair) return null;
    const name = pair[1];
    const expression = pair[2].trim();
    if (/^(?:id|bookId|book_id)$/i.test(expression)) fields.push(JSON.stringify(name) + ":{{bookId}}");
    else if (/^(?:page|pageIndex|i)$/i.test(expression)) fields.push(JSON.stringify(name) + ":{{page}}");
    else {
      const literal = literalValue(expression);
      if (literal === null && !/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(expression)) return null;
      fields.push(JSON.stringify(name) + ":" + (literal === null ? expression : JSON.stringify(literal)));
    }
  }
  if (!fields.some((item) => item.includes(":{{bookId}}"))
    || !fields.some((item) => item.includes(":{{page}}"))) return null;
  const bodyTemplate = "{" + fields.join(",") + "}";
  const totalPath = /\btotal_page\b/i.test(source) ? "data.total_page" : "";
  const responsePath = /\b(?:first|res)\.list\b/i.test(source) ? "data.list" : "";
  const pageLoop = /\bfor\s*\([^;]*=\s*2\s*;[\s\S]{0,300}?(?:total_page|totalPage)/i.test(source);
  return endpoint && bodyTemplate && totalPath && responsePath && pageLoop
    ? { endpoint, bodyTemplate, responsePath, totalPath }
    : null;
}

function compilePagedChapterCatalog(rules, { host = "", headers = {} } = {}) {
  const script = stripScriptRule(rules?.chapterList);
  if (!script || !/\bjava\.post\s*\(/i.test(script)) return null;
  const request = pagedRequestDescriptor(script);
  const title = actionFieldRule(rules?.chapterName);
  const urlField = fieldPath(rules?.chapterUrl) || actionFieldRule(rules?.chapterUrl, { url: true })?.path || "";
  const chapterUrl = chapterUrlAssignment(script, urlField);
  if (!request || !title || !urlField || !chapterUrl) return null;
  try {
    return normalizePlan({
      kind: "json-chapters-pages",
      host,
      input: "url",
      headers,
      request: {
        method: "POST",
        urlTemplate: request.endpoint,
        bodyTemplate: request.bodyTemplate,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      extractors: [{
        name: "bookId",
        pattern: ".*(?:/|=)([^/?#&]+)",
        flags: "",
        group: 1,
      }],
      responsePath: request.responsePath,
      pagination: {
        responsePath: request.responsePath,
        totalPath: request.totalPath,
        maxPages: 200,
      },
      output: {
        title,
        url: { template: chapterUrl },
        ...(actionFieldRule(rules?.chapterUpdateTime || rules?.updateTime)
          ? { updateTime: actionFieldRule(rules?.chapterUpdateTime || rules?.updateTime) }
          : {}),
      },
    });
  } catch {
    return null;
  }
}

function compileBatchChapterCatalog(rules, { host = "", headers = {}, tocUrl = "" } = {}) {
  const script = stripScriptRule(rules?.chapterList);
  if (!script || !/JSON\.parse\s*\(\s*result\s*\)/i.test(script)) return null;
  const tocExpression = assignedExpression(embeddedScriptRule(tocUrl), "result");
  const requestUrl = staticUrlTemplate(tocExpression, "result", "bookId");
  const batch = batchRequestDescriptor(script);
  const title = actionFieldRule(rules?.chapterName);
  const urlField = fieldPath(rules?.chapterUrl) || actionFieldRule(rules?.chapterUrl, { url: true })?.path || "";
  const chapterUrl = chapterUrlAssignment(script, urlField);
  if (!requestUrl || !batch || !title || !urlField || !chapterUrl) return null;
  try {
    return normalizePlan({
      kind: "json-chapters-batch",
      host,
      input: "url",
      headers,
      request: { method: "GET", urlTemplate: requestUrl, headers },
      extractors: [{
        name: "bookId",
        pattern: ".*(?:/|=)([^/?#&]+)",
        flags: "",
        group: 1,
      }],
      responsePath: "",
      output: {
        title,
        url: { template: chapterUrl },
        ...(actionFieldRule(rules?.chapterUpdateTime || rules?.updateTime)
          ? { updateTime: actionFieldRule(rules?.chapterUpdateTime || rules?.updateTime) }
          : {}),
      },
      batch,
    });
  } catch {
    return null;
  }
}

function compileHostCandidateChapterCatalog(rules, {
  host = "",
  headers = {},
  sourceComment = "",
} = {}) {
  const script = embeddedScriptRule(rules?.chapterList);
  const comment = String(sourceComment || "");
  if (!script || !/\beval\s*\(\s*String\s*\(\s*source\.bookSourceComment\s*\)\s*\)/i.test(script)
    || !/\brun\s*\(\s*["']data["']\s*\)\s*\.[A-Za-z_$][\w$]*/i.test(script)
    || !/createSymmetricCrypto\s*\(\s*["']AES\/CBC\/PKCS5Padding["']/i.test(script)
    || !/decryptStr\s*\(/i.test(script)) return null;
  const domainBlock = comment.match(/\bdomains\s*:\s*\[([\s\S]*?)\]\s*\}/i)?.[1] || "";
  const domains = [...domainBlock.matchAll(/\[\s*["']([a-z0-9.-]{2,128})["']\s*,\s*(\d+)\s*\]/gi)]
    .map((match) => ({ domain: match[1], type: Number(match[2]) || 0 }));
  const credentials = [...comment.matchAll(/\[\s*["']([0-9a-f]{8,64})["']\s*,\s*["'](bearer[^"']{8,2048})["']\s*\]/gi)]
    .map((match) => ({ key: match[1], authorization: match[2] }));
  if (!domains.length || !credentials.length) return null;
  const chapterRun = script.match(/\brun\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/i);
  const responsePath = chapterRun ? chapterRun[1] + "." + chapterRun[2] : "";
  const title = actionFieldRule(rules?.chapterName);
  const urlPath = actionFieldRule(rules?.chapterUrl, { url: true });
  if (!responsePath || !title || !urlPath?.path) return null;
  const dataType = comment.match(/\$\{\s*(?:java\.)?base64Encode\s*\(\s*Path\s*\)\s*\}\s*,\s*(\{[^\x60]{1,512}\})/i)?.[1] || "";
  const candidates = domains.map(({ domain, type }) => {
    const credential = credentials[type] || credentials[0];
    if (!credential) return null;
    const device = createHash("md5").update(credential.key, "utf8").digest("hex");
    return {
      urlTemplate: "http://api." + domain + ".com{{path}}",
      key: credential.key,
      headers: {
        ...headers,
        "client-device": device,
        Authorization: credential.authorization,
      },
    };
  }).filter(Boolean);
  if (!dataType || !candidates.length) return null;
  try {
    return normalizePlan({
      kind: "json-chapters-hosts",
      host,
      input: "value",
      decode: "base64",
      decodedFields: { path: "whole" },
      request: {
        method: "GET",
        urlTemplate: candidates[0].urlTemplate,
        headers: candidates[0].headers,
      },
      candidates,
      responsePath,
      output: {
        title,
        url: {
          path: urlPath.path,
          transform: "aes-base64-data",
          key: candidates[0].key,
          keyMode: "raw",
          iv: "0123456789abcdef",
          ivEncoding: "utf8",
          prefix: "data:;base64,",
          suffix: "," + dataType,
          stripOrigin: true,
        },
        ...(actionFieldRule(rules?.updateTime || rules?.chapterUpdateTime)
          ? { updateTime: actionFieldRule(rules.updateTime || rules.chapterUpdateTime) }
          : {}),
      },
    });
  } catch {
    return null;
  }
}

function actionFieldRule(value, { url = false } = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const template = String(value.urlTemplate || value.template || "")
      .replace(/\{\{\s*\$\.([A-Za-z_$][\w$]*)\s*\}\}/g, "{{$1}}");
    if (template) return { template };
    const path = fieldPath(value.path || value.selector);
    return path ? { path } : null;
  }
  const path = fieldPath(value);
  if (path) return { path };
  const source = stripScriptRule(value)
    .replace(/^return\s+/i, "")
    .replace(/;\s*$/, "")
    .trim();
  const sourcePath = String(value || "").match(
    /^\s*\$\.?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\n|@js:)/i,
  )?.[1] || "";
  const aes = source.match(
    /(?:java\.)?aesBase64DecodeToString\s*\(\s*result\s*,\s*(["'])([^"']{8,64})\1\s*,\s*(["'])AES\/CBC\/PKCS5Padding\3\s*,\s*(["'])([^"']{8,64})\4\s*\)/i,
  );
  if (aes) {
    return {
      selector: ".",
      ...(sourcePath ? { path: sourcePath } : {}),
      transform: "aes-base64",
      key: aes[2],
      keyMode: "raw",
      iv: aes[5],
      ivEncoding: "utf8",
      padding: "pkcs5",
      encoding: "base64",
    };
  }
  const logged = source.match(/(?:java\.)?log\s*\(\s*result\.([A-Za-z_$][\w$]*)\s*\)/i);
  if (logged && !url) return { path: logged[1] };
  const template = expressionTemplate(source, new Set(), {});
  return template ? { template } : null;
}

function actionListPath(value) {
  const source = String(value || "").trim()
    .replace(/^@json:\s*/i, "")
    .replace(/^\$\.?/, "")
    .replace(/^result\/?/i, "")
    .replace(/\//g, ".")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return source === "." ? "" : source;
}

function actionRequestPlan(requestInfo, headers) {
  const source = String(requestInfo || "");
  if (!/^@js:/i.test(source)) return null;
  const endpointLiteral = source.match(/\b(?:var|let|const)\s+endpoint\s*=\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/i)?.[1];
  const bodyLiteral = source.match(/\b(?:var|let|const)\s+body\s*=\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/i)?.[1];
  const endpoint = endpointLiteral ? literalValue(endpointLiteral) : "";
  const body = bodyLiteral ? literalValue(bodyLiteral) : "";
  if (!endpoint || !/^https?:\/\//i.test(endpoint) || body === null || body === undefined) return null;
  const fields = [];
  const bodyTemplate = String(body).replace(/\{\{?\s*\$?\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}?\}/g, (_match, path) => {
    const name = path.split(".").at(-1);
    if (!fields.includes(name)) fields.push(name);
    return `{{${name}}}`;
  });
  const extractors = fields.map((name) => ({
    name,
    pattern: "(?:^|/)([^/?#]+)$",
    flags: "",
    group: 1,
  }));
  return {
    method: /\bPOST\s*:\s*true\b/i.test(source) ? "POST" : "GET",
    urlTemplate: endpoint,
    ...(bodyTemplate ? { bodyTemplate } : {}),
    headers: {
      ...headers,
      ...(bodyTemplate && !Object.keys(headers || {}).some((name) => name.toLowerCase() === "content-type")
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    extractors,
  };
}

/**
 * Compile a JSON chapter action after the converter has already normalized its
 * requestInfo. This covers the common `bookUrl`-as-POST and generated JSON
 * menu cases where the original ruleToc itself is only a field projection.
 * It deliberately accepts only static endpoint/body literals and data fields.
 */
export function compileChapterCatalogPlanFromAction(action, { host = "", headers = {} } = {}) {
  if (!action || String(action.responseFormatType || "").toLowerCase() !== "json") return null;
  const request = actionRequestPlan(action.requestInfo, { ...headers, ...(action.httpHeaders || {}) });
  if (!request) return null;
  const title = actionFieldRule(action.title);
  const url = actionFieldRule(action.url, { url: true });
  if (!title || !url) return null;
  const responsePath = actionListPath(action.list);
  const plan = {
    kind: "json-chapters",
    host,
    input: "url",
    extractors: request.extractors,
    request: {
      method: request.method,
      urlTemplate: request.urlTemplate,
      ...(request.bodyTemplate ? { bodyTemplate: request.bodyTemplate } : {}),
      headers: request.headers,
    },
    responsePath,
    output: {
      title,
      url,
      ...(actionFieldRule(action.updateTime) ? { updateTime: actionFieldRule(action.updateTime) } : {}),
    },
  };
  try { return normalizePlan(plan); } catch { return null; }
}

export function encodeChapterCatalogPlan(plan) {
  const normalized = normalizePlan(plan);
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  if (encoded.length > MAX_PLAN_BYTES * 2) throw new TypeError("章节目录计划过大");
  return encoded;
}

export function decodeChapterCatalogPlan(encoded) {
  const value = String(encoded || "");
  if (!value || value.length > MAX_PLAN_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("章节目录计划编码无效");
  }
  try { return normalizePlan(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("章节目录计划不是有效 JSON");
  }
}

function decodeInput(value, mode) {
  let encoded = String(value || "");
  if (/^data:[^,]*,/i.test(encoded)) encoded = encoded.slice(encoded.indexOf(",") + 1).split(",", 1)[0];
  encoded = encoded.replace(/\s+/g, "");
  try {
    if (mode === "base64") return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (mode === "hex" && /^[\da-f]+$/i.test(encoded) && encoded.length % 2 === 0) return Buffer.from(encoded, "hex").toString("utf8");
  } catch {
    return "";
  }
  return "";
}

function cryptoBytes(value, encoding) {
  try {
    if (encoding === "hex" && /^[\da-f]+$/i.test(String(value || "")) && String(value).length % 2 === 0) return Buffer.from(String(value), "hex");
    if (encoding === "base64") return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (encoding === "utf8") return Buffer.from(String(value || ""), "utf8");
  } catch { /* invalid source configuration */ }
  return null;
}

function encryptDesEcb(value, key) {
  const textKey = Buffer.from(String(key || ""), "utf8");
  if (textKey.length !== 8) return "";
  try {
    const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([textKey, textKey, textKey]), null);
    return Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]).toString("base64");
  } catch {
    return "";
  }
}

function resourceIdFromInput(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object") {
      for (const name of ["resourceId", "resId", "bookId", "book_id", "id"]) {
        if (parsed[name] !== undefined && parsed[name] !== null && String(parsed[name]).trim()) return String(parsed[name]).trim();
      }
    }
  } catch { /* the chapter bridge normally passes a scalar or URL */ }
  if (/^data:[^,]*,/i.test(source)) {
    const encoded = source.slice(source.indexOf(",") + 1).split(",", 1)[0];
    try {
      const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (decoded && decoded !== source) return resourceIdFromInput(decoded);
    } catch { /* continue with the opaque value */ }
  }
  try {
    const parsed = new URL(source);
    for (const name of ["resourceId", "resId", "bookId", "book_id", "id"]) {
      const candidate = parsed.searchParams.get(name);
      if (candidate) return candidate;
    }
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (segment) return decodeURIComponent(segment);
  } catch { /* an opaque source id is valid */ }
  return source;
}

function aesConfigBytes(config) {
  let key = Buffer.from(String(config?.key || ""), "utf8");
  if (config?.keyMode === "sha256") key = createHash("sha256").update(key).digest();
  const iv = cryptoBytes(config?.iv, config?.ivEncoding);
  if (!iv || iv.length !== 16 || ![16, 24, 32].includes(key.length)) return null;
  return { key, iv };
}

function encryptAes(value, config) {
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

function decryptAes(value, config) {
  const bytes = aesConfigBytes(config);
  const encrypted = config.encoding === "hex" ? cryptoBytes(value, "hex") : cryptoBytes(value, "base64");
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

function expandPayload(value, variables) {
  if (typeof value === "string") return value.replace(/\{\{([A-Za-z_$][\w$]*)\}\}/g, (_match, name) => String(variables[name] ?? ""));
  if (Array.isArray(value)) return value.map((item) => expandPayload(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expandPayload(item, variables)]));
  return value;
}

function expand(template, values) {
  return String(template || "").replace(/\{\{([A-Za-z_$][\w$]*)\}\}/g, (_match, name) => String(values[name] ?? ""));
}

function outputValue(field, row, values, plan) {
  if (!field || typeof field !== "object") return "";
  if (field.conditional) {
    const { condition, whenTrue, whenFalse } = field.conditional;
    const current = jsonPathValue(row, condition.path);
    const matched = condition.operator === "equals"
      ? String(current ?? "") === condition.value
      : String(current ?? "") !== condition.value;
    return outputValue(matched ? whenTrue : whenFalse, row, values, plan);
  }
  if (field.transform === "aes-base64") {
    const encrypted = field.path ? jsonPathValue(row, field.path) : row;
    return decryptAes(encrypted, field).trim();
  }
  if (field.transform === "aes-base64-data") {
    const encrypted = field.path ? jsonPathValue(row, field.path) : row;
    let decoded = decryptAes(encrypted, field).trim();
    if (field.stripOrigin) {
      try {
        const parsed = new URL(decoded);
        decoded = parsed.pathname + parsed.search + parsed.hash;
      } catch {
        decoded = decoded.replace(/^https?:\/\/[^/]+/i, "");
      }
    }
    return String(field.prefix || "")
      + Buffer.from(decoded, "utf8").toString("base64")
      + String(field.suffix || "");
  }
  if (field.path) return String(jsonPathValue(row, field.path) ?? "").trim();
  if (field.transform === "base64-json") {
    const object = {};
    for (const [name, spec] of Object.entries(field.fields || {})) {
      if (spec.condition) {
        const current = jsonPathValue(row, spec.condition.path);
        const matched = spec.condition.operator === "equals"
          ? String(current ?? "") === spec.condition.value
          : String(current ?? "") !== spec.condition.value;
        object[name] = matched ? spec.trueValue : spec.falseValue;
      } else if (spec.path) object[name] = jsonPathValue(row, spec.path);
      else if (spec.variable) object[name] = values[spec.variable] ?? "";
      else object[name] = spec.constant ?? "";
    }
    return `${field.prefix || ""}${Buffer.from(JSON.stringify(object), "utf8").toString("base64")}${field.suffix || ""}`;
  }
  if (!field.template) return "";
  const inner = expand(field.template, { ...values, ...row });
  if (field.transform === "base64") {
    return `${field.prefix || ""}${Buffer.from(inner, "utf8").toString("base64")}${field.suffix || ""}`;
  }
  return expand(field.template, { ...values, ...row });
}

function absoluteChapterUrl(value, baseUrl, host) {
  const source = String(value || "").trim();
  if (!source || /^data:/i.test(source)) return source;
  try { return new URL(source, baseUrl || host || undefined).toString(); } catch { return ""; }
}

function mapChapterRows(rows, plan, variables, baseUrl) {
  const data = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (!row || typeof row !== "object") continue;
    if (plan.filter) {
      const current = String(jsonPathValue(row, plan.filter.path) ?? "");
      if (plan.filter.operator === "equals" ? current !== plan.filter.value : current === plan.filter.value) continue;
    }
    const rowValues = { ...row };
    for (const [name, path] of Object.entries(plan.rowFields || {})) {
      rowValues[name] = jsonPathValue(row, path);
    }
    const local = { ...variables, ...rowValues };
    const title = outputValue(plan.output.title, row, local, plan);
    let url = outputValue(plan.output.url, row, local, plan);
    url = absoluteChapterUrl(url, baseUrl, plan.host);
    if (!title || !url) continue;
    const mapped = { title, url };
    if (plan.output.updateTime) mapped.updateTime = outputValue(plan.output.updateTime, row, local, plan);
    data.push(mapped);
  }
  return data;
}

function qdNetworkQuery(query) {
  return String(query || "").split("&").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return encodeURIComponent(part);
    return encodeURIComponent(part.slice(0, separator)) + "=" + encodeURIComponent(part.slice(separator + 1));
  }).join("&");
}

/** Execute a safe, one-request JSON catalogue plan without source JavaScript. */
export async function executeChapterCatalogPlan(planValue, {
  sourceUrl = "",
  value = "",
  download,
  signal,
} = {}) {
  const plan = normalizePlan(planValue);
  if (typeof download !== "function") throw new TypeError("章节目录计划需要下载器");
  const input = String(value || sourceUrl || "");
  if (!input) throw new Error("章节目录输入为空");
  const baseUrl = plan.input === "url" ? input : plan.host;
  const variables = { ...plan.variables, host: plan.host, baseUrl };
  if (plan.kind === "qd-json-chapters") {
    const bookId = qdBookIdFromInput(input);
    if (!bookId) throw new Error("QD 章节目录书籍 ID 为空");
    const params = ["bookId=" + bookId];
    const signature = qdSignatureHeaders(params, {
      host: plan.host,
      config: plan.qd,
      timestamp: Date.now(),
    });
    if (!signature) throw new Error("QD 章节目录签名生成失败");
    const endpoint = plan.qd.endpoint.replace(/\/+$/, "") + "/" + plan.qd.path.replace(/^\/+/, "");
    const requestUrl = (() => {
      try {
        return new URL(endpoint + "?" + qdNetworkQuery(signature.query), plan.host || undefined).toString();
      } catch {
        return "";
      }
    })();
    if (!requestUrl) throw new Error("QD 章节目录请求地址无效");
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
      QDSign: signature.QDSign,
      QDInfo: signature.QDInfo,
      tstamp: signature.tstamp,
      Referer: plan.headers.Referer || plan.host,
    }, { method: "GET", ...(signal ? { signal } : {}) });
    let payload;
    try {
      payload = JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
    } catch {
      throw new Error("QD 章节目录响应不是有效 JSON");
    }
    const root = payload?.Data || payload?.data || payload;
    const volumes = Array.isArray(root?.Volumes) ? root.Volumes : (Array.isArray(root?.volumes) ? root.volumes : []);
    const chapters = Array.isArray(root?.Chapters) ? root.Chapters : (Array.isArray(root?.chapters) ? root.chapters : []);
    const volumeNames = new Map(volumes.map((item) => [String(item?.VolumeCode ?? item?.volumeCode ?? ""), String(item?.VolumeName ?? item?.volumeName ?? "")]));
    const sourceChapters = chapters.length > 1 ? chapters.slice(1) : chapters;
    const data = [];
    const groups = new Map();
    for (const chapter of sourceChapters.slice(0, MAX_ROWS)) {
      const code = String(chapter?.Vc ?? chapter?.vc ?? "");
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push(chapter);
    }
    const orderedCodes = [
      ...volumes.map((item) => String(item?.VolumeCode ?? item?.volumeCode ?? "")),
      ...[...groups.keys()].filter((code) => !volumes.some((item) => String(item?.VolumeCode ?? item?.volumeCode ?? "") === code)),
    ];
    let chapterCount = 0;
    const chapterInfoTime = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return String(value || "");
      const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
      try {
        return new Date(milliseconds + 12 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
      } catch {
        return String(value);
      }
    };
    for (const code of orderedCodes) {
      const volumeName = volumeNames.get(code) || "未知分卷";
      if (volumes.length > 1 && volumeNames.has(code)) {
        data.push({ title: volumeName, url: "", updateTime: "", isVip: false, isPay: false, isVolume: true });
      }
      for (const chapter of groups.get(code) || []) {
      const cid = chapter?.C ?? chapter?.c ?? chapter?.ChapterId ?? chapter?.chapterId;
      const title = String(chapter?.N ?? chapter?.n ?? chapter?.ChapterName ?? chapter?.chapterName ?? "").trim();
      if (cid === undefined || cid === null || !title) continue;
      const bookPayload = {
        source: "qd",
        cid,
        isVip: Number(chapter?.V ?? chapter?.v ?? chapter?.IsVip ?? chapter?.isVip) === 1 || chapter?.isVip === true,
        isPay: Number(chapter?.P ?? chapter?.p ?? chapter?.IsPay ?? chapter?.isPay) === 1 || chapter?.isPay === true,
        ccid: null,
        cbid: null,
        bookId,
      };
      const encoded = Buffer.from(JSON.stringify(bookPayload), "utf8").toString("base64");
      const mapped = { title, url: "data:chapterId;base64," + encoded + ",{\"type\":\"ywc\"}" };
      const updateTime = chapter?.T ?? chapter?.t ?? chapter?.UpdateTime ?? chapter?.updateTime;
      const wordCount = chapter?.W ?? chapter?.w;
      mapped.updateTime = [volumeName, chapterInfoTime(updateTime), wordCount === undefined ? "" : String(wordCount) + "字"].join("丨");
      mapped.isVip = bookPayload.isVip;
      mapped.isPay = bookPayload.isPay;
      mapped.isVolume = false;
      data.push(mapped);
      chapterCount += 1;
      }
    }
    if (!chapterCount) throw new Error("QD 章节目录解析为空");
    return { data, hasMore: false, pageSize: data.length };
  }
  if (plan.kind === "des-json-chapters") {
    const resourceId = resourceIdFromInput(input);
    if (!resourceId) throw new Error("DES 章节目录资源 ID 为空");
    const timeStamp = String(Date.now());
    const payload = expandPayload(plan.request.payload, {
      ...variables,
      resourceId,
      timeStamp,
    });
    const encrypted = encryptDesEcb(JSON.stringify(payload), plan.crypto.key);
    if (!encrypted) throw new Error("DES 章节目录请求加密失败");
    const envelope = {
      siteId: plan.crypto.siteId ?? 1,
      data: encrypted,
      userId: plan.crypto.userId ?? "0",
      fromSource: plan.crypto.fromSource ?? 3,
      osType: plan.crypto.osType ?? 5,
      version: plan.crypto.version ?? "1.0.1",
      versionCode: plan.crypto.versionCode ?? 10001,
      timeStamp,
      hashCode: createHash("md5").update(timeStamp + plan.crypto.md5Key, "utf8").digest("hex"),
    };
    const requestUrl = (() => {
      try { return new URL(expand(plan.request.urlTemplate, { ...variables, resourceId, timeStamp }), plan.host || undefined).toString(); } catch { return ""; }
    })();
    if (!requestUrl) throw new Error("DES 章节目录请求地址无效");
    const body = `cmd=${encodeURIComponent(plan.crypto.command)}&value=${encodeURIComponent(JSON.stringify(envelope))}`;
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
      "Content-Type": plan.request.headers?.["Content-Type"] || "application/x-www-form-urlencoded",
    }, {
      method: "POST",
      body,
      ...(signal ? { signal } : {}),
    });
    let payloadResponse;
    try {
      payloadResponse = JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
    } catch {
      throw new Error("DES 章节目录响应不是有效 JSON");
    }
    let rows = jsonPathValue(payloadResponse, plan.responsePath);
    if (plan.nestedPath && Array.isArray(rows?.[0]?.[plan.nestedPath])) rows = rows[0][plan.nestedPath];
    if (!Array.isArray(rows)) throw new Error("DES 章节目录响应不是列表");
    const data = [];
    for (const row of rows.slice(0, MAX_ROWS)) {
      if (!row || typeof row !== "object") continue;
      const local = { ...variables, resourceId, timeStamp, ...row };
      const title = outputValue(plan.output.title, row, local, plan);
      const content = String(jsonPathValue(row, plan.contentPath) ?? "").trim();
      if (!title || !content) continue;
      const encoded = Buffer.from(content, "utf8").toString("base64");
      data.push({ title, url: `data:;base64,${encoded},{"type":"text"}` });
    }
    if (!data.length) throw new Error("DES 章节目录解析为空");
    return { data, hasMore: false, pageSize: data.length };
  }
  if (plan.kind === "encrypted-json-chapters") {
    const decoded = decodeInput(input, plan.decode);
    if (!decoded) throw new Error("加密章节目录参数解码为空");
    for (const [name, mode] of Object.entries(plan.decodedFields || {})) {
      variables[name] = mode === "first" ? decoded.split("/")[0] : decoded;
    }
    const payload = expandPayload(plan.request.payload, variables);
    const encrypted = encryptAes(JSON.stringify(payload), plan.crypto.request);
    if (!encrypted) throw new Error("章节目录请求加密失败");
    const field = plan.crypto.request.envelopeField;
    const body = plan.crypto.request.envelope === "json"
      ? JSON.stringify({ [field]: encrypted })
      : `${encodeURIComponent(field)}=${encodeURIComponent(encrypted)}`;
    const requestUrl = (() => {
      try { return new URL(expand(plan.request.urlTemplate, variables), plan.host || undefined).toString(); } catch { return ""; }
    })();
    if (!requestUrl) throw new Error("加密章节目录请求地址无效");
    const response = await download(requestUrl, {
      ...plan.headers,
      ...(plan.request.headers || {}),
      "Content-Type": plan.request.headers?.["Content-Type"]
        || (plan.crypto.request.envelope === "json" ? "application/json" : "application/x-www-form-urlencoded"),
    }, {
      method: plan.request.method,
      body,
      ...(signal ? { signal } : {}),
    });
    const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
    let outer;
    try { outer = JSON.parse(responseText); } catch { throw new Error("加密章节目录外层响应不是 JSON"); }
    const encryptedResponse = jsonPathValue(outer, plan.crypto.response.outerPath || "data");
    const decrypted = decryptAes(encryptedResponse, plan.crypto.response);
    if (!decrypted) throw new Error("章节目录响应解密为空");
    let payloadResponse;
    try { payloadResponse = JSON.parse(decrypted); } catch { throw new Error("章节目录解密响应不是 JSON"); }
    const grouped = jsonPathValue(payloadResponse, plan.output.grouped.groupPath);
    if (!Array.isArray(grouped)) throw new Error("章节目录解密响应不是分组列表");
    const divisions = plan.output.grouped.divisionPath ? jsonPathValue(payloadResponse, plan.output.grouped.divisionPath) : [];
    const divisionMap = new Map(Array.isArray(divisions)
      ? divisions.map((item) => [String(item?.[plan.output.grouped.divisionIdPath] ?? ""), String(item?.[plan.output.grouped.divisionNamePath] ?? "")])
      : []);
    const data = [];
    for (const group of grouped.slice(0, MAX_ROWS)) {
      if (!group || typeof group !== "object") continue;
      const groupId = String(group[plan.output.grouped.divisionIdPath.split(".").at(-1)] ?? "");
      const groupName = divisionMap.get(groupId) || "";
      const chapters = jsonPathValue(group, plan.output.grouped.chapterPath);
      if (!Array.isArray(chapters)) continue;
      for (const chapter of chapters) {
        if (!chapter || typeof chapter !== "object") continue;
        const chapterId = String(jsonPathValue(chapter, plan.output.grouped.chapterIdPath) ?? "");
        const chapterTitle = String(jsonPathValue(chapter, plan.output.grouped.chapterTitlePath) ?? "").trim();
        if (!chapterId || !chapterTitle) continue;
        const chapterObject = {
          bookid: variables.bookid || "",
          chapterid: chapterId,
          isVip: String(chapter.is_paid ?? "0") === "1",
          isPay: String(chapter.auth_access ?? "0") === "1",
        };
        const encoded = Buffer.from(JSON.stringify(chapterObject), "utf8").toString("base64");
        data.push({
          title: groupName ? `${groupName} · ${chapterTitle}` : chapterTitle,
          url: `data:;base64,${encoded},{"type":"text"}`,
          isVip: chapterObject.isVip,
          isPay: chapterObject.isPay,
        });
        if (data.length >= MAX_ROWS) break;
      }
      if (data.length >= MAX_ROWS) break;
    }
    if (!data.length) throw new Error("章节目录解密解析为空");
    return { data, hasMore: false, pageSize: data.length };
  }
  if (plan.decode) {
    const decoded = decodeInput(input, plan.decode);
    if (!decoded) throw new Error("章节目录参数解码为空");
    const decodedParts = decoded.split("/");
    for (const [name, mode] of Object.entries(plan.decodedFields || {})) {
      variables[name] = mode === "first" ? decodedParts[0] : mode === "json"
        ? (() => { try { return JSON.parse(decoded)[name] || ""; } catch { return ""; } })()
        : decoded;
    }
  } else {
    for (const extractor of plan.extractors || []) {
      const found = input.match(new RegExp(extractor.pattern, extractor.flags));
      variables[extractor.name] = found?.[extractor.group] || "";
    }
  }
  if (plan.kind === "json-chapters-pages") {
    const resolveUrl = (template, values) => {
      const raw = expand(template, values);
      try { return new URL(raw, baseUrl || plan.host || undefined).toString(); } catch { return ""; }
    };
    const fetchPage = async (page, { required = false } = {}) => {
      const values = { ...variables, page: String(page), pageIndex: String(page) };
      const requestUrl = resolveUrl(plan.request.urlTemplate, values);
      if (!requestUrl) throw new Error("分页章节请求地址无效");
      const body = plan.request.bodyTemplate ? expand(plan.request.bodyTemplate, values) : undefined;
      const headers = { ...plan.headers };
      if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
        headers["Content-Type"] = /^\s*\{/.test(body) ? "application/json" : "application/x-www-form-urlencoded";
      }
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "referer") && baseUrl) headers.Referer = baseUrl;
      try {
        const response = await download(requestUrl, headers, {
          method: plan.request.method,
          ...(body !== undefined ? { body } : {}),
          ...(signal ? { signal } : {}),
        });
        return JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
      } catch (error) {
        if (required || signal?.aborted) throw error;
        return null;
      }
    };
    const firstPayload = await fetchPage(1, { required: true });
    const firstRows = jsonPathValue(firstPayload, plan.pagination.responsePath);
    if (!Array.isArray(firstRows)) throw new Error("分页章节首响应不是列表");
    const total = Math.max(1, Math.min(plan.pagination.maxPages,
      Number(jsonPathValue(firstPayload, plan.pagination.totalPath)) || 1));
    const allRows = [...firstRows];
    for (let offset = 2; offset <= total; offset += BATCH_CONCURRENCY) {
      const pages = Array.from({ length: Math.min(BATCH_CONCURRENCY, total - offset + 1) }, (_, index) => offset + index);
      const results = await Promise.all(pages.map((page) => fetchPage(page)));
      for (const payload of results) {
        const rows = payload ? jsonPathValue(payload, plan.pagination.responsePath) : null;
        if (Array.isArray(rows)) allRows.push(...rows);
      }
    }
    const data = mapChapterRows(allRows, plan, variables, baseUrl);
    if (!data.length) throw new Error("分页章节目录解析为空");
    return { data, hasMore: false, pageSize: data.length };
  }
  if (plan.kind === "json-chapters-hosts") {
    let lastError = null;
    for (const candidate of plan.candidates || []) {
      const requestUrl = (() => {
        try {
          return new URL(expand(candidate.urlTemplate, variables), plan.host || undefined).toString();
        } catch {
          return "";
        }
      })();
      if (!requestUrl) continue;
      try {
        const response = await download(requestUrl, {
          ...plan.headers,
          ...candidate.headers,
          Referer: plan.headers.Referer || plan.host,
        }, {
          method: "GET",
          ...(signal ? { signal } : {}),
        });
        const payload = JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
        const rows = jsonPathValue(payload, plan.responsePath);
        if (!Array.isArray(rows)) throw new Error("章节候选响应不是列表");
        const candidatePlan = {
          ...plan,
          output: {
            ...plan.output,
            url: { ...plan.output.url, key: candidate.key },
          },
        };
        const data = mapChapterRows(rows, candidatePlan, variables, requestUrl);
        if (data.length) return { data, hasMore: false, pageSize: data.length };
        throw new Error("章节候选解析为空");
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("章节候选地址均不可用");
  }
  if (plan.kind === "json-chapters-batch") {
    const resolveUrl = (template, values) => {
      const raw = expand(template, values);
      try { return new URL(raw, baseUrl || plan.host || undefined).toString(); } catch { return ""; }
    };
    const jsonDownload = async (requestUrl, { referer = baseUrl } = {}) => {
      if (!requestUrl) throw new Error("批量章节请求地址无效");
      const headers = { ...plan.headers };
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "referer") && referer) headers.Referer = referer;
      const response = await download(requestUrl, headers, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      try {
        return JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} }));
      } catch {
        throw new Error("批量章节响应不是有效 JSON");
      }
    };
    const requestUrl = resolveUrl(plan.request.urlTemplate, variables);
    if (!requestUrl) throw new Error("批量章节初始请求地址无效");
    const initialPayload = await jsonDownload(requestUrl);
    const initialRows = plan.responsePath ? jsonPathValue(initialPayload, plan.responsePath) : initialPayload;
    if (!Array.isArray(initialRows)) throw new Error("批量章节初始响应不是列表");
    const targets = [];
    for (const row of initialRows.slice(0, MAX_BATCH_REQUESTS)) {
      if (!row || typeof row !== "object") continue;
      const rawId = jsonPathValue(row, plan.batch.inputPath);
      const found = String(rawId ?? "").match(new RegExp(plan.batch.idPattern, plan.batch.idFlags));
      const collectionId = found?.[plan.batch.idGroup] ?? found?.[0] ?? "";
      if (collectionId) targets.push(String(collectionId));
    }
    const children = [];
    for (let offset = 0; offset < targets.length; offset += BATCH_CONCURRENCY) {
      const chunk = targets.slice(offset, offset + BATCH_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (collectionId) => {
        const childUrl = resolveUrl(plan.batch.urlTemplate, { ...variables, collectionId });
        try {
          const payload = await jsonDownload(childUrl, { referer: requestUrl });
          const rows = plan.batch.responsePath ? jsonPathValue(payload, plan.batch.responsePath) : payload;
          return Array.isArray(rows) ? rows : [];
        } catch (error) {
          if (signal?.aborted) throw error;
          return [];
        }
      }));
      for (const rows of results) children.push(...rows);
    }
    const data = mapChapterRows(children, plan, variables, baseUrl);
    if (!data.length) throw new Error("批量章节目录解析为空");
    return { data, hasMore: false, pageSize: data.length };
  }
  const requestUrl = (() => {
    const raw = expand(plan.request.urlTemplate, variables);
    try { return new URL(raw, baseUrl || plan.host || undefined).toString(); } catch { return ""; }
  })();
  if (!requestUrl) throw new Error("章节目录请求地址无效");
  const body = plan.request.bodyTemplate ? expand(plan.request.bodyTemplate, variables) : undefined;
  const headers = {
    ...plan.headers,
    ...(body !== undefined && !Object.keys(plan.headers).some((name) => name.toLowerCase() === "content-type")
      ? { "Content-Type": /^\s*\{/.test(body) ? "application/json" : "application/x-www-form-urlencoded" }
      : {}),
    ...(plan.headers.Referer ? {} : { Referer: plan.input === "url" ? baseUrl : plan.host }),
  };
  const response = await download(requestUrl, headers, {
    method: plan.request.method,
    ...(body !== undefined ? { body } : {}),
    ...(signal ? { signal } : {}),
  });
  let payload;
  try { payload = JSON.parse(decodeTextBuffer(response, { headers: response?.httpHeaders || {} })); } catch {
    throw new Error("章节目录响应不是有效 JSON");
  }
  const rows = plan.responsePath ? jsonPathValue(payload, plan.responsePath) : payload;
  if (!Array.isArray(rows)) throw new Error("章节目录响应不是列表");
  const data = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (!row || typeof row !== "object") continue;
    if (plan.filter) {
      const current = String(jsonPathValue(row, plan.filter.path) ?? "");
      if (plan.filter.operator === "equals" ? current !== plan.filter.value : current === plan.filter.value) continue;
    }
    const rowValues = { ...row };
    for (const [name, path] of Object.entries(plan.rowFields || {})) {
      rowValues[name] = jsonPathValue(row, path);
    }
    const local = { ...variables, ...rowValues };
    const title = outputValue(plan.output.title, row, local, plan);
    let url = outputValue(plan.output.url, row, local, plan);
    url = absoluteChapterUrl(url, baseUrl, plan.host);
    if (!title || !url) continue;
    const mapped = { title, url };
    if (plan.output.updateTime) mapped.updateTime = outputValue(plan.output.updateTime, row, local, plan);
    data.push(mapped);
  }
  if (!data.length) throw new Error("章节目录解析为空");
  return { data, hasMore: false, pageSize: data.length };
}
