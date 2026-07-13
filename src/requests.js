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

function expressionForTemplate(template, { keyword = true } = {}) {
  const pattern = /\{\{\s*(key|page)(?:\s*([+-])\s*(\d+))?\s*\}\}/gi;
  const parts = [];
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push(JSON.stringify(template.slice(lastIndex, match.index)));
    let expression = match[1].toLowerCase() === "key" && keyword ? "params.keyWord" : "params.pageIndex";
    if (match[2] && match[3]) expression = `(${expression} ${match[2]} ${match[3]})`;
    parts.push(expression);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < template.length) parts.push(JSON.stringify(template.slice(lastIndex)));
  return parts.length ? parts.join(" + ") : JSON.stringify(template);
}

export function replaceSimpleTemplates(value) {
  return value
    .replace(/\{\{\s*key\s*\}\}/gi, "%@keyWord")
    .replace(/\{\{\s*page\s*\}\}/gi, "%@pageIndex");
}

function objectLiteralFromBody(body) {
  const entries = [];
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator >= 0 ? pair.slice(0, separator) : pair;
    const value = separator >= 0 ? pair.slice(separator + 1) : "";
    entries.push(`${JSON.stringify(decodeURIComponent(key))}: ${expressionForTemplate(value)}`);
  }
  return `{${entries.join(", ")}}`;
}

function hasComplexTemplate(value) {
  return /\{\{\s*(?:page|key)\s*[+-]/i.test(value) || /\{\{(?!\s*(?:key|page)\s*\}\})/.test(value);
}

export function convertRequest(request, { headers = {}, warn = () => {}, fallback = "%@result" } = {}) {
  if (!request || request === "-") return { requestInfo: fallback };
  if (typeof request !== "string") return { requestInfo: fallback };
  const source = request.trim();

  if (/^(?:@js:|\{\{)/i.test(source)) {
    warn("阅读请求中的 JavaScript/模板表达式无法可靠翻译，已保留原规则供人工修改");
    return { requestInfo: source.startsWith("@js:") ? source : `@js:\n${source}` };
  }

  const { url, optionsText } = splitUrlAndOptions(source);
  const options = parseLooseJson(optionsText, warn);
  const method = String(options.method ?? "GET").toUpperCase();
  const mergedHeaders = { ...headers, ...(options.headers ?? {}) };
  const charset = String(options.charset ?? "").toLowerCase();
  const encoding = /gbk|gb2312|gb18030/.test(charset)
    ? { requestParamsEncode: "2147485234", responseEncode: "2147485234" }
    : {};
  const needsScript = method === "POST" || options.body || options.webView || hasComplexTemplate(url);

  if (!needsScript) {
    return { requestInfo: replaceSimpleTemplates(url), ...encoding };
  }

  const lines = ["@js:", `let url = ${expressionForTemplate(url)};`];
  if (options.body) lines.push(`let hp = ${objectLiteralFromBody(String(options.body))};`);
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
