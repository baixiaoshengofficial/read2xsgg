import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

const BLOCK_SIZE = 8;

function text(value) {
  return String(value ?? "");
}

function keyBytes(value) {
  const source = text(value);
  return source.length === 24 ? Buffer.from(source, "utf8") : null;
}

function ivBytes(value) {
  const source = text(value);
  return source.length === BLOCK_SIZE ? Buffer.from(source, "utf8") : null;
}

export function tripleDesCbcBase64(value, key, iv = "") {
  const keyBuffer = keyBytes(key);
  const ivBuffer = iv ? ivBytes(iv) : Buffer.alloc(BLOCK_SIZE);
  if (!keyBuffer || !ivBuffer) return "";
  try {
    const cipher = createCipheriv("des-ede3-cbc", keyBuffer, ivBuffer);
    return Buffer.concat([cipher.update(text(value), "utf8"), cipher.final()]).toString("base64");
  } catch {
    return "";
  }
}

function literal(source) {
  const match = String(source || "").match(/\bQDSign\s*:\s*\{\s*key\s*:\s*(?:String\.fromCharCode\s*\([^)]*\)|(["'])([^"']*)\1)/i);
  return match?.[2] || "";
}

export function qdCryptoConfig(jsLib) {
  const source = String(jsLib || "");
  const signKey = literal(source);
  const signIv = source.match(/QDSign[\s\S]{0,240}?\biv\s*:\s*(["'])([^"']*)\1/i)?.[2] || "";
  const infoKey = source.match(/QDInfo[\s\S]{0,240}?\bkey\s*:\s*(["'])([^"']*)\1/i)?.[2] || "";
  if (signKey.length !== 24 || signIv.length !== 8 || infoKey.length !== 24) return null;
  return { signKey, signIv, infoKey, infoIv: "" };
}

/** Extract the API root from either a QDSign object literal or local variable. */
export function qdApiEndpoint(jsLib) {
  const source = String(jsLib || "");
  const endpoint = source.match(
    /\burl\s*[:=]\s*(["'])(https?:\/\/[^"']+\/argus\/api\/?)\1\s*\+\s*path/i,
  )?.[2];
  return endpoint || "https://druidv6.if.qidian.com/argus/api/";
}

export function qdContentCryptoConfig(jsLib) {
  const source = String(jsLib || "");
  const functionBody = source.match(/function\s+dContentQD\s*\([^)]*\)\s*\{([\s\S]{0,8192}?)\n\}/i)?.[1] || "";
  if (!functionBody || !/HMacBase64\s*\(/i.test(functionBody)
    || !/DESede\/CBC\/PKCS5Padding/i.test(functionBody)) return null;
  const key1 = functionBody.match(/base64Decode\s*\(\s*(["'])([A-Za-z0-9+/=]+)\1\s*\)/i)?.[2] || "";
  const key3Prefix = functionBody.match(/hexDecodeToByteArray\s*\(\s*(["'])([0-9a-f]+)\1\s*\+\s*key2/i)?.[2] || "";
  const salt = functionBody.match(/\bsha1\s*=\s*["'][^"']*["']\s*\+\s*aid\s*\+\s*cid\s*\+\s*(["'])([^"']+)\1/i)?.[2] || "";
  if (!key1 || !key3Prefix || !salt || key3Prefix.length % 2 !== 0) return null;
  return { key1, key3Prefix, salt };
}

export function qdDeviceId(host = "") {
  return createHash("sha256").update(text(host), "utf8").digest("hex").slice(0, 16);
}

export function decryptQdChapterBytes(value, { host = "", chapterId = "", key1, key3Prefix, salt } = {}) {
  const source = Buffer.from(value || []);
  if (source.length <= 24 || !chapterId || !key1 || !key3Prefix || !salt) return "";
  const aid = qdDeviceId(host);
  const hmacInput = "0" + aid + text(chapterId) + salt;
  const key0 = createHmac("sha1", aid).update(hmacInput, "utf8").digest("base64").slice(0, -4);
  const key1Text = Buffer.from(key1, "base64").toString("utf8");
  const key2 = createHash("md5").update(key1Text + key0 + aid, "utf8").digest("hex");
  const key3 = Buffer.from(key3Prefix + key2, "hex");
  const key = createHash("md5").update(key3).digest("base64");
  const encrypted = source.subarray(8, source.length - 16);
  const iv = Buffer.alloc(BLOCK_SIZE);
  try {
    const inner = requireDesDecrypt(encrypted, key, iv);
    const plain = requireDesDecrypt(inner, key0, iv);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

function requireDesDecrypt(input, secret, iv) {
  const decipher = createDecipheriv("des-ede3-cbc", Buffer.from(secret, "utf8"), iv);
  return Buffer.concat([decipher.update(input), decipher.final()]);
}

export function qdSignatureHeaders(params, { host = "", config, timestamp = Date.now() } = {}) {
  if (!config || !Array.isArray(params)) return null;
  const query = params.map((value) => text(value)).sort().join("&");
  const time = String(timestamp);
  const digest = createHash("md5").update(query.toLowerCase(), "utf8").digest("hex");
  const sign = tripleDesCbcBase64("Rv1rPTnczce|" + time + "||||||" + digest, config.signKey, config.signIv);
  const info = tripleDesCbcBase64(qdDeviceId(host) + "||||||1||999|" + time, config.infoKey);
  if (!sign || !info) return null;
  return { QDSign: sign, QDInfo: info, tstamp: time, query };
}

export function decodeQdValue(value) {
  let source = text(value).trim();
  if (!source) return "";
  if (/^data:/i.test(source)) {
    const comma = source.indexOf(",");
    if (comma < 0) return "";
    const metadata = source.slice(0, comma);
    const payload = source.slice(comma + 1).split(",", 1)[0];
    try {
      source = /;base64(?:;|$)/i.test(metadata)
        ? Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
        : decodeURIComponent(payload);
    } catch {
      return "";
    }
  }
  try {
    const parsed = JSON.parse(source);
    if (typeof parsed === "string") source = parsed;
  } catch { /* the value may be a plain id */ }
  if (/^(?:[0-9a-f]{2})+$/i.test(source)) {
    try {
      const decoded = Buffer.from(source, "hex").toString("utf8").trim();
      if (/^\d+$/.test(decoded)) return decoded;
    } catch { /* keep the original value */ }
  }
  if (/^\d+$/.test(source)) return source;
  return source;
}

/** Resolve the QD book identifier carried by a detail URL or opaque data URL. */
export function qdBookIdFromInput(input) {
  const decoded = decodeQdValue(input);
  try {
    const value = JSON.parse(decoded);
    const id = value && typeof value === "object"
      ? value.bookId ?? value.book_id ?? value.BookId ?? value.id
      : value;
    if (/^\d+$/.test(String(id ?? ""))) return String(id);
  } catch { /* continue with URL/plain identifier forms */ }
  try {
    const parsed = new URL(decoded);
    const queryId = parsed.searchParams.get("bookId") || parsed.searchParams.get("book_id");
    if (/^\d+$/.test(String(queryId || ""))) return String(queryId);
  } catch { /* input may be a path or a plain ID */ }
  if (/^\d+$/.test(decoded)) return decoded;
  return decoded.match(/(?:^|\D)(\d+)(?:\D|$)/)?.[1] || "";
}
