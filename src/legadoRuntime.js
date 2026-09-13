/**
 * 香色 `@js:` 运行时是纯 JavaScript（function(config, params, result)），
 * 没有阅读的 Java 桥（java.md5Encode / java.base64Decode / jsoup 等）。
 * 这里把常用的阅读运行时 API 用自包含纯 JS 实现，转换器在重写脚本时
 * 按需内嵌，使生成的规则无需宿主额外能力即可执行。
 *
 * 约束：所有标识符使用 `__xs` 前缀；源码不得包含 `{{`、`java.`、`source.`、
 * `cookie.`、`<js>`、`Packages` 等会被香色结构校验判定为阅读运行时语法的片段。
 */

const UTF8_HELPERS = `
function __xsStrToBytes(str) {
  var out = [];
  var s = String(str == null ? "" : str);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) out[out.length] = (c);
    else if (c < 0x800) { out[out.length] = (0xc0 | (c >> 6)); out[out.length] = (0x80 | (c & 63)); }
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      var lo = s.charCodeAt(++i);
      if (lo >= 0xdc00 && lo < 0xe000) {
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
        (out[out.length] = (0xf0 | (cp >> 18)), out[out.length] = (0x80 | ((cp >> 12) & 63)), out[out.length] = (0x80 | ((cp >> 6) & 63)), out[out.length] = (0x80 | (cp & 63)));
      } else {
        (out[out.length] = (0xe0 | (c >> 12)), out[out.length] = (0x80 | ((c >> 6) & 63)), out[out.length] = (0x80 | (c & 63)));
        i -= 1;
      }
    } else (out[out.length] = (0xe0 | (c >> 12)), out[out.length] = (0x80 | ((c >> 6) & 63)), out[out.length] = (0x80 | (c & 63)));
  }
  return out;
}

function __xsBytesToStr(bytes) {
  var out = "";
  var i = 0;
  var b = bytes || [];
  while (i < b.length) {
    var c = b[i];
    var cp;
    if (c < 0x80) { cp = c; i += 1; }
    else if ((c & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1] & 0xc0) === 0x80) {
      cp = ((c & 0x1f) << 6) | (b[i + 1] & 63); i += 2;
    } else if ((c & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
      i += 3;
    } else if ((c & 0xf8) === 0xf0 && i + 3 < b.length && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) {
      cp = ((c & 0x07) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
      i += 4;
    } else {
      // 非法或截断的 UTF-8 序列：输出替换符并前进一个字节重新同步。
      cp = 0xfffd;
      i += 1;
    }
    if (!(cp >= 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp < 0xe000)) cp = 0xfffd;
    out += String.fromCodePoint(cp);
  }
  return out;
}
`;

const BASE64_HELPERS = `
function __xsBase64Bytes(input) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var s = String(input == null ? "" : input).replace(/-/g, "+").replace(/_/g, "/");
  var out = [];
  var acc = 0;
  var bits = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === "=" || ch === ";") break;
    var v = alphabet.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[out.length] = ((acc >> bits) & 0xff);
    }
  }
  return out;
}

function __xsBase64Decode(input) {
  return __xsBytesToStr(__xsBase64Bytes(input));
}

function __xsBase64Encode(input) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var bytes = typeof input === "string" ? __xsStrToBytes(input) : (input || []);
  var out = [];
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : NaN;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    out[out.length] = (alphabet.charAt(b0 >> 2));
    out[out.length] = alphabet.charAt(((b0 & 3) << 4) | ((isNaN(b1) ? 0 : b1) >> 4));
    out[out.length] = isNaN(b1) ? "=" : alphabet.charAt(((b1 & 15) << 2) | ((isNaN(b2) ? 0 : b2) >> 6));
    out[out.length] = (isNaN(b2) ? "=" : alphabet.charAt(b2 & 63));
  }
  return out.join("");
}
`;

const HEX_HELPERS = `
function __xsHexBytes(input) {
  var s = String(input == null ? "" : input).replace(/[^0-9a-fA-F]/g, "");
  if (s.length % 2 === 1) s = "0" + s;
  var out = [];
  for (var i = 0; i < s.length; i += 2) out[out.length] = (Number.parseInt(s.slice(i, i + 2), 16));
  return out;
}

function __xsHexDecode(input) {
  return __xsBytesToStr(__xsHexBytes(input));
}
`;

