/** Xiangse Windows code page for GBK / GB2312 / GB18030. */
export const XIANGSE_GBK_ENCODE = "2147485234";

export function normalizeCharsetName(value) {
  const charset = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!charset) return "";
  if (/^(?:gbk|gb2312|gb18030|cp936)$/i.test(charset)) return "gbk";
  if (/^utf-?8$/i.test(charset)) return "utf-8";
  return charset;
}

/**
 * Infer response/request charset from a Legado source definition.
 * Many HTML novel sites only mark charset on searchUrl, but the whole site is GBK.
 */
export function detectLegadoCharset(source) {
  const named = normalizeCharsetName(
    source?.bookSourceCharset || source?.sourceCharset || source?.charset || "",
  );
  if (named === "gbk" || named === "utf-8") return named;

  const fields = [
    source?.searchUrl,
    source?.exploreUrl,
    typeof source?.header === "string" ? source.header : JSON.stringify(source?.header || {}),
  ];
  for (const field of fields) {
    const text = String(field || "");
    const match = text.match(/charset["']?\s*[:=]\s*["']?\s*(gbk|gb2312|gb18030|cp936|utf-?8)/i);
    if (match) return normalizeCharsetName(match[1]);
  }
  return "";
}

export function xiangseEncodeFields(charset) {
  return normalizeCharsetName(charset) === "gbk"
    ? { requestParamsEncode: XIANGSE_GBK_ENCODE, responseEncode: XIANGSE_GBK_ENCODE }
    : {};
}

export function isXiangseGbkEncode(action) {
  return String(action?.responseEncode || action?.requestParamsEncode || "") === XIANGSE_GBK_ENCODE
    || normalizeCharsetName(action?.charset) === "gbk";
}

export function sniffCharsetFromHtml(buffer, headers = {}) {
  const contentType = String(headers["content-type"] || headers["Content-Type"] || "");
  const fromHeader = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  if (fromHeader) {
    const normalized = normalizeCharsetName(fromHeader);
    if (normalized) return normalized;
  }
  const head = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, Math.min(buffer.length, 8192)).toString("latin1")
    : String(buffer || "").slice(0, 8192);
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)
    || head.match(/<meta[^>]+content=["'][^"']*charset\s*=\s*([a-z0-9_-]+)/i);
  if (meta?.[1]) {
    const normalized = normalizeCharsetName(meta[1]);
    if (normalized) return normalized;
  }
  return "";
}

/**
 * Decode a downloaded page buffer. Prefer an explicit plan/source hint, then
 * HTTP / meta charset, then UTF-8.
 */
export function decodeTextBuffer(buffer, { headers = {}, charsetHint = "" } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ""), "utf8");
  const preferred = normalizeCharsetName(charsetHint)
    || sniffCharsetFromHtml(bytes, headers)
    || "utf-8";
  if (preferred === "gbk") {
    for (const label of ["gbk", "gb18030"]) {
      try { return new TextDecoder(label).decode(bytes); } catch { /* try next */ }
    }
  }
  if (preferred !== "utf-8") {
    try { return new TextDecoder(preferred).decode(bytes); } catch { /* fall through */ }
  }
  return bytes.toString("utf8");
}
