import { hasUnsupportedLegadoRuntime, legadoTemplateExpression, rewriteLegadoJavaScript } from "./legadoJs.js";

/** Refresh anonymous client IDs that are literal millisecond timestamps. */
export function refreshEphemeralHeaders(headers, now = Date.now()) {
  const output = { ...(headers || {}) };
  for (const [name, value] of Object.entries(output)) {
    if (!/(?:visitor|device|request|trace|session)[_-]?id/i.test(name)) continue;
    const numeric = String(value || "").trim();
    if (!/^1\d{12}$/.test(numeric)) continue;
    const timestamp = Number(numeric);
    if (timestamp < 1_400_000_000_000 || timestamp > 2_100_000_000_000) continue;
    if (Math.abs(now - timestamp) < 86_400_000) continue;
    output[name] = String(now);
  }
  return output;
}

function warnAndReturn(warn, message, fallback) {
  warn(message);
  return fallback;
}

/**
 * Legado sources often store headers as plain `Name: value` lines instead of JSON.
 * Accept only when every non-empty line matches that shape.
 */
function parsePlainHeaderBlock(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const result = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) return null;
    const name = match[1];
    const headerValue = match[2].trim();
    if (!headerValue) continue;
    result[name] = headerValue;
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Public collections sometimes drop the closing quote on the last JSON string
 * (`"Referer": "https://example.com/}`). Insert it before the final brace/bracket
 * when the quote count is odd so UA/Referer survive conversion.
 */
function repairTruncatedJsonStrings(value) {
  let source = String(value || "");
  let quotes = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') quotes += 1;
  }
  if (quotes % 2 === 0) return source;
  const trimmed = source.replace(/\s+$/g, "");
  if (/[}\]]$/.test(trimmed)) {
    return `${trimmed.slice(0, -1)}"${trimmed.slice(-1)}${source.slice(trimmed.length)}`;
  }
  return `${source}"`;
}

export function parseLooseJson(value, warn = () => {}) {
  if (!value) return {};
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    const plain = parsePlainHeaderBlock(text);
    if (plain) return plain;
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      const normalized = repairTruncatedJsonStrings(
        text
          // A number of public Legado collections contain literal NUL/newline
          // characters inside JSON-like strings. They are invalid JSON but are
          // only formatting noise for request/category metadata.
          .replace(/[\u0000-\u001F]/g, " ")
          .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, content) => JSON.stringify(content.replace(/\\'/g, "'")))
          .replace(/,\s*([}\]])/g, "$1"),
      );
      return JSON.parse(normalized);
    } catch {
      return warnAndReturn(warn, "请求配置不是有效 JSON，已忽略其中的 method/body/header 配置", {});
    }
  }
}