const MD5_HELPERS = `
function __xsMd5(input) {
  function add(x, y) {
    var l = (x & 0xFFFF) + (y & 0xFFFF);
    var m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xFFFF);
  }
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  var bytes = __xsStrToBytes(input);
  var bitLen = bytes.length * 8;
  bytes[bytes.length] = (0x80);
  while (bytes.length % 64 !== 56) bytes[bytes.length] = (0);
  for (var t = 0; t < 8; t++) bytes[bytes.length] = (Math.floor(bitLen / Math.pow(2, 8 * t)) & 0xff);
  var K = [];
  for (var k = 0; k < 64; k++) K[K.length] = Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296);
  var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  var a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
  for (var off = 0; off < bytes.length; off += 64) {
    var M = [];
    for (var j = 0; j < 16; j++) {
      M[M.length] = (bytes[off + j * 4] | (bytes[off + j * 4 + 1] << 8) | (bytes[off + j * 4 + 2] << 16) | (bytes[off + j * 4 + 3] << 24));
    }
    var A = a0, B = b0, C = c0, D = d0;
    for (var i = 0; i < 64; i++) {
      var F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(F, A), add(M[g], K[i]));
      A = D; D = C; C = B;
      B = add(B, rl(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  function hexLE(n) {
    var out = "";
    for (var i = 0; i < 4; i++) {
      var b = (n >>> (8 * i)) & 0xff;
      out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
  }
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
`;

const TIME_HELPERS = `
function __xsTimeFormatParts(timestamp, utc) {
  var n = Number(timestamp);
  if (!isFinite(n) || n <= 0) return null;
  if (n < 1e12) n *= 1000;
  var d = new Date(n);
  var p = function (v, w) {
    v = String(v);
    while (v.length < (w || 2)) v = "0" + v;
    return v;
  };
  var get = utc
    ? { Y: d.getUTCFullYear, M: d.getUTCMonth, D: d.getUTCDate, H: d.getUTCHours, m: d.getUTCMinutes, s: d.getUTCSeconds, S: d.getUTCMilliseconds }
    : { Y: d.getFullYear, M: d.getMonth, D: d.getDate, H: d.getHours, m: d.getMinutes, s: d.getSeconds, S: d.getMilliseconds };
  return {
    yyyy: String(get.Y.call(d)),
    MM: p(get.M.call(d) + 1),
    dd: p(get.D.call(d)),
    HH: p(get.H.call(d)),
    mm: p(get.m.call(d)),
    ss: p(get.s.call(d)),
    SSS: p(get.S.call(d), 3),
  };
}

function __xsApplyTimeFormat(parts, format) {
  var f = String(format == null || format === "" ? "yyyy-MM-dd HH:mm" : format);
  var out = "";
  var i = 0;
  while (i < f.length) {
    var matched = false;
    for (var token of ["yyyy", "SSS", "MM", "dd", "HH", "mm", "ss"]) {
      if (f.startsWith(token, i) && parts[token] !== undefined) {
        out += parts[token];
        i += token.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += f.charAt(i);
      i += 1;
    }
  }
  return out;
}

function __xsTimeFormat(timestamp, format) {
  var parts = __xsTimeFormatParts(timestamp, false);
  return parts ? __xsApplyTimeFormat(parts, format) : "";
}

function __xsTimeFormatUTC(timestamp, format) {
  var parts = __xsTimeFormatParts(timestamp, true);
  return parts ? __xsApplyTimeFormat(parts, format) : "";
}
`;

