import { readFileSync } from "node:fs";
import vm from "node:vm";

const MAX_SOURCE_BYTES = 256 * 1024;

function shiftedLiteralMarkers(source) {
  const values = [];
  for (const match of String(source || "").matchAll(/\[(?:\d+\s*,\s*){2,}\d+\]/g)) {
    if (match[0].length > 8_192) continue;
    let numbers;
    try { numbers = JSON.parse(match[0]); } catch { continue; }
    if (!Array.isArray(numbers) || numbers.length > 128) continue;
    for (let first = 32; first <= 126; first += 1) {
      const shift = numbers[0] - first;
      const codePoints = numbers.map((number, index) => number - index - shift);
      if (codePoints.some((number) => number < 32 || number > 126)) continue;
      values.push(String.fromCodePoint(...codePoints));
    }
  }
  return values;
}

function contextPrelude() {
  return `
    var __stub = new Proxy(function () { return __stub; }, {
      get: function (_target, property) {
        if (property === Symbol.toPrimitive) return function () { return 0; };
        return __stub;
      },
      set: function () { return true; },
      apply: function () { return __stub; },
      construct: function () { return __stub; }
    });
    var window = globalThis, self = globalThis;
    var document = __stub, location = __stub, navigator = __stub, URL = __stub;
    var MutationObserver = __stub, IntersectionObserver = __stub, Worker = __stub;
    var Blob = __stub, Image = __stub, fetch = __stub;
    var Packages = __stub, java = __stub;
    var __utf8Values = [];
    var CryptoJS = {
      enc: new Proxy({
        Utf8: { parse: function (value) { __utf8Values.push(String(value || '')); return __stub; } },
        Base64: __stub
      }, { get: function (target, property) { return target[property] || __stub; } }),
      lib: new Proxy({ WordArray: __stub, CipherParams: __stub }, {
        get: function (target, property) { return target[property] || __stub; }
      }),
      AES: __stub,
      mode: { CBC: __stub },
      pad: { Pkcs7: __stub }
    };
    var console = { log: function () {}, error: function () {}, warn: function () {} };
    function btoa(value) {
      var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var output = '';
      value = String(value || '');
      for (var index = 0; index < value.length; index += 3) {
        var number = (value.charCodeAt(index) << 16)
          | ((value.charCodeAt(index + 1) || 0) << 8)
          | (value.charCodeAt(index + 2) || 0);
        output += alphabet[(number >> 18) & 63] + alphabet[(number >> 12) & 63]
          + (index + 1 < value.length ? alphabet[(number >> 6) & 63] : '=')
          + (index + 2 < value.length ? alphabet[number & 63] : '=');
      }
      return output;
    }
    function atob() { return ''; }
    function setTimeout() { return 0; }
    function clearTimeout() {}
    var $ = function (value) {
      if (typeof value === 'function') {
        try { value(); } catch (_error) {}
      }
      return __stub;
    };
  `;
}

function declaredIdentifiers(source) {
  const names = new Set();
  for (const match of String(source || "").matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = match[1] || match[2];
    if (/(?:key|decrypt|cipher|crypto|iv)/i.test(name)) names.add(name);
  }
  return [...names].slice(0, 128);
}

function declaredCryptoFunctions(source) {
  const names = new Set();
  for (const match of String(source || "").matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/(?:decrypt|decipher|decode)/i.test(match[1])) names.add(match[1]);
  }
  return [...names].slice(0, 32);
}

function closingFunctionBrace(source, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return -1;
      continue;
    }
    if (char === "/" && next === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) return -1;
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function instrumentImageDecoderFunctions(source) {
  const edits = [];
  for (const match of String(source || "").matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gi)) {
    if (!/(?:decrypt|decode)/i.test(match[1]) || !/image/i.test(match[1])) continue;
    const openIndex = match.index + match[0].lastIndexOf("{");
    const closeIndex = closingFunctionBrace(source, openIndex);
    if (closeIndex < 0) continue;
    edits.push({ index: closeIndex + 1, name: match[1] });
  }
  let output = source;
  for (const edit of edits.reverse().slice(0, 8)) {
    const call = `;try { var __imageProbeResult = ${edit.name}(new Uint8Array(64)); if (__imageProbeResult && typeof __imageProbeResult.catch === "function") __imageProbeResult.catch(function () {}); } catch (__imageProbeError) {}`;
    output = `${output.slice(0, edit.index)}${call}${output.slice(edit.index)}`;
  }
  return output;
}

function lexicalString(context, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return "";
  try {
    const value = new vm.Script(`typeof ${name} === "string" ? ${name} : ""`)
      .runInContext(context, { timeout: 20 });
    return typeof value === "string" && value.length <= 64 * 1024 ? value : "";
  } catch {
    return "";
  }

  for (const name of declaredCryptoFunctions(source)) {
    try {
      new vm.Script(`
        try {
          var __probeResult = ${name}(new Uint8Array(64));
          if (__probeResult && typeof __probeResult.catch === "function") __probeResult.catch(function () {});
        } catch (__probeError) {}
      `).runInContext(context, { timeout: 30 });
    } catch {
      // Continue probing other declared decoder functions.
    }
  }
}