function splitUrlAndOptions(request) {
  const match = request.match(/,\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { url: request.trim(), optionsText: "" };
  return { url: request.slice(0, match.index).trim(), optionsText: match[1] };
}

/**
 * 阅读源常在请求开头放 cookie.removeCookie(...) 之类的副作用模板。
 * 它不属于 URL，香色也没有等价 cookie API；移除后继续转换后面的
 * 普通 URL 与请求配置，避免把整段模板误当作 JavaScript 请求。
 */
function stripLeadingLegadoSideEffectTemplates(request, warn) {
  let value = String(request ?? "").trim();
  let removed = false;
  const jsSideEffect = /^(?:@js:|<js>)\s*(?:(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie|setCookie)\s*\([^;\n]*\)\s*;?\s*)+<\/js>\s*/i;
  if (jsSideEffect.test(value)) {
    value = value.replace(jsSideEffect, "");
    removed = true;
  }
  const sideEffect = /^\{\{\s*([^{}]*)\s*\}\}\s*/i;
  while (sideEffect.test(value)) {
    const match = value.match(sideEffect);
    const body = match?.[1] || "";
    const onlyCookie = /^(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie|setCookie)\s*\([^{}]*\)\s*;?$/i.test(body);
    const hostCookieSetup = /\bsource\.(?:getKey\s*\(\s*\)|key\b|bookSourceUrl\b)/i.test(body)
      && /\b(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie|setCookie)\s*\(/i.test(body)
      && !/\b(?:ajax|webView|org\.jsoup|JSON\.parse)\b/i.test(body)
      && !String(body).replace(/\bsource\.(?:getKey\s*\(\s*\)|key\b|bookSourceUrl\b)/gi, "")
        .replace(/\b(?:cookie\s*\.\s*)?(?:removeCookie|clearCookie|setCookie)\s*\([^;]*\)\s*;?/gi, "")
        .replace(/\bjava\.put\s*\(\s*['"][^'"]+['"]\s*,\s*[^;]+\)\s*;?/gi, "")
        .replace(/\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*;?/g, "")
        .replace(/[A-Za-z_$][\w$]*\s*=\s*;?/g, "")
        .replace(/[;\s]/g, "")
        .trim();
    if (!onlyCookie && !hostCookieSetup) break;
    value = value.slice(match[0].length);
    removed = true;
  }
  if (removed) warn("阅读请求开头的 cookie 清理表达式在香色无等价 API，已忽略并保留后续 URL 请求");
  return value;
}

/**
 * 把阅读 URL/正文里的 Mustache 片段转成可拼进香色 @js 的表达式。
 * - {{key}} / {{page}} / {{page±n}} → params.*
 * - {{Get('url')}} / {{get("url")}} → config.host（登录分流在香色无等价，回退站点 host）
 * - 其余 Get(...) → 空串并告警
 */
function expressionForTemplate(template, { keyword = true, warn = () => {} } = {}) {
  const pattern = /\{\{\s*([\s\S]*?)\s*\}\}/g;
  const parts = [];
  let lastIndex = 0;
  let usedHostFallback = false;
  for (const match of template.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push(JSON.stringify(template.slice(lastIndex, match.index)));
    const inner = match[1].trim();
    const portable = legadoTemplateExpression(inner);
    if (portable) {
      parts.push(!keyword && /^key$/i.test(inner) ? "params.pageIndex" : portable);
    } else if (/^(?:Get|get)\s*\(/i.test(inner)) {
      const getKey = inner.match(/^[^(]+\(\s*['"]([^'"]+)['"]\s*\)$/)?.[1] || "";
      if (/^url$/i.test(getKey)) {
        parts.push("config.host");
        usedHostFallback = true;
      } else {
        warn(`请求模板含 Get('${getKey}')，香色无登录变量，已替换为空串`);
        parts.push('""');
      }
    } else {
      warn(`请求模板表达式 {{${inner}}} 无法自动转换，已原样保留`);
      parts.push(JSON.stringify(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < template.length) parts.push(JSON.stringify(template.slice(lastIndex)));
  if (usedHostFallback) {
    warn("请求模板含 Get('url')（阅读登录/分流域名），已回退为 config.host；镜像失效时请手工改 host 或 requestInfo");
  }
  return parts.length ? parts.join(" + ") : JSON.stringify(template);
}

export function replaceSimpleTemplates(value) {
  return value
    .replace(/\{\{\s*key\s*\}\}/gi, "%@keyWord")
    .replace(/\{\{\s*page\s*\}\}/gi, "%@pageIndex");
}

function objectLiteralFromBody(body, warn) {
  const source = String(body ?? "").trim();
  // 阅读的 POST body 既可能是表单，也可能是 JSON。把 JSON 拆成
  // key=value 会生成一个错误的单字段对象（例如 {"{\"page\"...": ""}）。
  // 先将模板拼为 JSON 文本，再在香色运行时解析，数值型 {{page}} 也能保持数值。
  if (/^(?:\{|\[)/.test(source)) {
    return `JSON.parse(${expressionForTemplate(source, { warn })})`;
  }
  const entries = [];
  for (const pair of source.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator >= 0 ? pair.slice(0, separator) : pair;
    const value = separator >= 0 ? pair.slice(separator + 1) : "";
    entries.push(`${JSON.stringify(decodeURIComponent(key))}: ${expressionForTemplate(value, { warn })}`);
  }
  return `{${entries.join(", ")}}`;
}

function objectLiteralFromHeaders(headers, warn) {
  const entries = Object.entries(headers).map(([key, value]) => {
    const expression = typeof value === "string" && value.includes("{{")
      ? expressionForTemplate(value, { warn })
      : JSON.stringify(value);
    return `${JSON.stringify(key)}: ${expression}`;
  });
  return `{${entries.join(", ")}}`;
}

function hasComplexTemplate(value) {
  return /\{\{\s*(?:page|key)\s*[+-]/i.test(value)
    || /\{\{\s*(?:Get|get)\s*\(/i.test(value)
    || /\{\{(?!\s*(?:key|page)\s*\}\})/.test(value);
}

function isJsonBody(body) {
  return /^(?:\{|\[)/.test(String(body ?? "").trim());
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function rewriteGetTemplates(url, warn) {
  // 仅处理含 Get()/get() 的 URL；普通 {{key}}/{{page}} 仍走占位符或通用脚本路径。
  if (!/\{\{\s*(?:Get|get)\s*\(/i.test(url)) return null;
  if (/^(?:@js:|<js>)/i.test(url.trim())) return null;
  // 仍含无法识别的 {{...}}（非 key/page/Get）则放弃自动翻译
  const residual = url.replace(
    /\{\{\s*(?:key|page(?:\s*[+-]\s*\d+)?|Get\(\s*['"][^'"]+['"]\s*\)|get\(\s*['"][^'"]+['"]\s*\))\s*\}\}/gi,
    "",
  );
  if (/\{\{/.test(residual)) return null;
  return expressionForTemplate(url, { warn });
}

function legadoPageBranchExpression(url, warn) {
  const source = String(url || "");
  const branch = source.match(/<([^<>]*),([^<>]*)>/);
  if (!branch || !/\bpage\b|\{\{\s*page/i.test(branch[0])) return "";
  const before = source.slice(0, branch.index);
  const after = source.slice(branch.index + branch[0].length);
  const first = expressionForTemplate(branch[1], { warn });
  const following = expressionForTemplate(branch[2], { warn });
  return [
    expressionForTemplate(before, { warn }),
    `(params.pageIndex === 1 ? (${first}) : (${following}))`,
    expressionForTemplate(after, { warn }),
  ].join(" + ");
}

function maskScriptStrings(value) {
  return String(value || "")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (match) => " ".repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/\/\/[^\r\n]*/g, (match) => " ".repeat(match.length));
}

function splitTopLevelStatements(value) {
  const source = String(value || "");
  const masked = maskScriptStrings(source);
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const output = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const token = masked[index];
    if (token === "(" || token === "[" || token === "{") stack.push(token);
    else if (pairs[token] && stack.at(-1) === pairs[token]) stack.pop();
    else if (token === ";" && !stack.length) {
      output.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) output.push(tail);
  return output.filter(Boolean);
}

function matchingCallArgument(expression, functionName) {
  const source = String(expression || "").trim();
  const prefix = new RegExp(`^${functionName.replace(".", "\\.")}\\s*\\(`, "i").exec(source);
  if (!prefix) return "";
  const masked = maskScriptStrings(source);
  let depth = 0;
  for (let index = prefix[0].length - 1; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(prefix[0].length, index).trim();
      }
    }
  }
  return "";
}

const PORTABLE_REQUEST_GLOBALS = new Set([
  "key", "page", "params", "config", "true", "false", "null", "undefined",
  "String", "Number", "Boolean", "Math", "encodeURI", "encodeURIComponent",
]);

function portableExpressionDependencies(expression, declarations) {
  const masked = maskScriptStrings(expression);
  if (/\b(?:new|function|class|await|yield|eval|Function|require|import)\b|=>/.test(masked)) return null;
  const calls = [...masked.matchAll(/(?:\b([A-Za-z_$][\w$]*)|\.\s*([A-Za-z_$][\w$]*))\s*\(/g)];
  const safeCalls = new Set([
    "String", "Number", "Boolean", "encodeURI", "encodeURIComponent",
    "substring", "substr", "slice", "trim", "toLowerCase", "toUpperCase",
    "replace", "concat", "padStart", "padEnd", "floor", "ceil", "round", "abs",
  ]);
  if (calls.some((match) => !safeCalls.has(match[1] || match[2]))) return null;

  const dependencies = new Set();
  for (const match of masked.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    const before = masked.slice(0, match.index);
    const after = masked.slice(match.index + name.length);
    if (/\.\s*$/.test(before) || /^\s*:/.test(after)) continue;
    if (PORTABLE_REQUEST_GLOBALS.has(name) || safeCalls.has(name)) continue;
    if (!declarations.has(name)) return null;
    dependencies.add(name);
  }
  return dependencies;
}

/**
 * Recover a declarative JSON POST from scripts whose URL/body are portable but
 * whose optional headers are produced by a Legado-only signing helper. Only the
 * dependency-closed, side-effect-free declarations needed by URL and body are
 * retained; the source script is never evaluated.
 */
function compilePortableJsonPost(script, headers, warn) {
  const body = String(script || "").replace(/^@js:\s*/i, "").trim();
  if (!/\\?["']method\\?["']\s*:\s*\\?["']POST\\?["']/i.test(body)) return null;

  const declarations = new Map();
  for (const statement of splitTopLevelStatements(body)) {
    const match = statement.match(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
    if (match) declarations.set(match[1], match[2].trim());
  }
  const bodyEntry = [...declarations.entries()].find(([, expression]) => (
    /^JSON\.stringify\s*\(/i.test(expression)
  ));
  if (!bodyEntry) return null;
  const paramsExpression = matchingCallArgument(bodyEntry[1], "JSON.stringify");
  if (!/^[{[]/.test(paramsExpression)) return null;

  const urlEntry = [...declarations.entries()].find(([, expression]) => {
    const literal = expression.match(/^(['"])(https?:\/\/[^'"]+)\1$/i);
    return Boolean(literal);
  });
  if (!urlEntry) return null;

  const required = new Set();
  const visiting = new Set();
  const collect = (expression) => {
    const dependencies = portableExpressionDependencies(expression, declarations);
    if (!dependencies) return false;
    for (const name of dependencies) {
      if (required.has(name)) continue;
      if (visiting.has(name)) return false;
      visiting.add(name);
      if (!collect(declarations.get(name))) return false;
      visiting.delete(name);
      required.add(name);
    }
    return true;
  };
  if (!collect(urlEntry[1]) || !collect(paramsExpression)) return null;
  required.add(urlEntry[0]);

  const retained = [...declarations.entries()]
    .filter(([name]) => required.has(name))
    .map(([name, expression]) => `var ${name} = ${expression};`);
  const mergedHeaders = { ...headers };
  if (!hasHeader(mergedHeaders, "Content-Type")) {
    mergedHeaders["Content-Type"] = "application/json; charset=utf-8";
  }
  const candidate = rewriteLegadoJavaScript([
    "@js:",
    ...retained,
    `return {url:${urlEntry[0]},POST:true,httpParams:${paramsExpression},httpHeaders:${objectLiteralFromHeaders(mergedHeaders, warn)}};`,
  ].join("\n"));
  if (hasUnsupportedLegadoRuntime(candidate)) return null;
  warn("阅读请求的 URL 与 JSON 请求体可移植，已忽略无法执行的动态签名头并转换为标准 POST 请求");
  return {
    requestInfo: candidate,
    httpHeaders: mergedHeaders,
  };
}

export function convertRequest(request, { headers = {}, warn = () => {}, fallback = "%@result" } = {}) {
  if (!request || request === "-") return { requestInfo: fallback };
  if (typeof request !== "string") return { requestInfo: fallback };
  const source = stripLeadingLegadoSideEffectTemplates(request, warn);

  if (/^@js:/i.test(source) || /^<js>/i.test(source)) {
    const normalized = source.replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "");
    const declarative = normalized.replace(/^@js:\s*/i, "").trim();
    if (/^https?:\/\/[^\s,]+\s*,\s*\{/i.test(declarative)) {
      warn("已将 @js 包装的静态 URL 请求还原为声明式请求");
      return convertRequest(declarative, { headers, warn, fallback });
    }
    const portablePost = compilePortableJsonPost(normalized, headers, warn);
    if (portablePost) return portablePost;
    const rewritten = rewriteLegadoJavaScript(normalized);
    if (rewritten !== normalized) warn("已将阅读 JavaScript 中的分页、关键词或结果字段模板转换为香色运行时表达式");
    else warn("阅读请求中的 JavaScript/模板表达式无法可靠翻译，已保留原规则供人工修改");
    return { requestInfo: rewritten };
  }

  const { url, optionsText } = splitUrlAndOptions(source);
  const options = parseLooseJson(optionsText, warn);
  const method = String(options.method ?? "GET").toUpperCase();
  const mergedHeaders = { ...headers, ...(options.headers ?? {}) };
  // JSON API commonly rejects a raw body when Content-Type is omitted (HTTP 415).
  // 阅读源里 body 已是 JSON 时，香色的 httpParams 也必须声明这个媒体类型。
  if (isJsonBody(options.body) && !hasHeader(mergedHeaders, "Content-Type")) {
    mergedHeaders["Content-Type"] = "application/json";
  }
  const staticHeaders = Object.fromEntries(Object.entries(mergedHeaders).filter(([, value]) => (
    !String(value).includes("{{")
  )));
  const actionHeaders = Object.keys(staticHeaders).length ? { httpHeaders: staticHeaders } : {};
  const charset = String(options.charset ?? "").toLowerCase();
  const encoding = /gbk|gb2312|gb18030/.test(charset)
    ? { requestParamsEncode: "2147485234", responseEncode: "2147485234" }
    : {};

  // Legado's `<first,following>` URL branch chooses the text before the comma
  // on page 1 and the text after it on later pages. Leaving the angle brackets
  // in a URL makes clients percent-encode them and request a non-existent path.
  const pageBranchExpr = legadoPageBranchExpression(url, warn);
  if (pageBranchExpr) {
    const lines = ["@js:", `let url = ${pageBranchExpr};`];
    if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body), warn)};`);
    const result = ["url:url", `POST:${method === "POST"}`];
    if (options.body) result.push("httpParams:hp");
    if (Object.keys(mergedHeaders).length) result.push(`httpHeaders:${objectLiteralFromHeaders(mergedHeaders, warn)}`);
    if (options.webView) result.push("webView:true");
    lines.push(`return {${result.join(",")}};`);
    return { requestInfo: lines.join("\n"), ...encoding, ...actionHeaders };
  }

  // {{Get('url')}}/path?q={{key}} 这类：先归一成表达式，再走标准 @js 请求对象。
  const getUrlExpr = rewriteGetTemplates(url, warn);
  if (getUrlExpr) {
    const lines = ["@js:", `let url = ${getUrlExpr};`];
    if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body), warn)};`);
    const result = ["url:url", `POST:${method === "POST"}`];
    if (options.body) result.push("httpParams:hp");
    if (Object.keys(mergedHeaders).length) result.push(`httpHeaders:${objectLiteralFromHeaders(mergedHeaders, warn)}`);
    if (options.webView) result.push("webView:true");
    lines.push(`return {${result.join(",")}};`);
    return { requestInfo: lines.join("\n"), ...encoding, ...actionHeaders };
  }

  const hasUnsupportedTemplate = [...url.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)].some((match) => (
    !legadoTemplateExpression(match[1]) && !/^(?:Get|get)\s*\(/i.test(match[1])
  ));
  if (/^\{\{/i.test(url) && hasUnsupportedTemplate) {
    warn("阅读请求中的 JavaScript/模板表达式无法可靠翻译，已保留原规则供人工修改");
    return { requestInfo: `@js:\n${source}` };
  }

  const needsScript = method === "POST" || options.body || options.webView || hasComplexTemplate(url);

  if (!needsScript) {
    return { requestInfo: replaceSimpleTemplates(url), ...encoding, ...actionHeaders };
  }

  const lines = ["@js:", `let url = ${expressionForTemplate(url, { warn })};`];
  if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body), warn)};`);
  const result = ["url:url", `POST:${method === "POST"}`];
  if (options.body) result.push("httpParams:hp");
  if (Object.keys(mergedHeaders).length) result.push(`httpHeaders:${objectLiteralFromHeaders(mergedHeaders, warn)}`);
  if (options.webView) result.push("webView:true");
  lines.push(`return {${result.join(",")}};`);
  return { requestInfo: lines.join("\n"), ...encoding, ...actionHeaders };
}

export function parseHeaders(header, warn = () => {}) {
  let text = header;
  if (typeof text === "string") {
    const trimmed = text.trim();
    // Public sources often wrap static headers as:
    //   @js: JSON.stringify({ "User-Agent": "...", Referer: "..." })
    // Extract the object literal so UA/Referer survive conversion.
    const jsObject = trimmed.match(
      /^(?:@js:|<js>)\s*(?:return\s+)?JSON\.stringify\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*(?:<\/js>)?\s*$/i,
    );
    if (jsObject) text = jsObject[1];
  }
  const result = parseLooseJson(text, warn);
  return result && typeof result === "object" && !Array.isArray(result) ? result : {};
}
