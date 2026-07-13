import { Buffer } from "node:buffer";

// 香色闺阁 XBS 使用的 16 字节 XXTEA key。
const XBS_KEY = Buffer.from([
  0xe5, 0x87, 0xbc, 0xe8, 0xa4, 0x86, 0xe6, 0xbb,
  0xbf, 0xe9, 0x87, 0x91, 0xe6, 0xba, 0xa1, 0xe5,
]);
const DELTA = 0x9e3779b9;

function toUint32Array(buffer) {
  const result = new Uint32Array(buffer.length / 4);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = buffer.readUInt32LE(index * 4);
  }
  return result;
}

function fromUint32Array(values) {
  const result = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    result.writeUInt32LE(values[index] >>> 0, index * 4);
  }
  return result;
}

function mix(y, z, position, e, sum, key) {
  const left = ((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4));
  const right = (sum ^ y) + (key[(position & 3) ^ e] ^ z);
  return (left ^ right) >>> 0;
}

function encryptWords(values, key) {
  const length = values.length;
  let rounds = 6 + Math.floor(52 / length);
  let sum = 0;
  let z = values[length - 1];

  while (rounds > 0) {
    rounds -= 1;
    sum = (sum + DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    let position = 0;
    for (; position < length - 1; position += 1) {
      const y = values[position + 1];
      values[position] = (values[position] + mix(y, z, position, e, sum, key)) >>> 0;
      z = values[position];
    }
    const y = values[0];
    values[length - 1] = (values[length - 1] + mix(y, z, position, e, sum, key)) >>> 0;
    z = values[length - 1];
  }
  return values;
}

function decryptWords(values, key) {
  const length = values.length;
  let rounds = 6 + Math.floor(52 / length);
  let sum = Math.imul(rounds, DELTA) >>> 0;
  let y = values[0];

  while (rounds > 0) {
    rounds -= 1;
    const e = (sum >>> 2) & 3;
    let position = length - 1;
    for (; position > 0; position -= 1) {
      const z = values[position - 1];
      values[position] = (values[position] - mix(y, z, position, e, sum, key)) >>> 0;
      y = values[position];
    }
    const z = values[length - 1];
    values[0] = (values[0] - mix(y, z, position, e, sum, key)) >>> 0;
    y = values[0];
    sum = (sum - DELTA) >>> 0;
  }
  return values;
}

export function encodeXbs(json) {
  const jsonBuffer = Buffer.isBuffer(json)
    ? json
    : Buffer.from(typeof json === "string" ? json : JSON.stringify(json), "utf8");
  const paddedLength = Math.ceil(jsonBuffer.length / 4) * 4;
  const payload = Buffer.alloc(paddedLength + 4);
  jsonBuffer.copy(payload);
  payload.writeUInt32LE(jsonBuffer.length, paddedLength);
  return fromUint32Array(encryptWords(toUint32Array(payload), toUint32Array(XBS_KEY)));
}

export function decodeXbs(xbs) {
  const buffer = Buffer.isBuffer(xbs) ? xbs : Buffer.from(xbs);
  if (buffer.length < 8 || buffer.length % 4 !== 0) {
    throw new Error("无效的 XBS：文件长度必须是不小于 8 的 4 字节倍数");
  }
  const decoded = fromUint32Array(decryptWords(toUint32Array(buffer), toUint32Array(XBS_KEY)));
  const paddedLength = decoded.length - 4;
  const jsonLength = decoded.readUInt32LE(paddedLength);
  if (jsonLength < paddedLength - 3 || jsonLength > paddedLength) {
    throw new Error("无效的 XBS：解密后的 JSON 长度校验失败");
  }
  return decoded.subarray(0, jsonLength);
}