const JSOUP_HELPERS = `
function __xsJsoupNode(tag) {
  return { tag: tag, attrs: {}, classes: {}, children: [], parent: null };
}

function __xsJsoupDecodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#(\\d+);/g, function (all, code) { return String.fromCodePoint(Number(code)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (all, code) { return String.fromCodePoint(Number.parseInt(code, 16)); })
    .replace(/&amp;/g, "&");
}

function __xsJsoupFindTagEnd(html, start) {
  var quote = "";
  for (var i = start; i < html.length; i++) {
    var ch = html.charAt(i);
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function __xsJsoupBuild(html) {
  var root = __xsJsoupNode("#root");
  var stack = [root];
  var __xsHtml = String(html == null ? "" : html);
  var VOID = { br: 1, img: 1, hr: 1, meta: 1, link: 1, input: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, track: 1, wbr: 1, param: 1 };
  var RAWTEXT = { script: 1, style: 1, textarea: 1 };
  function appendText(text) {
    if (!text) return;
    var node = __xsJsoupNode("#text");
    node.text = __xsJsoupDecodeEntities(text);
    var top = stack[stack.length - 1];
    node.parent = top;
    top.children[top.children.length] = (node);
  }
  var pos = 0;
  while (pos < __xsHtml.length) {
    var lt = __xsHtml.indexOf("<", pos);
    if (lt < 0) { appendText(__xsHtml.slice(pos)); break; }
    if (lt > pos) appendText(__xsHtml.slice(pos, lt));
    if (__xsHtml.slice(lt, lt + 4) === "<!--") {
      var cend = __xsHtml.indexOf("-->", lt + 4);
      pos = cend < 0 ? __xsHtml.length : cend + 3;
      continue;
    }
    if (__xsHtml.charAt(lt + 1) === "!" || __xsHtml.charAt(lt + 1) === "?") {
      var degt = __xsHtml.indexOf(">", lt);
      pos = degt < 0 ? __xsHtml.length : degt + 1;
      continue;
    }
    if (__xsHtml.charAt(lt + 1) === "/") {
      var closeEnd = __xsHtml.indexOf(">", lt);
      var closeTag = __xsHtml.slice(lt + 2, closeEnd < 0 ? __xsHtml.length : closeEnd).trim().toLowerCase().split(/\\s+/)[0];
      for (var si = stack.length - 1; si > 0; si--) {
        if (stack[si].tag === closeTag) { stack.length = si; break; }
      }
      pos = closeEnd < 0 ? __xsHtml.length : closeEnd + 1;
      continue;
    }
    var gt = __xsJsoupFindTagEnd(__xsHtml, lt);
    if (gt < 0) { appendText(__xsHtml.slice(lt)); break; }
    var tagSource = __xsHtml.slice(lt + 1, gt);
    var selfClosed = /\\/$/.test(tagSource.trim());
    tagSource = tagSource.trim().replace(/\\/$/, "");
    var nameMatch = tagSource.match(/^[A-Za-z][\\w:-]*/);
    var tag = nameMatch ? nameMatch[0].toLowerCase() : "";
    if (!tag) { pos = gt + 1; continue; }
    var node = __xsJsoupNode(tag);
    var attrPattern = /([:\\w.$-]+)\\s*(?:=\\s*("([^"]*)"|'([^']*)'|[^\\s"'>]+))?/g;
    var attrSource = tagSource.slice(nameMatch ? nameMatch[0].length : 0);
    var attrMatch;
    while ((attrMatch = attrPattern.exec(attrSource))) {
      var key = attrMatch[1].toLowerCase();
      if (key === "/" || !key) continue;
      var value = attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4] !== undefined ? attrMatch[4] : attrMatch[2] !== undefined ? attrMatch[2] : "";
      node.attrs[key] = __xsJsoupDecodeEntities(value);
      if (key === "class") {
        var cls = value.split(/\\s+/);
        for (var ci = 0; ci < cls.length; ci++) if (cls[ci]) node.classes[cls[ci]] = true;
      }
    }
    var top = stack[stack.length - 1];
    node.parent = top;
    top.children[top.children.length] = (node);
    if (RAWTEXT[tag] && !selfClosed) {
      var closeProbe = new RegExp("</" + tag + "\\b", "i");
      var rest = __xsHtml.slice(gt + 1);
      var closeMatch = rest.match(closeProbe);
      if (closeMatch) {
        var raw = rest.slice(0, closeMatch.index);
        if (tag !== "textarea") {
          var rawNode = __xsJsoupNode("#text");
          rawNode.text = raw;
          rawNode.parent = node;
          node.children[node.children.length] = (rawNode);
        } else appendText(raw);
        var rawEnd = __xsHtml.indexOf(">", gt + 1 + closeMatch.index);
        pos = rawEnd < 0 ? __xsHtml.length : rawEnd + 1;
      } else pos = __xsHtml.length;
      continue;
    }
    if (VOID[tag] || selfClosed) { pos = gt + 1; continue; }
    stack[stack.length] = (node);
    pos = gt + 1;
  }
  return root;
}

function __xsJsoupSerializeChildren(node) {
  var out = "";
  for (var i = 0; i < node.children.length; i++) out += __xsJsoupOuter(node.children[i]);
  return out;
}

function __xsJsoupOuter(node) {
  if (!node) return "";
  if (node.tag === "#text") return String(node.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (node.tag === "#root") return __xsJsoupSerializeChildren(node);
  var out = "<" + node.tag;
  for (var key in node.attrs) {
    if (Object.prototype.hasOwnProperty.call(node.attrs, key)) out += " " + key + '="' + String(node.attrs[key]).replace(/"/g, "&quot;") + '"';
  }
  out += ">";
  out += __xsJsoupSerializeChildren(node);
  return out + "</" + node.tag + ">";
}

function __xsJsoupText(node) {
  if (!node) return "";
  if (node.tag === "#text") return String(node.text || "");
  var out = "";
  for (var i = 0; i < node.children.length; i++) {
    var child = node.children[i];
    if (child.tag === "script" || child.tag === "style") continue;
    out += __xsJsoupText(child) + " ";
  }
  return out;
}

function __xsJsoupElementMatches(node, simple) {
  if (!node || node.tag === "#text" || node.tag === "#root") return false;
  var tokens = simple.match(/(?:[.#]?[\\w:-]+|\\[[^\\]]+\\])/g) || [];
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.charAt(0) === "#") {
      if (node.attrs.id !== token.slice(1)) return false;
    } else if (token.charAt(0) === ".") {
      if (!node.classes[token.slice(1)]) return false;
    } else if (token.charAt(0) === "[") {
      var body = token.slice(1, -1);
      var eq = body.indexOf("=");
      var op = "";
      if (eq > 0 && body.charAt(eq - 1) !== "!") {
        var opChars = ["*=", "^=", "$="];
        for (var oi = 0; oi < opChars.length; oi++) {
          if (body.indexOf(opChars[oi]) >= 0 && body.indexOf(opChars[oi]) === eq - 1) op = opChars[oi];
        }
      }
      if (op) {
        var attr = body.slice(0, eq - 1).trim();
        var want = body.slice(eq + 1).replace(/^['"]|['"]$/g, "");
        var have = node.attrs[attr] || "";
        if (op === "*=" && have.indexOf(want) < 0) return false;
        if (op === "^=" && have.indexOf(want) !== 0) return false;
        if (op === "$=" && have.indexOf(want, have.length - want.length) < 0) return false;
      } else {
        var plainEq = body.indexOf("=");
        if (plainEq < 0) {
          if (node.attrs[body.trim()] === undefined) return false;
        } else {
          var key = body.slice(0, plainEq).trim().replace(/!$/, "");
          var expected = body.slice(plainEq + 1).replace(/^['"]|['"]$/g, "");
          var actual = node.attrs[key] || "";
          if (body.charAt(plainEq - 1) === "!") { if (actual === expected) return false; }
          else if (actual !== expected) return false;
        }
      }
    } else if (token !== "*") {
      if (node.tag !== token.toLowerCase()) return false;
    }
  }
  return true;
}

function __xsJsoupSelectAll(root) {
  var out = [];
  function walk(node) {
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (child.tag !== "#text") {
        out[out.length] = (child);
        walk(child);
      }
    }
  }
  walk(root);
  return out;
}

function __xsJsoupElements(list) {
  var wrapped = list.slice();
  wrapped.size = function () { return wrapped.length; };
  wrapped.get = function (index) { return wrapped[index]; };
  wrapped.first = function () { return wrapped[0] || null; };
  wrapped.last = function () { return wrapped[wrapped.length - 1] || null; };
  wrapped.isEmpty = function () { return wrapped.length === 0; };
  wrapped.text = function () {
    var out = [];
    for (var i = 0; i < wrapped.length; i++) out[out.length] = (wrapped[i].text());
    return out.join(" ");
  };
  wrapped.html = function () { return wrapped.length ? wrapped[0].html() : ""; };
  wrapped.outerHtml = function () { return wrapped.length ? wrapped[0].outerHtml() : ""; };
  wrapped.attr = function (name) { return wrapped.length ? wrapped[0].attr(name) : ""; };
  wrapped.select = function (selector) { return __xsJsoupCollect(wrapped, selector); };
  wrapped.toString = function () { return wrapped.outerHtml(); };
  for (var i = 0; i < wrapped.length; i++) wrapped[i] = __xsJsoupWrap(wrapped[i]);
  return wrapped;
}

function __xsJsoupWrap(node) {
  if (!node) return node;
  if (node.__xsApi) return node.__xsApi;
  var api = {
    __xsSelf: node,
    tagName: function () { return node.tag; },
    attr: function (name) { return node.attrs[String(name).toLowerCase()] || ""; },
    hasAttr: function (name) { return node.attrs[String(name).toLowerCase()] !== undefined; },
    text: function () { return __xsJsoupText(node).replace(/\\s+/g, " ").trim(); },
    ownText: function () {
      var out = [];
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tag === "#text") out[out.length] = (node.children[i].text);
      }
      return out.join(" ").replace(/\\s+/g, " ").trim();
    },
    html: function () { return __xsJsoupSerializeChildren(node); },
    outerHtml: function () { return __xsJsoupOuter(node); },
    toString: function () { return __xsJsoupOuter(node); },
    data: function () {
      var out = "";
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tag === "#text") out += node.children[i].text;
      }
      return out;
    },
    children: function () { return __xsJsoupElements(node.children.filter(function (c) { return c.tag !== "#text"; })); },
    parents: function () {
      var out = [];
      var p = node.parent;
      while (p && p.tag !== "#root") { out[out.length] = (p); p = p.parent; }
      return __xsJsoupElements(out);
    },
    siblingElements: function () {
      var out = [];
      var parent = node.parent || [];
      for (var i = 0; i < (parent.children || []).length; i++) {
        if (parent.children[i] !== node && parent.children[i].tag !== "#text") out[out.length] = (parent.children[i]);
      }
      return __xsJsoupElements(out);
    },
    nextElementSibling: function () {
      var parent = node.parent;
      if (!parent) return null;
      var index = parent.children.indexOf(node);
      for (var i = index + 1; i < parent.children.length; i++) {
        if (parent.children[i].tag !== "#text") return __xsJsoupWrap(parent.children[i]);
      }
      return null;
    },
    select: function (selector) { return __xsJsoupCollect([node], selector); },
    selectFirst: function (selector) { var r = __xsJsoupCollect([node], selector); return r.first(); },
    getElementById: function (id) { return __xsJsoupCollect([node], "#" + id).first(); },
    getElementsByClass: function (name) { return __xsJsoupCollect([node], "." + name); },
    getElementsByTag: function (name) { return __xsJsoupCollect([node], name); },
  };
  node.__xsApi = api;
  return api;
}

function __xsJsoupCollect(roots, selector) {
  var chains = String(selector || "").split(",").map(function (part) {
    var tokens = part.trim().split(/\\s+/);
    var chain = [];
    var direct = false;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === ">") { direct = true; continue; }
      if (tokens[i]) { chain[chain.length] = ({ simple: tokens[i], child: direct }); direct = false; }
    }
    return chain;
  }).filter(function (chain) { return chain.length; });
  var bareRoots = roots.map(function (root) { return root && root.__xsSelf ? root.__xsSelf : root; })
    .filter(function (root) { return root && root.tag !== "#text"; });
  var candidates = __xsJsoupSelectAll({ children: bareRoots, parent: null });
  var out = [];
  for (var i = 0; i < candidates.length; i++) {
    var node = candidates[i];
    for (var c = 0; c < chains.length; c++) {
      var chain = chains[c];
      if (__xsJsoupMatchChain(node, chain)) { out[out.length] = (node); break; }
    }
  }
  return __xsJsoupElements(out);
}

function __xsJsoupMatchFrom(node, chain, index) {
  if (!node || node.tag === "#root") return false;
  if (!__xsJsoupElementMatches(node, chain[index].simple)) return false;
  if (index === 0) return true;
  var parent = node.parent;
  if (chain[index].child) return __xsJsoupMatchFrom(parent, chain, index - 1);
  while (parent && parent.tag !== "#root") {
    if (__xsJsoupMatchFrom(parent, chain, index - 1)) return true;
    parent = parent.parent;
  }
  return false;
}

function __xsJsoupMatchChain(node, chain) {
  return __xsJsoupMatchFrom(node, chain, chain.length - 1);
}

var __xsJsoup = {
  parse: function (html) {
    return __xsJsoupWrap(__xsJsoupBuild(html));
  },
  parseBodyFragment: function (html) {
    return __xsJsoup.parse(html);
  },
};
`;

