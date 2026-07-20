import { hasUnsupportedLegadoRuntime, legadoTemplateExpression, rewriteLegadoJavaScript } from "./legadoJs.js";

function quoteXPath(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

const TEXT_PROPERTIES = new Set(["text", "textNodes", "ownText", "html"]);
const ATTR_PROPERTIES = new Set(["href", "src", "content", "value", "title", "alt", "data-src"]);
const RELATIVE_PROPERTIES = new Set([...TEXT_PROPERTIES, ...ATTR_PROPERTIES]);

function propertyToXPath(name, { bare = false } = {}) {
  if (name === "html") return "";
  if (TEXT_PROPERTIES.has(name)) return "/text()";
  if (ATTR_PROPERTIES.has(name) || name.startsWith("data-")) {
    // 单独 href：//@href 可命中节点自身；接在 a@href 后用 /@href。
    return bare ? `//@${name}` : `/@${name}`;
  }
  return "";
}

function splitCss(selector) {
  const parts = [];
  let current = "";
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (quote) {
      current += character;
      if (character === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === "[") {
      bracketDepth += 1;
      current += character;
    } else if (character === "]") {
      bracketDepth -= 1;
      current += character;
    } else if (character === "(") {
      parenthesisDepth += 1;
      current += character;
    } else if (character === ")") {
      parenthesisDepth -= 1;
      current += character;
    } else if (bracketDepth === 0 && parenthesisDepth === 0 && character === ">") {
      if (current.trim()) parts.push(current.trim());
      parts.push(">");
      current = "";
    } else if (bracketDepth === 0 && parenthesisDepth === 0 && /\s/.test(character)) {
      if (current.trim()) parts.push(current.trim());
      if (parts.at(-1) !== " " && parts.at(-1) !== ">") parts.push(" ");
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((part, index) => part !== " " || (index > 0 && parts[index - 1] !== ">"));
}

function jsoupRegexToContains(attribute, value) {
  // Jsoup `[attr~=regex]` uses regex matching. Approximate with literal contains().
  const literals = String(value)
    .replace(/\\[dDwWsS]/g, " ")
    .replace(/\\([.^$*+?()[\]{}|\\])/g, "$1")
    .split(/[^a-zA-Z0-9/_-]+/)
    .filter((part) => part.length >= 2);
  if (!literals.length) return [`@${attribute}`];
  return literals.map((part) => `contains(@${attribute}, ${quoteXPath(part)})`);
}

function cssAtomToXPath(atom) {
  let source = atom;
  let excludedFirst = false;
  let slicePredicate = "";
  if (/!0$/.test(source)) {
    source = source.slice(0, -2);
    excludedFirst = true;
  }

  // Legado/Jsoup supports result slices such as `li[0:-1]`. This is not a CSS
  // attribute selector: [0:-1] means all matches except the last one. Treating
  // it as an attribute made the generated XPath syntactically invalid.
  const slice = source.match(/\[\s*(-?\d*)\s*:\s*(-?\d*)\s*\]$/);
  if (slice && (slice[1] || slice[2])) {
    source = source.slice(0, slice.index);
    const start = slice[1] === "" ? null : Number(slice[1]);
    const end = slice[2] === "" ? null : Number(slice[2]);
    const clauses = [];
    if (start !== null) clauses.push(start >= 0
      ? `position() >= ${start + 1}`
      : `position() >= last() - ${Math.abs(start) - 1}`);
    if (end !== null) clauses.push(end >= 0
      ? `position() <= ${end}`
      : `position() <= last() - ${Math.abs(end)}`);
    slicePredicate = clauses.join(" and ");
  }

  // Legado also uses a single index like `.panel[-2]` / `li[0]` for the Nth
  // match (negative from the end). That must not become a bogus `@-2` attribute.
  const indexOnly = source.match(/\[\s*(-?\d+)\s*\]$/);
  if (!slicePredicate && indexOnly) {
    source = source.slice(0, indexOnly.index);
    const index = Number(indexOnly[1]);
    slicePredicate = index >= 0
      ? `position() = ${index + 1}`
      : `position() = last() - ${Math.abs(index) - 1}`;
  }

  const tagMatch = source.match(/^[a-zA-Z][\w-]*|^\*/);
  const tag = tagMatch?.[0] ?? "*";
  if (tagMatch) source = source.slice(tagMatch[0].length);
  const predicates = [];

  for (const match of source.matchAll(/#([\w-]+)/g)) {
    predicates.push(`@id=${quoteXPath(match[1])}`);
  }
  for (const match of source.matchAll(/\.([\w-]+)/g)) {
    predicates.push(`contains(concat(' ', normalize-space(@class), ' '), ${quoteXPath(` ${match[1]} `)})`);
  }
  for (const match of source.matchAll(/\[\s*([\w:-]+)(?:\s*([~|^$*]?=)\s*["']?([^\]"']+)["']?)?\s*\]/g)) {
    const [, attribute, operator, value] = match;
    // Numeric-only tokens are result indices handled above, never attributes.
    if (/^-?\d+$/.test(attribute)) continue;
    if (!operator) predicates.push(`@${attribute}`);
    else if (operator === "=") predicates.push(`@${attribute}=${quoteXPath(value.trim())}`);
    else if (operator === "*=") predicates.push(`contains(@${attribute}, ${quoteXPath(value.trim())})`);
    else if (operator === "^=") predicates.push(`starts-with(@${attribute}, ${quoteXPath(value.trim())})`);
    else if (operator === "$=") {
      const quoted = quoteXPath(value.trim());
      predicates.push(`substring(@${attribute}, string-length(@${attribute}) - string-length(${quoted}) + 1) = ${quoted}`);
    } else if (operator === "~=") {
      // Legado/Jsoup: regex. CSS3 ~= is word-match; prefer Jsoup semantics here.
      predicates.push(...jsoupRegexToContains(attribute, value.trim()));
    }
  }

  const contains = source.match(/:contains\(["']?(.*?)["']?\)/);
  if (contains) predicates.push(`contains(., ${quoteXPath(contains[1])})`);
  const nth = source.match(/:nth-(?:child|of-type)\(\s*(?:n\s*\+\s*)?(\d+)\s*\)/);
  if (nth) predicates.push(source.includes("n+") ? `position() >= ${nth[1]}` : `position() = ${nth[1]}`);
  const eq = source.match(/:eq\(\s*(-?\d+)\s*\)/);
  if (eq) predicates.push(Number(eq[1]) >= 0 ? `position() = ${Number(eq[1]) + 1}` : `position() = last() - ${Math.abs(Number(eq[1])) - 1}`);
  const lt = source.match(/:lt\(\s*(\d+)\s*\)/);
  if (lt) predicates.push(`position() <= ${lt[1]}`);
  if (excludedFirst) predicates.push("position() > 1");
  if (slicePredicate) predicates.push(slicePredicate);
  return `${tag}${predicates.map((predicate) => `[${predicate}]`).join("")}`;
}

function regexOnlyAttributeRule(rule, warn) {
  if (!String(rule).startsWith("##")) return "";
  const [pattern = "", replacement = ""] = String(rule).slice(2).split("##");
  if (!/^\$1(?:#*)?$/.test(replacement)) return "";
  const attribute = pattern.match(/\b(href|src|data-src|data-original|content)\s*=\s*["']\s*\(\[\^["']/i)?.[1]
    || pattern.match(/\b(href|src|data-src|data-original|content)\b/i)?.[1];
  if (!attribute) return "";
  const tag = pattern.match(/<\s*(a|img|meta|source)\b/i)?.[1]?.toLowerCase() || "*";
  warn(`纯 HTML 正则取 ${attribute} 已转换为 XPath 属性选择器`);
  return `//${tag}/@${attribute}`;
}

export function cssToXPath(selector) {
  const parts = splitCss(selector.trim());
  let xpath = "";
  let axis = "//";
  for (const part of parts) {
    if (part === ">") {
      axis = "/";
    } else if (part === " ") {
      axis = "//";
    } else {
      xpath += `${axis}${cssAtomToXPath(part)}`;
      axis = "//";
    }
  }
  return xpath || selector;
}

function indexPredicateFromSuffix(suffix) {
  const indices = suffix.split(":").map(Number);
  if (indices.length === 1) {
    const index = indices[0];
    return index >= 0 ? `[${index + 1}]` : `[last() - ${Math.abs(index) - 1}]`;
  }
  const clauses = indices.map((index) => (
    index >= 0 ? `position() = ${index + 1}` : `position() = last() - ${Math.abs(index) - 1}`
  ));
  return `[${clauses.join(" or ")}]`;
}

/**
 * 阅读的 a.1 / tag.p.0 是「匹配结果集中的第 N 个」，对应 XPath `(.//a)[2]`，
 * 而不是 sibling 语义的 `//a[2]`（后者要求该 a 是父节点下第 2 个 a 子元素）。
 * 使用 `.//` 形式，才能在目录/搜索列表的相对上下文中与文档绝对上下文同时正确。
 */
function withResultIndex(path, indexPredicate, first) {
  if (!indexPredicate) return path;
  const relative = path.startsWith("//") ? `.${path}` : path.startsWith("/") ? `.${path}` : `.//${path}`;
  if (first) return `(${relative})${indexPredicate}`;
  // Chained `/(…)` is not valid XPath 1.0 (and JSDOM/XSGG reject it).
  // A step predicate is evaluated within the current list item and preserves
  // Legado's usual tag.a.-1 / tag.p.0 intent.
  return `${path}${indexPredicate}`;
}

function legacySegmentToXPath(segment, first) {
  let value = segment.trim();
  if (!value) return "";
  if (value.startsWith("@") && !value.startsWith("@css:") && !/^@json:/i.test(value)) {
    value = value.slice(1);
  }

  const propertyPath = propertyToXPath(value);
  if (propertyPath !== "" || TEXT_PROPERTIES.has(value) || ATTR_PROPERTIES.has(value)) {
    return propertyPath;
  }

  let indexPredicate = "";
  const indexMatch = value.match(/\.((-?\d+)(?::-?\d+)*)$/);
  if (indexMatch) {
    indexPredicate = indexPredicateFromSuffix(indexMatch[1]);
    value = value.slice(0, -indexMatch[0].length);
  }
  if (value.startsWith("id.")) {
    return withResultIndex(`//*[@id=${quoteXPath(value.slice(3))}]`, indexPredicate, first);
  }
  if (value.startsWith("class.")) {
    const classes = value.slice(6).trim().split(/\s+/).filter(Boolean);
    const predicates = classes.map((name) => `contains(concat(' ', normalize-space(@class), ' '), ${quoteXPath(` ${name} `)})`);
    return withResultIndex(`//*[${predicates.join(" and ")}]`, indexPredicate, first);
  }
  if (value.startsWith("text.")) {
    return withResultIndex(`//*[contains(normalize-space(.), ${quoteXPath(value.slice(5))})]`, indexPredicate, first);
  }
  if (value.startsWith("tag.")) value = value.slice(4);
  if (/^[a-zA-Z][\w-]*$/.test(value)) {
    return withResultIndex(`//${value}`, indexPredicate, first);
  }
  const cssPath = cssToXPath(value);
  return withResultIndex(cssPath, indexPredicate, first);
}

function legadoHtmlToXPath(selector) {
  let source = selector.trim();
  if (/^@?(?:XPath|xpath):/.test(source)) return source.replace(/^@?(?:XPath|xpath):/, "");
  if (source.startsWith("//") || source.startsWith("(") || source.startsWith("/html") || source.startsWith("/text()") || source.startsWith("/@")) {
    return source;
  }
  if (/^@css:/i.test(source)) {
    const css = source.replace(/^@css:/i, "");
    const property = css.match(/@([A-Za-z_$][\w$-]*)$/)?.[1] || "";
    if (property && (RELATIVE_PROPERTIES.has(property) || property.startsWith("data-"))) {
      const path = cssToXPath(css.slice(0, -(property.length + 1)));
      return `${path}${propertyToXPath(property)}`;
    }
    return cssToXPath(css);
  }

  // Bare relative properties used inside list/detail items (very common in ruleToc).
  if (RELATIVE_PROPERTIES.has(source) || (source.startsWith("@") && RELATIVE_PROPERTIES.has(source.slice(1)))) {
    return propertyToXPath(source.startsWith("@") ? source.slice(1) : source, { bare: true }) || ".";
  }

  if (source.includes("@")) {
    const segments = source.split("@").filter(Boolean);
    // text.下一页@href → //a[contains(.,'下一页')]/@href
    // 不能用 //*[contains]/@href：祖先节点先命中且无 href 时，香色取首节点会得到空。
    if (segments[0]?.startsWith("text.") && segments.length >= 2) {
      const prop = segments[1].replace(/^@/, "");
      if (ATTR_PROPERTIES.has(prop) || prop.startsWith("data-")) {
        const label = quoteXPath(segments[0].slice(5));
        const head = `//a[contains(normalize-space(.), ${label})]`;
        const rest = segments.slice(1).map((segment) => legacySegmentToXPath(segment, false)).join("");
        return head + rest;
      }
    }
    return segments.map((segment, index) => legacySegmentToXPath(segment, index === 0)).join("");
  }
  if (source.startsWith("id.") || source.startsWith("class.") || source.startsWith("tag.") || source.startsWith("text.")) {
    return legacySegmentToXPath(source, true);
  }
  return cssToXPath(source);
}

function jsonPathToXsgg(path, warn) {
  let source = path.trim().replace(/^@json:/i, "");
  let jsSuffix = "";
  const jsMatch = source.match(/((?:@js:|<js>)[\s\S]*)$/i);
  if (jsMatch) {
    warn("阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查");
    jsSuffix = jsMatch[1].replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
    source = source.slice(0, jsMatch.index);
  }
  if (source.includes("..")) {
    warn("JSONPath 的递归下降操作符 '..' 在香色中没有完全等价语法，已按普通路径转换");
    source = source.replace(/\.\./g, ".");
  }
  if (/\[\?\(|\[\(/.test(source)) {
    warn("JSONPath 过滤表达式在香色中没有完全等价语法，已保留父级数组路径");
    source = source.replace(/\[\?\([\s\S]*?\)\]|\[\([\s\S]*?\)\]/g, "");
  }
  const converted = source
    .replace(/^\$\.?/, "")
    .replace(/\[['"]([^'"]+)['"]\]/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\[\*\]/g, "")
    .replace(/\.\*/g, "")
    .replace(/\./g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!jsSuffix) return converted;
  return converted
    ? `${converted}||${jsSuffix}`
    : jsSuffix;
}

function appendRegexReplacement(converted, suffix, warn) {
  const [pattern = "", replacement = ""] = suffix.split("##");
  if (!pattern) return converted;

  // Legado chapter option idiom: href##$##,{"webView":true} → append option at end of URL.
  // 香色不支持该 URL 尾部配置，这里丢掉配置并告警，只保留链接本身。
  if (pattern === "$" && /webView/i.test(replacement)) {
    warn("章节链接中的 webView 附加配置无法自动映射到香色 URL 字段，已只保留链接；如需 webView 请在正文 requestInfo 中配置");
    return converted;
  }

  let safeReplacement = replacement;
  if (/\{\{\s*(?:Get|get)\s*\(/i.test(safeReplacement)) {
    warn("替换结果含 Get(...) 登录变量，已去掉该片段；镜像/分流参数请在香色中手工配置");
    safeReplacement = safeReplacement.replace(/\{\{\s*(?:Get|get)\(\s*['"][^'"]+['"]\s*\)\s*\}\}/gi, "");
  }

  try {
    // Validate only. The expression itself is executed by 香色闺阁.
    new RegExp(pattern);
  } catch {
    warn("清理正则无法解析，已原样写入转换结果");
  }
  return `${converted}||@js:\nreturn String(result).replace(new RegExp(${JSON.stringify(pattern)}, "g"), ${JSON.stringify(safeReplacement)});`;
}

/**
 * 展开阅读 Mustache：
 * - {{@sel}} / {{@@sel}} → 选择器本身
 * - 多行 Mustache → || 备选
 * - 末尾 @js / <js> 仍接到后续 convertRule 处理
 */
function expandMustacheRule(rule, warn) {
  const trimmed = rule.trim();
  if (!/\{\{/.test(trimmed)) return trimmed;

  const mustacheOnly = /^\s*(?:\{\{[\s\S]*?\}\}\s*)+(?:(?:@js:|<js>)[\s\S]*)?$/i.test(trimmed);
  if (!mustacheOnly && !/\{\{\s*@/.test(trimmed)) return trimmed;

  const fragments = [];
  let trailingJs = "";
  const jsMatch = trimmed.match(/((?:@js:|<js>)[\s\S]*)$/i);
  let body = trimmed;
  if (jsMatch) {
    trailingJs = jsMatch[1].trim();
    body = trimmed.slice(0, jsMatch.index).trim();
  }

  for (const match of body.matchAll(/\{\{\s*(@?@?)([\s\S]*?)\}\}/g)) {
    const marks = match[1] || "";
    let inner = match[2].trim();
    if (!inner) continue;
    if (/^(?:Get|get)\s*\(/i.test(inner)) {
      warn(`规则中的 {{${marks}${inner}}} 依赖阅读登录变量，无法自动转换`);
      continue;
    }
    // {{@@sel}} = 全部匹配；香色用同一选择器，由客户端聚合
    if (marks === "@@") {
      warn("阅读 {{@@...}}（全部匹配）已按普通选择器转换，聚合语义请实测");
    }
    fragments.push(inner);
  }

  if (!fragments.length) return trimmed;
  const joined = fragments.join("||");
  return trailingJs ? `${joined}\n${trailingJs}` : joined;
}

function looksLikeJsonPath(value) {
  const trimmed = value.trim();
  if (/^\s*(?:@?json:|\$[.[])/i.test(trimmed)) return true;
  if (RELATIVE_PROPERTIES.has(trimmed) || RELATIVE_PROPERTIES.has(trimmed.replace(/^@/, ""))) return false;
  if (/^(?:class|id|tag|text)\./i.test(trimmed)) return false;
  // JSONPath filters: data.items[?(@.id)] / data[(@.length)]
  if (/^[\w$-]+(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[\?\([\s\S]*?\)\]|\[\([\s\S]*?\)\])+$/.test(trimmed)) return true;
  if (/[#>@\s]|=/.test(trimmed) || /^\./.test(trimmed)) return false;
  if (/\[(?!\?|\(|\d|\*)/.test(trimmed)) return false;
  // data / bookName / authorName — bare JSON object fields
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return true;
  // data.books / data.books[0].title / data||data.items
  if (/^[\w$-]+(?:\[[\d*]+\]|\.[\w$*\[\]-]+)+$/.test(trimmed)) return true;
  return splitTopLevel(trimmed, "||").length > 1
    && splitTopLevel(trimmed, "||").every((part) => looksLikeJsonPath(part));
}

function looksLikeHtmlRule(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:@js:|<js>)/i.test(trimmed)) return false;
  if (/^\s*(?:@?json:|\$[.[])/i.test(trimmed)) return false;
  // A composed absolute URL is an output value, not an HTML selector. Treating
  // `https://.../{{$.id}}` as XPath solely because it contains `//` makes a
  // JSON detail response enter the DOM parser.
  if (/^https?:\/\//i.test(trimmed)) return false;
  // JSON URL / field templates: /pc/book/{$.id}/catalog or {{$.name}}
  if (/\{(?:\{\s*)?\$\./.test(trimmed)) return false;
  // Common Legado JSON form `field@js:...` / `field||alt@js:` is not HTML.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\s*\|\|\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)*(?:@js:|<js>)/i.test(trimmed)) {
    return false;
  }
  if (looksLikeJsonPath(trimmed.split(/(?:@js:|<js>|##)/i, 1)[0].trim())) return false;
  if (RELATIVE_PROPERTIES.has(trimmed) || RELATIVE_PROPERTIES.has(trimmed.replace(/^@/, ""))) return true;
  if (/\/\/|^\/html|@(?:text|href|src|html|css:)|^\s*(?:class|id|tag|text)\./i.test(trimmed)) return true;
  if (/[#>\[\]]/.test(trimmed) && !/\[\?\(|\[\(/.test(trimmed)) return true;
  // CSS `div.class` / `a.href`, but not JSON `data.items` / `bookName`.
  if (/(?:^|[\s>+~,])(?:[a-z][\w-]*)\.(?:[a-z][\w-]*)/i.test(trimmed)
    && /(?:^|[\s>+~,])(?:div|span|a|p|li|ul|ol|td|tr|table|img|h[1-6]|section|article|main|body|html)\./i.test(trimmed)) {
    return true;
  }
  if (/\s/.test(trimmed) && /[a-z]/i.test(trimmed)) return true;
  return false;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let current = "";
  let depthParen = 0;
  let depthBracket = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depthParen += 1;
    else if (character === ")") depthParen -= 1;
    else if (character === "[") depthBracket += 1;
    else if (character === "]") depthBracket -= 1;
    else if (depthParen === 0 && depthBracket === 0 && value.startsWith(separator, index)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      index += separator.length - 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function rewriteCssHas(selector, warn) {
  // li:has(a) → keep as CSS-like host[.//inner] then cssToXPath for host only
  return selector.replace(/(^|[\s>+,])([a-zA-Z*][\w-]*(?:[.#\[][^\s:<>]*)*):has\(([^()]+)\)/gi, (_, prefix, host, inner) => {
    warn(`CSS :has() 已近似转换，复杂条件请人工复核：:has(${inner})`);
    const hostPath = cssToXPath(host.trim());
    const innerPath = cssToXPath(inner.trim()).replace(/^\/\//, ".//");
    // Emit an already-xpath fragment that legadoHtmlToXPath will keep (starts with //)
    const combined = `${hostPath}[${innerPath}]`;
    return `${prefix}${combined.startsWith("//") ? combined : `//${combined}`}`;
  });
}

export function convertRule(rule, { responseType = "html", warn = () => {} } = {}) {
  if (rule === undefined || rule === null) return "";
  if (Array.isArray(rule)) return rule.map((item) => convertRule(item, { responseType, warn })).join("||");
  if (typeof rule !== "string") return String(rule);
  let trimmed = rule.trim();
  if (!trimmed) return "";

  const attributeFallback = regexOnlyAttributeRule(trimmed, warn);
  if (attributeFallback) return attributeFallback;

  const literalMustache = trimmed.match(/^\{\{\s*(["'])([\s\S]*)\1\s*\}\}$/);
  if (literalMustache) {
    return `@js:\nreturn ${JSON.stringify(literalMustache[2])};`;
  }
  const runtimeMustache = trimmed.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);
  const runtimeExpression = runtimeMustache ? legadoTemplateExpression(runtimeMustache[1]) : "";
  if (runtimeExpression) return `@js:\nreturn String(${runtimeExpression});`;

  const leadingScript = trimmed.match(/^<js>([\s\S]*?)<\/js>\s*([\s\S]+)$/i);
  if (leadingScript) {
    warn("列表规则开头的阅读 JavaScript 前处理无法安全移植，已忽略前处理并保留后续选择器");
    trimmed = leadingScript[2].trim();
  }

  if (/^(?:@js:|<js>)/i.test(trimmed)) {
    const normalized = trimmed.replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
    const rewritten = rewriteLegadoJavaScript(normalized);
    warn(rewritten === normalized
      ? "阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查"
      : "已将阅读 JavaScript 中的分页、关键词或结果字段模板转换为香色运行时表达式");
    return rewritten;
  }

  // Absolute or relative JSON URL / field templates:
  // `/pc/book/{$.id}` / `{$.free}{$.name}` / `https://x/{{$.id}}`.
  // Rewrite before HTML/JSONPath branching so `{$.field}` is not treated as a path.
  if ((/\{\{\s*\$\./.test(trimmed) || /(?<!\{)\{(\$\.[^}]+)\}(?!\})/.test(trimmed))
    && !looksLikeHtmlRule(trimmed.replace(/\{(?:\{\s*)?\$\.[^}]+\}(?:\})?/g, "x"))) {
    let template = trimmed;
    let scriptBody = "";
    let cleanupPattern = "";
    let cleanupReplacement = "";
    const trailing = template.match(/^([\s\S]*?)((?:@js:|<js>)[\s\S]*)$/i);
    if (trailing && trailing[1].trim()) {
      template = trailing[1].trim();
      let script = trailing[2].trim().replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
      const scriptCleanup = script.match(/^@js:\s*([\s\S]*?)##([\s\S]*)$/i);
      if (scriptCleanup) {
        scriptBody = scriptCleanup[1].trim().replace(/;\s*$/, "");
        const [pattern = "", replacement = ""] = scriptCleanup[2].split("##");
        cleanupPattern = pattern;
        cleanupReplacement = replacement;
      } else {
        scriptBody = script.replace(/^@js:\s*/i, "").replace(/;\s*$/, "");
      }
    } else {
      const templateCleanup = template.match(/^(.*?)##([\s\S]*)$/);
      if (templateCleanup && /\{(?:\{\s*)?\$\./.test(templateCleanup[1])) {
        template = templateCleanup[1].trim();
        const [pattern = "", replacement = ""] = templateCleanup[2].split("##");
        cleanupPattern = pattern;
        cleanupReplacement = replacement;
      }
    }
    let expression = rewriteLegadoJavaScript(`@js:\nreturn ${JSON.stringify(template)};`)
      .replace(/^@js:\s*return\s+/i, "")
      .replace(/;\s*$/, "");
    if (scriptBody) {
      expression = `(function(result){ return (${scriptBody}); })(${expression})`;
    }
    if (cleanupPattern) {
      expression = `String(${expression}).replace(new RegExp(${JSON.stringify(cleanupPattern)}, "g"), ${JSON.stringify(cleanupReplacement)})`;
    }
    const composed = `@js:\nreturn ${expression};`;
    if (!composed.includes("{{") && !/\{(\$\.)/.test(composed)) {
      if (!hasUnsupportedLegadoRuntime(composed)) warn("已将阅读 JSON 字段模板转换为香色运行时表达式");
      return composed;
    }
  }

  if (trimmed.includes("{{") && !/\{\{\s*@/.test(trimmed)) {
    const composed = rewriteLegadoJavaScript(`@js:\nreturn ${JSON.stringify(trimmed)};`);
    if (!composed.includes("{{")) return composed;
  }

  if (/\{\{/.test(trimmed)) {
    trimmed = expandMustacheRule(trimmed, warn);
    if (!trimmed) return "";
  }

  // Absolute URL literal fallback: img@src||https://cdn/.../fallback.png
  if (/^https?:\/\//i.test(trimmed)) {
    return rewriteLegadoJavaScript(`@js:\nreturn ${JSON.stringify(trimmed)};`);
  }

  // Trailing <js>/@js after a selector (Legado often writes `href\n<js>...</js>`).
  // 也兼容 `selector@js:...`；但 `|| @js:` 是香色既有的备选/后处理形式，
  // 不能误切成 selector + 单竖线 JS。
  let trailingJs = trimmed.match(/^([\s\S]*?)(\n\s*(?:@js:|<js>)[\s\S]*)$/i);
  if (!trailingJs && !trimmed.includes("||")) {
    trailingJs = trimmed.match(/^([\s\S]*?)((?:@js:|<js>)[\s\S]*)$/i);
  }
  if (trailingJs && trailingJs[1].trim() && /[@$.#\[a-z]/i.test(trailingJs[1])) {
    const head = convertRule(trailingJs[1].trim(), { responseType, warn });
    const script = rewriteLegadoJavaScript(
      trailingJs[2].trim().replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, ""),
    );
    if (/(?:\bjava\.|\bPackages\b|\bsource\.|\bbook\.|traditionalToSimplified|\beval\s*\()/i.test(script)) {
      warn("选择器后的阅读专用 JavaScript 在香色不可执行，已保留基础选择器并忽略该后处理");
      return head;
    }
    warn("阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查");
    // 2.56.1 的公开可用源与独立模拟器统一使用 `selector||@js:`。
    // 单管道虽然出现在部分旧文档中，但真实客户端上会出现只执行选择器、
    // 不把结果交给 JS 的兼容差异，因此发布产物固定使用双管道。
    return `${head}||${script}`;
  }

  // Apply ## cleanup to the whole rule (including && combinations) before splitting.
  const replacementIndex = trimmed.indexOf("##");
  if (replacementIndex >= 0) {
    const selector = trimmed.slice(0, replacementIndex);
    const suffix = trimmed.slice(replacementIndex + 2);
    // Pipes after ## belong to the regular expression, not to Legado selector
    // alternatives (for example ad|script cleanup patterns).
    if (!selector.includes("||") && !selector.includes("|")) {
      const converted = convertRule(selector, { responseType, warn });
      const wrapped = converted.includes(" | ") ? `(${converted})` : converted;
      return appendRegexReplacement(wrapped, suffix, warn);
    }
  }

  // Legado `&&` joins all matched texts with newline; approximate with XPath union.
  if (trimmed.includes("&&")) {
    const parts = trimmed.split("&&").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      const convertedParts = parts.map((part) => convertRule(part, { responseType, warn }));
      if (convertedParts.every((part) => part.startsWith("/") || part.startsWith("("))) {
        warn("阅读的 &&（拼接全部匹配）已近似转换为 XPath 并集；若结果不符合预期请手工调整");
        return convertedParts.join(" | ");
      }
      return convertedParts.join("||");
    }
  }

  // Legado / CSS alternatives: || , and single | (not XPath " | ")
  let alternatives = splitTopLevel(trimmed, "||");
  if (alternatives.length === 1 && trimmed.includes("|") && !trimmed.includes(" | ")) {
    alternatives = splitTopLevel(trimmed, "|");
  }
  if (alternatives.length === 1 && /,(?![^\[]*\])/.test(trimmed) && !trimmed.includes("@json:") && !trimmed.startsWith("$")) {
    const commaParts = splitTopLevel(trimmed, ",");
    if (commaParts.length > 1 && commaParts.every((part) => !part.includes("{{"))) {
      alternatives = commaParts;
    }
  }
  if (alternatives.length > 1) {
    return alternatives.map((part) => convertRule(part, { responseType, warn })).filter(Boolean).join("||");
  }

  const forceJson = /^@?json:/i.test(trimmed) || trimmed.startsWith("$");
  const bareRelativeProperty = RELATIVE_PROPERTIES.has(trimmed)
    || RELATIVE_PROPERTIES.has(trimmed.replace(/^@/, ""));
  // In a declared JSON response, `title`, `content`, `src`, `data.items` and
  // similar names are overwhelmingly object fields. They were previously forced
  // down the HTML attribute path (`//@title` / `//data`), so a valid API
  // response produced an empty bridge list. Explicit CSS/XPath/`a@href` rules
  // still override JSON.
  const forceHtml = looksLikeHtmlRule(trimmed)
    && !(responseType === "json" && (bareRelativeProperty || looksLikeJsonPath(trimmed)));
  const isJson = forceJson || (responseType === "json" && !forceHtml) || (responseType !== "html" && looksLikeJsonPath(trimmed) && !looksLikeHtmlRule(trimmed));
  if (isJson) return jsonPathToXsgg(trimmed, warn);

  const withHas = /:has\(/i.test(trimmed) ? rewriteCssHas(trimmed, warn) : trimmed;
  return legadoHtmlToXPath(withHas);
}

export function inferResponseType(rules = {}) {
  const values = Object.values(rules).filter((value) => typeof value === "string" && value.trim());
  if (!values.length) return "html";

  const explicitJsonCount = values.filter((value) => (
    /^\s*(?:@?json:|\$[.[])/i.test(value) || /\{\{\s*\$\.[^}]+\}\}/.test(value)
  )).length;
  const htmlCount = values.filter((value) => looksLikeHtmlRule(value)).length;
  const implicitJsonCount = values.filter((value) => looksLikeJsonPath(value)).length;

  if (explicitJsonCount > 0 && htmlCount === 0) return "json";
  if (explicitJsonCount > htmlCount) return "json";
  if (htmlCount > 0) return "html";
  return implicitJsonCount > 0 ? "json" : "html";
}
