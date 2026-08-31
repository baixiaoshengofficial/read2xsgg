import { createHash } from "node:crypto";

const MAX_PLAN_CHARS = 8_192;
const TOKEN = /\{\{(keyWord|pageIndex|value)\}\}/g;

function decodeLiteral(value) {
  const text = String(value || "").trim();
  if (!/^(["'])[\s\S]*\1$/.test(text)) return null;
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  return text.slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function queryTemplate(expression) {
  const parts = String(expression || "").trim().split(/\s*\+\s*/);
  if (!parts.length || parts.length > 32) return null;
  let template = "";
  let valueField = "";
  for (const part of parts) {
    const literal = decodeLiteral(part);
    if (literal !== null) {
      template += literal.replace(/\{\{\s*\$\.([A-Za-z_$][\w$]{0,63})\s*\}\}/g, (_all, field) => {
        if (valueField && valueField !== field) return "";
        valueField = field;
        return "{{value}}";
      });
      continue;
    }
    if (/^(?:key|keyword)$/i.test(part.trim())) template += "{{keyWord}}";
    else if (/^(?:page|pageIndex)$/i.test(part.trim())) template += "{{pageIndex}}";
    else return null;
  }
  if (!template || /[\r\n]/.test(template)) return null;
  return { template, valueField };
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const endpoint = String(value.endpoint || "");
  const query = String(value.query || "");
  const header = String(value.signatureHeader || "");
  const prefix = String(value.signaturePrefix || "");
  const suffix = String(value.signatureSuffix || "");
  const valueField = String(value.valueField || "");
  if (!/^https?:\/\/[^<>\r\n]{1,2048}\?$/.test(endpoint)) return null;
  if (!query || query.length > 4_096 || /[<>\r\n]/.test(query)) return null;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(header)) return null;
  if ((!prefix && !suffix) || prefix.length > 256 || suffix.length > 256) return null;
  if (valueField && !/^[A-Za-z_$][\w$]{0,63}$/.test(valueField)) return null;
  const unknown = query.replace(TOKEN, "");
  if (/\{\{/.test(unknown)) return null;
  return {
    version: 1,
    endpoint,
    query,
    signatureHeader: header,
    signaturePrefix: prefix,
    signatureSuffix: suffix,
    ...(valueField ? { valueField } : {}),
  };
}

/** Compile the common Legado pattern query → md5(query + secret) → header. */
export function compileSignedRequestPlan(rule) {
  const source = String(rule || "").replace(/^\s*(?:@js:|<js>)\s*/i, "").replace(/<\/js>\s*$/i, "");
  const body = source.match(/\bbody\s*=\s*([^;]{1,4096});/i);
  if (!body) return null;
  const compiledQuery = queryTemplate(body[1]);
  if (!compiledQuery) return null;
  const endpoint = source.match(/\burl\s*=\s*(["'])(https?:\/\/[^"'\r\n]+\?)\1\s*\+\s*body\b/i)?.[2];
  if (!endpoint) return null;
  const signature = source.match(/(?:java\.)?md5Encode\s*\(\s*(?:(["'])([^"']{1,256})\1\s*\+\s*)?body(?:\s*\+\s*(["'])([^"']{1,256})\3)?\s*\)/i);
  if (!signature) return null;
  const signatureHeader = source.match(/["']([!#$%&'*+.^_`|~0-9A-Za-z-]{1,64})["']\s*:\s*String\s*\(\s*sign\s*\)/i)?.[1];
  if (!signatureHeader) return null;
  return normalizePlan({
    endpoint,
    query: compiledQuery.template,
    signatureHeader,
    signaturePrefix: signature[2] || "",
    signatureSuffix: signature[4] || "",
    valueField: compiledQuery.valueField,
  });
}

export function encodeSignedRequestPlan(plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) throw new TypeError("签名请求计划无效");
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  if (encoded.length > MAX_PLAN_CHARS) throw new TypeError("签名请求计划过大");
  return encoded;
}

export function decodeSignedRequestPlan(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > MAX_PLAN_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("签名请求计划编码无效");
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch {
    throw new TypeError("签名请求计划不是有效 JSON");
  }
  const normalized = normalizePlan(parsed);
  if (!normalized) throw new TypeError("签名请求计划无效");
  return normalized;
}

export function signedRequestTarget(plan, params = {}) {
  const normalized = normalizePlan(plan);
  if (!normalized) throw new TypeError("签名请求计划无效");
  const values = {
    keyWord: String(params.keyWord || ""),
    pageIndex: String(Math.max(1, Number.parseInt(params.pageIndex, 10) || 1)),
    value: String(params.value || ""),
  };
  if (normalized.valueField && !values.value) throw new TypeError("签名请求缺少条目字段值");
  const query = normalized.query.replace(TOKEN, (_all, name) => values[name]);
  const signature = createHash("md5")
    .update(`${normalized.signaturePrefix}${query}${normalized.signatureSuffix}`)
    .digest("hex");
  return {
    url: new URL(`${normalized.endpoint}${query}`).toString(),
    headers: { [normalized.signatureHeader]: signature },
  };
}
