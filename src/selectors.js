import { hasUnsupportedLegadoRuntime, legadoTemplateExpression, rewriteLegadoJavaScript, rewriteLegadoJavaScriptRaw } from "./legadoJs.js";
import { injectRuntimeHelpers } from "./legadoRuntime.js";

function quoteXPath(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

const TEXT_PROPERTIES = new Set(["text", "textNodes", "ownText", "html"]);
const ATTR_PROPERTIES = new Set(["href", "src", "content", "value", "title", "alt", "data-src"]);
const RELATIVE_PROPERTIES = new Set([...TEXT_PROPERTIES, ...ATTR_PROPERTIES]);
const HTML_ELEMENTS = new Set([
  "html", "body", "main", "header", "footer", "nav", "article", "section", "aside",
  "div", "span", "p", "a", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "h1", "h2", "h3", "h4", "h5", "h6", "img", "picture", "source",
  "audio", "video", "iframe", "form", "input", "button", "label", "select", "option",
  "strong", "b", "em", "i", "small", "time", "br", "pre", "code", "blockquote",
]);

function propertyToXPath(name, { bare = false } = {}) {
  if (name === "html") return "";
  if (TEXT_PROPERTIES.has(name)) return "/text()";
  // 自定义属性（init-data）含连字符；排除 class.xxx / tag.xxx 这类分段选择器。
  const customAttr = /^[A-Za-z_][\w-]*$/.test(name) && name.includes("-");
  if (ATTR_PROPERTIES.has(name) || name.startsWith("data-") || customAttr) {
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
  const raw = String(value);
  // Common Legado form `[property~=category|status|update_time]`: Jsoup treats
  // `~=` as regex, so `|` is alternation (OR), not an AND of contains().
  if (/^(?:[a-zA-Z0-9/_-]+\|){1,}[a-zA-Z0-9/_-]+$/.test(raw)) {
    const parts = raw.split("|").filter(Boolean);
    return [`(${parts.map((part) => `contains(@${attribute}, ${quoteXPath(part)})`).join(" or ")})`];
  }
  // Approximate other regexes with literal contains() fragments.
  const literals = raw
    .replace(/\\[dDwWsS]/g, " ")
    .replace(/\\([.^$*+?()[\]{}|\\])/g, "$1")
    .split(/[^a-zA-Z0-9/_-]+/)
    .filter((part) => part.length >= 2);
  if (!literals.length) return [`@${attribute}`];
  return literals.map((part) => `contains(@${attribute}, ${quoteXPath(part)})`);
}

function wrapResultSetPredicate(path, predicate) {
  if (!predicate) return path;
  const relative = path.startsWith("//") ? `.${path}` : path.startsWith("/") ? `.${path}` : `.//${path}`;
  return `(${relative})[${predicate}]`;
}

function cssAtomToXPath(atom) {
  let source = atom;
  let excludedFirst = false;
  let resultSetPredicate = "";
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
    resultSetPredicate = clauses.join(" and ");
  }

  // Legado also uses a single index like `.panel[-2]` / `li[0]` / `a[1]` for the
  // Nth match in the result set (same idea as `tag.a.1`), not "Nth sibling a".
  const indexOnly = source.match(/\[\s*(-?\d+)\s*\]$/);
  if (!resultSetPredicate && indexOnly) {
    source = source.slice(0, indexOnly.index);
    const index = Number(indexOnly[1]);
    resultSetPredicate = index >= 0
      ? String(index + 1)
      : `last() - ${Math.abs(index) - 1}`;
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
  if (eq) {
    // :eq(n) is also result-set indexing in Jsoup.
    const index = Number(eq[1]);
    resultSetPredicate = index >= 0
      ? String(index + 1)
      : `last() - ${Math.abs(index) - 1}`;
  }
  const lt = source.match(/:lt\(\s*(\d+)\s*\)/);
  if (lt) predicates.push(`position() <= ${lt[1]}`);
  if (excludedFirst) predicates.push("position() > 1");
  const core = `${tag}${predicates.map((predicate) => `[${predicate}]`).join("")}`;
  return { core, resultSetPredicate };
}

function regexOnlyAttributeRule(rule, warn) {
  if (!String(rule).startsWith("##")) return "";
  const [pattern = "", replacement = ""] = String(rule).slice(2).split("##");
  if (!/^\$1(?:#*)?$/.test(replacement)) return "";
  const normalizedPattern = pattern.replace(/\\([-=])/g, "$1");
  const attribute = normalizedPattern.match(
    /\b(href|src|content|value|title|alt|data-[A-Za-z0-9_-]+)\s*=\s*["']\s*\(\[\^["']/i,
  )?.[1] || normalizedPattern.match(
    /\b(href|src|content|value|title|alt|data-[A-Za-z0-9_-]+)\b/i,
  )?.[1];
  if (!attribute) return "";
  const tag = normalizedPattern.match(/<\s*(a|img|meta|source)\b/i)?.[1]?.toLowerCase() || "*";
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
      const { core, resultSetPredicate } = cssAtomToXPath(part);
      xpath += `${axis}${core}`;
      if (resultSetPredicate) xpath = wrapResultSetPredicate(xpath, resultSetPredicate);
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

function looksLikeNativeXPath(source) {
  const value = String(source || "").trim();
  // Relative/absolute XPath used directly in public collections
  // (Gutenberg/Standard Ebooks/DuckDuckGo-style rules).
  if (/^(?:\.\.?\/|\/\/|\()/.test(value)) return true;
  if (/^text\(\)$/i.test(value)) return true;
  return false;
}

function legadoHtmlToXPath(selector) {
  let source = selector.trim();
  if (/^@?(?:XPath|xpath):/.test(source)) return source.replace(/^@?(?:XPath|xpath):/, "");
  if (looksLikeNativeXPath(source)
    || source.startsWith("/html")
    || source.startsWith("/text()")
    || source.startsWith("/@")) {
    return source;
  }
  if (/^@css:/i.test(source)) {
    const css = source.replace(/^@css:/i, "");
    const property = css.match(/@([A-Za-z_$][\w$-]*)$/)?.[1] || "";
    if (property && (RELATIVE_PROPERTIES.has(property) || property.startsWith("data-") || (/^[A-Za-z_][\w-]*$/.test(property) && property.includes("-")))) {
      const path = cssToXPath(css.slice(0, -(property.length + 1)));
      return `${path}${propertyToXPath(property)}`;
    }
    return cssToXPath(css);
  }

  // Bare relative properties used inside list/detail items (very common in ruleToc).
  if (RELATIVE_PROPERTIES.has(source) || (source.startsWith("@") && RELATIVE_PROPERTIES.has(source.slice(1)))) {
    return propertyToXPath(source.startsWith("@") ? source.slice(1) : source, { bare: true }) || ".";
  }
  const bareAttribute = source.match(/^@([A-Za-z_][\w:-]*)$/);
  if (bareAttribute) return `//@${bareAttribute[1]}`;

  if (source.includes("@")) {
    const segments = source.split("@").filter(Boolean);
    if (/^title$/i.test(segments[0] || "") && /^(?:text|textNodes|ownText|html)$/i.test(segments[1] || "")) {
      return `//title${propertyToXPath(segments[1])}`;
    }
    // text.下一页@href → //a[contains(.,'下一页')]/@href
    // 不能用 //*[contains]/@href：祖先节点先命中且无 href 时，香色取首节点会得到空。
    if (segments[0]?.startsWith("text.") && segments.length >= 2) {
      const prop = segments[1].replace(/^@/, "");
      if (ATTR_PROPERTIES.has(prop) || prop.startsWith("data-") || (/^[A-Za-z_][\w-]*$/.test(prop) && prop.includes("-"))) {
        const label = quoteXPath(segments[0].slice(5));
        const head = `//a[contains(normalize-space(.), ${label})]`;
        const rest = segments.slice(1).map((segment) => legacySegmentToXPath(segment, false)).join("");
        return head + rest;
      }
    }
    return segments.map((segment, index) => {
      if (index > 0 && /^[A-Za-z_][\w:-]*$/.test(segment)
        && !TEXT_PROPERTIES.has(segment)
        && !ATTR_PROPERTIES.has(segment)
        && !HTML_ELEMENTS.has(segment.toLowerCase())) return `/@${segment}`;
      return legacySegmentToXPath(segment, index === 0);
    }).join("");
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
  const filtered = encodeSimpleJsonFilter(source, jsSuffix);
  if (filtered) {
    warn("JSONPath 条件筛选已转换为通用规则桥接筛选器");
    return filtered;
  }
  const recursiveRoot = source.trim().match(/^\$\.\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\.\*|\[\*\])?$/);
  if (recursiveRoot && !jsSuffix) {
    warn("JSONPath 根级递归下降已转换为通用递归选择器");
    return `@json-recursive:${encodeURIComponent(recursiveRoot[1])}${recursiveRoot[2] ? ":values" : ""}`;
  }
  if (source.includes("..")) {
    // `$..data[*]` / `$..content` from public comic/novel APIs almost always
    // mean the root field of that name. Only warn when recursion sits under a
    // prefix or descends through multiple segments, where the approximation is
    // more lossy.
    const onlyRootField = /^\$\.\.[A-Za-z_$][\w$]*(?:\[\*?\])?$/.test(source.trim());
    if (!onlyRootField) {
      warn("JSONPath 的递归下降操作符 '..' 在香色中没有完全等价语法，已按普通路径转换");
    }
    source = source.replace(/\.\./g, ".");
  }
  if (/\[\?\(|\[\(/.test(source)) {
    warn("JSONPath 过滤表达式在香色中没有完全等价语法，已保留父级数组路径");
    source = source.replace(/\[\?\([\s\S]*?\)\]|\[\([\s\S]*?\)\]/g, "");
  }
  const rootArray = /^\$\.?\[\*\]$/.test(source.trim());
  const converted = source
    .replace(/^\$\.?/, "")
    .replace(/\[['"]([^'"]+)['"]\]/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\[\*\]/g, "")
    .replace(/\.\*/g, "")
    .replace(/\./g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!jsSuffix) return converted || (rootArray || /^\$$/.test(source.trim()) ? "." : "");
  return converted
    ? chainJsPostprocess(converted, jsSuffix)
    : jsSuffix;
}

function encodeSimpleJsonFilter(source, jsSuffix = "") {
  const match = String(source || "").trim().match(/^(.*?)(?:\[\?\(([\s\S]+)\)\])(?:\[\*\])?\s*$/);
  if (!match) return "";
  const conditions = match[2].split(/\s*\|\|\s*/).map((condition) => (
    condition.trim().replace(/^\(+|\)+$/g, "").trim()
  ));
  const parsed = conditions.map((condition) => condition.match(
    /^@\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*={2,3}\s*(["'])([\s\S]*?)\2$/,
  ));
  if (!parsed.length || parsed.some((condition) => !condition)) return "";
  const field = parsed[0][1];
  if (parsed.some((condition) => condition[1] !== field)) return "";
  let values = [...new Set(parsed.map((condition) => condition[3]))];

  // A common Legado form first selects several node types and then narrows the
  // result in a short JS filter. Preserve that narrower declarative condition.
  const scriptValue = String(jsSuffix || "").match(
    new RegExp(`(?:item|it|node|track|result)\\.${field.replace(/\./g, "\\.")}\\s*={2,3}\\s*(["'])([\\s\\S]*?)\\1`, "i"),
  );
  if (scriptValue && values.includes(scriptValue[2])) values = [scriptValue[2]];

  let base = match[1].trim().replace(/^\$\.?/, "");
  const recursive = /\.\.$/.test(base) || /^\$\.\.$/.test(match[1].trim());
  base = base.replace(/\.\.$/, "").replace(/\[\*\]/g, "").replace(/\./g, "/").replace(/^\/+|\/+$/g, "");
  return [
    "@json-filter",
    recursive ? "recursive" : "direct",
    encodeURIComponent(base),
    encodeURIComponent(field.replace(/\./g, "/")),
    values.map((value) => encodeURIComponent(value)).join(","),
  ].join(":");
}

function stripLegadoRegexOptions(replacement, warn) {
  let value = String(replacement ?? "");
  // Trailing ### (or extra #) is Legado's end-of-replace marker, not part of $n.
  value = value.replace(/#+$/, "");
  const optionMatch = value.match(/^([\s\S]*?),(\{[\s\S]*\})\s*$/);
  if (optionMatch) {
    try {
      const options = JSON.parse(optionMatch[2]);
      if (options && typeof options === "object" && !Array.isArray(options)) {
        warn("正则替换后的 headers/webView 等附加配置无法映射到香色字段，已忽略配置并保留替换文本");
        return optionMatch[1];
      }
    } catch {
      // Keep the original replacement when the trailing object is not JSON.
    }
  }
  return value;
}

/**
 * 给规则追加一段 `@js:` 后处理。规则已有 `||@js:` 或本身就是脚本时，把已有
 * 脚本包进 IIFE、让新脚本接续处理其返回值——直接再拼一个 `||@js:` 会产生
 * 两个 @js: 段，香色无法执行。
 */
function chainJsPostprocess(rule, processorBody) {
  const source = String(rule || "").trim();
  const body = String(processorBody || "").replace(/^\s*@js:\s*/i, "").trim();
  if (!body) return source;
  const segments = [];
  let selector = "";
  const splitMatch = source.match(/^([\s\S]*?)\|\|\s*@js:([\s\S]*)$/i);
  const pureScript = !splitMatch && /^@js:/i.test(source);
  if (splitMatch) {
    selector = splitMatch[1].trim();
    segments.push(splitMatch[2].trim());
  } else if (pureScript) {
    segments.push(source.replace(/^@js:\s*/i, "").trim());
  } else {
    selector = source;
  }
  segments.push(body);
  const lines = ["@js:"];
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    const seed = index === 0 ? "result" : `__r${index - 1}`;
    lines.push(`${isLast ? "return " : "var __r" + index + " = "}(function (result) {`);
    lines.push(segment);
    lines.push(`})(${seed});`);
  });
  const composed = lines.join("\n");
  return selector ? `${selector}||${composed}` : composed;
}

function appendRegexReplacement(converted, suffix, warn) {
  const [pattern = "", replacement = ""] = suffix.split("##");
  if (!pattern) return converted;

  const safeReplacement = stripLegadoRegexOptions(replacement, warn);

  // Legado URL append idiom: href##$##?page=1 or {{baseUrl}}##$##?page=1
  // Pattern `$` means "end of string" / append, not a regexp substitution.
  if (pattern === "$") {
    if (/webView/i.test(replacement)) {
      warn("章节链接中的 webView 附加配置无法自动映射到香色 URL 字段，已只保留链接；如需 webView 请在正文 requestInfo 中配置");
      return converted;
    }
    if (!safeReplacement) return converted;
    return chainJsPostprocess(converted, `return String(result || "") + ${JSON.stringify(safeReplacement)};`);
  }

  if (/\{\{\s*(?:Get|get)\s*\(/i.test(safeReplacement)) {
    warn("替换结果含 Get(...) 登录变量，已去掉该片段；镜像/分流参数请在香色中手工配置");
    const cleaned = safeReplacement.replace(/\{\{\s*(?:Get|get)\(\s*['"][^'"]+['"]\s*\)\s*\}\}/gi, "");
    try {
      new RegExp(pattern);
    } catch {
      warn("清理正则无法解析，已原样写入转换结果");
    }
    return chainJsPostprocess(converted, `return String(result).replace(new RegExp(${JSON.stringify(pattern)}, "g"), ${JSON.stringify(cleaned)});`);
  }

  try {
    // Validate only. The expression itself is executed by 香色闺阁.
    new RegExp(pattern);
  } catch {
    warn("清理正则无法解析，已原样写入转换结果");
  }
  return chainJsPostprocess(converted, `return String(result).replace(new RegExp(${JSON.stringify(pattern)}, "g"), ${JSON.stringify(safeReplacement)});`);
}

/**
 * 展开阅读 Mustache：
 * - {{@sel}} / {{@@sel}} → 选择器本身
 * - 多行 Mustache → || 备选
 * - 末尾 @js / <js> 仍接到后续 convertRule 处理
 */
/**
 * 把 `字面量{{表达式}}字面量` 形式的字段模板（desc/title 等）编译为一条
 * `@js:` 拼接脚本。没有该处理时，这类混合规则会落入 JSONPath/XPath 分支，
 * 整串做点号→斜杠转换产生不可执行的规则。
 */
function composeTemplateRule(rule, warn) {
  const matches = [...String(rule).matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)];
  if (!matches.length) return "";
  const parts = [];
  let lastIndex = 0;
  let sawRuntimeExpression = false;
  for (const match of matches) {
    if (match.index > lastIndex) parts.push(JSON.stringify(rule.slice(lastIndex, match.index)));
    const inner = match[1].trim();
    const expression = compileTemplateInner(inner, warn);
    if (!expression) return "";
    if (expression.iife) sawRuntimeExpression = true;
    parts.push(expression.code);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < rule.length) parts.push(JSON.stringify(rule.slice(lastIndex)));
  const composed = `@js:\nreturn (${parts.join(" + ") || '""'});`;
  return sawRuntimeExpression ? injectRuntimeHelpers(composed) : composed;
}

function compileTemplateInner(inner, warn) {
  // {{'字面量'}} / {{"字面量"}}
  const literalOnly = inner.match(/^(['"])([\s\S]*)\1$/);
  if (literalOnly) {
    const decoded = literalOnly[2]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\(['"\\])/g, "$1");
    return { code: JSON.stringify(decoded) };
  }
  const direct = legadoTemplateExpression(inner);
  if (direct) return { code: `String(${direct})` };
  // 支持 `表达式##正则##替换` 的清理后缀。
  let body = inner;
  let cleanup = "";
  const hashSplit = body.match(/^([\s\S]*?)##([\s\S]*)$/);
  if (hashSplit && legadoTemplateExpression(hashSplit[1].trim())) {
    const [pattern = "", replacement = ""] = hashSplit[2].split("##");
    body = hashSplit[1].trim();
    cleanup = { pattern, replacement };
  }
  const directBody = legadoTemplateExpression(body);
  if (directBody) {
    if (!cleanup) return { code: `String(${directBody})` };
    return {
      code: `String(String(${directBody}).replace(new RegExp(${JSON.stringify(cleanup.pattern)}, "g"), ${JSON.stringify(cleanup.replacement)}))`,
    };
  }
  // 复杂 JS 模板：作为内联 IIFE 编译；运行时助手统一在整条规则上注入一次。
  const script = rewriteLegadoJavaScriptRaw(`@js:\n${body}`);
  if (script.includes("{{") || hasUnsupportedLegadoRuntime(script)) return null;
  const body2 = script.replace(/^@js:\s*/i, "").trim();
  let code = `(function () {\n${body2}\n})()`;
  if (cleanup) {
    code = `String(${code}.replace(new RegExp(${JSON.stringify(cleanup.pattern)}, "g"), ${JSON.stringify(cleanup.replacement)}))`;
  }
  return { code, iife: true };
}

function expandMustacheRule(rule, warn) {  const trimmed = rule.trim();
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
    // The first `@` normally marks a selector expression and is not part of
    // the selector (`{{@class.item@text}}`). Explicit parser directives are
    // different: stripping it from `{{@css:...}}` turns `css` into an HTML
    // tag and produces an unusable `//css[...]` XPath.
    const explicitDirective = /^(?:css|json):/i.test(inner) ? `@${inner}` : inner;
    fragments.push(explicitDirective);
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
  if (looksLikeNativeXPath(trimmed)) return true;
  if (/^(?:html|body|main|article|section|div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|img|picture|source|audio|video|h[1-6])$/i.test(trimmed)) {
    return true;
  }
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
  if (/^@embedded-json-array:[A-Za-z_$][\w$]*$/.test(trimmed)
    || /^@json-media-pairs:[^:]+:[^:]+:[^:]+:[^:]+$/.test(trimmed)) return trimmed;

  if (/\{\{\s*\$\.\.[A-Za-z_$]/.test(trimmed)) {
    trimmed = trimmed.replace(/\{\{\s*\$\.\.([A-Za-z_$][\w$]*)\s*\}\}/g, (_match, field) => `{{$.${field}}}`);
    warn("列表项中的 JSONPath 递归字段已收敛为当前对象字段");
  }

  // Placeholder list/detail rules seen in public stubs (`NA`, `-`).
  if (/^(?:NA|N\/A|null|none|-)$/i.test(trimmed)) return "";

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
    // 整条脚本只是一次元素/规则求值（java.getElements / getString('css@attr') /
    // getString('$.json')）时，直接降级为声明式规则，避免为单次调用内嵌运行时助手。
    const scriptBody = normalized.replace(/^@js:\s*/i, "");
    const soleCall = scriptBody.match(
      /^\s*(?:return\s+)?java\.(?:getElements?|getString(?:List)?)\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)\s*;?\s*$/i,
    );
    if (soleCall) {
      const soleRule = soleCall[2].trim();
      if (soleRule && !soleRule.includes("{{") && !soleRule.includes("${")
        && !/^https?:\/\//i.test(soleRule)) {
        const converted = convertRule(soleRule, { responseType, warn });
        if (converted && !/^(?:@js:|<js>)/i.test(converted)) {
          warn("阅读 JS 单次规则求值已降级为等价声明式规则");
          return converted;
        }
      }
    }
    // 列表/字段脚本若只是用 java.getElements('选择器') 取元素列表，可把首个
    // 选择器降级为声明式规则，香色无需执行脚本即可得到同一批节点。
    const elementSelectors = [...normalized.matchAll(
      /\bjava\.getElements?\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/gi,
    )].map((match) => match[2].trim()).filter((selector) => (
      selector && !selector.includes("{{") && !selector.includes("${")
    ));
    if (elementSelectors.length) {
      for (const selector of elementSelectors) {
        const converted = convertRule(selector, { responseType, warn });
        if (converted && !/^(?:@js:|<js>)/i.test(converted)) {
          warn("阅读 JS 列表已降级为其调用的元素选择器（java.getElements 不可执行）");
          return converted;
        }
      }
    }
    const rewritten = rewriteLegadoJavaScript(normalized);
    warn(rewritten === normalized
      ? "阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查"
      : "已将阅读 JavaScript 中的分页、关键词或结果字段模板转换为香色运行时表达式");
    return rewritten;
  }

  // URL / field append before mustache rewrite so `{{baseUrl}}##$##?page=1`
  // becomes baseUrl + "?page=1" instead of a literal "##$##" suffix.
  const appendMatch = trimmed.match(/^([\s\S]*?)##\$##([\s\S]*)$/);
  if (appendMatch && appendMatch[1].trim()) {
    const head = convertRule(appendMatch[1].trim(), { responseType, warn });
    const suffix = stripLegadoRegexOptions(appendMatch[2], warn);
    if (!suffix) return head;
    if (/^@js:/i.test(head)) {
      const body = head.replace(/^@js:\s*/i, "").trim().replace(/;\s*$/, "");
      if (/^return\b/i.test(body)) {
        const expression = body.replace(/^return\s+/i, "").replace(/;\s*$/, "");
        return `@js:\nreturn String(${expression}) + ${JSON.stringify(suffix)};`;
      }
      return `@js:\n${body};\nreturn String(result || "") + ${JSON.stringify(suffix)};`;
    }
    if (head) return chainJsPostprocess(head, `return String(result || "") + ${JSON.stringify(suffix)};`);
    return `@js:\nreturn ${JSON.stringify(suffix)};`;
  }

  // Absolute or relative JSON URL / field templates:
  // `/pc/book/{$.id}` / `{$.free}{$.name}` / `https://x/{{$.id}}`.
  // Rewrite before HTML/JSONPath branching so `{$.field}` is not treated as a path.
  const hasJsonFieldTemplate = /\{\{\s*\$\./.test(trimmed) || /(?<!\{)\{(\$\.[^}]+)\}(?!\})/.test(trimmed);
  const hasSourceBaseTemplate = /\{\{\s*Url\s*\(\s*\)\s*\}\}/i.test(trimmed);
  if (hasJsonFieldTemplate
    && (hasSourceBaseTemplate || !looksLikeHtmlRule(trimmed.replace(/\{(?:\{\s*)?\$\.[^}]+\}(?:\})?/g, "x")))) {
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
    // A scalar selector followed by a postprocessor matches Xiangse's field
    // evaluation model and remains declarative for bridge verification. Pure
    // JS receives different result shapes across list runtimes and can turn a
    // nested object into `[object Object]` instead of reading its leaf value.
    if (!scriptBody && !cleanupPattern) {
      const placeholder = /\{\{\s*\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\s*\}\}|\{\s*\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\s*\}/g;
      const matches = [...template.matchAll(placeholder)];
      const paths = [...new Set(matches.map((match) => match[1] || match[2]))];
      if (matches.length && paths.length === 1) {
        const marker = "__READ2XSGG_FIELD__";
        const literal = template.replace(placeholder, marker);
        if (!/\{\{|\{\s*\$\./.test(literal)) {
          const selector = paths[0].replace(/\[(\d+)\]/g, "/$1").replace(/\./g, "/");
          const parts = literal.split(marker).map((part) => JSON.stringify(part));
          const expression = parts
            .flatMap((part, index) => index < parts.length - 1
              ? [part, 'String(result || "")']
              : [part])
            .join(" + ");
          warn("已将阅读 JSON 字段 URL 模板转换为香色声明式字段后处理");
          return chainJsPostprocess(selector, `return ${expression};`);
        }
      }
    }
    let expression = rewriteLegadoJavaScript(`@js:\nreturn ${JSON.stringify(template)};`)
      .replace(/^@js:\s*return\s+/i, "")
      .replace(/;\s*$/, "");
    if (scriptBody) {
      // scriptBody 可能是多语句脚本（var/if/else），包进 IIFE 后用
      // ensureJavaScriptReturn 语义补 return，而不是非法的 `return (多语句)`。
      const chained = rewriteLegadoJavaScriptRaw(`@js:\n${scriptBody}`)
        .replace(/^@js:\s*/i, "")
        .trim();
      expression = `(function(result){ ${chained} })(${expression})`;
    }
    if (cleanupPattern) {
      expression = `String(${expression}).replace(new RegExp(${JSON.stringify(cleanupPattern)}, "g"), ${JSON.stringify(cleanupReplacement)})`;
    }
    const composed = `@js:\nreturn ${expression};`;
    if (!composed.includes("{{") && !/\{(\$\.)/.test(composed)) {
      if (!hasUnsupportedLegadoRuntime(composed)) warn("已将阅读 JSON 字段模板转换为香色运行时表达式");
      return injectRuntimeHelpers(composed);
    }
  }

  if (trimmed.includes("{{") && !/\{\{\s*@/.test(trimmed)) {
    const composed = composeTemplateRule(trimmed, warn);
    if (composed) return composed;
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
    if (hasUnsupportedLegadoRuntime(script)) {
      warn("选择器后的阅读专用 JavaScript 在香色不可执行，已保留基础选择器并忽略该后处理");
      return head;
    }
    warn("阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查");
    // 2.56.1 的公开可用源与独立模拟器统一使用 `selector||@js:`。
    // 单管道虽然出现在部分旧文档中，但真实客户端上会出现只执行选择器、
    // 不把结果交给 JS 的兼容差异，因此发布产物固定使用双管道。
    return chainJsPostprocess(head, script);
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

  // Legado `%%` interleaves list results by index. It is commonly used when
  // one API response has more than one possible item shape, so preserving it
  // as a first-class bridge selector also makes an empty branch harmless.
  if (trimmed.includes("%%")) {
    const parts = splitTopLevel(trimmed, "%%");
    if (parts.length > 1) {
      const convertedParts = parts.map((part) => convertRule(part, { responseType, warn }));
      if (responseType === "json" && convertedParts.every(Boolean)) {
        warn("阅读的 JSON %%（按索引交错匹配）已转换为数组交错选择器");
        return `@json-interleave:${convertedParts.map((part) => encodeURIComponent(part)).join(",")}`;
      }
      return convertedParts.filter(Boolean).join("||");
    }
  }

  // Legado `&&` joins all matched texts with newline; approximate with XPath union.
  if (trimmed.includes("&&")) {
    const parts = trimmed.split("&&").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      const convertedParts = parts.map((part) => convertRule(part, { responseType, warn }));
      if (responseType === "json" && convertedParts.every(Boolean)) {
        warn("阅读的 JSON &&（合并全部匹配）已转换为数组合并选择器");
        return `@json-union:${convertedParts.map((part) => encodeURIComponent(part)).join(",")}`;
      }
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
  // imageStyle/imageDecode 等是阅读的样式/解码指令，不是解析规则；
  // 裸词值（如 imageStyle: "FULL"）会被误判成 JSON 字段导致整源误标 json。
  const DIRECTIVE_FIELDS = new Set(["imageStyle", "imageDecode", "enabledCookieJar"]);
  const values = Object.entries(rules)
    .filter(([field, value]) => typeof value === "string" && value.trim() && !DIRECTIVE_FIELDS.has(field))
    .map(([, value]) => value);
  if (!values.length) return "html";
  if (values.some((value) => /\bJSON\.parse\s*\(\s*(?:src|result)\s*\)/.test(value))) return "json";

  // The collection selector describes the response root. Bare item fields such
  // as `title`, `url` or `src` are valid JSON properties but also resemble HTML
  // attributes, so they must not overrule an explicit JSONPath collection.
  const collectionRule = [rules.bookList, rules.chapterList].find((value) => (
    typeof value === "string" && value.trim()
  ));
  if (collectionRule && /^\s*(?:@?json:|@json-media-pairs:|\$[.[]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*\[\*\])/i.test(collectionRule)) return "json";

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
