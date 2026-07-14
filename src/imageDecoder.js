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

function jmTileCount(bookId, imageId) {
  const bookNumber = Number(bookId);
  if (bookNumber < 220980) return 0;
  if (bookNumber < 268850) return 10;
  const tailAscii = createHash("md5").update(`${bookId}${imageId}`).digest("hex").at(-1).charCodeAt(0);
  return bookNumber > 421925 ? (tailAscii % 8 + 1) * 2 : (tailAscii % 10 + 1) * 2;
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

/** Reproduce 禁漫天堂's Android Canvas vertical tile reversal using RGBA pixels. */
async function jmScramble(buffer, { url } = {}) {
  if (/qyyuapi\.com/i.test(String(url || "")) || imageMimeType(buffer) === "image/gif") return buffer;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ImageDecodeError("禁漫图片 URL 无效");
  }
  const match = parsed.pathname.match(/\/photos\/(\d+)\/(\d+)/i);
  if (!match) throw new ImageDecodeError("禁漫图片 URL 缺少 photos/{bookId}/{imageId} 参数");
  const [, bookId, imageId] = match;
  const tiles = jmTileCount(bookId, imageId);
  if (!tiles) return buffer;

  return reverseVerticalTiles(buffer, tiles, "禁漫");
}

/** Reproduce sources which derive a 5..14 tile count from an encoded image path. */
async function md5ReverseTiles(buffer, { url } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ImageDecodeError("MD5 分块图片 URL 无效");
  }
  const match = parsed.pathname.match(/\/sr:([^/]+)\/([^/]+)/i);
  if (!match) throw new ImageDecodeError("图片 URL 缺少 sr 和编码路径参数");
  if (match[1] !== "1") return buffer;
  const encodedPath = match[2].replace(/\.[^.]+$/, "");
  let decodedPath;
  try {
    decodedPath = Buffer.from(encodedPath, "base64url");
  } catch {
    throw new ImageDecodeError("图片 URL 中的路径编码无效");
  }
  if (!decodedPath.length) throw new ImageDecodeError("图片 URL 中的路径编码为空");
  const md5 = createHash("md5").update(decodedPath).digest("hex");
  const tiles = Number.parseInt(md5.slice(-2), 16) % 10 + 5;
  return reverseVerticalTiles(buffer, tiles, "MD5 分块");
}

const DECODERS = {
  "mwwz-aes": { decode: mwwzAesCbc, processImageBytes: false },
  "jm-scramble": { decode: jmScramble, processImageBytes: true },
  "md5-reverse-tiles": { decode: md5ReverseTiles, processImageBytes: true },
};

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

  const requested = String(decoder || "auto").toLowerCase();
  if (requested === "passthrough") {
    if (directMime) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
    throw new ImageDecodeError("上游响应不是可识别的图片");
  }
  // Auto must never alter already-valid image pixels. Pixel-scramble decoders are
  // only invoked explicitly after a source rule has positively identified a site.
  if (requested === "auto" && directMime) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
  const candidates = requested === "auto" ? ["mwwz-aes"] : [requested];
  if (!candidates.length) throw new ImageDecodeError("没有可用的图片解码器");

  let lastError;
  for (const name of candidates) {
    const item = DECODERS[name];
    if (!item) throw new ImageDecodeError(`不支持的图片解码器：${name}`);
    if (directMime && !item.processImageBytes) return { buffer: input, mimeType: directMime, decoder: "passthrough" };
    try {
      const decoded = await item.decode(input, context);
      const mimeType = imageMimeType(decoded);
      if (!mimeType) throw new ImageDecodeError("解码结果不是可识别图片");
      return { buffer: decoded, mimeType, decoder: decoded === input ? "passthrough" : name };
    } catch (error) {
      lastError = error;
      if (requested !== "auto") break;
    }
  }
  throw new ImageDecodeError(lastError?.message || "无法解码上游图片");
}

/** Detect imageDecode implementations that the proxy can reproduce safely. */
export function decoderForLegadoImageRule(rule) {
  const source = String(rule || "");
  if (
    /createSymmetricCrypto\s*\(\s*["']AES\/CBC\/PKCS5Padding/i.test(source)
    && /0B6666A0-BB59-1381-B746-a0E4C9AC/.test(source)
    && /result\.slice\(0\s*,\s*16\)/.test(source)
  ) return "mwwz-aes";
  if (
    /BitmapFactory\.decodeByteArray/.test(source)
    && /Canvas\s*\(/.test(source)
    && /bookId/.test(source)
    && /imgId/.test(source)
  ) return "jm-scramble";
  if (
    /src\.indexOf\(\s*["']sr:1["']\s*\)/.test(source)
    && /base64Decode/.test(source)
    && /md5Encode/.test(source)
    && /parseInt\([^)]*,\s*16\)\s*%\s*10\s*\)\s*\+\s*5/.test(source)
    && /Canvas\s*\(/.test(source)
  ) return "md5-reverse-tiles";
  return null;
}
