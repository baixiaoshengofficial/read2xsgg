import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { decodeTextBuffer } from "./charset.js";
import { qdApiEndpoint, qdBookIdFromInput, qdCryptoConfig, qdSignatureHeaders } from "./qdCrypto.js";

const MAX_PLAN_BYTES = 24 * 1024;
const MAX_TEMPLATE_LENGTH = 4_096;
const ALLOWED_HEADERS = /^(?:user-agent|referer|origin|accept|accept-language|content-type|x-requested-with|x-fingerprint|cookie|app-version|platform|reg|authorization|application-id|net-env|channel|qm-params|sign)$/i;

function safeRegex(pattern, flags = "") {
  const value = String(pattern || "");
  if (!value || value.length > 2_048 || !/^[dgimsuvy]*$/.test(String(flags || ""))) return null;
  if (/\((?:[^()]|\\.)*(?:\||[+*?{])(?:[^()]|\\.)*\)[+*?{]/.test(value)) return null;
  try {
    new RegExp(value, flags);
    return { pattern: value, flags: String(flags || "") };
  } catch {
    return null;
  }
}

function decodeLiteral(token) {
  const source = String(token || "").trim();
  if (source.length < 2) return null;
  const quote = source[0];
  if (!["'", '"', "`"].includes(quote) || source.at(-1) !== quote) return null;
  if (quote === '"') {
    try { return JSON.parse(source); } catch { return null; }
  }
  return source.slice(1, -1)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([\\'"`])/g, "$1");
}

function normalizeHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!ALLOWED_HEADERS.test(name) || typeof value !== "string") continue;
    output[name] = value.slice(0, 2_048);
  }
  return output;
}

function normalizeTemplate(value, { body = false, fields = [] } = {}) {
  let source = String(value || "").trim();
  if (!source || source.length > MAX_TEMPLATE_LENGTH || /[\r\n]/.test(source)) return "";
  source = source
    .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
    .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}")
    .replace(/\$\{\s*(?:key|keyword|searchKey)\s*\}/gi, "{{keyWord}}")
    .replace(/\$\{\s*(?:page|pageIndex)\s*\}/gi, "{{pageIndex}}");
  if (body) {
    source = source.replace(/\b(?:key|keyword|searchKey)\b(?!\s*=)/g, "{{keyWord}}");
    source = source.replace(/\b(?:page|pageIndex)\b(?!\s*=)/g, "{{pageIndex}}");
  }
  const allowed = ["host", "raw:[A-Za-z_$][\\w$]*", "keyWord", "pageIndex", ...fields.map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|");
  if (new RegExp(`\\$\\{|\\{\\{(?!\\s*(?:${allowed})\\s*\\}\\})`).test(source)) return "";
  if (!/^https?:\/\//i.test(source) && /[<>]/.test(source)) return "";
  return source;
}

function normalizedScript(value) {
  return String(value || "")
    .replace(/^\s*(?:@js:|<js>)\s*/i, "")
    .replace(/\s*<\/js>\s*$/i, "")
    .trim();
}

function staticSearchFunctionTemplate(jsLibrary, functionName) {
  const name = String(functionName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!name) return "";
  const source = String(jsLibrary || "");
  const declaration = source.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`, "i"));
  if (!declaration) return "";
  const args = declaration[1].split(",").map((value) => value.trim()).filter(Boolean);
  const returned = source.slice((declaration.index || 0) + declaration[0].length)
    .match(/\breturn\s+`([\s\S]*?)`\s*;?/i);
  if (!returned || !args.length) return "";
  const keyArg = args.find((value) => /(?:name|novel|keyword|query|key)/i.test(value)) || args[0];
  const pageArg = args.find((value) => /page|offset/i.test(value));
  let template = returned[1]
    .replace(new RegExp(`\\$\\{\\s*${keyArg.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\}`, "g"), "{{keyWord}}");
  if (pageArg) {
    template = template.replace(new RegExp(`\\$\\{\\s*${pageArg.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\}`, "g"), "{{pageIndex}}");
  }
  if (/\$\{|\{\{|\}/.test(template.replace(/\{\{(?:keyWord|pageIndex)\}\}/g, ""))) return "";
  return /^https?:\/\//i.test(template) && template.length <= MAX_TEMPLATE_LENGTH ? template : "";
}

function assignmentExpression(script, name) {
  const source = String(script || "");
  const match = source.match(new RegExp(`(?:^|[;\\n])\\s*(?:(?:var|let|const)\\s+)?${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*`));
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
    if (["'", '"', "`"].includes(character)) quote = character;
    else if ("([{".includes(character)) depth += 1;
    else if (")] }".replace(/\s/g, "").includes(character)) depth = Math.max(0, depth - 1);
    else if ((character === ";" || character === "\n") && depth === 0) return source.slice(start, index).trim();
  }
  return source.slice(start).trim().replace(/;\s*$/, "");
}

function urlTemplate(value, { host = "" } = {}) {
  let source = String(value || "").trim();
  if (!source) return "";
  if (/^source\.(?:key|getKey\s*\(\s*\)|bookSourceUrl)$/i.test(source)) return "{{host}}";
  source = source.replace(/\b(?:config\.host|host)\b/g, "{{host}}");
  source = source.replace(/\bsource\.(?:key|getKey\s*\(\s*\)|bookSourceUrl)\b/gi, "{{host}}");
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (const character of source) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      current += character;
    } else if ("([{".includes(character)) {
      depth += 1;
      current += character;
    } else if (")] }".replace(/\s/g, "").includes(character)) {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (character === "+" && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  if (!parts.length) return "";
  let output = "";
  for (const part of parts) {
    const literal = decodeLiteral(part);
    if (literal !== null) output += literal;
    else if (/^\{\{host\}\}$/.test(part)) output += part;
    else if (/^(?:key|keyword|searchKey)$/i.test(part)) output += "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(part)) output += "{{pageIndex}}";
    else return "";
  }
  if (!output || output.length > MAX_TEMPLATE_LENGTH) return "";
  if (!/^https?:\/\//i.test(output) && !/^\{\{host\}\}/.test(output) && host) {
    output = `${host.replace(/\/$/, "")}/${output.replace(/^\/+/, "")}`;
  }
  return output;
}

function bodyTemplateFromScript(script) {
  const match = script.match(/["']?body["']?\s*:\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/i);
  if (match) {
    let value = decodeLiteral(match[1]) || "";
    const tail = script.slice((match.index || 0) + match[0].length);
    if (/^\s*\+\s*(?:encodeURIComponent\s*\(\s*)?(?:key|keyword)(?:\s*\))?/i.test(tail)) value += "{{keyWord}}";
    return normalizeTemplate(value, { body: true }) || backtickBodyTemplate(script)?.value || "";
  }
  const expression = assignmentExpression(script, "body");
  if (!expression) return "";
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (const character of expression) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(character)) quote = character;
    else if ("([{ ".includes(character) && character !== " ") depth += 1;
    else if (")] }".replace(/\s/g, "").includes(character)) depth = Math.max(0, depth - 1);
    if (character === "+" && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  if (!parts.length) return "";
  let output = "";
  for (const part of parts) {
    const literal = decodeLiteral(part);
    if (literal !== null) output += literal;
    else if (/^(?:key|keyword|searchKey)$/i.test(part)) output += "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(part)) output += "{{pageIndex}}";
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) output += `{{${part}}}`;
    else return "";
  }
  const fields = [...output.matchAll(/\{\{([A-Za-z_$][\w$]*)\}\}/g)].map((match) => match[1]).filter((name) => name !== "keyWord" && name !== "pageIndex");
  if (fields.some((name) => name !== "token")) return "";
  return normalizeTemplate(output, { body: false, fields });
}

function backtickBodyTemplate(script) {
  const match = script.match(/["']?body["']?\s*:\s*`([\s\S]*?)`/i);
  if (!match) return null;
  const fields = [];
  const value = match[1].replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_all, name) => {
    fields.push(name);
    if (/^(?:key|keyword|searchKey)$/i.test(name)) return "{{keyWord}}";
    if (/^(?:page|pageIndex)$/i.test(name)) return "{{pageIndex}}";
    return `{{${name}}}`;
  });
  return { value: normalizeTemplate(value, { fields }), fields: [...new Set(fields)] };
}

function formActionPattern(script) {
  if (!/(?:form\s*\[|\.select\s*\(\s*["']form|match\s*\(\s*\/form|action\s*=)/i.test(script)) return null;
  const nameMatch = script.match(/form\s*\[\s*name\s*=\s*(?:["']([^"']+)["']|([A-Za-z0-9_-]+))\s*\]/i);
  const idMatch = script.match(/form\s*\[\s*id\s*=\s*(?:["']([^"']+)["']|([A-Za-z0-9_-]+))\s*\]/i);
  const name = nameMatch?.[1] || nameMatch?.[2]
    || idMatch?.[1] || idMatch?.[2]
    || "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = escaped
    ? `<form\\b(?=[^>]*\\b(?:name|id)\\s*=\\s*["']${escaped}["'])[^>]*`
    : `<form\\b[^>]*`;
  const pattern = `${prefix}\\baction\\s*=\\s*["']([^"']+)`;
  return safeRegex(pattern, "i");
}

function extractorForToken(script) {
  if (/_token|csrf|nonce/i.test(script)) {
    const field = script.match(/(?:name|id)\s*=\s*["']([^"']*(?:token|csrf|nonce)[^"']*)["']/i)?.[1] || "_token";
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `(?:name|id)\\s*=\\s*["']${escaped}["'][^>]*\\bvalue\\s*=\\s*["']([^"']+)`;
    return { name: "token", pattern, flags: "i", group: 1 };
  }
  return null;
}

function directQueryTemplate(script, host) {
  const match = String(script || "").match(/["']([^"']*(?:searchkey|keyword|query|wd)=)["']\s*\+\s*(?:encodeURIComponent\s*\(\s*)?(?:key|keyword)(?:\s*\))?/i);
  if (!match) return "";
  const prefix = urlTemplate(match[1], { host });
  return prefix ? `${prefix}{{keyWord}}` : "";
}

function directQuerySuffix(script) {
  const match = String(script || "").match(/["']([?&][^"']*(?:searchkey|keyword|query|wd)=)["']\s*\+\s*(?:encodeURIComponent\s*\(\s*)?(?:key|keyword)(?:\s*\))?/i);
  if (match) return `${match[1]}{{keyWord}}`;
  const template = String(script || "").match(/([?&](?:searchkey|keyword|query|wd)=)\{\{\s*(?:key|keyword)\s*\}\}/i);
  return template ? `${template[1]}{{keyWord}}` : "";
}

function signedQuerySearchPlan(script, { host = "", headers = {} } = {}) {
  const source = String(script || "");
  if (!/java\.md5Encode\s*\(/i.test(source) || !/Object\.keys\s*\(\s*(?:params|headers)/i.test(source)) return null;
  const signKey = source.match(/\b(?:signKey|sign_key|secretKey)\s*=\s*["']([^"']{8,512})["']/i)?.[1] || "";
  if (!signKey || !/\b(?:params|headers)\s*\[["']sign["']\]/i.test(source)) return null;
  const action = source.match(/\b(?:action|searchUrl|endpoint)\s*=\s*(["'])([^"']+)\1/i)?.[2] || "";
  if (!action) return null;
  const endpoint = /^https?:\/\//i.test(action)
    ? action.replace(/[?&]+$/, "")
    : `${String(host).replace(/\/$/, "")}/${action.replace(/^\/?/, "")}`.replace(/[?&]+$/, "");
  const paramsText = source.match(/\b(?:var|let|const)\s+params\s*=\s*\{([\s\S]{0,4096}?)\}/i)?.[1] || "";
  if (!paramsText) return null;
  const query = {};
  for (const match of paramsText.matchAll(/(["'])([A-Za-z_$][\w$]*)\1\s*:\s*([^,\n}]+)/g)) {
    const name = match[2];
    const expression = match[3].trim();
    if (/^(?:key|keyword|searchKey)$/i.test(expression)) query[name] = "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(expression)) query[name] = "{{pageIndex}}";
    else {
      const literal = decodeLiteral(expression);
      if (literal !== null) query[name] = literal;
      else if (/^\d+(?:\.\d+)?$/.test(expression)) query[name] = expression;
    }
  }
  if (!Object.keys(query).length || !Object.values(query).some((value) => String(value).includes("{{keyWord}}"))) return null;
  const staticObject = source.match(/\b(?:var|let|const)\s+(?:headers|h)\s*=\s*\{([\s\S]{0,4096}?)\}/i)?.[1] || "";
  const requestHeaders = { ...headers };
  for (const match of staticObject.matchAll(/(["'])([A-Za-z][\w-]{0,63})\1\s*:\s*(["'])((?:\\.|(?!\3)[\s\S])*?)\3/g)) {
    const value = decodeLiteral(match[3] + match[4] + match[3]);
    if (value !== null) requestHeaders[match[2]] = value;
  }
  try {
    return normalizePlan({
      kind: "signed",
      host,
      seedTemplate: "{{host}}",
      headers: requestHeaders,
      request: {
        method: "GET",
        urlTemplate: endpoint,
        query,
        sign: { key: signKey, field: "sign" },
        headerSign: /headers\s*\[["']sign["']\]/i.test(source),
        headers: requestHeaders,
      },
    });
  } catch {
    return null;
  }
}

function staticDescriptorSearchPlan(script, { host = "", headers = {} } = {}) {
  const source = String(script || "");
  const candidates = [...source.matchAll(
    /(https?:\/\/[^,\s"']+),\{\\"method\\":\\"(POST|GET)\\",\\"body\\":\\"([\s\S]*?)\\"\}/gi,
  )];
  for (const match of candidates.reverse()) {
    let body = String(match[3] || "")
      .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
      .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}");
    const endpoint = match[1] || "";
    if (!endpoint) continue;
    body = body
      .replace(/"\s*\+\s*(?:encodeURIComponent\s*\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*\+\s*"/g, (_all, name) => {
        if (/^(?:key|keyword|searchKey)$/i.test(name)) return "{{keyWord}}";
        if (/^(?:page|pageIndex)$/i.test(name)) return "{{pageIndex}}";
        // Values read from source storage are intentionally treated as empty;
        // they are not allowed to become arbitrary server-side expressions.
        return "";
      })
      .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
      .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}");
    if (!/\{\{keyWord\}\}/.test(body) || /[\r\n]/.test(body)) continue;
    try {
      return normalizePlan({
        kind: "static",
        host,
        seedTemplate: "{{host}}",
        headers,
        request: {
          method: match[2],
          urlTemplate: endpoint,
          bodyTemplate: body,
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        },
      });
    } catch { /* continue with other bounded recognizers */ }
  }

  // The same descriptor is often assembled as
  // `url + JSON.stringify({method:'POST', body:'...'})`, which has no
  // executable site logic beyond a literal form body.
  const assembled = [...source.matchAll(
    /(["'])(https?:\/\/[^"']+),\1\s*\+\s*JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/gi,
  )];
  for (const match of assembled.reverse()) {
    const object = match[3] || "";
    const method = object.match(/(?:^|[,\s])(["']?)method\1\s*:\s*(["'])(POST|GET)\2/i)?.[3] || "GET";
    const body = object.match(/(?:^|[,\s])(["']?)body\1\s*:\s*(["'])([\s\S]*?)\2\s*(?:[,}]|$)/i)?.[3] || "";
    if (!body && method === "POST") continue;
    const bodyTemplate = body
      .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
      .replace(/\{\{\s*(?:page|pageIndex)\s*-\s*1\s*\}\}/gi, "{{pageIndexMinusOne}}")
      .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}");
    if (method === "POST" && !/\{\{keyWord\}\}/.test(bodyTemplate)) continue;
    try {
      return normalizePlan({
        kind: "static",
        host,
        seedTemplate: "{{host}}",
        headers,
        request: {
          method,
          urlTemplate: match[2],
          ...(bodyTemplate ? { bodyTemplate } : {}),
          headers: method === "POST"
            ? { ...headers, "Content-Type": "application/x-www-form-urlencoded" }
            : headers,
        },
      });
    } catch { /* continue with other bounded recognizers */ }
  }
  return null;
}

function hiddenFieldSearchPlan(script, { host = "", headers = {} } = {}) {
  const source = String(script || "");
  const field = source.match(/input\s*\[\s*(?:name|id)\s*=\s*["']([A-Za-z_$][\w$-]*)["']/i)?.[1]
    || source.match(/(?:name|id)\s*=\s*["']([A-Za-z_$][\w$-]*(?:token|csrf|nonce|sign)[A-Za-z_$\w-]*)["']/i)?.[1]
    || source.match(/(?:match|valueOf)\s*\(\s*\/[^/]*["']([A-Za-z_$][\w$-]*(?:token|csrf|nonce|sign)[A-Za-z_$\w-]*)["']/i)?.[1]
    // Some rules discover the field with a regular expression instead of a
    // DOM selector, for example /="_token" value="(.*?)"/.  The field name
    // is still a bounded form field; it must not become executable code.
    || source.match(/\\?["']([A-Za-z_$][\w$-]*(?:token|csrf|nonce|sign)[A-Za-z_$\w-]*)\\?["']/i)?.[1]
    || "";
  if (!field) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const extractor = {
    name: field,
    pattern: `<[^>]*?(?=\\b(?:name|id)\\s*=\\s*["']${escaped}["'])(?=[^>]*\\bvalue\\s*=\\s*["']([^"']+))[^>]*>`,
    flags: "i",
    group: 1,
  };
  const staticUrl = source.match(/\burl\s*=\s*(["'])(https?:\/\/[^"']+)\1/i)?.[2] || "";
  const staticTarget = staticUrl && /\{\{\s*(?:key|keyword|searchKey)\s*\}\}|(?:search|query|wd)=/i.test(staticUrl)
    ? staticUrl.replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}") + `{{${field}}}`
    : "";
  const body = backtickBodyTemplate(source);
  const dynamicTarget = /\b(?:surl|searchUrl|postUrl)\s*=\s*[A-Za-z_$][\w$]*\s*\+\s*["'](?:\/?search|\/?query)["']/i.test(source)
    ? "{{raw:responseUrl}}/search"
    : "";
  const target = staticTarget || dynamicTarget;
  if (!target) return null;
  const literalBody = body?.value || bodyTemplateFromScript(source);
  let bodyTemplate = literalBody
    ? literalBody.replace(/\{\{\s*(?:token|csrf|nonce|sign|field)\s*\}\}/gi, `{{${field}}}`)
    : "";
  // Object descriptors frequently concatenate the extracted field after a
  // literal prefix (`body: "kw=" + ...match(...)[1]`).  Keep the literal
  // prefix and bind the safe extractor value; computed expressions are not
  // evaluated by the converter.
  if (bodyTemplate && !bodyTemplate.includes(`{{${field}}}`)
    && /\+\s*(?:java\.(?:ajax|get)|[A-Za-z_$][\w$]*)[\s\S]*?(?:match|valueOf)\s*\(/i.test(source)) {
    bodyTemplate += `{{${field}}}`;
  }
  const requestMethod = bodyTemplate ? "POST" : "GET";
  try {
    return normalizePlan({
      kind: dynamicTarget ? "redirect" : "static",
      host,
      seedTemplate: "{{host}}",
      headers,
      extractors: [extractor],
      request: {
        method: requestMethod,
        urlTemplate: target,
        ...(bodyTemplate ? { bodyTemplate } : {}),
        headers: bodyTemplate ? { ...headers, Referer: "{{raw:responseUrl}}" } : headers,
      },
    });
  } catch { return null; }
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
    if (character === "\"" || character === "'" || character === "\x60") {
      quote = character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function callArguments(source, index) {
  const script = String(source || "");
  const open = script.indexOf("(", index);
  if (open < 0) return "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let cursor = open; cursor < script.length; cursor += 1) {
    const character = script[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "\x60") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return script.slice(open + 1, cursor);
    }
  }
  return "";
}

function qdParameterTemplate(expression, { allowBookId = false } = {}) {
  let output = "";
  for (const part of splitTopLevel(expression, "+")) {
    const literal = decodeLiteral(part);
    if (literal !== null) {
      output += literal;
      continue;
    }
    const identifier = part.match(/^(?:String\s*\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?$/)?.[1] || "";
    if (/^(?:key|keyword|searchKey)$/i.test(identifier)) output += "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(identifier)) output += "{{pageIndex}}";
    else if (allowBookId && /^(?:bookId|book_id|bookid|bid|id)$/i.test(identifier)) output += "{{value}}";
    else if (/^\d+$/.test(identifier)) output += identifier;
    else return "";
  }
  return output && output.length <= MAX_TEMPLATE_LENGTH ? output : "";
}

export function compileQdDetailPlan(rule, { host = "", headers = {}, jsLib = "" } = {}) {
  const script = normalizedScript(rule);
  if (!script || !/\bQDSign\s*\(/i.test(script) || !/bookdetail\/get/i.test(script)) return null;
  const anchor = script.search(/\bQDSign\s*\(/i);
  const args = callArguments(script, anchor);
  const parts = splitTopLevel(args);
  const path = decodeLiteral(parts[0] || "");
  const array = parts.find((part) => part.startsWith("[") && part.endsWith("]"));
  if (!path || !array) return null;
  const tail = script.replace(/<\/js>\s*$/i, "").trim().split(/[;\r\n]+/).at(-1)?.trim() || "";
  const resultPath = tail.match(/^\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/)?.[1] || "";
  if (!resultPath) return null;
  const params = splitTopLevel(array.slice(1, -1))
    .map((part) => qdParameterTemplate(part, { allowBookId: true }));
  if (!params.length || params.some((value) => !value) || !params.some((value) => /\{\{value\}\}/.test(value))) return null;
  const config = qdCryptoConfig(jsLib);
  if (!config) return null;
  const endpoint = qdApiEndpoint(jsLib);
  try {
    return normalizePlan({
      kind: "qd-sign-json",
      host,
      seedTemplate: "{{host}}",
      responseType: "json",
      headers,
      request: { method: "GET", urlTemplate: endpoint },
      qd: { endpoint, path, params, valueMode: "bookId", resultPath, ...config },
    });
  } catch {
    return null;
  }
}

function compileQdSearchPlan(script, { host = "", headers = {}, jsLib = "" } = {}) {
  if (!/\bQDSign\s*\(/i.test(script) || !/booksearch\/searchbooks/i.test(script)) return null;
  const anchor = script.search(/\bQDSign\s*\(/i);
  const args = callArguments(script, anchor);
  const parts = splitTopLevel(args);
  const path = decodeLiteral(parts[0] || "");
  const array = parts.find((part) => part.startsWith("[") && part.endsWith("]"));
  if (!path || !array) return null;
  const params = splitTopLevel(array.slice(1, -1)).map(qdParameterTemplate);
  if (!params.length || params.some((value) => !value) || !params.some((value) => /\{\{keyWord\}\}/.test(value))) return null;
  const config = qdCryptoConfig(jsLib);
  if (!config) return null;
  const endpoint = qdApiEndpoint(jsLib);
  try {
    return normalizePlan({
      kind: "qd-sign-json",
      host,
      seedTemplate: "{{host}}",
      responseType: "json",
      headers,
      request: { method: "GET", urlTemplate: endpoint },
      qd: { endpoint, path, params, ...config },
    });
  } catch {
    return null;
  }
}

function objectTemplateFromScript(source, anchor) {
  const script = String(source || "");
  const start = script.indexOf(String(anchor || ""));
  if (start < 0) return null;
  const body = callArguments(script, start).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  const fields = {};
  for (const part of splitTopLevel(body.slice(1, -1))) {
    const match = part.match(/^(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);
    if (!match) return null;
    const name = match[1] || match[2];
    const expression = match[3].trim().replace(/,\s*$/, "");
    const literal = decodeLiteral(expression);
    if (literal !== null) {
      fields[name] = literal;
      continue;
    }
    if (/^\{\{[\s\S]*\}\}$/.test(expression)) {
      fields[name] = "{{value}}";
      continue;
    }
    const identifier = expression.match(/^(?:String\s*\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?$/)?.[1] || "";
    if (!identifier) return null;
    if (/^(?:key|keyword|searchKey)$/i.test(identifier)) fields[name] = "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(identifier)) fields[name] = "{{pageIndex}}";
    else if (/^time$/i.test(identifier)) fields[name] = "{{time}}";
    else if (/^sign$/i.test(identifier)) fields[name] = "{{sign}}";
    else if (/^type$/i.test(identifier)) fields[name] = "{{type}}";
    else fields[name] = "{{" + identifier + "}}";
  }
  return fields;
}

function signatureTemplateFromScript(source) {
  const match = String(source || "").match(/\b(?:java\.)?md5Encode\s*\(\s*\x60([\s\S]*?)\x60\s*\)/i);
  if (!match) return "";
  return match[1]
    .replace(/\$\{\s*(?:key|keyword|searchKey)\s*\}/gi, "{{keyWord}}")
    .replace(/\$\{\s*(?:page|pageIndex)\s*\}/gi, "{{pageIndex}}")
    .replace(/\$\{\s*time\s*\}/gi, "{{time}}")
    .replace(/\$\{\s*value\s*\}/gi, "{{value}}")
    .replace(/\{\{\s*\$[^}]+\}\}/g, "{{value}}");
}

function aesPostDescriptor(source) {
  const script = String(source || "");
  const endpoint = script.match(/(["'])(https?:\/\/[^"']+)\1\s*\+\s*JSON\.stringify/i)?.[2] || "";
  const crypto = script.match(
    /createSymmetricCrypto\s*\(\s*["']AES\/CBC\/PKCS5Padding["']\s*,\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/i,
  );
  const payload = objectTemplateFromScript(script, "JSON.stringify({");
  const signature = signatureTemplateFromScript(script);
  if (!endpoint || !crypto || !payload || !signature || !/["']?method["']?\s*:\s*["']POST["']/i.test(script)) return null;
  return {
    urlTemplate: endpoint.replace(/,+$/, ""),
    payload,
    signTemplate: signature,
    signUppercase: /\.toUpperCase\s*\(\s*\)/i.test(script),
    crypto: { key: crypto[1], iv: crypto[2] },
  };
}

function compileAesPostSearchPlan(rule, { host = "", headers = {}, detailRule = "" } = {}) {
  const descriptor = aesPostDescriptor(rule);
  if (!descriptor) return null;
  const detail = detailRule ? aesPostDescriptor(detailRule) : null;
  try {
    return normalizePlan({
      kind: "aes-post-json",
      host,
      seedTemplate: "{{host}}",
      responseType: "json",
      headers,
      request: {
        method: "POST",
        urlTemplate: descriptor.urlTemplate,
        payload: descriptor.payload,
        envelopeField: "c",
        signTemplate: descriptor.signTemplate,
        signUppercase: descriptor.signUppercase,
      },
      crypto: {
        key: descriptor.crypto.key,
        iv: descriptor.crypto.iv,
        keyEncoding: "utf8",
        ivEncoding: "utf8",
        responsePath: "data",
        encoding: "base64",
      },
      ...(detail ? {
        detail: {
          method: "POST",
          urlTemplate: detail.urlTemplate,
          payload: detail.payload,
          signTemplate: detail.signTemplate,
          signUppercase: detail.signUppercase,
        },
      } : {}),
    });
  } catch {
    return null;
  }
}

function wbiQueryTemplate(source, anchor) {
  const body = callArguments(source, source.indexOf(String(anchor || ""))).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  const output = {};
  for (const part of splitTopLevel(body.slice(1, -1))) {
    const match = part.match(/^(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);
    if (!match) return null;
    const name = match[1] || match[2];
    const expression = match[3].trim();
    const literal = decodeLiteral(expression);
    if (literal !== null) {
      output[name] = literal;
    } else if (/^(?:true|false)$/i.test(expression)) {
      output[name] = expression.toLowerCase() === "true";
    } else if (/^-?\d+(?:\.\d+)?$/.test(expression)) {
      output[name] = Number(expression);
    } else if (/^(?:getSearchOrder)\s*\(\s*\)$/i.test(expression)) {
      output[name] = "";
    } else if (/^(?:key|keyword|searchKey)$/i.test(expression)) {
      output[name] = "{{keyWord}}";
    } else if (/^(?:page|pageIndex)$/i.test(expression)) {
      output[name] = "{{pageIndex}}";
    } else if (/^type$/i.test(expression)) {
      output[name] = "{{type}}";
    } else {
      return null;
    }
  }
  return output;
}

function compileWbiSearchPlan(rule, { host = "", headers = "", jsLib = "" } = {}) {
  const script = String(rule || "");
  if (!/\bgetWbiEnc\s*\(/i.test(script) || !/\bwbi_img\b/i.test(jsLib)) return null;
  const tableText = String(jsLib).match(/\bmixinKeyEncTab\s*=\s*\[([\s\S]*?)\]/i)?.[1] || "";
  const table = tableText.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item));
  const navUrl = String(jsLib).match(/java\.ajax\s*\(\s*([\"'])(https?:\/\/[^\"']+\/nav)\1\s*\)/i)?.[2] || "";
  const allUrl = script.match(/([\"'])(https?:\/\/[^\"']+\/wbi\/search\/all\/v2)\??\1\s*\+/i)?.[2] || "";
  const typeUrl = script.match(/([\"'])(https?:\/\/[^\"']+\/wbi\/search\/type)\??\1\s*\+/i)?.[2] || "";
  const inlineIndex = script.lastIndexOf("getWbiEnc({");
  const query = inlineIndex >= 0
    ? wbiQueryTemplate(script.slice(inlineIndex), "getWbiEnc(")
    : { keyword: "{{keyWord}}", page: "{{pageIndex}}", page_size: 30, order: "" };
  const queryObject = script.match(/\bqueryJson\s*=\s*\{([\s\S]*?)\}\s*;/i)
    ? wbiQueryTemplate(script.slice(script.indexOf("queryJson = {")), "queryJson = ")
    : null;
  if (!navUrl || !allUrl || table.length !== 64 || table.some((item) => item < 0 || item > 63) || !query) return null;
  const prefixes = {};
  for (const match of script.matchAll(/case\s*([\"'])([^\"']+)\1\s*:[\s\S]{0,120}?\btype\s*=\s*([\"'])([^\"']+)\3/gi)) {
    prefixes[match[2]] = match[4];
  }
  try {
    return normalizePlan({
      kind: "wbi",
      host,
      seedTemplate: "{{host}}",
      responseType: "json",
      headers,
      request: { method: "GET", urlTemplate: allUrl },
      wbi: {
        navUrl,
        table,
        query,
        ...(typeUrl ? { typeUrl } : {}),
        ...(queryObject ? { typeQuery: queryObject } : {}),
        ...(Object.keys(prefixes).length ? { prefixes } : {}),
      },
    });
  } catch {
    return null;
  }
}

function concatExpressionTemplate(expression, fields) {
  const parts = splitTopLevel(String(expression || ""), "+");
  if (!parts.length) return "";
  let output = "";
  for (const part of parts) {
    const literal = decodeLiteral(part);
    if (literal !== null) {
      output += literal;
      continue;
    }
    const identifier = part.match(/^(?:String\s*\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?$/)?.[1] || "";
    if (!identifier || !fields.has(identifier)) return "";
    output += "{{" + identifier + "}}";
  }
  return output;
}

function compileJsonEnrichSearchPlan(rule, { host = "", headers = {}, bookListRule = "" } = {}) {
  const searchUrl = String(rule || "").trim();
  const script = normalizedScript(bookListRule);
  if (!script || !/\bJSON\.parse\s*\(\s*result\s*\)\.[A-Za-z_$][\w$]*/i.test(script)
    || !/\bjava\.ajax\s*\(/i.test(script) || !/\bmd5Encode\s*\(/i.test(script)) return null;
  let requestUrl = searchUrl
    .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
    .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}");
  if (/^\//.test(requestUrl)) requestUrl = String(host).replace(/\/$/, "") + requestUrl;
  if (!/^https?:\/\//i.test(requestUrl)) return null;
  const rootName = script.match(/\bJSON\.parse\s*\(\s*result\s*\)\.([A-Za-z_$][\w$]*)/i)?.[1] || "";
  const rootPattern = rootName
    ? new RegExp("\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*"
      + rootName.replace(/[^\w$]/g, "\\$&")
      + "\\.([A-Za-z_$][\\w$]*)")
    : null;
  const idMatch = rootPattern ? rootPattern.exec(script) : null;
  const bootstrapMatch = script.match(/\bjava\.ajax\s*\(\s*['"]([^'"]+)['"]\s*\+\s*([A-Za-z_$][\w$]*)\s*\)/i);
  const patternMatch = [...script.matchAll(/\.match\s*\(\s*\/((?:\\.|[^/])*)\/([dgimsuvy]*)\s*\)/g)]
    .find((item) => /key/i.test(item[1]));
  const keyPattern = patternMatch ? safeRegex(patternMatch[1], patternMatch[2]) : null;
  const keyGroup = patternMatch
    ? Number(script.slice(patternMatch.index || 0).match(/\]\s*\[\s*(\d+)\s*\]/)?.[1] || 1)
    : 1;
  const userId = script.match(/\buserId\s*=\s*['"]([^'"]+)['"]/i)?.[1] || "";
  const signIndex = script.search(/\b(?:java\.)?md5Encode\s*\(/i);
  const signCall = signIndex >= 0 ? callArguments(script, signIndex) : "";
  const signTemplate = concatExpressionTemplate(signCall, new Set(["bid", "timestamp", "userId", "scpubKey"]));
  const paramsExpression = script.match(/\bparams\s*=\s*([\s\S]*?);/i)?.[1] || "";
  const paramsTemplate = concatExpressionTemplate(paramsExpression, new Set(["bid", "userId", "timestamp", "sign"]));
  const chapterUrl = script.match(/:\s*['"]((?:https?:\/\/)[^'"]+)['"]\s*\+\s*params/i)?.[1] || "";
  const urlField = script.match(/\b(?:let|var|const)\s+\w+\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*:/i)?.[1] || "cata";
  if (!rootName || !idMatch || !bootstrapMatch || !keyPattern || !userId
    || !signTemplate || !paramsTemplate || !chapterUrl) return null;
  const keyVariable = bootstrapMatch[2];
  if (keyVariable !== idMatch[1]) return null;
  const fields = { bid: "{{bid}}", userId, timestamp: "{{time}}", sign: "{{sign}}" };
  const chapterTemplate = chapterUrl + paramsTemplate
    .replace(/\{\{bid\}\}/g, "{{bid}}")
    .replace(/\{\{userId\}\}/g, "{{userId}}")
    .replace(/\{\{timestamp\}\}/g, "{{time}}");
  const finalSignTemplate = signTemplate
    .replace(/\{\{timestamp\}\}/g, "{{time}}")
    .replace(/\{\{scpubKey\}\}/g, "{{scpubKey}}");
  try {
    return normalizePlan({
      kind: "json-enrich",
      host,
      seedTemplate: "{{host}}",
      responseType: "json",
      headers,
      request: { method: "GET", urlTemplate: requestUrl },
      enrich: {
        responsePath: rootName,
        idField: idMatch[2],
        bootstrapUrlTemplate: bootstrapMatch[1] + "{{bid}}",
        keyPattern: keyPattern.pattern,
        keyFlags: keyPattern.flags,
        keyGroup,
        userId,
        signTemplate: finalSignTemplate,
        urlTemplate: chapterTemplate,
        urlField,
      },
    });
  } catch {
    return null;
  }
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("搜索桥接计划无效");
  const kind = ["form", "static", "direct", "script-vars", "redirect", "bootstrap", "signed", "aes-post-json", "wbi", "json-enrich", "qd-sign-json"].includes(value.kind) ? value.kind : "";
  if (!kind) throw new TypeError("搜索桥接计划类型无效");
  const host = /^https?:\/\//i.test(String(value.host || "")) ? String(value.host).slice(0, 2_048) : "";
  const seedTemplate = String(value.seedTemplate || "").trim();
  const request = value.request && typeof value.request === "object" ? value.request : {};
  const requestUrl = String(request.urlTemplate || "").trim();
  const method = String(request.method || "GET").toUpperCase();
  const bodyTemplate = String(request.bodyTemplate || "");
  if (!seedTemplate || seedTemplate.length > MAX_TEMPLATE_LENGTH
    || !requestUrl || requestUrl.length > MAX_TEMPLATE_LENGTH
    || !["GET", "POST"].includes(method)
    || bodyTemplate.length > MAX_TEMPLATE_LENGTH) {
    throw new TypeError("搜索桥接计划请求不完整");
  }
  const query = request.query && typeof request.query === "object" && !Array.isArray(request.query)
    ? Object.fromEntries(Object.entries(request.query)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
    ? Object.fromEntries(Object.entries(request.payload)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const crypto = value.crypto && typeof value.crypto === "object" ? value.crypto : null;
  const qd = kind === "qd-sign-json" && value.qd && typeof value.qd === "object" ? value.qd : null;
  const qdEndpoint = String(qd?.endpoint || "").trim();
  const qdPath = String(qd?.path || "").trim();
  const qdParams = Array.isArray(qd?.params) ? qd.params.map((item) => String(item || "").slice(0, MAX_TEMPLATE_LENGTH)) : [];
  const qdValueMode = qd?.valueMode === "bookId" ? "bookId" : "";
  const qdResultPath = String(qd?.resultPath || "").trim();
  const qdSignKey = String(qd?.signKey || "");
  const qdSignIv = String(qd?.signIv || "");
  const qdInfoKey = String(qd?.infoKey || "");
  const signTemplate = String(request.signTemplate || "").trim();
  const detailSource = kind === "aes-post-json" && value.detail && typeof value.detail === "object"
    ? value.detail
    : null;
  const detailPayload = detailSource?.payload && typeof detailSource.payload === "object" && !Array.isArray(detailSource.payload)
    ? Object.fromEntries(Object.entries(detailSource.payload)
      .filter(([name]) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(([name, item]) => [name, typeof item === "string"
        ? item.slice(0, MAX_TEMPLATE_LENGTH)
        : (typeof item === "number" || typeof item === "boolean" ? item : "")]))
    : {};
  const detailUrl = String(detailSource?.urlTemplate || "").trim();
  const detailSignTemplate = String(detailSource?.signTemplate || "").trim();
  const wbi = kind === "wbi" && value.wbi && typeof value.wbi === "object" ? value.wbi : null;
  const wbiNavUrl = String(wbi?.navUrl || "").trim();
  const wbiTypeUrl = String(wbi?.typeUrl || "").trim();
  const wbiTable = Array.isArray(wbi?.table) ? wbi.table.map((item) => Number(item)) : [];
  const wbiQuery = wbi?.query && typeof wbi.query === "object" && !Array.isArray(wbi.query)
    ? wbi.query
    : {};
  const wbiTypeQuery = wbi?.typeQuery && typeof wbi.typeQuery === "object" && !Array.isArray(wbi.typeQuery)
    ? wbi.typeQuery
    : {};
  const wbiPrefixes = wbi?.prefixes && typeof wbi.prefixes === "object" && !Array.isArray(wbi.prefixes)
    ? Object.fromEntries(Object.entries(wbi.prefixes)
      .filter(([prefix, type]) => typeof prefix === "string" && prefix.length <= 2 && typeof type === "string" && type.length <= 64))
    : {};
  const enrich = kind === "json-enrich" && value.enrich && typeof value.enrich === "object" ? value.enrich : null;
  const enrichResponsePath = String(enrich?.responsePath || "").trim();
  const enrichIdField = String(enrich?.idField || "").trim();
  const enrichBootstrap = String(enrich?.bootstrapUrlTemplate || "").trim();
  const enrichKeyPattern = kind === "json-enrich" ? safeRegex(enrich?.keyPattern, enrich?.keyFlags) : null;
  const enrichKeyGroup = Number(enrich?.keyGroup) || 1;
  const enrichUserId = String(enrich?.userId || "");
  const enrichSignTemplate = String(enrich?.signTemplate || "").trim();
  const enrichUrlTemplate = String(enrich?.urlTemplate || "").trim();
  const enrichUrlField = String(enrich?.urlField || "url").trim();
  if (kind === "json-enrich" && (!enrich || !enrichResponsePath || !/^[A-Za-z_$][\w$]*$/.test(enrichIdField)
    || !/^https?:\/\//i.test(enrichBootstrap) || !enrichKeyPattern || enrichKeyGroup < 1 || enrichKeyGroup > 8
    || !enrichUserId || !enrichSignTemplate || !enrichUrlTemplate || !/^[A-Za-z_$][\w$]*$/.test(enrichUrlField))) {
    throw new TypeError("搜索 JSON 补全计划不完整");
  }
  if (kind === "wbi" && (!/^https?:\/\//i.test(wbiNavUrl) || !wbiTable.length || wbiTable.length !== 64
    || wbiTable.some((item) => !Number.isInteger(item) || item < 0 || item > 63)
    || !Object.keys(wbiQuery).length)) {
    throw new TypeError("搜索 WBI 计划不完整");
  }
  if (kind === "aes-post-json") {
    const key = String(crypto?.key || "");
    const iv = String(crypto?.iv || "");
    if (method !== "POST" || !Object.keys(payload).length || !signTemplate
      || key.length < 16 || key.length > 512 || iv.length !== 16
      || (detailSource && (!detailUrl || !Object.keys(detailPayload).length || !detailSignTemplate))) {
      throw new TypeError("搜索 AES 请求计划不完整");
    }
  }
  const sign = request.sign && typeof request.sign === "object" ? request.sign : null;
  if (kind === "signed" && (!Object.keys(query).length || !sign
    || typeof sign.key !== "string" || !sign.key || sign.key.length > 512
    || !/^[A-Za-z_$][\w$]*$/.test(String(sign.field || "sign")))) {
    throw new TypeError("搜索加签计划不完整");
  }
  if (kind === "qd-sign-json" && (!qd
    || !/^https?:\/\/[^/]+\/argus\/api\/?$/i.test(qdEndpoint)
    || !/^[A-Za-z0-9._/-]+$/.test(qdPath)
    || !qdParams.length
    || qdParams.some((item) => !item || item.length > MAX_TEMPLATE_LENGTH)
    || qdParams.some((item) => /\{\{(?!keyWord\}\}|pageIndex\}\}|value\}\})/.test(item))
    || (qdValueMode && !qdParams.some((item) => /\{\{value\}\}/.test(item)))
    || (qdValueMode && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(qdResultPath))
    || qdSignKey.length !== 24
    || qdSignIv.length !== 8
    || qdInfoKey.length !== 24)) {
    throw new TypeError("QD 签名搜索计划不完整");
  }
  const actionPattern = value.action && safeRegex(value.action.pattern, value.action.flags);
  const actionGroup = Number(value.action?.group) || 1;
  const extractors = Array.isArray(value.extractors) ? value.extractors.map((item) => {
    const pattern = safeRegex(item?.pattern, item?.flags);
    const name = String(item?.name || "");
    const group = Number(item?.group) || 1;
    return pattern && /^[A-Za-z_$][\w$]*$/.test(name) && group >= 1 && group <= 8
      ? { name, pattern: pattern.pattern, flags: pattern.flags, group }
      : null;
  }).filter(Boolean).slice(0, 16) : [];
  const bootstrapTemplate = String(value.bootstrapTemplate || "").trim();
  const variables = Array.isArray(value.variables)
    ? value.variables.filter((name) => /^[A-Za-z_$][\w$]*$/.test(String(name))).slice(0, 32)
    : [];
  if (kind === "script-vars" && (!bootstrapTemplate || !variables.length)) {
    throw new TypeError("搜索变量计划不完整");
  }
  const bootstrapUrl = kind === "bootstrap" ? String(value.bootstrapUrl || "").trim() : "";
  const bootstrapPattern = kind === "bootstrap" ? safeRegex(value.bootstrapPattern, value.bootstrapFlags) : null;
  if (kind === "bootstrap" && (!/^https?:\/\//i.test(bootstrapUrl) || !bootstrapPattern)) {
    throw new TypeError("搜索最新地址计划不完整");
  }
  if (kind === "form" && !actionPattern && !/\{\{(?:host|raw:action)\}\}/.test(requestUrl)) {
    throw new TypeError("搜索表单计划缺少 action");
  }
  if (actionPattern && (actionGroup < 1 || actionGroup > 8)) throw new TypeError("搜索表单 action 无效");
  return {
    version: 1,
    kind,
    host,
    seedTemplate,
    ...(["html", "json"].includes(value.responseType) ? { responseType: value.responseType } : {}),
    headers: normalizeHeaders(value.headers),
    ...(kind === "script-vars" ? { bootstrapTemplate, variables } : {}),
    ...(kind === "bootstrap" ? {
      bootstrapUrl: bootstrapUrl.slice(0, MAX_TEMPLATE_LENGTH),
      bootstrapPattern: bootstrapPattern.pattern,
      bootstrapFlags: bootstrapPattern.flags,
      bootstrapGroup: Math.max(1, Math.min(8, Number(value.bootstrapGroup) || 1)),
    } : {}),
    ...(actionPattern ? { action: { pattern: actionPattern.pattern, flags: actionPattern.flags, group: actionGroup } } : {}),
    ...(extractors.length ? { extractors } : {}),
    request: {
      method,
      urlTemplate: requestUrl,
      ...(bodyTemplate ? { bodyTemplate } : {}),
      ...(Object.keys(query).length ? { query } : {}),
      ...(kind === "aes-post-json" ? {
        payload,
        envelopeField: /^[A-Za-z_$][\w$]*$/.test(String(request.envelopeField || "c"))
          ? String(request.envelopeField || "c")
          : "c",
        signTemplate: signTemplate.slice(0, MAX_TEMPLATE_LENGTH),
        ...(request.signUppercase ? { signUppercase: true } : {}),
      } : {}),
      ...(kind === "signed" ? {
        sign: { key: String(sign.key), field: String(sign.field || "sign") },
        ...(request.headerSign ? { headerSign: true } : {}),
      } : {}),
      headers: normalizeHeaders(request.headers || value.headers),
    },
    ...(kind === "qd-sign-json" ? {
      qd: {
        endpoint: qdEndpoint.slice(0, MAX_TEMPLATE_LENGTH),
        path: qdPath.slice(0, MAX_TEMPLATE_LENGTH),
        params: qdParams,
        ...(qdValueMode ? { valueMode: qdValueMode } : {}),
        ...(qdValueMode ? { resultPath: qdResultPath } : {}),
        signKey: qdSignKey,
        signIv: qdSignIv,
        infoKey: qdInfoKey,
        infoIv: "",
      },
    } : {}),
    ...(kind === "aes-post-json" && detailSource ? {
      detail: {
        method: "POST",
        urlTemplate: detailUrl.slice(0, MAX_TEMPLATE_LENGTH),
        payload: detailPayload,
        signTemplate: detailSignTemplate.slice(0, MAX_TEMPLATE_LENGTH),
        ...(detailSource.signUppercase ? { signUppercase: true } : {}),
      },
      crypto: {
        key: String(crypto.key),
        iv: String(crypto.iv),
        keyEncoding: "utf8",
        ivEncoding: "utf8",
        responsePath: String(crypto.responsePath || "data"),
        encoding: "base64",
      },
    } : kind === "aes-post-json" ? {
      crypto: {
        key: String(crypto.key),
        iv: String(crypto.iv),
        keyEncoding: "utf8",
        ivEncoding: "utf8",
        responsePath: String(crypto.responsePath || "data"),
        encoding: "base64",
      },
    } : {}),
    ...(kind === "wbi" ? {
      wbi: {
        navUrl: wbiNavUrl.slice(0, MAX_TEMPLATE_LENGTH),
        table: wbiTable,
        query: wbiQuery,
        ...(wbiTypeUrl ? { typeUrl: wbiTypeUrl.slice(0, MAX_TEMPLATE_LENGTH) } : {}),
        ...(Object.keys(wbiTypeQuery).length ? { typeQuery: wbiTypeQuery } : {}),
        ...(Object.keys(wbiPrefixes).length ? { prefixes: wbiPrefixes } : {}),
      },
    } : {}),
    ...(kind === "json-enrich" ? {
      enrich: {
        responsePath: enrichResponsePath,
        idField: enrichIdField,
        bootstrapUrlTemplate: enrichBootstrap.slice(0, MAX_TEMPLATE_LENGTH),
        keyPattern: enrichKeyPattern.pattern,
        keyFlags: enrichKeyPattern.flags,
        keyGroup: enrichKeyGroup,
        userId: enrichUserId.slice(0, 128),
        signTemplate: enrichSignTemplate.slice(0, MAX_TEMPLATE_LENGTH),
        urlTemplate: enrichUrlTemplate.slice(0, MAX_TEMPLATE_LENGTH),
        urlField: enrichUrlField,
      },
    } : {}),
  };
}

export function compileSearchBridgePlan(rule, { host = "", headers = "", jsLib = "", detailRule = "", bookListRule = "" } = {}) {
  const script = normalizedScript(rule);
  if (!script || script.length > 64 * 1024) return null;
  const baseHeaders = typeof headers === "object" ? headers : {};

  const qdPlan = compileQdSearchPlan(script, { host, headers: baseHeaders, jsLib });
  if (qdPlan) return qdPlan;

  const aesPlan = compileAesPostSearchPlan(script, { host, headers: baseHeaders, detailRule });
  if (aesPlan) return aesPlan;

  const wbiPlan = compileWbiSearchPlan(script, { host, headers: baseHeaders, jsLib });
  if (wbiPlan) return wbiPlan;

  const enrichPlan = compileJsonEnrichSearchPlan(rule, { host, headers: baseHeaders, bookListRule });
  if (enrichPlan) return enrichPlan;

  const signedPlan = signedQuerySearchPlan(script, { host, headers: baseHeaders });
  if (signedPlan) return signedPlan;

  const descriptorPlan = staticDescriptorSearchPlan(script, { host, headers: baseHeaders });
  if (descriptorPlan) return descriptorPlan;

  const hiddenFieldPlan = hiddenFieldSearchPlan(script, { host, headers: baseHeaders });
  if (hiddenFieldPlan) return hiddenFieldPlan;

  const bootstrapUrl = script.match(/\bjava\.ajax\s*\(\s*(["'])(https?:\/\/[^"']+)\1\s*\)/i)?.[2] || "";
  const searchPath = script.match(/\bpostUrl\s*\+\s*(["'])([^"']*\?(?:[^"']*?(?:keyword|query|wd)=)[^"']*)\1/i)?.[2] || "";
  const bootstrapPath = script.match(/\$\{\s*soUrl\s*\}([/A-Za-z0-9._?=&-]+)\x60/i)?.[1]
    || script.match(/\bsoUrl\s*\+\s*(["'])(\/[^"']+)\1/i)?.[2]
    || "";
  if (bootstrapUrl && bootstrapPath && searchPath && /\b(?:soUrl|postUrl)\b/i.test(script)) {
    const path = searchPath
      .replace(/\{\{\s*(?:key|keyword|searchKey)\s*\}\}/gi, "{{keyWord}}")
      .replace(/\{\{\s*(?:page|pageIndex)\s*\}\}/gi, "{{pageIndex}}");
    try {
      return normalizePlan({
        kind: "bootstrap",
        host,
        seedTemplate: bootstrapUrl,
        bootstrapUrl,
        bootstrapPattern: "(?:href=[\"']?|>)(https?:\\/\\/[^\"'<>\\s]+)",
        bootstrapFlags: "i",
        bootstrapGroup: 1,
        responseType: "html",
        headers: baseHeaders,
        request: { method: "GET", urlTemplate: "{{raw:bootstrapHost}}" + bootstrapPath + path },
      });
    } catch { /* continue with ordinary search recognizers */ }
  }

  const directBase = script.match(/\b(?:let|var|const)\s+base\s*=\s*(["'])(https?:\/\/[^"']+)\1/i)?.[2] || "";
  const directPath = script.match(/\b(?:let|var|const)\s+url\s*=\s*base\s*\+\s*(["'])([^"']+)\1/i)?.[2] || "";
  const directBody = script.match(/\b(?:let|var|const)\s+body\s*=\s*(["'])([^"']*)\1\s*\+\s*(?:encodeURIComponent\s*\(\s*)?(?:key|keyword|searchKey)(?:\s*\))?\s*\+\s*(["'])([^"']*)\3/i);
  if (directBase && directPath && directBody) {
    try {
      return normalizePlan({
        kind: "direct",
        host,
        seedTemplate: directBase + directPath,
        responseType: "html",
        headers: baseHeaders,
        request: {
          method: "POST",
          urlTemplate: directBase + directPath,
          bodyTemplate: directBody[2] + "{{keyWord}}" + directBody[4],
          headers: { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        },
      });
    } catch { /* continue with ordinary search recognizers */ }
  }

  // A source-selected host followed by a fixed API path is still a normal
  // GET search once the converter has resolved the host. Accept only literal
  // path pieces and the two standard Xiangse inputs.
  const hostConcat = script.match(
    /\b(?:url|host)\s*\+\s*(["'])([^"']*)\1\s*\+\s*(?:encodeURIComponent\s*\(\s*)?(key|keyword|searchKey)(?:\s*\))?\s*\+\s*(["'])([^"']*)\4\s*\+\s*(page|pageIndex)/i,
  );
  if (hostConcat && /^https?:\/\//i.test(String(host || ""))) {
    const template = `${String(host).replace(/\/$/, "")}/${hostConcat[2].replace(/^\/+/, "")}{{keyWord}}${hostConcat[5]}{{pageIndex}}`;
    try {
      return normalizePlan({
        kind: "static",
        host,
        seedTemplate: "{{host}}",
        headers: baseHeaders,
        request: { method: "GET", urlTemplate: template },
      });
    } catch { /* continue */ }
  }

  // A few otherwise ordinary sources keep the host in a source-comment
  // expression (`{{source.bookSourceComment.match(...)[1]}}/s?q={{key}}`).
  // The expression only selects the already-known source host; once the
  // converter has resolved that host it is a normal, bounded GET template.
  const sourceHostSuffix = String(rule || "").trim().match(/^\{\{\s*source\.[\s\S]*?\}\}([\s\S]*)$/i);
  if (sourceHostSuffix && /^https?:\/\//i.test(String(host || ""))) {
    const suffix = sourceHostSuffix[1].split(/,\s*\{/, 1)[0].trim();
    const template = normalizeTemplate(`${String(host).replace(/\/$/, "")}/${suffix.replace(/^\/+/, "")}`);
    if (template) {
      try {
        return normalizePlan({
          kind: "static",
          host,
          seedTemplate: "{{host}}",
          headers: baseHeaders,
          request: { method: "GET", urlTemplate: template },
        });
      } catch { /* continue with regular request recognizers */ }
    }
  }

  // Public Legado libraries commonly keep the actual search URL in a small
  // pure function (`urlSearchNovel(name, page)`) and let the rule only select
  // which helper to call. Read the static template without executing jsLib;
  // the request remains a bounded GET with normal key/page substitution.
  const searchFunction = String(jsLib || "").match(/function\s+(url(?:Search|Query|Find)[A-Za-z_$]*)\s*\(/i)?.[1] || "";
  const functionTemplate = staticSearchFunctionTemplate(jsLib, searchFunction);
  const usesSearchFunction = searchFunction && (new RegExp(`\\b${searchFunction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "i").test(script)
    || /\burlUserFavorite\s*\(/i.test(script));
  if (functionTemplate && usesSearchFunction) {
    try {
      return normalizePlan({
        kind: "static",
        host,
        seedTemplate: functionTemplate,
        headers: baseHeaders,
        request: { method: "GET", urlTemplate: functionTemplate },
      });
    } catch { /* continue with regular request recognizers */ }
  }

  // A simple request descriptor may be wrapped by a pagination script. The
  // first static request is still a valid portable search operation; paging
  // remains bounded by the normal Xiangse page controls.
  const descriptor = script.match(/^(https?:\/\/[^,\s]+),\s*\{[\s\S]*?\}\s*(?:\n|$)/i);
  if (descriptor) {
    const body = script.match(/["']body["']\s*:\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/i);
    const method = script.match(/["']method["']\s*:\s*["'](POST|GET)["']/i)?.[1] || "GET";
    const bodyTemplate = body ? normalizeTemplate(decodeLiteral(body[1]), { body: true }) : "";
    if (bodyTemplate || method === "GET") {
      try {
        return normalizePlan({
          kind: "static",
          host,
          seedTemplate: descriptor[1],
          headers: baseHeaders,
          request: { method, urlTemplate: descriptor[1], bodyTemplate },
        });
      } catch { /* continue with the dynamic recognizers */ }
    }
  }

  // Some collections interpolate the mirror host in a mustache block and
  // leave a normal request descriptor after it. Once the converter has
  // resolved the source host, the descriptor is a regular portable request.
  const interpolatedPath = script.match(/\}\}\s*(\/[^,\s]+)\s*,/i)?.[1] || "";
  if (interpolatedPath && /(?:search|query)/i.test(interpolatedPath)) {
    const body = bodyTemplateFromScript(script);
    const method = script.match(/["']method["']\s*:\s*["'](POST|GET)["']/i)?.[1] || "GET";
    if (body || method === "GET") {
      try {
        return normalizePlan({
          kind: "static",
          host,
          seedTemplate: "{{host}}",
          headers: baseHeaders,
          request: { method, urlTemplate: `${host.replace(/\/$/, "")}${interpolatedPath}`, bodyTemplate: method === "POST" ? body : "" },
        });
      } catch { /* continue */ }
    }
  }

  // A small family of sites first loads a landing page, then fetches a
  // second page containing literal anti-bot variables before POSTing the
  // search API.  Only string assignments referenced by the body are
  // accepted; computed JavaScript/signing code remains uncompiled.
  const backtickBody = backtickBodyTemplate(script);
  const bootstrapMatch = script.match(/\bjava\.ajax\s*\(\s*(?:source\.(?:key|getKey\s*\(\s*\))|config\.host)\s*\+\s*(["'])([^"']*(?:\?|&)[^"']*)\1\s*\+\s*(?:key|keyword)\s*\)/i);
  const targetExpression = assignmentExpression(script, "url");
  const targetTemplate = targetExpression ? urlTemplate(targetExpression, { host }) : "";
  if (backtickBody?.value && bootstrapMatch && targetTemplate) {
    const variables = backtickBody.fields.filter((name) => !/^(?:key|keyword|searchKey|page|pageIndex)$/i.test(name));
    const bootstrapTemplate = `${host.replace(/\/$/, "")}/${bootstrapMatch[2].replace(/^\/+/, "")}{{keyWord}}`;
    if (variables.length) {
      try {
        return normalizePlan({
          kind: "script-vars",
          host,
          seedTemplate: "{{host}}",
          bootstrapTemplate,
          variables,
          headers: baseHeaders,
          request: { method: "POST", urlTemplate: targetTemplate, bodyTemplate: backtickBody.value },
        });
      } catch { /* continue */ }
    }
  }

  // Redirect-based search endpoints use the final URL of an initial GET as
  // the stable host/path for the actual POST. This is the same data flow as a
  // normal form, without relying on a domain-specific redirect target.
  if (/\bposturl\b/i.test(script) && /\bjava\.get\s*\(/i.test(script) && /["']\/search\/?(?:,)?["']/i.test(script)) {
    const bodyTemplate = bodyTemplateFromScript(script);
    if (bodyTemplate) {
      try {
        return normalizePlan({
          kind: "redirect",
          host,
          seedTemplate: "{{host}}",
          headers: baseHeaders,
          request: { method: "POST", urlTemplate: "{{raw:responseUrl}}/search", bodyTemplate },
        });
      } catch { /* continue */ }
    }
  }

  const fixedPath = script.match(/["'](\/[^"']*?(?:search|query)[^"']*?)(?:,)?["']\s*\+/i)?.[1] || "";
  if (fixedPath) {
    const body = bodyTemplateFromScript(script);
    if (body) {
      try {
        return normalizePlan({
          kind: "static",
          host,
          seedTemplate: "{{host}}",
          headers: baseHeaders,
          extractors: extractorForToken(script) ? [extractorForToken(script)] : [],
          request: { method: "POST", urlTemplate: `${host.replace(/\/$/, "")}${fixedPath}`, bodyTemplate: body },
        });
      } catch { /* continue */ }
    }
  }

  // A GET endpoint that exposes a Location header is equivalent to the
  // redirect form above; following it gives the result page URL directly.
  const directGet = script.match(/java\.get\s*\(\s*(["'])(https?:\/\/[^"']*(?:\?|&)keyboard=)["']\s*\+\s*(?:key|keyword)/i);
  if (directGet) {
    try {
      return normalizePlan({
        kind: "redirect",
        host,
        seedTemplate: `${directGet[2]}{{keyWord}}`,
        headers: baseHeaders,
        request: { method: "GET", urlTemplate: "{{raw:responseUrl}}" },
      });
    } catch { /* continue */ }
  }

  const requestCall = script.match(/\bjava\.(?:ajax|connect|get)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/i);
  const requestName = requestCall?.[1] || "";
  const seedExpression = requestName ? assignmentExpression(script, requestName) : "";
  const seedTemplate = urlTemplate(seedExpression || "source.getKey()", { host });
  if (!seedTemplate) return null;

  const bodyTemplate = bodyTemplateFromScript(script);
  const method = (script.match(/(?:["']method["']\s*:\s*|\bmethod\s*:\s*)["'](POST|GET)["']/i)?.[1]
    || (bodyTemplate ? "POST" : "GET")).toUpperCase();
  const action = formActionPattern(script);
  const querySuffix = directQuerySuffix(script);
  const token = extractorForToken(script);
  const extractors = token ? [token] : [];

  // Form-action discovery is valid for both POST forms and GET search forms.
  if (action && (bodyTemplate || querySuffix)) {
    const requestBody = bodyTemplate;
    try {
      return normalizePlan({
        kind: "form",
        host,
        seedTemplate,
        headers: baseHeaders,
        action: { ...action, group: 1 },
        extractors,
        request: {
          method,
          urlTemplate: method === "GET" ? `{{raw:action}}${querySuffix}` : "{{raw:action}}",
          bodyTemplate: method === "POST" ? requestBody : "",
        },
      });
    } catch { /* continue */ }
  }

  // Some sources explicitly append a stable path to the source host and put
  // the keyword in the query string. Accept only literal path/query pieces.
  const directUrl = directQueryTemplate(script, host);
  if (directUrl) {
    try {
      return normalizePlan({
        kind: "static",
        host,
        seedTemplate,
        headers: baseHeaders,
        request: { method: "GET", urlTemplate: directUrl },
      });
    } catch { /* continue */ }
  }

  return null;
}

export function encodeSearchPlan(plan) {
  const normalized = normalizePlan(plan);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_PLAN_BYTES) throw new TypeError("搜索桥接计划过大");
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeSearchPlan(encoded) {
  const value = String(encoded || "");
  if (!value || value.length > MAX_PLAN_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("搜索桥接计划编码无效");
  }
  try { return normalizePlan(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("搜索桥接计划不是有效 JSON");
  }
}

function mergeCookies(current, response) {
  const cookies = new Map();
  for (const part of String(current || "").split(/;\s*/)) {
    const match = part.match(/^([^=;\s]+)=([^;]*)$/);
    if (match) cookies.set(match[1], match[2]);
  }
  const headers = response?.httpHeaders || {};
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"] ?? [];
  for (const item of (Array.isArray(raw) ? raw : [raw])) {
    const match = String(item || "").match(/^([^=;\s]+)=([^;]*)/);
    if (match) cookies.set(match[1], match[2]);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function expandTemplate(template, values, { encode = true } = {}) {
  return String(template || "").replace(/\{\{(raw:)?([A-Za-z_$][\w$]*)\}\}/g, (_all, raw, name) => {
    const value = values[name] ?? "";
    return raw || !encode ? String(value) : encodeURIComponent(String(value));
  });
}

function resolveUrl(template, baseUrl, host) {
  try { return new URL(template, baseUrl || host || undefined).toString(); } catch { return ""; }
}

function signedSearchUrl(endpoint, query, sign) {
  const values = {};
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    values[name] = String(value);
  }
  const field = String(sign?.field || "sign");
  const canonical = Object.keys(values).sort().map((name) => name + "=" + values[name]).join("") + String(sign?.key || "");
  values[field] = createHash("md5").update(canonical, "utf8").digest("hex");
  return String(endpoint || "").replace(/[?&]+$/, "") + "?" + Object.entries(values)
    .map(([name, value]) => encodeURIComponent(name) + "=" + encodeURIComponent(value)).join("&");
}

function signedSearchHeader(headers, sign) {
  const field = String(sign?.field || "sign").toLowerCase();
  const values = Object.fromEntries(Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== field));
  const canonical = Object.keys(values).sort((left, right) => left.localeCompare(right))
    .map((name) => name + "=" + values[name]).join("") + String(sign?.key || "");
  return createHash("md5").update(canonical, "utf8").digest("hex");
}

function expandSearchPayload(value, values) {
  if (typeof value === "string") {
    return value.replace(/\{\{(raw:)?([A-Za-z_$][\w$]*)\}\}/g, (_all, _raw, name) => String(values[name] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => expandSearchPayload(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expandSearchPayload(item, values)]));
  }
  return value;
}

function cryptoBytes(value, encoding) {
  const source = String(value || "");
  if (encoding === "base64") {
    try { return Buffer.from(source, "base64"); } catch { return null; }
  }
  if (encoding === "hex") {
    try { return Buffer.from(source, "hex"); } catch { return null; }
  }
  return Buffer.from(source, "utf8");
}

function jsonPathValue(input, path) {
  let value = input;
  for (const key of String(path || "").split(".").filter(Boolean)) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

async function executeAesPostSearch(plan, descriptor, values, { download, signal } = {}) {
  const key = cryptoBytes(plan.crypto.key, plan.crypto.keyEncoding);
  const iv = cryptoBytes(plan.crypto.iv, plan.crypto.ivEncoding);
  if (!key || !iv || ![16, 24, 32].includes(key.length) || iv.length !== 16) {
    throw new Error("搜索 AES 密钥参数无效");
  }
  const signSource = expandTemplate(descriptor.signTemplate, values, { encode: false });
  let sign = createHash("md5").update(signSource, "utf8").digest("hex");
  if (descriptor.signUppercase) sign = sign.toUpperCase();
  const payload = expandSearchPayload(descriptor.payload, { ...values, sign });
  const cipher = createCipheriv("aes-" + (key.length * 8) + "-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
  const envelopeField = String(plan.request.envelopeField || "c");
  const body = JSON.stringify({ [envelopeField]: encrypted });
  const requestUrl = resolveUrl(
    expandTemplate(descriptor.urlTemplate, values, { encode: false }),
    plan.host,
    plan.host,
  );
  if (!requestUrl) throw new Error("搜索 AES 请求地址无效");
  const response = await download(requestUrl, {
    ...plan.headers,
    ...(plan.request.headers || {}),
    "Content-Type": "application/json",
    Referer: plan.headers.Referer || plan.host,
  }, {
    method: "POST",
    body,
    followPostRedirects: true,
    ...(signal ? { signal } : {}),
  });
  const responseText = decodeTextBuffer(response, { headers: response?.httpHeaders || {} });
  let outer;
  try { outer = JSON.parse(responseText); } catch { throw new Error("搜索 AES 响应不是 JSON"); }
  const encoded = jsonPathValue(outer, plan.crypto.responsePath);
  const encryptedResponse = cryptoBytes(encoded, plan.crypto.encoding);
  if (!encryptedResponse) throw new Error("搜索 AES 响应密文为空");
  try {
    const decipher = createDecipheriv("aes-" + (key.length * 8) + "-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(encryptedResponse), decipher.final()]);
    Object.defineProperty(plain, "httpHeaders", { value: { ...(response.httpHeaders || {}), "content-type": "application/json; charset=utf-8" } });
    Object.defineProperty(plain, "read2xsggResponseUrl", { value: response.read2xsggResponseUrl || requestUrl });
    return plain;
  } catch {
    throw new Error("搜索 AES 响应解密失败");
  }
}

function wbiFileKey(value) {
  try {
    const url = new URL(String(value || ""));
    const name = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return name.split(".", 1)[0] || "";
  } catch {
    return "";
  }
}

async function executeWbiSearch(plan, values, { download, signal } = {}) {
  const navUrl = resolveUrl(plan.wbi.navUrl, plan.host, plan.host);
  if (!navUrl) throw new Error("搜索 WBI 导航地址无效");
  const nav = await download(navUrl, plan.headers, { method: "GET", ...(signal ? { signal } : {}) });
  let parsed;
  try { parsed = JSON.parse(decodeTextBuffer(nav, { headers: nav?.httpHeaders || {} })); } catch { throw new Error("搜索 WBI 导航响应不是 JSON"); }
  const imgUrl = jsonPathValue(parsed, "data.wbi_img.img_url");
  const subUrl = jsonPathValue(parsed, "data.wbi_img.sub_url");
  const imgKey = wbiFileKey(imgUrl);
  const subKey = wbiFileKey(subUrl);
  const original = imgKey + subKey;
  if (original.length < 64) throw new Error("搜索 WBI 导航响应缺少签名密钥");
  const mixin = plan.wbi.table.map((index) => original[index]).join("").slice(0, 32);
  const prefix = String(values.keyWord || "").slice(0, 1);
  const typed = Boolean(plan.wbi.typeUrl && plan.wbi.prefixes?.[prefix]);
  const queryTemplate = typed && Object.keys(plan.wbi.typeQuery || {}).length
    ? plan.wbi.typeQuery
    : plan.wbi.query;
  const queryValues = expandSearchPayload(queryTemplate, {
    ...values,
    keyWord: typed ? String(values.keyWord || "").slice(1) : values.keyWord,
    type: typed ? plan.wbi.prefixes[prefix] : "",
  });
  queryValues.wts = values.time;
  const query = Object.keys(queryValues).sort().map((name) => {
    const filtered = String(queryValues[name] ?? "").replace(/[!'()*]/g, "");
    return encodeURIComponent(name) + "=" + encodeURIComponent(filtered);
  }).join("&");
  const signed = query + "&w_rid=" + createHash("md5").update(query + mixin, "utf8").digest("hex");
  const endpoint = typed ? plan.wbi.typeUrl : plan.request.urlTemplate;
  const requestUrl = resolveUrl(endpoint + (endpoint.includes("?") ? "" : "?") + signed, plan.host, plan.host);
  if (!requestUrl) throw new Error("搜索 WBI 请求地址无效");
  const response = await download(requestUrl, {
    ...plan.headers,
    Referer: plan.headers.Referer || plan.host,
  }, { method: "GET", ...(signal ? { signal } : {}) });
  return response;
}

async function executeJsonEnrichSearch(plan, values, { download, signal } = {}) {
  const requestUrl = resolveUrl(
    expandTemplate(plan.request.urlTemplate, values),
    plan.host,
    plan.host,
  );
  if (!requestUrl) throw new Error("搜索 JSON 补全初始地址无效");
  const initial = await download(requestUrl, plan.headers, { method: "GET", ...(signal ? { signal } : {}) });
  let parsed;
  try { parsed = JSON.parse(decodeTextBuffer(initial, { headers: initial?.httpHeaders || {} })); } catch { throw new Error("搜索 JSON 补全初始响应不是 JSON"); }
  const root = jsonPathValue(parsed, plan.enrich.responsePath);
  const rows = Array.isArray(root) ? root : (root && typeof root === "object" ? [root] : []);
  if (!rows.length) throw new Error("搜索 JSON 补全没有列表数据");
  const output = new Array(rows.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      const row = rows[index];
      const bid = row && typeof row === "object" ? row[plan.enrich.idField] : "";
      if (bid === undefined || bid === null || String(bid) === "") continue;
      try {
        const bootstrapUrl = resolveUrl(
          expandTemplate(plan.enrich.bootstrapUrlTemplate, { bid: String(bid) }),
          requestUrl,
          plan.host,
        );
        if (!bootstrapUrl) continue;
        const bootstrap = await download(bootstrapUrl, {
          ...plan.headers,
          Referer: requestUrl,
        }, { method: "GET", ...(signal ? { signal } : {}) });
        const bootstrapText = decodeTextBuffer(bootstrap, { headers: bootstrap?.httpHeaders || {} });
        const found = bootstrapText.match(new RegExp(plan.enrich.keyPattern, plan.enrich.keyFlags));
        const scpubKey = found?.[plan.enrich.keyGroup] || "";
        if (!scpubKey) continue;
        const fields = {
          bid: String(bid),
          userId: plan.enrich.userId,
          time: values.time,
          scpubKey,
        };
        fields.sign = createHash("md5")
          .update(expandTemplate(plan.enrich.signTemplate, fields, { encode: false }), "utf8")
          .digest("hex");
        const chapterUrl = expandTemplate(plan.enrich.urlTemplate, fields);
        if (!chapterUrl) continue;
        output[index] = { ...row, [plan.enrich.urlField]: chapterUrl };
      } catch {
        // A single mirror/bootstrap failure must not discard other search rows.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, rows.length) }, () => worker()));
  const data = output.filter(Boolean);
  if (!data.length) throw new Error("搜索 JSON 补全没有可用详情地址");
  const body = Buffer.from(JSON.stringify({ data }), "utf8");
  Object.defineProperty(body, "httpHeaders", { value: { ...(initial.httpHeaders || {}), "content-type": "application/json; charset=utf-8" } });
  Object.defineProperty(body, "read2xsggResponseUrl", { value: initial.read2xsggResponseUrl || requestUrl });
  return body;
}

function qdNetworkQuery(query) {
  return String(query || "").split("&").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return encodeURIComponent(part);
    return encodeURIComponent(part.slice(0, separator)) + "=" + encodeURIComponent(part.slice(separator + 1));
  }).join("&");
}

async function executeQdSearch(plan, values, { download, signal } = {}) {
  const requestValues = plan.qd.valueMode === "bookId"
    ? { ...values, value: qdBookIdFromInput(values.value) }
    : values;
  if (plan.qd.valueMode === "bookId" && !requestValues.value) {
    throw new Error("QD 详情请求缺少书籍 ID");
  }
  const params = plan.qd.params.map((template) => expandTemplate(template, requestValues, { encode: false }));
  const signature = qdSignatureHeaders(params, {
    host: plan.host,
    config: plan.qd,
    timestamp: Date.now(),
  });
  if (!signature) throw new Error("QD 搜索签名生成失败");
  const endpoint = plan.qd.endpoint.replace(/\/+$/, "") + "/" + plan.qd.path.replace(/^\/+/, "");
  const requestUrl = resolveUrl(endpoint + "?" + qdNetworkQuery(signature.query), plan.host, plan.host);
  if (!requestUrl) throw new Error("QD 搜索请求地址无效");
  const response = await download(requestUrl, {
    ...plan.headers,
    ...(plan.request.headers || {}),
    QDSign: signature.QDSign,
    QDInfo: signature.QDInfo,
    tstamp: signature.tstamp,
    Referer: plan.headers.Referer || plan.host,
  }, { method: "GET", ...(signal ? { signal } : {}) });
  if (plan.qd.valueMode !== "bookId") return response;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(response).toString("utf8"));
  } catch {
    throw new Error("QD 详情 API 返回的不是有效 JSON");
  }
  if (payload && payload.Result !== undefined && Number(payload.Result) !== 0) {
    throw new Error(`QD 详情 API 返回 Result=${String(payload.Result).slice(0, 32)}`);
  }
  const detail = plan.qd.resultPath.split(".").reduce((value, key) => value?.[key], payload);
  if (detail === undefined || detail === null || typeof detail !== "object") {
    throw new Error(`QD 详情 API 响应缺少 init 声明节点 ${plan.qd.resultPath}`);
  }
  const body = Buffer.from(JSON.stringify(detail), "utf8");
  Object.defineProperty(body, "httpHeaders", {
    value: { ...(response?.httpHeaders || {}), "content-type": "application/json; charset=utf-8" },
  });
  Object.defineProperty(body, "read2xsggResponseUrl", {
    value: response?.read2xsggResponseUrl || requestUrl,
  });
  return body;
}

export async function executeSearchPlan(planValue, {
  keyWord = "",
  pageIndex = 1,
  value = "",
  download,
  signal,
} = {}) {
  const plan = normalizePlan(planValue);
  if (typeof download !== "function") throw new TypeError("搜索桥接计划需要下载器");
  const values = {
    host: plan.host,
    keyWord: String(keyWord || ""),
    pageIndex: String(Math.max(1, Number.parseInt(pageIndex, 10) || 1)),
    value: String(value || ""),
    time: String(Math.floor(Date.now() / 1000)),
  };
  if (plan.kind === "aes-post-json") {
    const descriptor = values.value && plan.detail
      ? plan.detail
      : plan.request;
    return executeAesPostSearch(plan, descriptor, values, { download, signal });
  }
  if (plan.kind === "wbi") {
    return executeWbiSearch(plan, values, { download, signal });
  }
  if (plan.kind === "json-enrich") {
    return executeJsonEnrichSearch(plan, values, { download, signal });
  }
  if (plan.kind === "qd-sign-json") {
    return executeQdSearch(plan, values, { download, signal });
  }
  values.pageIndexMinusOne = String(Math.max(0, Number(values.pageIndex) - 1));
  if (plan.kind === "signed") {
    const query = Object.fromEntries(Object.entries(plan.request.query || {}).map(([name, template]) => [
      name,
      expandTemplate(template, values, { encode: false }),
    ]));
    const requestUrl = signedSearchUrl(plan.request.urlTemplate, query, plan.request.sign);
    const requestHeaders = Object.fromEntries(Object.entries(plan.request.headers || {}).map(([name, value]) => [
      name,
      expandTemplate(value, values, { encode: false }),
    ]));
    if (plan.request.headerSign) {
      requestHeaders[plan.request.sign.field] = signedSearchHeader(requestHeaders, plan.request.sign);
    }
    return download(requestUrl, {
      ...requestHeaders,
      Referer: requestHeaders.Referer || plan.host,
    }, { method: "GET", ...(signal ? { signal } : {}) });
  }
  if (plan.kind === "direct") {
    const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, values, { encode: false }), plan.host, plan.host);
    if (!requestUrl) throw new Error("搜索直连地址无效");
    const body = plan.request.bodyTemplate ? expandTemplate(plan.request.bodyTemplate, values) : undefined;
    const headers = Object.fromEntries(Object.entries(plan.request.headers || plan.headers || {}).map(([name, value]) => [
      name,
      expandTemplate(value, values, { encode: false }),
    ]));
    if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    return download(requestUrl, {
      ...headers,
      Referer: headers.Referer || plan.host,
    }, {
      method: plan.request.method,
      ...(body !== undefined ? { body, followPostRedirects: true } : {}),
      ...(signal ? { signal } : {}),
    });
  }
  if (plan.kind === "bootstrap") {
    const bootstrapUrl = resolveUrl(plan.bootstrapUrl, plan.host, plan.host);
    if (!bootstrapUrl) throw new Error("搜索最新地址引导地址无效");
    const initial = await download(bootstrapUrl, plan.headers, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    const initialText = decodeTextBuffer(initial, { headers: initial?.httpHeaders || {} });
    const found = initialText.match(new RegExp(plan.bootstrapPattern, plan.bootstrapFlags));
    values.bootstrapHost = found?.[plan.bootstrapGroup] || "";
    if (!/^https?:\/\//i.test(values.bootstrapHost)) throw new Error("搜索最新地址引导页未发现有效地址");
    const cookie = mergeCookies(plan.headers.Cookie || plan.headers.cookie || "", initial);
    const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, values), bootstrapUrl, plan.host);
    if (!requestUrl) throw new Error("搜索最新地址请求地址无效");
    return download(requestUrl, {
      ...plan.headers,
      Referer: plan.headers.Referer || bootstrapUrl,
      ...(cookie ? { Cookie: cookie } : {}),
    }, { method: plan.request.method, ...(signal ? { signal } : {}) });
  }
  const seedUrl = resolveUrl(expandTemplate(plan.seedTemplate, values, { encode: false }), plan.host, plan.host);
  if (!seedUrl) throw new Error("搜索引导地址无效");
  const initial = await download(seedUrl, plan.headers, { method: "GET", ...(signal ? { signal } : {}) });
  let cookie = mergeCookies(plan.headers.Cookie || plan.headers.cookie || "", initial);
  const initialText = decodeTextBuffer(initial, { headers: initial?.httpHeaders || {} });
  if (plan.kind === "redirect") values.responseUrl = String(initial.read2xsggResponseUrl || seedUrl).replace(/\/+$/, "");
  if (plan.kind === "script-vars") {
    const bootstrapUrl = resolveUrl(expandTemplate(plan.bootstrapTemplate, values, { encode: false }), seedUrl, plan.host);
    if (!bootstrapUrl) throw new Error("搜索变量引导地址无效");
    const bootstrap = await download(bootstrapUrl, {
      ...plan.headers,
      Referer: seedUrl,
      ...(cookie ? { Cookie: cookie } : {}),
    }, { method: "GET", ...(signal ? { signal } : {}) });
    cookie = mergeCookies(cookie, bootstrap);
    const bootstrapText = decodeTextBuffer(bootstrap, { headers: bootstrap?.httpHeaders || {} });
    for (const name of plan.variables || []) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = bootstrapText.match(new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
      values[name] = match?.[1] || "";
      if (!values[name]) throw new Error(`搜索变量 ${name} 未从引导页解析到`);
    }
  }
  if (plan.action) {
    const found = initialText.match(new RegExp(plan.action.pattern, plan.action.flags));
    values.action = found?.[plan.action.group] || "";
    if (!values.action) throw new Error("搜索表单未发现 action");
  }
  for (const extractor of plan.extractors || []) {
    const found = initialText.match(new RegExp(extractor.pattern, extractor.flags));
    values[extractor.name] = found?.[extractor.group] || "";
  }
  const requestUrl = resolveUrl(expandTemplate(plan.request.urlTemplate, values), seedUrl, plan.host);
  if (!requestUrl) throw new Error("搜索请求地址无效");
  let body;
  if (plan.request.bodyTemplate) body = expandTemplate(plan.request.bodyTemplate, values);
  let finalUrl = requestUrl;
  if (plan.request.method === "GET" && body) {
    finalUrl += (finalUrl.includes("?") ? "&" : "?") + body;
    body = undefined;
  }
  const requestHeaders = Object.fromEntries(Object.entries(plan.request.headers || {}).map(([name, value]) => [
    name,
    expandTemplate(value, values, { encode: false }),
  ]));
  const response = await download(finalUrl, {
    ...Object.fromEntries(Object.entries(plan.headers || {}).map(([name, value]) => [
      name,
      expandTemplate(value, values, { encode: false }),
    ])),
    ...requestHeaders,
    Referer: requestHeaders.Referer || expandTemplate(plan.headers.Referer || "", values, { encode: false }) || seedUrl,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(body !== undefined ? { "Content-Type": requestHeaders["Content-Type"] || "application/x-www-form-urlencoded" } : {}),
  }, {
    method: plan.request.method,
    ...(body !== undefined ? { body, followPostRedirects: true } : {}),
    ...(signal ? { signal } : {}),
  });
  cookie = mergeCookies(cookie, response);
  return response;
}