const RULE_HELPERS = `
function __xsJsonPathValue(data, path) {
  var current = data;
  var tokens = String(path || "").match(/\\[["']?[^\\]'"[]+["']?\\]|\\[\\*\\]|\\[-?\\d+\\]|[.$][A-Za-z_][\\w$]*|^[$.]/g) || [];
  var index = 0;
  if (tokens[0] === "$" || tokens[0] === ".") index = 1;
  for (; index < tokens.length; index++) {
    var token = tokens[index];
    if (current == null) return null;
    if (token.charAt(0) === "." && token.length > 1) {
      current = current[token.slice(1)];
    } else if (token.charAt(0) === "[" || token.charAt(0) === "$" || token.charAt(0) === ".") {
      var inner = token.slice(1, -1);
      if (inner === "*") {
        if (current instanceof Array) {
          var rest = tokens.slice(index + 1).join("");
          if (!rest) return current.join("\\n");
          var mapped = [];
          for (var mi = 0; mi < current.length; mi++) mapped[mi] = __xsJsonPathValue(current[mi], "$" + rest);
          return mapped.filter(function (item) { return item != null && item !== ""; }).join("\\n");
        }
        return null;
      }
      var key = inner.replace(/^["']|["']$/g, "");
      current = current != null ? current[key] : null;
    } else return null;
  }
  return current == null ? null : current;
}

function __xsJsonPath(result, path) {
  var data = result;
  if (typeof result === "string") {
    try { data = JSON.parse(result); } catch (error) { return ""; }
  }
  var value = __xsJsonPathValue(data, path);
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function __xsRuleStringPart(result, rule) {
  var value = String(rule || "").trim();
  var negated = value.charAt(0) === "!";
  if (negated) value = value.slice(1);
  var at = value.lastIndexOf("@");
  var selector = at > 0 ? value.slice(0, at) : value;
  var attribute = at > 0 ? value.slice(at + 1) : "text";
  if (selector === "" || selector === ".") return "";
  var doc = __xsJsoup.parse(typeof result === "string" ? result : (result && result.outerHtml ? result.outerHtml() : ""));
  var element = doc.select(selector).first();
  if (!element) return "";
  if (attribute === "text" || attribute === "textNodes") return element.text();
  if (attribute === "ownText") return element.ownText();
  if (attribute === "html" || attribute === "content") return element.html();
  if (attribute === "all") return element.outerHtml();
  return element.attr(attribute);
}

function __xsRuleString(result, rule) {
  var alternatives = String(rule || "").split("||");
  for (var i = 0; i < alternatives.length; i++) {
    var value = __xsRuleStringPart(result, alternatives[i]);
    if (value) return value;
  }
  return "";
}
`;

