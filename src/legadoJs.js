import { injectRuntimeHelpers } from "./legadoRuntime.js";

function propertyExpression(root, path) {
  const value = String(path || "").trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(value)) return "";
  return `${root}.${value}`;
}

const PORTABLE_STRING_METHODS = "length|substring|substr|slice|indexOf|charAt|charCodeAt|trim|toLowerCase|toUpperCase|startsWith|endsWith|includes|replace|concat|padStart|padEnd";

/**
 * 香色把脚本包装成 function(config, params, result)，脚本体内再声明同名变量
 * 会触发 "Identifier has already been declared"。统一改名本地声明，保持脚本
 * 语义不变（改名是一致替换）。
 */
function rewriteShadowedRuntimeNames(value) {
  let source = String(value || "");
  let masked = maskedJavaScript(source);
  const renames = [];
  for (const name of ["config", "params", "result"]) {
    if (new RegExp(`\\b(?:var|let|const)\\s+${name}\\b`).test(masked)) {
      renames.push([name, `__xsLocal${name.charAt(0).toUpperCase()}${name.slice(1)}`]);
    }
  }
  if (!renames.length) return source;
  for (const [name, replacement] of renames) {
    masked = maskedJavaScript(source);
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

function rewriteJavaRuntimeApis(value) {
  let source = String(value || "");
  // 纯 JS 可实现的编码/加密/时间 API（助手按需内嵌）。
  const apiRenames = [
    [/java\.base64DecodeToByteArray\s*\(/g, "__xsBase64Bytes("],
    [/java\.base64Decode\s*\(/g, "__xsBase64Decode("],
    [/java\.base64Encode\s*\(/g, "__xsBase64Encode("],
    [/java\.hexDecodeToString\s*\(/g, "__xsHexDecode("],
    [/java\.hexDecodeToByteArray\s*\(/g, "__xsHexBytes("],
    [/java\.strToBytes\s*\(/g, "__xsStrToBytes("],
    [/java\.bytesToStr\s*\(/g, "__xsBytesToStr("],
    [/java\.md5Encode\s*\(/g, "__xsMd5("],
    [/java\.timeFormatUTC\s*\(/g, "__xsTimeFormatUTC("],
    [/java\.timeFormat\s*\(/g, "__xsTimeFormat("],
    // htmlFormat 在阅读里做 HTML 标准化；转换后正则按原文匹配即可，恒等映射。
    [/java\.htmlFormat\s*\(/g, "String("],
  ];
  for (const [pattern, replacement] of apiRenames) {
    source = source.replace(pattern, replacement);
  }
  // jsoup（Java DOM）改为内嵌迷你 DOM。
  source = source
    .replace(/(?:Packages\.)?org\.jsoup\.Jsoup\s*\.\s*parse\s*\(/gi, "__xsJsoup.parse(")
    .replace(/(?<![A-Za-z_$][\w$]*\.)\bJsoup\s*\.\s*parse\s*\(/g, "__xsJsoup.parse(");
  // getString 的规则求值形态（JSONPath / CSS@属性）可移植；URL 形态是 HTTP 请求，保留。
  source = source
    .replace(/java\.getString(?:List)?\s*\(\s*(['"])(\$[^'"]*)\1\s*\)/gi,
      (_match, _quote, path) => `__xsJsonPath(result, ${JSON.stringify(path)})`)
    .replace(/java\.getString\s*\(\s*(['"])([^'"]*@[^'"]*)\1\s*\)/gi,
      (_match, _quote, rule) => `__xsRuleString(result, ${JSON.stringify(rule)})`);
  // 正文后处理里常见的「再取一次当前响应」可直接用 result。
  source = source
    .replace(/java\.ajax\s*\(\s*result\s*\)/gi, "String(result)")
    .replace(/java\.getString\s*\(\s*result\s*\)/gi, "String(result)");
  // 状态读写：香色无跨字段变量，按脚本内局部状态编译（跨脚本场景由告警提示）。
  source = source.replace(
    /^(\s*)java\.put\s*\(\s*(['"])([^'"]+)\2\s*,\s*([\s\S]+?)\s*\)\s*;?$/gim,
    (_match, indent, _quote, key, expression) => `${indent}__xsState[${JSON.stringify(key)}] = (${expression});`,
  );
  source = source.replace(
    /java\.get\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (match, quote, key) => (/^[^:/]*:\/\//.test(key) ? match : `(__xsState[${JSON.stringify(key)}] || "")`),
  );
  // 无副作用的 UI/日志调用整句移除。
  source = source
    .replace(/^\s*java\.(?:log|toast|longToast)\s*\([^;\r\n]*\)\s*;?\s*$/gim, "")
    .replace(/^\s*java\.refresh(?:Explore|Book)\s*\(\s*\)\s*;?\s*$/gim, "")
    .replace(/try\s*\{\s*java\.(?:log|toast|longToast)\s*\([^;{}]*\)\s*;?\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/gi, "");
  return source;
}

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
  if (/^(?:host(?:\s*\.\s*(?:call|apply)\s*\(\s*(?:this|[^)]*)\s*\))?|(?:getCurrentUrl|Url)\s*\(\s*\))$/i.test(expression)) return "config.host";
  // 镜像/登录分流 jsLib（eval(source.loginUrl)、GetUL() 等）在香色无宿主等价物，
  // 站点主域回退 config.host，保持请求可达而不是丢弃整条规则。
  if (/^(?:eval\s*\(\s*String\s*\(\s*source\.loginUrl\s*\)\s*\)\s*;?\s*)?(?:get(?:ul|url|host)|get\s*\(\s*['"](?:ul|url|host)['"]?\s*\))\s*\(\s*\)\s*;?$/i.test(expression)) {
    return "config.host";
  }
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
  // 单遍扫描：按 JS 词法上下文把字符串、模板串、注释和正则字面量整体抹成
  // 空格。旧的「先字符串后正则」两段式在正则含引号（如 /x="a"/）时会把
  // 正则里的引号误当字符串边界，导致后续语句边界判断错位。
  const source = String(value || "");
  const out = new Array(source.length);
  let index = 0;
  // 表达式位置判定：`/` 出现在这些字符之后才是正则字面量，否则是除号。
  const regexPrefix = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "{", "}", "+", "-", "*", "%", "~", "<", ">", "^", "\n", "\r", ""]);
  const lastMeaningful = () => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (!/\s/.test(source[cursor])) return source[cursor];
    }
    return "";
  };
  const blank = (start, end) => {
    for (let cursor = start; cursor < end && cursor < source.length; cursor += 1) {
      out[cursor] = source[cursor] === "\n" ? "\n" : " ";
    }
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") { cursor += 2; continue; }
        if (source[cursor] === char) { cursor += 1; break; }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "/" && regexPrefix.has(lastMeaningful())) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") { cursor += 2; continue; }
        if (current === "\n") break;
        if (inClass) {
          if (current === "]") inClass = false;
        } else if (current === "[") {
          inClass = true;
        } else if (current === "/") {
          closed = true;
          cursor += 1;
          while (cursor < source.length && /[dgimsuvy]/.test(source[cursor])) cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (closed) {
        blank(index, cursor);
        index = cursor;
        continue;
      }
      // 未闭合（可能是除号或被截断的 URL），按普通字符保留。
      out[index] = char;
      index += 1;
      continue;
    }
    out[index] = char;
    index += 1;
  }
  return out.join("");
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
  // Legado 脚本常以给 result 赋值收尾（隐式返回 result），补上显式返回。
  const assignCandidate = `${statementBody};\nreturn result;`;
  if (/\bresult\s*=(?!=)/.test(masked)) {
    try {
      new Function("config", "params", "result", assignCandidate);
      return `${prefix}\n${assignCandidate}`;
    } catch {
      // Fall through and keep the original script.
    }
  }
  // 列表规则脚本还有 `list = ...` 的魔法赋值约定，同样补返回。
  const listCandidate = `${statementBody};\nreturn typeof list === "undefined" ? result : list;`;
  if (/\blist\s*=(?!=)/.test(masked)) {
    try {
      new Function("config", "params", "result", listCandidate);
      return `${prefix}\n${listCandidate}`;
    } catch {
      // Fall through and keep the original script.
    }
  }
  return source;
}


/**
 * 阅读源常用 `typeof Packages!='undefined'?jsoup路径:回退` 守卫。香色没有
 * Packages，运行时恒走回退分支；编译期直接裁掉不可达的真分支，规则才
 * 不会因残留的 Packages 字样被结构校验拒收。
 */
function stripGuardedPackagesBranches(source) {
  let out = String(source || "");
  const marker = /typeof\s+Packages\s*(?:!==?|==?)\s*(['"])undefined\1\s*\?/gi;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const match = marker.exec(out);
    if (!match) break;
    marker.lastIndex = 0;
    const start = match.index;
    const question = start + match[0].length - 1;
    // 找到与该 `?` 配对的同级 `:`（括号/嵌套三元感知）。
    let depth = 0;
    let ternary = 1;
    let colon = -1;
    for (let cursor = question + 1; cursor < out.length; cursor += 1) {
      const ch = out[cursor];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === "?" && depth === 0) ternary += 1;
      else if (ch === ":" && depth === 0) {
        ternary -= 1;
        if (ternary === 0) { colon = cursor; break; }
      }
    }
    if (colon < 0) break;
    out = `${out.slice(0, start).trimEnd()}${out.slice(colon + 1).trimStart()}`;
  }
  return out;
}

/**
 * Translate the portable subset of Legado JavaScript templates to the 香色
 * runtime. This never evaluates source code; it only rewrites recognised
 * placeholders inside JavaScript string literals and standalone templates.
 */
export function rewriteLegadoJavaScriptRaw(value) {
  let source = String(value || "")
    .replace(/<\/js>/gi, "")
    // Older Legado collections also use `{$.id}` (one brace) in JSON URL
    // templates. Normalise only this narrow field form; ordinary JS objects
    // are deliberately untouched.
    .replace(/(?<!\{)\{(\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\s*\|\|\s*\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)*)\}(?!\})/g, "{{$1}}");
  source = stripGuardedPackagesBranches(source);
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
  source = rewriteJavaRuntimeApis(source);
  source = source
    .replace(/\bsource\.getKey\s*\(\s*\)/gi, "config.host")
    .replace(/\bsource\.(?:key|bookSourceUrl)\b/gi, "config.host")
    .replace(/^\s*(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie)\s*\([^;\n]*\)\s*;?\s*$/gim, "");
  source = rewriteShadowedRuntimeNames(source);
  source = rewriteBareRuntimeIdentifiers(source);
  source = rewriteImplicitRuntimeAliases(source);
  return ensureJavaScriptReturn(source);
}

export function rewriteLegadoJavaScript(value) {
  return injectRuntimeHelpers(rewriteLegadoJavaScriptRaw(value));
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
