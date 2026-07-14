import { createDecipheriv } from "node:crypto";

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

const DECODERS = {
  "mwwz-aes": mwwzAesCbc,
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
export function decodeImage(buffer, decoder = "auto") {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const directMime = imageMimeType(input);
  if (directMime) return { buffer: input, mimeType: directMime, decoder: "passthrough" };

  const requested = String(decoder || "auto").toLowerCase();
  if (requested === "passthrough") throw new ImageDecodeError("上游响应不是可识别的图片");
  const candidates = requested === "auto" ? supportedImageDecoders() : [requested];
  if (!candidates.length) throw new ImageDecodeError("没有可用的图片解码器");

  let lastError;
  for (const name of candidates) {
    const decode = DECODERS[name];
    if (!decode) throw new ImageDecodeError(`不支持的图片解码器：${name}`);
    try {
      const decoded = decode(input);
      return { buffer: decoded, mimeType: imageMimeType(decoded), decoder: name };
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
  return null;
}