const STATE_HELPERS = `
var __xsState = {};
`;

export const RUNTIME_HELPERS = {
  __xsStrToBytes: UTF8_HELPERS,
  __xsBytesToStr: UTF8_HELPERS,
  __xsBase64Encode: BASE64_HELPERS,
  __xsBase64Decode: BASE64_HELPERS,
  __xsBase64Bytes: BASE64_HELPERS,
  __xsHexDecode: HEX_HELPERS,
  __xsHexBytes: HEX_HELPERS,
  __xsMd5: MD5_HELPERS,
  __xsTimeFormat: TIME_HELPERS,
  __xsTimeFormatUTC: TIME_HELPERS,
  __xsJsoup: JSOUP_HELPERS,
  __xsJsonPath: RULE_HELPERS,
  __xsRuleString: RULE_HELPERS,
  __xsState: STATE_HELPERS,
};

const HELPER_DEPENDENCIES = {
  __xsMd5: ["__xsStrToBytes"],
  __xsBase64Decode: ["__xsBase64Bytes", "__xsBytesToStr"],
  __xsBase64Encode: ["__xsStrToBytes"],
  __xsHexDecode: ["__xsBytesToStr", "__xsHexBytes"],
  __xsTimeFormat: [],
  __xsTimeFormatUTC: [],
  __xsStrToBytes: [],
  __xsBytesToStr: [],
  __xsBase64Bytes: [],
  __xsHexBytes: [],
  __xsJsoup: [],
  __xsJsonPath: [],
  __xsRuleString: ["__xsJsoup"],
  __xsState: [],
};

/**
 * 把脚本里实际用到的运行时助手按需内嵌到 `@js:` 主体开头。
 */
export function injectRuntimeHelpers(script) {
  const body = String(script || "");
  const marker = body.search(/@js:/i);
  if (marker < 0) return body;
  const prefix = body.slice(0, marker + 4);
  const rest = body.slice(marker + 4);
  const used = new Set();
  for (const name of Object.keys(RUNTIME_HELPERS)) {
    const callPattern = new RegExp(`\\b${name}\\s*[.\\[(]`);
    if (callPattern.test(rest)) used.add(name);
  }
  if (!used.size) return body;
  // 依赖助手一并注入，函数声明提升保证顺序无关。
  for (const name of [...used]) {
    for (const dep of HELPER_DEPENDENCIES[name] || []) used.add(dep);
  }
  const definitions = [...used].map((name) => RUNTIME_HELPERS[name].trim()).join("\n\n");
  return `${prefix}\n${definitions}\n${rest}`;
}
