function propertyExpression(root, path) {
  const value = String(path || "").trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(value)) return "";
  return `${root}.${value}`;
}

const PORTABLE_STRING_METHODS = "length|substring|substr|slice|indexOf|charAt|charCodeAt|trim|toLowerCase|toUpperCase|startsWith|endsWith|includes|replace|concat|padStart|padEnd";

function rewriteKeyPageIdentifiers(expression) {
  return String(expression || "")
    .replace(/\bkey\b/gi, "params.keyWord")
    .replace(/\bpage\b/gi, "params.pageIndex");
}

/**
 * Comic/search sources often truncate keywords in URL templates, e.g.
 * `{{key.length>3?key.substring(0,3):key}}`. Rewrite only expressions that stay
 * within key/page plus a whitelist of String methods and operators.
 */
function portableKeyPageExpression(expression) {
  const source = String(expression || "").trim();
  if (!/\b(?:key|page)\b/i.test(source)) return "";
  if (/\b(?:java|Packages|android|cookie|source|book|result|baseUrl|src)\b/i.test(source)) return "";
  const withoutStrings = source.replace(/(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');
  const remainder = withoutStrings
    .replace(/\b(?:key|page)\b/gi, "")
    .replace(new RegExp(`\\b(?:${PORTABLE_STRING_METHODS}|encodeURIComponent|encodeURI)\\b`, "g"), "")
    .replace(/[\d\s()?:<>!=+*/%.,'[\]_&|+-]/g, "");
  if (remainder) return "";
  return `(${rewriteKeyPageIdentifiers(source)})`;
}

export function legadoTemplateExpression(value) {
  const expression = String(value || "").trim();
  if (/^key$/i.test(expression)) return "params.keyWord";
  if (/^page$/i.test(expression)) return "params.pageIndex";
  // java.put(name, value) returns value; public URL templates commonly wrap
  // page/key this way for side storage that 香色 cannot keep. Keep the URL value.
  if (/^java\.put\(\s*['"]page['"]\s*,\s*page\s*\)(?:\s*;\s*page)?$/i.test(expression)) {
    return "params.pageIndex";
  }
  if (/^java\.put\(\s*['"]key['"]\s*,\s*key\s*\)(?:\s*;\s*key)?$/i.test(expression)) {
    return "params.keyWord";
  }
  if (/^java\.(?:t2s|s2t)\(\s*key\s*\)$/i.test(expression)) return "params.keyWord";
  if (/^(?:java\.)?encodeURI(?:Component)?\(\s*key\s*(?:,\s*['"](?:gbk|gb2312|gb18030|utf-?8)['"]\s*)?\)$/i.test(expression)) {
    return "encodeURIComponent(params.keyWord)";
  }
  if (/^source\.(?:bookSourceUrl|key|getKey\s*\(\s*\))$/i.test(expression)) return "config.host";
  if (/^source\.getVariable\(\s*\)\s*\?\s*source\.getVariable\(\s*\)\s*:\s*source\.getKey\(\s*\)$/i.test(expression)) {
    return "config.host";
  }
  if (/^String\(\s*source\.getVariable\(\s*\)\s*!==?\s*['"]['"]\s*\?\s*source\.getVariable\(\s*\)\s*:\s*source\.getKey\(\s*\)\s*\)\.replace\(\s*\/\\\/\$\/\s*,\s*['"]['"]\s*\)$/i.test(expression)) {
    return 'String(config.host || "").replace(/\\\/$/, "")';
  }
  if (/^(?:host|(?:getCurrentUrl|Url)\s*\(\s*\))$/i.test(expression)) return "config.host";
  if (/^java\.connect\(\s*source\.getKey\(\s*\)\s*\)\.raw\(\s*\)\.request\(\s*\)\.url\(\s*\)$/i.test(expression)) {
    return "config.host";
  }
  if (/^[\d\s()+*/%.-]*\bpage\b[\d\s()+*/%.-]*$/i.test(expression)) {
    return expression.replace(/\bpage\b/gi, "params.pageIndex");
  }
  const withoutStrings = expression.replace(/(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');
  const pageRemainder = withoutStrings.replace(/\bpage\b/gi, "");
  if (/\bpage\b/i.test(withoutStrings) && /^[\d\s?:()+*/%<>=!&|.'"_-]*$/.test(pageRemainder)) {
    return `(${expression.replace(/\bpage\b/gi, "params.pageIndex")})`;
  }
  const keyPage = portableKeyPageExpression(expression);
  if (keyPage) return keyPage;
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
    if (/^durChapterTitle$/i.test(bookPath)) {
      return '(params.queryInfo.chapterTitle || params.queryInfo.chapterName || params.queryInfo.title || "")';
    }
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
    .replace(/\/\/[^\r\n]*/g, (match) => " ".repeat(match.length))
    // Runtime names inside `/.../` are regex text, not JavaScript globals.
    // Require an expression-leading token so arithmetic division is retained.
    .replace(/(^|[=(:,!&|?;{}\[\]\n]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[dgimsuvy]*/gm,
      (match, prefix) => `${prefix}${" ".repeat(match.length - prefix.length)}`);
}

function insideObjectLiteral(masked, index) {
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (let cursor = 0; cursor < index; cursor += 1) {
    const token = masked[cursor];
    if (token === "(" || token === "[" || token === "{") {
      stack.push(token);
    } else if (pairs[token] && stack.at(-1) === pairs[token]) {
      stack.pop();
    }
  }
  return stack.at(-1) === "{";
}

function rewrittenIdentifier(masked, index, name, replacement) {
  const before = masked.slice(0, index);
  const after = masked.slice(index + name.length);
  const previous = before.match(/\S\s*$/)?.[0]?.trim() || "";
  const next = after.match(/^\s*\S/)?.[0]?.trim() || "";
  if (previous === "." || next === ":") return "";
  const shorthand = (previous === "{" || previous === ",")
    && insideObjectLiteral(masked, index)
    && /^\s*[,}]/.test(after);
  return shorthand ? `${name}: ${replacement}` : replacement;
}

function rewriteBareRuntimeIdentifiers(value) {
  let source = String(value || "");
  for (const [name, replacement] of [["page", "params.pageIndex"], ["key", "params.keyWord"]]) {
    let masked = maskedJavaScript(source);
    if (new RegExp(`\\b(?:var|let|const)\\s+${name}\\b|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\([^)]*\\b${name}\\b`).test(masked)) continue;
    const edits = [];
    for (const match of masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      const index = match.index;
      const text = rewrittenIdentifier(masked, index, name, replacement);
      if (text) edits.push({ index, text });
    }
    for (const edit of edits.reverse()) {
      source = `${source.slice(0, edit.index)}${edit.text}${source.slice(edit.index + name.length)}`;
    }
  }
  return source;
}

function rewriteImplicitRuntimeAliases(value) {
  let source = String(value || "");
  const bookGuard = "\\b(?:var|let|const)\\s+book\\b|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\([^)]*\\bbook\\b";
  const aliases = [
    {
      name: "book.name",
      replacement: '(params.queryInfo && params.queryInfo.bookName || "")',
      guard: bookGuard,
    },
    {
      name: "book.url",
      replacement: '(params.queryInfo && (params.queryInfo.detailUrl || params.queryInfo.url) || "")',
      guard: bookGuard,
    },
    { name: "src", replacement: "result", guard: null },
    { name: "host", replacement: "config.host", guard: null },
    {
      name: "baseUrl",
      replacement: '(params.responseUrl || (params.queryInfo && (params.queryInfo.chapterUrl || params.queryInfo.url || params.queryInfo.detailUrl)) || config.host || "")',
      guard: null,
    },
  ];
  for (const alias of aliases) {
    const { name, replacement } = alias;
    const guard = alias.guard ?? `\\b(?:var|let|const)\\s+${name}\\b|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\([^)]*\\b${name}\\b`;
    const pattern = name.replace(/\./g, "\\.");
    let masked = maskedJavaScript(source);
    if (new RegExp(guard).test(masked)) continue;
    const edits = [];
    for (const match of masked.matchAll(new RegExp(`\\b${pattern}\\b`, "g"))) {
      const index = match.index;
      const text = rewrittenIdentifier(masked, index, name, replacement);
      if (text) edits.push({ index, text });
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
  if (!body) return source;
  // A trailing comment after the value is common in shared sources (usually a
  // mirror note). It is not part of the expression and would comment out the
  // closing parenthesis inserted by the return wrapper.
  body = body
    // Requiring a line boundary or actual whitespace avoids treating the `//`
    // in an URL string as a JavaScript comment.
    .replace(/(?:^|[ \t\r\n])\/\/[^\r\n]*(?:\r?\n\s*)*$/g, "")
    .replace(/(?:^|[;\r\n][ \t]*)\/\*[\s\S]*?\*\/\s*$/g, "")
    .trim();
  const maskedBody = maskedJavaScript(body);
  const stackForReturn = [];
  const returnPairs = { ")": "(", "]": "[", "}": "{" };
  let hasTopLevelReturn = false;
  for (let index = 0; index < maskedBody.length; index += 1) {
    const token = maskedBody[index];
    if (token === "(" || token === "[" || token === "{") stackForReturn.push(token);
    else if (returnPairs[token] && stackForReturn.at(-1) === returnPairs[token]) stackForReturn.pop();
    else if (!stackForReturn.length
      && maskedBody.startsWith("return", index)
      && !/[\w$]/.test(maskedBody[index - 1] || "")
      && !/[\w$]/.test(maskedBody[index + 6] || "")) {
      hasTopLevelReturn = true;
      break;
    }
  }
  if (hasTopLevelReturn) return source;

  const expressionBody = body.replace(/;\s*$/, "");
  const assignedResult = expressionBody.match(/^result\s*=\s*([\s\S]+)$/)?.[1] || expressionBody;
  try {
    // A single expression may contain object literals, callbacks, or template
    // strings. Compile it before looking for a trailing statement.
    new Function("config", "params", "result", `return (${assignedResult});`);
    return `${prefix}\nreturn (${assignedResult});`;
  } catch {
    // Continue with statement-list handling below.
  }

  const finalValue = body.match(/(^|[;\n])(\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*;?\s*$/);
  if (finalValue && finalValue.index !== undefined) {
    const start = finalValue.index + finalValue[1].length + finalValue[2].length;
    body = `${body.slice(0, start)}return ${finalValue[3]};`;
    return `${prefix}\n${body}`;
  }

  // Remove a trailing semicolon before locating the final top-level statement.
  // Otherwise the semicolon itself becomes the last boundary and expressions
  // such as `result = value;` or `[item];` are left without a return value.
  const statementBody = body.replace(/;\s*$/, "");
  const masked = maskedJavaScript(statementBody);
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let boundary = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const token = masked[index];
    if (token === "(" || token === "[" || token === "{") stack.push(token);
    else if (pairs[token] && stack.at(-1) === pairs[token]) {
      stack.pop();
      if (!stack.length && token === "}") boundary = index + 1;
    } else if (token === ";" && !stack.length) boundary = index + 1;
  }
  const finalExpression = statementBody.slice(boundary).trim().replace(/^;+\s*/, "");
  if (finalExpression) {
    const start = statementBody.lastIndexOf(finalExpression);
    const candidate = `${statementBody.slice(0, start)}return (${finalExpression});`;
    try {
      new Function("config", "params", "result", candidate);
      return `${prefix}\n${candidate}`;
    } catch {
      // Keep the original script when the final statement is not an expression.
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
    .replace(/<\/js>/gi, "")
    // Older Legado collections also use `{$.id}` (one brace) in JSON URL
    // templates. Normalise only this narrow field form; ordinary JS objects
    // are deliberately untouched.
    .replace(/(?<!\{)\{(\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\s*\|\|\s*\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)*)\}(?!\})/g, "{{$1}}");
  source = source
    // Xiangse has no Legado source-variable UI. Empty is the exact initial
    // value on Legado and therefore selects a script's declared default path.
    .replace(/\bsource\.getVariable\s*\(\s*\)/gi, '""')
    // Private jsLib/comment loaders cannot be executed safely. Removing only
    // this standalone loader lets the declarative remainder be compiled.
    .replace(/^\s*eval\s*\(\s*String\s*\(\s*source\.bookSourceComment\s*\)\s*\)\s*;?\s*$/gim, "")
    // Logging has no request semantics and should not make a static fallback
    // depend on the Android runtime.
    .replace(/try\s*\{\s*java\.(?:log|toast)\s*\([^;{}]*\)\s*;?\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/gi, "")
    .replace(/^\s*java\.(?:log|toast)\s*\([^;\r\n]*\)\s*;?\s*$/gim, "")
    // Bare runtime aliases inside template literals are masked from the later
    // identifier pass, so translate their narrow interpolation form first.
    .replace(/\$\{\s*host\s*\}/gi, "${config.host}")
    .replace(/\$\{\s*key\s*\}/gi, "${params.keyWord}")
    .replace(/\$\{\s*page\s*\}/gi, "${params.pageIndex}");
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
  source = source
    .replace(/\bsource\.getKey\s*\(\s*\)/gi, "config.host")
    .replace(/\bsource\.(?:key|bookSourceUrl)\b/gi, "config.host")
    .replace(/^\s*(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie)\s*\([^;\n]*\)\s*;?\s*$/gim, "")
    .replace(/^\s*java\.put\s*\(\s*['"][^'"]+['"]\s*,\s*[^;\n]+\)\s*;?\s*$/gim, "");
  source = rewriteBareRuntimeIdentifiers(source);
  source = rewriteImplicitRuntimeAliases(source);
  return ensureJavaScriptReturn(source);
}

export function hasUnsupportedLegadoRuntime(value) {
  const source = String(value || "");
  const maskedSource = maskedJavaScript(source);
  if (/\b(?:java\.|Packages\b|android\.|org\.jsoup|source\.|book\.(?:name|author|kind|url)|cookie\.|javaScript\.)|<js>|\{\{|@(?:put|get):|\{\$\./i.test(maskedSource)) {
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
    if (new RegExp(`\\b(?:var|let|const)\\s+${name}\\b|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\([^)]*\\b${name}\\b`).test(masked)) return false;
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
