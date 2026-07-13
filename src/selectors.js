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
  if (/!0$/.test(source)) {
    source = source.slice(0, -2);
    excludedFirst = true;
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
  return `${tag}${predicates.map((predicate) => `[${predicate}]`).join("")}`;
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
  return `/(${relative})${indexPredicate}`;
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
  if (/^@css:/i.test(source)) return cssToXPath(source.replace(/^@css:/i, ""));

  // Bare relative properties used inside list/detail items (very common in ruleToc).
  if (RELATIVE_PROPERTIES.has(source) || (source.startsWith("@") && RELATIVE_PROPERTIES.has(source.slice(1)))) {
    return propertyToXPath(source.startsWith("@") ? source.slice(1) : source, { bare: true }) || ".";
  }

  if (source.includes("@")) {
    const segments = source.split("@").filter(Boolean);
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
  const converted = source
    .replace(/^\$\.?/, "")
    .replace(/\[['"]([^'"]+)['"]\]/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\[\*\]/g, "")
    .replace(/\.\*/g, "")
    .replace(/\./g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!jsSuffix) return converted;
  return converted ? `${converted}||${jsSuffix}` : jsSuffix;
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

  try {
    // Validate only. The expression itself is executed by 香色闺阁.
    new RegExp(pattern);
  } catch {
    warn("清理正则无法解析，已原样写入转换结果");
  }
  return `${converted}||@js:\nreturn String(result).replace(new RegExp(${JSON.stringify(pattern)}, "g"), ${JSON.stringify(replacement)});`;
}

function looksLikeJsonPath(value) {
  const trimmed = value.trim();
  if (/^\s*(?:@?json:|\$[.[])/i.test(trimmed)) return true;
  if (RELATIVE_PROPERTIES.has(trimmed) || RELATIVE_PROPERTIES.has(trimmed.replace(/^@/, ""))) return false;
  if (/^(?:class|id|tag|text)\./i.test(trimmed)) return false;
  if (/[#>@\s]|\[.|^=/.test(trimmed) || /^\./.test(trimmed)) return false;
  // data.books / data.books[0].title 之类
  return /^[\w$-]+(?:\[[\d*]+\]|\.[\w$*\[\]-]+)+$/.test(trimmed);
}

function looksLikeHtmlRule(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:@js:|<js>)/i.test(trimmed)) return false;
  if (/^\s*(?:@?json:|\$[.[])/i.test(trimmed)) return false;
  if (RELATIVE_PROPERTIES.has(trimmed) || RELATIVE_PROPERTIES.has(trimmed.replace(/^@/, ""))) return true;
  if (/\/\/|^\/html|@(?:text|href|src|html|css:)|^\s*(?:class|id|tag|text)\./i.test(trimmed)) return true;
  if (/[#>\[\]]/.test(trimmed) || /(?:^|[\s>+~,])[a-z][\w-]*\./i.test(trimmed)) return true;
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
  const trimmed = rule.trim();
  if (!trimmed) return "";

  if (/^(?:@js:|<js>)/i.test(trimmed)) {
    warn("阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查");
    return trimmed.replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
  }

  // Absolute URL literal fallback: img@src||https://cdn/.../fallback.png
  if (/^https?:\/\//i.test(trimmed)) {
    return `@js:\nreturn ${JSON.stringify(trimmed)};`;
  }

  // Trailing <js>/@js after a selector (Legado often writes `href\n<js>...</js>`).
  const trailingJs = trimmed.match(/^([\s\S]*?)(\n\s*(?:@js:|<js>)[\s\S]*)$/i);
  if (trailingJs && trailingJs[1].trim() && /[@$.#\[a-z]/i.test(trailingJs[1])) {
    const head = convertRule(trailingJs[1].trim(), { responseType, warn });
    warn("阅读与香色的 JavaScript 运行环境不同，JS 规则已保留但需要人工检查");
    const script = trailingJs[2].trim().replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
    return `${head}||${script}`;
  }

  // Apply ## cleanup to the whole rule (including && combinations) before splitting.
  const replacementIndex = trimmed.indexOf("##");
  if (replacementIndex >= 0 && !trimmed.includes("||") && !trimmed.includes("|")) {
    const selector = trimmed.slice(0, replacementIndex);
    const suffix = trimmed.slice(replacementIndex + 2);
    const converted = convertRule(selector, { responseType, warn });
    const wrapped = converted.includes(" | ") ? `(${converted})` : converted;
    return appendRegexReplacement(wrapped, suffix, warn);
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
  const forceHtml = looksLikeHtmlRule(trimmed);
  const isJson = forceJson || (responseType === "json" && !forceHtml);
  if (isJson) return jsonPathToXsgg(trimmed, warn);

  const withHas = /:has\(/i.test(trimmed) ? rewriteCssHas(trimmed, warn) : trimmed;
  return legadoHtmlToXPath(withHas);
}

export function inferResponseType(rules = {}) {
  const values = Object.values(rules).filter((value) => typeof value === "string" && value.trim());
  if (!values.length) return "html";

  const explicitJsonCount = values.filter((value) => /^\s*(?:@?json:|\$[.[])/i.test(value)).length;
  const htmlCount = values.filter((value) => looksLikeHtmlRule(value)).length;
  const implicitJsonCount = values.filter((value) => looksLikeJsonPath(value)).length;

  if (explicitJsonCount > 0 && htmlCount === 0) return "json";
  if (explicitJsonCount > htmlCount) return "json";
  if (htmlCount > 0) return "html";
  return implicitJsonCount > 0 ? "json" : "html";
}
