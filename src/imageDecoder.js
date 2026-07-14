import { createDecipheriv, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Jimp, JimpMime } from "jimp";

const MWWZ_AES_KEY = Buffer.from("0B6666A0-BB59-1381-B746-a0E4C9AC", "utf8");

/** Return the MIME type only when the bytes have a well-known image signature. */
export function imageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 6).equals(Buffer.from("GIF87a")) || buffer.subarray(0, 6).equals(Buffer.from("GIF89a"))) return "image/gif";
  if (buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WEBP"))) return "image/webp";
  if (buffer.subarray(0, 2).equals(Buffer.from([0x42, 0x4d]))) return "image/bmp";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return "image/x-icon";
  if (buffer.subarray(0, 4).equals(Buffer.from("\x00\x00\x00\x0c")) && buffer.subarray(4, 8).equals(Buffer.from("jP  "))) return "image/jp2";
  return null;
}

export class ImageDecodeError extends Error {}

function mwwzAesCbc(buffer) {
  if (buffer.length <= 16) throw new ImageDecodeError("图片密文长度不足，无法进行 AES 解密");
  const decipher = createDecipheriv("aes-256-cbc", MWWZ_AES_KEY, buffer.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]);
  if (!imageMimeType(plain)) throw new ImageDecodeError("AES 解密结果不是可识别图片");
  return plain;
}

function aesCbcPrefixIv(buffer, { key } = {}) {
  let keyBytes;
  try {
    keyBytes = Buffer.from(String(key || ""), "base64url");
  } catch {
    throw new ImageDecodeError("AES 图片规则的密钥编码无效");
  }
  if (![16, 24, 32].includes(keyBytes.length)) throw new ImageDecodeError("AES 图片规则的密钥长度必须为 16、24 或 32 字节");
  if (buffer.length <= 16) throw new ImageDecodeError("图片密文长度不足，无法进行 AES 解密");
  const decipher = createDecipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, buffer.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]);
  if (!imageMimeType(plain)) throw new ImageDecodeError("AES 解密结果不是可识别图片");
  return plain;
}

const DEFAULT_ID_TILE_PLAN = {
  bypassToken: "qyyuapi.com",
  minimumId: 220980,
  middleId: 268850,
  upperId: 421925,
  fixedTiles: 10,
  middleModulo: 10,
  upperModulo: 8,
  factor: 2,
};

function idTileCount(bookId, imageId, plan = DEFAULT_ID_TILE_PLAN) {
  const bookNumber = Number(bookId);
  if (bookNumber < plan.minimumId) return 0;
  if (bookNumber < plan.middleId) return plan.fixedTiles;
  const tailAscii = createHash("md5").update(`${bookId}${imageId}`).digest("hex").at(-1).charCodeAt(0);
  return bookNumber > plan.upperId
    ? (tailAscii % plan.upperModulo + 1) * plan.factor
    : (tailAscii % plan.middleModulo + 1) * plan.factor;
}

/**
 * Jimp 1.x cannot decode WebP, while 禁漫的当前 CDN primarily returns WebP.
 * ImageMagick is installed in the production image and is used only as a byte
 * format bridge; tile reassembly remains deterministic JavaScript below.
 */
function imageMagickConvert(command, buffer) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, ["webp:-", "png:-"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && chunks.length) {
        resolve(Buffer.concat(chunks));
        return;
      }
      reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `${command} exited with code ${code}`));
    });
    child.stdin.once("error", reject);
    child.stdin.end(buffer);
  });
}