function keyCandidates(name, value) {
  const text = String(value || "");
  if (/(?:base64|b64)/i.test(name) && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    try {
      const decoded = Buffer.from(text, "base64");
      if ([16, 24, 32].includes(decoded.length)) return [decoded];
    } catch {
      return [];
    }
  }
  const raw = Buffer.from(text, "utf8");
  if ([16, 24, 32].includes(raw.length)) return [raw];
  if (!/(?:key|secret|password)/i.test(name) || raw.length < 16 || raw.length > 128) return [];
  return [32, 24, 16].filter((length) => raw.length > length).map((length) => raw.subarray(0, length));
}

function staticStringValues(source) {
  const values = [];
  const pattern = /(?:\b(?:const|let|var)\s+|(?:^|[{,;])\s*)([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/gm;
  for (const match of String(source || "").matchAll(pattern)) {
    let value = match[3];
    try {
      if (match[2] === '"') value = JSON.parse(`"${match[3]}"`);
      else value = value.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } catch {
      continue;
    }
    if (value.length <= 256) values.push({ name: match[1], value });
  }
  return values.slice(0, 256);
}

function probe(source) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(contextPrelude()).runInContext(context, { timeout: 50 });
  try {
    new vm.Script(instrumentImageDecoderFunctions(source), { filename: "image-decoder-rule.js" })
      .runInContext(context, { timeout: 750 });
  } catch {
    // Browser scripts commonly reach an unavailable DOM API after declaring
    // their decoder. Declarations made before that point remain inspectable.
  }

  const strings = [];
  for (const [name, value] of Object.entries(context)) {
    if (typeof value === "string" && value.length <= 64 * 1024) strings.push({ name, value });
  }
  for (const value of Array.isArray(context.__utf8Values) ? context.__utf8Values : []) {
    if (typeof value === "string" && value.length <= 256) strings.push({ name: "observedUtf8Key", value });
  }
  for (const name of declaredIdentifiers(source)) {
    const value = lexicalString(context, name);
    if (value) strings.push({ name, value });
  }
  strings.push(...staticStringValues(source));
  const shiftedMarkers = shiftedLiteralMarkers(source);
  const evidence = [source, ...strings.map((item) => item.value), ...shiftedMarkers].join("\n");
  const aesCbc = /AES\s*\/\s*CBC\s*\/\s*PKCS5Padding|AES\.decrypt[\s\S]{0,600}mode\s*:\s*CryptoJS\.mode\.CBC/i.test(evidence);
  const observedCryptoKey = strings.some((item) => (
    item.name === "observedUtf8Key" && [16, 24, 32].includes(Buffer.byteLength(item.value))
  ));
  const instrumentedCryptoJs = observedCryptoKey
    && (source.match(/CryptoJS/g) || []).length >= 3
    && /decrypt/i.test(source);
  const webCryptoAes = /AES-CBC/i.test(evidence)
    && /(?:crypto\s*\.\s*subtle|subtle)\s*\.\s*(?:importKey|decrypt)/i.test(evidence)
    && /decrypt/i.test(evidence);
  const prefixIv = /slice\s*\(\s*0\s*,\s*16\s*\)|subarray\s*\(\s*0\s*,\s*16\s*\)/i.test(evidence)
    || /const\s+iv[\s\S]{0,160}(?:slice|subarray)\s*\(\s*0\s*,\s*16\s*\)/i.test(evidence)
    || (shiftedMarkers.includes("SLICE") && shiftedMarkers.includes("DECRYPT"));
  if (!aesCbc && !instrumentedCryptoJs && !webCryptoAes) return [];

  const ranked = strings
    .flatMap((item) => keyCandidates(item.name, item.value).map((key) => ({ ...item, key })))
    .sort((left, right) => (
      Number(/^(?:base64)?key$/i.test(right.name)) - Number(/^(?:base64)?key$/i.test(left.name))
      || Number(/key/i.test(right.name)) - Number(/key/i.test(left.name))
    ));
  const observed = ranked.filter((item) => item.name === "observedUtf8Key");
  const selected = observed.length ? observed : ranked;
  const decoders = [];
  for (const item of selected.slice(0, 8)) {
    const encoded = item.key.toString("base64url");
    if (prefixIv || instrumentedCryptoJs) decoders.push(`aes-cbc-prefix-iv-${encoded}`);
    decoders.push(`aes-cbc-fixed-iv-${encoded}-${encoded}`);
  }
  return [...new Set(decoders)];
}

const input = readFileSync(0);
if (input.length > MAX_SOURCE_BYTES) process.exit(2);
const decoders = probe(input.toString("utf8"));
process.stdout.write(`${JSON.stringify(decoders)}\n`);
