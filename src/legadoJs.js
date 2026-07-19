function propertyExpression(root, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part))) return "";
  return [root, ...parts].join(".");
}

export function legadoTemplateExpression(value) {
  const expression = String(value || "").trim();
  if (/^key$/i.test(expression)) return "params.keyWord";
  if (/^page$/i.test(expression)) return "params.pageIndex";
  if (/^java\.encodeURI\(\s*key\s*\)$/i.test(expression)) return "encodeURIComponent(params.keyWord)";
  if (/^encodeURI\(\s*key\s*\)$/i.test(expression)) return "encodeURIComponent(params.keyWord)";
  if (/^[\d\s()+*/%.-]*\bpage\b[\d\s()+*/%.-]*$/i.test(expression)) {
    return expression.replace(/\bpage\b/gi, "params.pageIndex");
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
  return /\b(?:java\.|Packages\b|android\.|org\.jsoup|source\.(?:get|set|key|variable)|book\.(?:name|author|kind|url)|cookie\.|javaScript\.)|<js>|\{\{/i
    .test(String(value || ""));
}
