function quoteXPath(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
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
      predicates.push(`contains(concat(' ', normalize-space(@${attribute}), ' '), ${quoteXPath(` ${value.trim()} `)})`);
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

function legacySegmentToXPath(segment, first) {
  let value = segment.trim();
  const propertyNames = new Set(["text", "textNodes", "ownText", "html"]);
  if (propertyNames.has(value)) return value === "html" ? "" : "/text()";
  if (/^(href|src|data-[\w-]+|content|value|title)$/.test(value)) return `/@${value}`;

  let indexPredicate = "";
  const indexMatch = value.match(/\.(-?\d+)$/);
  if (indexMatch) {
    const index = Number(indexMatch[1]);
    indexPredicate = index >= 0 ? `[${index + 1}]` : `[last() - ${Math.abs(index) - 1}]`;
    value = value.slice(0, -indexMatch[0].length);
  }
  if (value.startsWith("id.")) {
    return `${first ? "//" : "//"}*[@id=${quoteXPath(value.slice(3))}]${indexPredicate}`;
  }
  if (value.startsWith("class.")) {
    const classes = value.slice(6).trim().split(/\s+/).filter(Boolean);
    const predicates = classes.map((name) => `contains(concat(' ', normalize-space(@class), ' '), ${quoteXPath(` ${name} `)})`);
    return `//*[${predicates.join(" and ")}]${indexPredicate}`;
  }
  if (value.startsWith("text.")) {
    return `//*[contains(normalize-space(.), ${quoteXPath(value.slice(5))})]${indexPredicate}`;
  }
  if (value.startsWith("tag.")) value = value.slice(4);
  if (/^[a-zA-Z][\w-]*$/.test(value)) return `//${value}${indexPredicate}`;
  return `${cssToXPath(value)}${indexPredicate}`;
}

function legadoHtmlToXPath(selector) {
  let source = selector.trim();
  if (/^@?(?:XPath|xpath):/.test(source)) return source.replace(/^@?(?:XPath|xpath):/, "");
  if (source.startsWith("//") || source.startsWith("/html")) return source;
  if (/^@css:/i.test(source)) return cssToXPath(source.replace(/^@css:/i, ""));

  if (source.includes("@")) {
    const segments = source.split("@").filter(Boolean);
    return segments.map((segment, index) => legacySegmentToXPath(segment, index === 0)).join("");
  }
  if (source.startsWith("id.")) return legacySegmentToXPath(source, true);
  if (source.startsWith("class.")) return legacySegmentToXPath(source, true);
  if (source.startsWith("tag.")) return legacySegmentToXPath(source, true);
  return cssToXPath(source);
}

function jsonPathToXsgg(path, warn) {
  let source = path.trim().replace(/^@json:/i, "");
  if (source.includes("..")) {
    warn("JSONPath 的递归下降操作符 '..' 在香色中没有完全等价语法，已按普通路径转换");
    source = source.replace(/\.\./g, ".");
  }
  return source
    .replace(/^\$\.?/, "")
    .replace(/\[['"]([^'"]+)['"]\]/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\[\*\]/g, "")
    .replace(/\.\*/g, "")
    .replace(/\./g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function appendRegexReplacement(converted, suffix, warn) {
  const [pattern = "", replacement = ""] = suffix.split("##");
  if (!pattern) return converted;
  try {
    // Validate only. The expression itself is executed by 香色闺阁.
    new RegExp(pattern);
  } catch {
    warn("清理正则无法解析，已原样写入转换结果");
  }
  return `${converted}||@js:\nreturn String(result).replace(new RegExp(${JSON.stringify(pattern)}, "g"), ${JSON.stringify(replacement)});`;
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

  const alternatives = trimmed.split("||");
  if (alternatives.length > 1) {
    return alternatives.map((part) => convertRule(part, { responseType, warn })).join("||");
  }

  const replacementIndex = trimmed.indexOf("##");
  const selector = replacementIndex >= 0 ? trimmed.slice(0, replacementIndex) : trimmed;
  const suffix = replacementIndex >= 0 ? trimmed.slice(replacementIndex + 2) : "";
  const isJson = responseType === "json" || /^@?json:/i.test(selector) || selector.startsWith("$");
  const converted = isJson ? jsonPathToXsgg(selector, warn) : legadoHtmlToXPath(selector);
  return replacementIndex >= 0 ? appendRegexReplacement(converted, suffix, warn) : converted;
}

export function inferResponseType(rules = {}) {
  const values = Object.values(rules).filter((value) => typeof value === "string");
  const explicitJsonCount = values.filter((value) => /^\s*(?:@?json:|\$[.[])/i.test(value)).length;
  const htmlCount = values.filter((value) => /(?:\/\/|@(?:text|href|src|html)|^\s*(?:class|id|tag)\.|[#>])/i.test(value)).length;
  const implicitJsonCount = values.filter((value) => {
    const trimmed = value.trim();
    if (/^(?:class|id|tag)\./i.test(trimmed) || /^[.#]/.test(trimmed)) return false;
    return /^[\w$-]+(?:\[[\d*]+\]|\.[\w$*\[\]-]+)*$/.test(trimmed);
  }).length;
  if (explicitJsonCount > 0 && htmlCount === 0) return "json";
  if (explicitJsonCount > htmlCount) return "json";
  if (htmlCount > 0) return "html";
  return implicitJsonCount > 0 ? "json" : "html";
}
