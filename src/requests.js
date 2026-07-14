function warnAndReturn(warn, message, fallback) {
  warn(message);
  return fallback;
}

export function parseLooseJson(value, warn = () => {}) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    try {
      const normalized = value
        .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, content) => JSON.stringify(content.replace(/\\'/g, "'")))
        .replace(/,\s*([}\]])/g, "$1");
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
 * 把阅读 URL/正文里的 Mustache 片段转成可拼进香色 @js 的表达式。
 * - {{key}} / {{page}} / {{page±n}} → params.*
 * - {{Get('url')}} / {{get("url")}} → config.host（登录分流在香色无等价，回退站点 host）
 * - 其余 Get(...) → 空串并告警
 */
function expressionForTemplate(template, { keyword = true, warn = () => {} } = {}) {
  const pattern =
    /\{\{\s*(?:key|page(?:\s*([+-])\s*(\d+))?|Get\(\s*['"]([^'"]+)['"]\s*\)|get\(\s*['"]([^'"]+)['"]\s*\))\s*\}\}/gi;
  const parts = [];
  let lastIndex = 0;
  let usedHostFallback = false;
  for (const match of template.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push(JSON.stringify(template.slice(lastIndex, match.index)));
    const raw = match[0];
    const inner = raw.replace(/^\{\{\s*|\s*\}\}$/g, "");
    if (/^key$/i.test(inner)) {
      parts.push(keyword ? "params.keyWord" : "params.pageIndex");
    } else if (/^page$/i.test(inner)) {
      parts.push("params.pageIndex");
    } else if (/^page\s*[+-]\s*\d+$/i.test(inner)) {
      const op = match[1];
      const n = match[2];
      parts.push(`(params.pageIndex ${op} ${n})`);
    } else {
      const getKey = match[3] || match[4] || "";
      if (/^url$/i.test(getKey)) {
        parts.push("config.host");
        usedHostFallback = true;
      } else {
        warn(`请求模板含 Get('${getKey}')，香色无登录变量，已替换为空串`);
        parts.push('""');
      }
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

export function convertRequest(request, { headers = {}, warn = () => {}, fallback = "%@result" } = {}) {
  if (!request || request === "-") return { requestInfo: fallback };
  if (typeof request !== "string") return { requestInfo: fallback };
  const source = request.trim();

  if (/^@js:/i.test(source) || /^<js>/i.test(source)) {
    warn("阅读请求中的 JavaScript/模板表达式无法可靠翻译，已保留原规则供人工修改");
    return { requestInfo: source.replace(/^<js>/i, "@js:\n").replace(/<\/js>$/i, "") };
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
  const charset = String(options.charset ?? "").toLowerCase();
  const encoding = /gbk|gb2312|gb18030/.test(charset)
    ? { requestParamsEncode: "2147485234", responseEncode: "2147485234" }
    : {};

  // {{Get('url')}}/path?q={{key}} 这类：先归一成表达式，再走标准 @js 请求对象。
  const getUrlExpr = rewriteGetTemplates(url, warn);
  if (getUrlExpr) {
    const lines = ["@js:", `let url = ${getUrlExpr};`];
    if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body), warn)};`);
    const result = ["url:url", `POST:${method === "POST"}`];
    if (options.body) result.push("httpParams:hp");
    if (Object.keys(mergedHeaders).length) result.push(`httpHeaders:${JSON.stringify(mergedHeaders)}`);
    if (options.webView) result.push("webView:true");
    lines.push(`return {${result.join(",")}};`);
    return { requestInfo: lines.join("\n"), ...encoding };
  }

  if (/^\{\{/i.test(url) && !/\{\{\s*(?:key|page|Get|get)/i.test(url)) {
    warn("阅读请求中的 JavaScript/模板表达式无法可靠翻译，已保留原规则供人工修改");
    return { requestInfo: `@js:\n${source}` };
  }

  const needsScript = method === "POST" || options.body || options.webView || hasComplexTemplate(url);

  if (!needsScript) {
    return { requestInfo: replaceSimpleTemplates(url), ...encoding };
  }

  const lines = ["@js:", `let url = ${expressionForTemplate(url, { warn })};`];
  if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body), warn)};`);
  const result = ["url:url", `POST:${method === "POST"}`];
  if (options.body) result.push("httpParams:hp");
  if (Object.keys(mergedHeaders).length) result.push(`httpHeaders:${JSON.stringify(mergedHeaders)}`);
  if (options.webView) result.push("webView:true");
  lines.push(`return {${result.join(",")}};`);
  return { requestInfo: lines.join("\n"), ...encoding };
}

export function parseHeaders(header, warn = () => {}) {
  const result = parseLooseJson(header, warn);
  return result && typeof result === "object" && !Array.isArray(result) ? result : {};
}
