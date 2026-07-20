function propertyExpression(root, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part))) return "";
  return [root, ...parts].join(".");
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
  const resultPath = expression.match(/^\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/)?.[1];
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

/**
 * Translate the portable subset of Legado JavaScript templates to the 香色
 * runtime. This never evaluates source code; it only rewrites recognised
 * placeholders inside JavaScript string literals and standalone templates.
 */
export function rewriteLegadoJavaScript(value) {
  let source = String(value || "");
  source = source.replace(/(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g, (literal, quote, body) => {
    if (!body.includes("{{")) return literal;
    const decoded = decodedStringLiteral(quote, body);
    if (decoded === null) return literal;
    return compileTemplateString(decoded) || literal;
  });
  source = source.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (template, expression) => (
    legadoTemplateExpression(expression) || template
  ));
  return source.replace(/\bjava\.encodeURI\s*\(/g, "encodeURIComponent(");
}

export function hasUnsupportedLegadoRuntime(value) {
  const source = String(value || "");
  if (/\b(?:java\.|Packages\b|android\.|org\.jsoup|source\.(?:get|set|key|variable)|book\.(?:name|author|kind|url)|cookie\.|javaScript\.)|<js>|\{\{/i.test(source)) {
    return true;
  }
  const marker = source.search(/@js:/i);
  if (marker < 0) return false;
  const script = source.slice(marker + 4);
  // `src`（原始响应）和 `baseUrl`（阅读当前页）是 Legado 字段脚本的
  // 隐式全局量，不在香色公开的 config/params/result 合约中。局部声明
  // 同名变量时保留脚本，否则在线源必须桥接或删除该可选字段。
  const usesUndeclared = (name) => {
    // 属性名（item.src / params.baseUrl）不是隐式全局量。
    if (!new RegExp(`(^|[^\\w$.])${name}\\b`).test(script)) return false;
    return !new RegExp(`\\b(?:var|let|const)\\s+${name}\\b`).test(script);
  };
  return usesUndeclared("src") || usesUndeclared("baseUrl");
}