async function webpToPng(buffer) {
  let lastError;
  // ImageMagick 7 uses `magick`; some minimal images expose only `convert`.
  for (const command of ["magick", "convert"]) {
    try {
      return await imageMagickConvert(command, buffer);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ImageDecodeError(`无法解码 WebP 图片：${lastError?.message || "ImageMagick 不可用"}`);
}

async function reverseVerticalTiles(buffer, tiles, label) {
  const input = imageMimeType(buffer) === "image/webp" ? await webpToPng(buffer) : buffer;
  let image;
  try {
    image = await Jimp.read(input);
  } catch (error) {
    throw new ImageDecodeError(`无法读取${label}图片：${error.message}`);
  }
  const { width, height, data } = image.bitmap;
  if (!width || !height || height < tiles) throw new ImageDecodeError(`${label}图片尺寸不足，无法重排`);
  const rowBytes = width * 4;
  const tileHeight = Math.floor(height / tiles);
  const remainder = height % tiles;
  const output = Buffer.alloc(data.length);
  for (let index = 1; index <= tiles; index += 1) {
    const extra = index === tiles ? remainder : 0;
    const sourceY = tileHeight * (index - 1);
    const destinationY = height - sourceY - tileHeight - extra;
    const byteLength = (tileHeight + extra) * rowBytes;
    data.copy(output, destinationY * rowBytes, sourceY * rowBytes, sourceY * rowBytes + byteLength);
  }
  return Jimp.fromBitmap({ data: output, width, height }).getBuffer(JimpMime.png);
}

/** Reverse vertical tiles whose count is derived from two numeric URL IDs. */
async function idMd5ReverseTiles(buffer, { url, idTilePlan = DEFAULT_ID_TILE_PLAN } = {}) {
  if ((idTilePlan.bypassToken && String(url || "").includes(idTilePlan.bypassToken)) || imageMimeType(buffer) === "image/gif") return buffer;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ImageDecodeError("ID 分块图片 URL 无效");
  }
  const ids = parsed.pathname.split("/").flatMap((segment) => {
    const match = segment.match(/^(\d+)(?:\.[^.]+)?$/);
    return match ? [match[1]] : [];
  });
  if (ids.length < 2) throw new ImageDecodeError("ID 分块图片 URL 缺少两个数字路径参数");
  const [bookId, imageId] = ids.slice(-2);
  const tiles = idTileCount(bookId, imageId, idTilePlan);
  if (!tiles) return buffer;

  return reverseVerticalTiles(buffer, tiles, "ID 分块");
}

/** Reproduce sources which derive a 5..14 tile count from an encoded image path. */
async function md5ReverseTiles(buffer, { url, modulo = 10, add = 5 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ImageDecodeError("MD5 分块图片 URL 无效");
  }
  // Preserve the common on/off marker when present, but discover the encoded
  // path segment generically instead of relying on a domain or fixed position.
  const scrambleFlag = parsed.pathname.match(/\/(?:sr|scramble):([^/]+)/i)?.[1];
  if (scrambleFlag && scrambleFlag !== "1") return buffer;
  let decodedPath = null;
  for (const segment of parsed.pathname.split("/").reverse()) {
    const encoded = segment.replace(/\.[^.]+$/, "");
    if (!/^[A-Za-z0-9_-]{12,}$/.test(encoded)) continue;
    const candidate = Buffer.from(encoded, "base64url");
    const text = candidate.toString("utf8");
    if (candidate.length && /(?:\/|\\)/.test(text) && !text.includes("\uFFFD")) {
      decodedPath = candidate;
      break;
    }
  }
  if (!decodedPath) throw new ImageDecodeError("图片 URL 中没有可识别的 Base64 路径参数");
  const md5 = createHash("md5").update(decodedPath).digest("hex");
  const safeModulo = Number.parseInt(modulo, 10);
  const safeAdd = Number.parseInt(add, 10);
  if (!(safeModulo >= 1 && safeModulo <= 64 && safeAdd >= 1 && safeAdd <= 64)) throw new ImageDecodeError("MD5 分块参数超出允许范围");
  const tiles = Number.parseInt(md5.slice(-2), 16) % safeModulo + safeAdd;
  return reverseVerticalTiles(buffer, tiles, "MD5 分块");
}

const DECODERS = {
  "mwwz-aes": { decode: mwwzAesCbc, processImageBytes: false },
  "jm-scramble": { decode: idMd5ReverseTiles, processImageBytes: true },
  "id-md5-reverse-tiles": { decode: idMd5ReverseTiles, processImageBytes: true },
  "md5-reverse-tiles": { decode: md5ReverseTiles, processImageBytes: true },
};

function decoderDefinition(name) {
  const direct = DECODERS[String(name).toLowerCase()];
  if (direct) return { ...direct, context: {} };
  const aes = String(name).match(/^aes-cbc-prefix-iv-([A-Za-z0-9_-]+)$/i);
  if (aes) return { decode: aesCbcPrefixIv, processImageBytes: false, context: { key: aes[1] } };
  const idTiles = String(name).match(/^id-md5-reverse-tiles-([A-Za-z0-9_-]+)$/i);
  if (idTiles) {
    let plan;
    try {
      plan = JSON.parse(Buffer.from(idTiles[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const numericKeys = ["minimumId", "middleId", "upperId", "fixedTiles", "middleModulo", "upperModulo", "factor"];
    if (numericKeys.some((key) => !Number.isInteger(plan[key]) || plan[key] < 1 || plan[key] > 10_000_000)) return null;
    if (!(plan.minimumId < plan.middleId && plan.middleId <= plan.upperId)) return null;
    if (typeof plan.bypassToken !== "string" || plan.bypassToken.length > 128) return null;
    return { decode: idMd5ReverseTiles, processImageBytes: true, context: { idTilePlan: plan } };
  }
  const md5 = String(name).match(/^md5-reverse-tiles-(\d+)-(\d+)$/i);
  if (md5) return {
    decode: md5ReverseTiles,
    processImageBytes: true,
    context: { modulo: Number(md5[1]), add: Number(md5[2]) },
  };
  return null;
}

export function supportedImageDecoders() {
  return Object.keys(DECODERS);
}

/**
 * Decode an upstream comic image.
 *
 * Normal image bytes always pass through untouched. `auto` tries every registered
 * non-destructive decoder and accepts a result only if it has a valid image header.
 */
export async function decodeImage(buffer, decoder = "auto", context = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const directMime = imageMimeType(input);

  const requested = String(decoder || "auto");
  const requestedType = requested.toLowerCase();
  if (requestedType === "passthrough") {
    if (directMime) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
    throw new ImageDecodeError("上游响应不是可识别的图片");
  }
  // Auto must never alter already-valid image pixels. Pixel-scramble decoders are
  // only invoked explicitly after a source rule has positively identified a site.
  if (requestedType === "auto" && directMime) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
  const candidates = requestedType === "auto" ? ["mwwz-aes"] : [requested];
  if (!candidates.length) throw new ImageDecodeError("没有可用的图片解码器");

  let lastError;
  for (const name of candidates) {
    const item = decoderDefinition(name);
    if (!item) throw new ImageDecodeError(`不支持的图片解码器：${name}`);
    if (directMime && !item.processImageBytes) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
    try {
      const decoded = await item.decode(input, { ...context, ...item.context });
      const mimeType = imageMimeType(decoded);
      if (!mimeType) throw new ImageDecodeError("解码结果不是可识别图片");
      return { buffer: decoded, mimeType, decoder: decoded === input ? "passthrough" : name };
    } catch (error) {
      lastError = error;
      if (requestedType !== "auto") break;
    }
  }
  throw new ImageDecodeError(lastError?.message || "无法解码上游图片");
}

/** Detect imageDecode implementations that the proxy can reproduce safely. */
export function decoderForLegadoImageRule(rule) {
  const source = String(rule || "");
  if (
    /createSymmetricCrypto\s*\(\s*["']AES\/CBC\/PKCS5Padding/i.test(source)
    && /result\.slice\(0\s*,\s*16\)/.test(source)
  ) {
    const key = source.match(/strToBytes\s*\(\s*["']([^"']+)["']\s*\)/i)?.[1];
    if (key && [16, 24, 32].includes(Buffer.byteLength(key))) {
      return `aes-cbc-prefix-iv-${Buffer.from(key, "utf8").toString("base64url")}`;
    }
  }
  if (
    /BitmapFactory\.decodeByteArray/.test(source)
    && /Canvas\s*\(/.test(source)
    && /bookId/.test(source)
    && /imgId/.test(source)
  ) {
    const moduloMatches = [...source.matchAll(/ascii\s*%\s*(\d+)/g)].map((match) => Number(match[1]));
    const plan = {
      bypassToken: source.match(/src\.search\(\s*["']([^"']+)["']\s*\)\s*!=\s*-1/i)?.[1] || "",
      minimumId: Number(source.match(/Number\(bookId\)\s*<\s*(\d+)/)?.[1]),
      middleId: Number(source.match(/Number\(bookId\)\s*>=\s*(\d+)/)?.[1]),
      upperId: Number(source.match(/Number\(bookId\)\s*>\s*(\d+)/)?.[1]),
      fixedTiles: Number(source.match(/else\s*\{\s*num\s*=\s*(\d+)/)?.[1]),
      upperModulo: moduloMatches[0],
      middleModulo: moduloMatches[1],
      factor: Number(source.match(/\(ascii\s*%\s*\d+\s*\+\s*1\)\s*\*\s*(\d+)/)?.[1]),
    };
    const numeric = Object.entries(plan).filter(([key]) => key !== "bypassToken").map(([, value]) => value);
    if (numeric.every((value) => Number.isInteger(value) && value > 0)
      && plan.minimumId < plan.middleId && plan.middleId <= plan.upperId) {
      return `id-md5-reverse-tiles-${Buffer.from(JSON.stringify(plan), "utf8").toString("base64url")}`;
    }
    return "id-md5-reverse-tiles";
  }
  if (
    /src\.indexOf\(\s*["']sr:1["']\s*\)/.test(source)
    && /base64Decode/.test(source)
    && /md5Encode/.test(source)
    && /parseInt\([^)]*,\s*16\)\s*%\s*\d+\s*\)\s*\+\s*\d+/.test(source)
    && /Canvas\s*\(/.test(source)
  ) {
    const formula = source.match(/parseInt\([^)]*,\s*16\)\s*%\s*(\d+)\s*\)\s*\+\s*(\d+)/);
    const modulo = Number(formula?.[1]);
    const add = Number(formula?.[2]);
    if (modulo >= 1 && modulo <= 64 && add >= 1 && add <= 64) return `md5-reverse-tiles-${modulo}-${add}`;
  }
  return null;
}
