function propertyExpression(root, path) {
  const value = String(path || "").trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(value)) return "";
  return `${root}.${value}`;
}

export function legadoTemplateExpression(value) {
  const expression = String(value || "").trim();
  if (/^key$/i.test(expression)) return "params.keyWord";
  if (/^page$/i.test(expression)) return "params.pageIndex";
  if (/^(?:java\.)?encodeURI(?:Component)?\(\s*key\s*\)$/i.test(expression)) return "encodeURIComponent(params.keyWord)";
  if (/^source\.bookSourceUrl$/i.test(expression)) return "config.host";
  if (/^[\d\s()+*/%.-]*\bpage\b[\d\s()+*/%.-]*$/i.test(expression)) {
    return expression.replace(/\bpage\b/gi, "params.pageIndex");
  }
  const withoutStrings = expression.replace(/(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');
  const pageRemainder = withoutStrings.replace(/\bpage\b/gi, "");
  if (/\bpage\b/i.test(withoutStrings) && /^[\d\s?:()+*/%<>=!&|.'"_-]*$/.test(pageRemainder)) {
    return `(${expression.replace(/\bpage\b/gi, "params.pageIndex")})`;
  }
  const resultFallback = expression.split(/\s*\|\|\s*/).map((part) => (
    part.match(/^\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/)?.[1] || ""
  ));
  if (resultFallback.length > 1 && resultFallback.every(Boolean)) {
    return `(${resultFallback.map((path) => propertyExpression("result", path)).join(" || ")})`;
  }
  const resultPath = expression.match(/^\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/)?.[1];
  if (resultPath) return propertyExpression("result", resultPath);
  const bookPath = expression.match(/^book\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/i)?.[1];
  if (bookPath) {
    if (/^name$/i.test(bookPath)) return '(params.queryInfo.bookName || params.queryInfo.name || "正文")';
    if (/^author$/i.test(bookPath)) return '(params.queryInfo.author || "")';
    return propertyExpression("params.queryInfo", bookPath);
  }
  if (/^baseUrl$/i.test(expression)) return '(params.responseUrl || config.host || "")';
  return "";
}

function decodedStringLiteral(quote, body) {
  try {
    if (quote === '"') return JSON.parse(`"${body}"`);
    return body
      .replace(/\\'/g, "'")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  } catch {
    return null;
  }
}

function compileTemplateString(value) {
  const pattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;
  const parts = [];
  let lastIndex = 0;
  let found = false;
  for (const match of value.matchAll(pattern)) {
    const expression = legadoTemplateExpression(match[1]);
    if (!expression) return "";
    if (match.index > lastIndex) parts.push(JSON.stringify(value.slice(lastIndex, match.index)));
    parts.push(`String(${expression})`);
    lastIndex = match.index + match[0].length;
    found = true;
  }
  if (!found) return "";
  if (lastIndex < value.length) parts.push(JSON.stringify(value.slice(lastIndex)));
  return `(${parts.join(" + ") || '""'})`;
}

function maskedJavaScript(value) {
  return String(value || "")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (match) => " ".repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/\/\/[^\r\n]*/g, (match) => " ".repeat(match.length));
}

function rewriteBareRuntimeIdentifiers(value) {
  let source = String(value || "");
  for (const [name, replacement] of [["page", "params.pageIndex"], ["key", "params.keyWord"]]) {
    let masked = maskedJavaScript(source);
    if (new RegExp(`\\b(?:var|let|const)\\s+${name}\\b|function\\s*\\([^)]*\\b${name}\\b`).test(masked)) continue;
    const edits = [];
    for (const match of masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      const index = match.index;
      const before = masked.slice(0, index);
      const after = masked.slice(index + name.length);
      const previous = before.match(/\S\s*$/)?.[0]?.trim() || "";
      const next = after.match(/^\s*\S/)?.[0]?.trim() || "";
      if (previous === "." || next === ":") continue;
      const shorthand = /(?:^|[{,])\s*$/.test(before) && /^\s*[,}]/.test(after);
      edits.push({ index, text: shorthand ? `${name}: ${replacement}` : replacement });
    }
    for (const edit of edits.reverse()) {
      source = `${source.slice(0, edit.index)}${edit.text}${source.slice(edit.index + name.length)}`;
    }
  }
  return source;
}

function ensureJavaScriptReturn(value) {
  const source = String(value || "");
  const marker = source.search(/@js:/i);
  if (marker < 0) return source;
  const prefix = source.slice(0, marker + 4);
  let body = source.slice(marker + 4).trim();
  if (!body || /\breturn\b/.test(maskedJavaScript(body))) return source;

  const finalValue = body.match(/(^|[;\n])(\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*;?\s*$/);
  if (finalValue && finalValue.index !== undefined) {
    const start = finalValue.index + finalValue[1].length + finalValue[2].length;
    body = `${body.slice(0, start)}return ${finalValue[3]};`;
    return `${prefix}\n${body}`;
  }

  if (!/[;{}]|\b(?:if|for|while|try|catch|var|let|const|function)\b/.test(maskedJavaScript(body))) {
    try {
      // Compile only: source code is never evaluated here.
      new Function("config", "params", "result", `return (${body});`);
      return `${prefix}\nreturn (${body});`;
    } catch {
      return source;
    }
  }
  return source;
}

/**
 * Translate the portable subset of Legado JavaScript templates to the 香色
 * runtime. This never evaluates source code; it only rewrites recognised
 * placeholders inside JavaScript string literals and standalone templates.
 */
export function rewriteLegadoJavaScript(value) {
  let source = String(value || "")
    // Older Legado collections also use `{$.id}` (one brace) in JSON URL
    // templates. Normalise only this narrow field form; ordinary JS objects
    // are deliberately untouched.
    .replace(/(?<!\{)\{(\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\s*\|\|\s*\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)*)\}(?!\})/g, "{{$1}}");
  source = source.replace(/(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g, (literal, quote, body) => {
    if (!body.includes("{{")) return literal;
    const decoded = decodedStringLiteral(quote, body);
    if (decoded === null) return literal;
    return compileTemplateString(decoded) || literal;
  });
  source = source.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (template, expression) => (
    legadoTemplateExpression(expression) || template
  ));
  source = source.replace(/\bjava\.encodeURI\s*\(/g, "encodeURIComponent(");
  source = rewriteBareRuntimeIdentifiers(source);
  return ensureJavaScriptReturn(source);
}

export function hasUnsupportedLegadoRuntime(value) {
  const source = String(value || "");
  if (/\b(?:java\.|Packages\b|android\.|org\.jsoup|source\.(?:get|set|key|variable)|book\.(?:name|author|kind|url)|cookie\.|javaScript\.)|<js>|\{\{|@(?:put|get):|\{\$\./i.test(source)) {
    return true;
  }
  const marker = source.search(/@js:/i);
  if (marker < 0) return false;
  if ((source.match(/@js:/gi) || []).length > 1) return true;
  const script = source.slice(marker + 4);
  const masked = maskedJavaScript(script);
  // `src`（原始响应）和 `baseUrl`（阅读当前页）是 Legado 字段脚本的
  // 隐式全局量，不在香色公开的 config/params/result 合约中。局部声明
  // 同名变量时保留脚本，否则在线源必须桥接或删除该可选字段。
  const usesUndeclared = (name) => {
    // 属性名（item.src / params.baseUrl）不是隐式全局量。
    if (new RegExp(`\\b(?:var|let|const)\\s+${name}\\b|function\\s*\\([^)]*\\b${name}\\b`).test(masked)) return false;
    for (const match of masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      const before = masked.slice(0, match.index);
      const after = masked.slice(match.index + name.length);
      const previous = before.match(/\S\s*$/)?.[0]?.trim() || "";
      const next = after.match(/^\s*\S/)?.[0]?.trim() || "";
      if (previous !== "." && next !== ":") return true;
    }
    return false;
  };
  if (!/\breturn\b/.test(masked)
    || usesUndeclared("src")
    || usesUndeclared("baseUrl")
    || usesUndeclared("page")
    || usesUndeclared("key")) return true;
  try {
    // Syntax validation only; source code is never evaluated.
    new Function("config", "params", "result", script);
    return false;
  } catch {
    return true;
  }
}
