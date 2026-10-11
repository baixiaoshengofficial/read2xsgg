import {
  compileBookBridgePlan,
  compileChapterBridgePlan,
  compileDetailBridgePlan,
  decodeBridgePlan,
  encodeBridgePlan,
  executeBridgePlan,
  bridgeTocUrl,
  orderChaptersAscending,
} from "./bridgePlan.js";
import {
  executeXbsJavaScriptRule,
  isPlayableMediaResponse,
  runXbsChapterContent,
  runXbsPipeline,
} from "./xbsRuntime.js";
import { CONTEXTUAL_CHAPTER_URL_MARKER } from "./chapterUrlPlan.js";
import { downloadAsFetch } from "./xiangseValidate.js";
import { decodeTextBuffer, encodeFormBody } from "./charset.js";
import { refreshEphemeralHeaders } from "./requests.js";
import { usableCoverUrl } from "./siteAnalyze/coverSelectors.js";
import { isDateOnlyMetadata } from "./elementValidation.js";
import { requestIdentity } from "./requestIdentity.js";

async function withTimeoutSignal(parentSignal, timeoutMs, operation, timeoutCode = "") {
  const controller = new AbortController();
  const duration = Math.max(1, Number(timeoutMs) || 1);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
      handler(value);
    };
    const abort = (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason || "请求已取消"));
      controller.abort(error);
      finish(reject, error);
    };
    const abortFromParent = () => abort(parentSignal?.reason || new Error("请求已取消"));
    if (parentSignal?.aborted) {
      abortFromParent();
      return;
    }
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`操作超时（${duration}ms）`);
      if (timeoutCode) error.code = timeoutCode;
      abort(error);
    }, duration);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function isRequestTimeout(error) {
  const message = String(error?.message || error?.reason || error || "");
  return error?.code === "ETIMEDOUT"
    || error?.name === "TimeoutError"
    || /(?:操作超时|请求超时|timed\s*out|timeout|ETIMEDOUT|ECONNABORTED|HTTP\s*(?:408|504|524)\b)/i.test(message);
}

function throwIfRequestTimedOut(error, signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : error;
  }
  if (isRequestTimeout(error)) throw error;
}

function firstRequestFilter(action) {
  const filters = String(action?.moreKeys?.requestFilters || "");
  const line = filters.split("\n").find((item) => item.includes("::"));
  if (!line) return "";
  return line.slice(line.indexOf("::") + 2).trim();
}

function defaultSearchKeyword(sourceType) {
  return ({ comic: "漫画", audio: "广播剧", video: "视频" })[String(sourceType || "").trim()]
    || "小说";
}

function declarativeBridgeAction(action, type) {
  const requestInfo = String(action?.requestInfo || "");
  // Allow paging/query params between plan= and url= (e.g. &page=&pageSize=&slice=1).
  const match = requestInfo.match(new RegExp(`/adapter/${type}\\?plan=([A-Za-z0-9_-]+)[^"'\\\\\\s]*?&url=`));
  if (!match) return null;
  try {
    return { plan: decodeBridgePlan(match[1]), requestInfo };
  } catch {
    return null;
  }
}

function generatedAdapterUrl(requestInfo, type, targetUrl) {
  const pattern = new RegExp(`(https?:\\/\\/[^"'\\\\\\s]+\\/adapter\\/${type}\\?[^"'\\\\\\s]*[?&]url=)`, "i");
  const prefix = String(requestInfo || "").match(pattern)?.[1] || "";
  return prefix && targetUrl ? `${prefix}${encodeURIComponent(targetUrl)}` : "";
}

function actionHeaders(source, action) {
  return { ...(source?.httpHeaders || {}), ...(action?.httpHeaders || {}) };
}

function usesWebViewMediaAction(action) {
  const requestInfo = String(action?.requestInfo || "");
  return /\bwebView\s*:\s*(?:""|true)/i.test(requestInfo)
    && (/\bwebViewJs\s*:/i.test(requestInfo) || /\bwebView\s*:\s*true\b/i.test(requestInfo));
}

function executableBookAction(source, action) {
  const bridged = declarativeBridgeAction(action, "books");
  if (bridged) return bridged;
  const requestInfo = String(action?.requestInfo || "");
  if (!requestInfo) return null;
  try {
    const plan = compileBookBridgePlan(action, actionHeaders(source, action));
    if (!plan.list || !plan.fields.name || !plan.fields.url) return null;
    return { plan, requestInfo };
  } catch {
    return null;
  }
}

/**
 * Reuse a search action's proven list schema for browse categories whose
 * requests return rows but whose stale selectors do not. Keep each category's
 * request and pagination intact; the repaired candidate still has to pass a
 * complete browse → detail → chapter → content verification before publishing.
 */
export function reuseSearchListRulesForBrowse(source) {
  const searchAction = source?.searchBook;
  const searchBridge = executableBookAction(source, searchAction);
  const worlds = Object.entries(source?.bookWorld || {});
  if (!searchBridge || !worlds.length) return null;

  const repaired = structuredClone(source);
  const ruleFields = [
    "list", "bookName", "detailUrl", "author", "cover", "cat",
    "lastChapterTitle", "status", "wordCount", "kind",
    "responseFormatType", "parserID", "charset",
  ];
  let changed = 0;
  for (const [name, originalAction] of worlds) {
    const browseBridge = executableBookAction(source, originalAction);
    const action = repaired.bookWorld?.[name];
    if (!browseBridge || !action) continue;

    for (const field of ruleFields) {
      if (searchAction[field] !== undefined && searchAction[field] !== null && searchAction[field] !== "") {
        action[field] = structuredClone(searchAction[field]);
      }
    }

    const plan = structuredClone(browseBridge.plan);
    plan.list = searchBridge.plan.list;
    plan.fields = { ...(plan.fields || {}), ...(searchBridge.plan.fields || {}) };
    const requestInfo = String(action.requestInfo || "");
    if (/\/adapter\/books\b/i.test(requestInfo)) {
      const tokenPattern = /([?&]plan=)([A-Za-z0-9_-]+)/;
      if (tokenPattern.test(requestInfo)) {
        action.requestInfo = requestInfo.replace(tokenPattern, (_match, prefix) => (
          `${prefix}${encodeBridgePlan(plan)}`
        ));
      }
    }
    changed += 1;
  }
  return changed ? { source: repaired, repairedWorlds: changed } : null;
}

function executableChapterAction(source) {
  const action = source?.chapterList;
  const bridged = declarativeBridgeAction(action, "chapters");
  if (bridged) return bridged;
  try {
    const plan = compileChapterBridgePlan(action, { headers: actionHeaders(source, source?.chapterList) });
    if (!plan.list || !plan.fields.title || !plan.fields.url) return null;
    return { plan, requestInfo: String(action?.requestInfo || "") };
  } catch {
    return null;
  }
}

function executableDetailAction(source) {
  const action = source?.bookDetail;
  const bridged = declarativeBridgeAction(action, "detail");
  if (bridged) return Object.keys(bridged.plan?.fields || {}).length ? bridged : null;
  try {
    const plan = compileDetailBridgePlan(action, actionHeaders(source, action));
    if (!Object.keys(plan.fields || {}).length) return null;
    return { plan, requestInfo: String(action?.requestInfo || "") };
  } catch {
    return null;
  }
}

function assignedExpression(script, name) {
  const match = String(script || "").match(new RegExp(`\\b(?:var|let|const)\\s+${name}\\s*=`));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === ";" && depth === 0) return script.slice(start, index).trim();
  }
  return "";
}

function portableUrlExpression(expression, {
  host = "",
  keyWord = "",
  pageIndex = 1,
  result = "",
  baseUrl = result,
} = {}) {
  const source = String(expression || "").trim();
  if (!source || source.length > 4_000) return "";
  const masked = source.replace(/(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, (value) => " ".repeat(value.length));
  if (/[`{};\\]/.test(masked) || /\[(?!\s*\d+\s*\])/.test(masked)) return "";
  const indexed = masked.replace(/\[\s*\d+\s*\]/g, "");
  if (/[\[\]]/.test(indexed) || /\b(?:__proto__|prototype|constructor)\b/.test(masked)) return "";
  const allowed = new Set([
    "params", "pageIndex", "keyWord", "config", "host", "result", "baseUrl",
    "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "escape", "String", "Math",
    "length", "substring", "substr", "slice", "indexOf", "charAt",
    "trim", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
    "includes", "replace", "concat", "padStart", "padEnd",
    "floor", "ceil", "round", "max", "min", "abs",
    "true", "false", "null", "undefined",
  ]);
  const identifiers = [...masked.matchAll(/[A-Za-z_$][\w$]*/g)]
    .filter((match) => masked[match.index - 1] !== ".")
    .map((match) => match[0]);
  if (identifiers.some((identifier) => !allowed.has(identifier))) return "";
  const allowedMembers = new Set([
    "length", "substring", "substr", "slice", "split", "indexOf", "charAt", "trim",
    "toLowerCase", "toUpperCase", "startsWith", "endsWith", "includes", "replace",
    "concat", "padStart", "padEnd",
    // These are data properties on the frozen request context, not callable
    // methods. Permit them so safe templates using params.keyWord/pageIndex
    // can be evaluated during verification and generic rule repair.
    "keyWord", "pageIndex", "host",
  ]);
  if ([...masked.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)]
    .some((match) => !allowedMembers.has(match[1]))) return "";
  try {
    const evaluate = new Function(
      "params",
      "config",
      "encodeURIComponent",
      "encodeURI",
      "escape",
      "String",
      "Math",
      "result",
      "baseUrl",
      `"use strict"; return (${source});`,
    );
    const value = evaluate(
      Object.freeze({ pageIndex, keyWord }),
      Object.freeze({ host }),
      encodeURIComponent,
      encodeURI,
      globalThis.escape,
      String,
      Math,
      String(result || ""),
      String(baseUrl || ""),
    );
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function portableValueExpression(expression, {
  keyWord = "",
  pageIndex = 1,
  filter = "",
  variables = {},
} = {}) {
  const source = String(expression || "").trim();
  if (!source || source.length > 10_000
    || /(?:__proto__|prototype|constructor|\bfunction\b|=>|\bnew\s|\bthis\b|\bprocess\b|\bglobal\b|\brequire\b|\bimport\b|\beval\b)/.test(source)) {
    return null;
  }
  const masked = source
    .replace(/(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, (value) => " ".repeat(value.length))
    .replace(/\b[A-Za-z_$][\w$]*\s*:/g, (value) => " ".repeat(value.length));
  const allowed = new Set([
    "params", "keyWord", "pageIndex", "filter", "filters", "category",
    "JSON", "parse", "stringify", "String", "encodeURIComponent", "encodeURI",
    "Math", "floor", "ceil", "round", "max", "min", "abs",
    "indexOf", "lastIndexOf", "includes", "replace", "trim", "slice", "substring",
    "toLowerCase", "toUpperCase", "charAt", "split", "join", "match", "test", "length",
    "true", "false", "null", "undefined",
    ...Object.keys(variables),
  ]);
  const identifiers = [...masked.matchAll(/[A-Za-z_$][\w$]*/g)]
    .filter((match) => masked[match.index - 1] !== ".")
    .map((match) => match[0]);
  if (identifiers.some((identifier) => !allowed.has(identifier))) return null;
  try {
    const variableNames = Object.keys(variables)
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !["params", "JSON", "String", "Math"].includes(name));
    const evaluate = new Function(
      "params",
      "JSON",
      "String",
      "encodeURIComponent",
      "encodeURI",
      "Math",
      ...variableNames,
      `"use strict"; return (${source});`,
    );
    const value = evaluate(
      Object.freeze({
        keyWord,
        pageIndex,
        filter,
        filters: Object.freeze(filter ? { category: filter } : {}),
      }),
      JSON,
      String,
      encodeURIComponent,
      encodeURI,
      Math,
      ...variableNames.map((name) => variables[name]),
    );
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return null;
    if (value && typeof value === "object") {
      const serialized = JSON.stringify(value);
      if (!serialized || serialized.length > 100_000) return null;
      return JSON.parse(serialized);
    }
    return value;
  } catch {
    return null;
  }
}

function portableDataExpression(expression, options = {}) {
  const value = portableValueExpression(expression, options);
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        output[String(key)] = item;
      }
    }
    return output;
  } catch {
    return null;
  }
}

function portableRequestVariables(script, options = {}) {
  const variables = {};
  const declarations = String(script || "").matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g);
  for (const declaration of declarations) {
    const name = declaration[1];
    if (Object.hasOwn(variables, name) || ["params", "JSON", "String", "Math"].includes(name)) continue;
    const expression = assignedExpression(String(script).slice(declaration.index), name);
    const value = portableValueExpression(expression, { ...options, variables });
    if (value !== null && value !== undefined) variables[name] = value;
  }
  return variables;
}

function returnedPropertyExpression(script, name) {
  const startAt = String(script || "").lastIndexOf("return {");
  if (startAt < 0) return "";
  const tail = script.slice(startAt);
  const match = tail.match(new RegExp(`\\b${name}\\s*:`));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = start; index < tail.length; index += 1) {
    const char = tail[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) return tail.slice(start, index).trim();
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return tail.slice(start, index).trim();
    }
  }
  return "";
}

function generatedRequestOptions(requestInfo, { keyWord = "小说", pageIndex = 1 } = {}) {
  const script = String(requestInfo || "");
  if (!/^@js:/i.test(script)) return null;
  if (!assignedExpression(script, "url")) return null;
  const variables = portableRequestVariables(script, { keyWord, pageIndex });
  const method = /\bPOST\s*:\s*true\b/.test(script) ? "POST" : "GET";
  let paramsExpression = returnedPropertyExpression(script, "httpParams");
  if (!paramsExpression) paramsExpression = assignedExpression(script, "hp");
  const params = /^[A-Za-z_$][\w$]*$/.test(paramsExpression)
    ? variables[paramsExpression] || null
    : portableDataExpression(paramsExpression, { keyWord, pageIndex, variables });
  let headerExpression = returnedPropertyExpression(script, "httpHeaders");
  if (headerExpression && /^[A-Za-z_$][\w$]*$/.test(headerExpression)) {
    const value = variables[headerExpression];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { method, params, headers: value, url: variables.url || "" };
    }
    headerExpression = assignedExpression(script, headerExpression);
  }
  const headers = headerExpression
    ? portableDataExpression(headerExpression, { keyWord, pageIndex, variables }) || {}
    : {};
  return { method, params, headers, url: variables.url || "" };
}

function splitReturnedRequest(value) {
  const source = String(value || "").trim();
  const match = source.match(/,\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { url: source, options: {} };
  try {
    const options = JSON.parse(match[1]);
    return {
      url: source.slice(0, match.index).trim(),
      options: options && typeof options === "object" && !Array.isArray(options) ? options : {},
    };
  } catch {
    return { url: source, options: {} };
  }
}

function returnedExpression(source, start) {
  const input = String(source || "");
  let quote = "";
  let escaped = false;
  const stack = [];
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (!stack.length) return input.slice(start, index).trim();
      stack.pop();
      continue;
    }
    if (char === ";" && !stack.length) return input.slice(start, index).trim();
    if (char === "\n" && !stack.length && input.slice(start, index).trim()) {
      return input.slice(start, index).trim();
    }
  }
  return input.slice(start).replace(/;\s*$/, "").trim();
}

/**
 * Some valid Legado request scripts return `url + JSON.stringify(options)`
 * instead of assigning `url` first. The client can execute that form, so the
 * verifier must evaluate the same portable subset rather than treating it as
 * an empty search target. No arbitrary script is executed here: the evaluator
 * rejects unknown identifiers, calls and side effects.
 */
function evaluatedReturnedRequestOptions(requestInfo, {
  keyWord = "小说",
  pageIndex = 1,
  filter = "",
} = {}) {
  const source = String(requestInfo || "").replace(/^@js:\s*/i, "");
  const variables = portableRequestVariables(source, { keyWord, pageIndex, filter });
  const returns = [...source.matchAll(/\breturn\s+/g)];
  for (let index = returns.length - 1; index >= 0; index -= 1) {
    const start = (returns[index].index || 0) + returns[index][0].length;
    const expression = returnedExpression(source, start);
    const value = portableValueExpression(expression, { keyWord, pageIndex, filter, variables });
    if (!value || (typeof value !== "string" && (typeof value !== "object" || Array.isArray(value)))) continue;
    const request = typeof value === "string" ? splitReturnedRequest(value) : {
      url: String(value.url || value.uri || "").trim(),
      options: value,
    };
    if (!request.url) continue;
    const options = request.options || {};
    const method = String(options.method || (options.POST ? "POST" : "GET")).toUpperCase();
    const headers = options.headers || options.httpHeaders || {};
    const params = options.body && typeof options.body === "object"
      ? options.body
      : options.httpParams && typeof options.httpParams === "object"
        ? options.httpParams
        : null;
    return {
      method,
      params,
      body: options.body,
      headers: headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {},
      url: request.url,
    };
  }
  return null;
}

function requestOptionsForVerification(requestInfo, options = {}) {
  const generated = generatedRequestOptions(requestInfo, options);
  if (generated?.url) return generated;
  return evaluatedReturnedRequestOptions(requestInfo, options) || generated;
}

/**
 * Resolve the upstream page URL embedded in a bridged or plain requestInfo.
 * Supports literal templates and the `@js` wrappers that only substitute page/filter.
 */
export function resolveBookTargetUrl(action, bridge, {
  keyWord = "小说",
  pageIndex = 1,
  filter = "",
} = {}) {
  if (!bridge) return "";
  const requestInfo = String(bridge.requestInfo || action?.requestInfo || "").trim();
  const host = bridge.plan?.host || action?.host || "";

  if (/^@js:/i.test(requestInfo)) {
    const generatedRequest = requestOptionsForVerification(requestInfo, { keyWord, pageIndex, filter });
    if (generatedRequest) {
      const expression = assignedExpression(requestInfo, "url");
      const target = generatedRequest.url || portableUrlExpression(expression, { host, keyWord, pageIndex });
      if (!target) return "";
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    const literal = requestInfo.match(/var\s+u\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/);
    if (literal) {
      let target = "";
      try {
        target = JSON.parse(literal[1].replace(/^'/, '"').replace(/'$/, '"'));
      } catch {
        try { target = Function(`return (${literal[1]})`)(); } catch { return ""; }
      }
      target = String(target || "")
        .replace(/%@pageIndex/g, String(pageIndex))
        .replace(/%@offset/g, "0")
        .replace(/%@keyWord/g, encodeURIComponent(keyWord))
        .replace(/%@filter/g, filter || firstRequestFilter(action));
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    const filterJs = requestInfo.match(/params\.filters[\s\S]{0,200}?return\s+String\(f\)/);
    if (filterJs) {
      const value = filter || firstRequestFilter(action);
      if (!value) return "";
      const target = String(value).replace(/__READ2XSGG_PAGE__/g, String(pageIndex));
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    if (/\/adapter\/books\?plan=[A-Za-z0-9_-]+[\s\S]*?&url=/.test(requestInfo)
      && /encodeURIComponent\(u\)/.test(requestInfo)) {
      const expression = assignedExpression(requestInfo, "url");
      const target = portableUrlExpression(expression, { host, keyWord, pageIndex });
      if (!target) return "";
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    // Never interpret the JavaScript following an adapter's literal `&url=`
    // as an upstream address. Unknown scripts must go through generic repair.
    return "";
  }

  const marker = "&url=";
  const index = requestInfo.indexOf(marker);
  const embedded = index >= 0;
  let target = (embedded ? requestInfo.slice(index + marker.length) : requestInfo)
    .replace(/^@js:[\s\S]*$/i, "")
    .replaceAll("%@filter", filter || firstRequestFilter(action))
    .replaceAll("%@pageIndex", String(pageIndex))
    .replaceAll("%@offset", "0")
    .replaceAll("%@keyWord", encodeURIComponent(keyWord));
  if (!target || /%@|\{\{|<[^>]*>|^@js:/i.test(target)) return "";
  if (embedded) {
    try { target = decodeURIComponent(target); } catch { return ""; }
  }
  try { return new URL(target, host).toString(); } catch { return ""; }
}

export function resolveBookTargetRequest(source, action, bridge, {
  keyWord = "小说",
  pageIndex = 1,
  filter = "",
} = {}) {
  const url = resolveBookTargetUrl(action, bridge, { keyWord, pageIndex, filter });
  if (!url) return null;
  const generated = requestOptionsForVerification(
    bridge?.requestInfo || action?.requestInfo,
    { keyWord, pageIndex, filter },
  );
  const headers = { ...actionHeaders(source, action), ...(generated?.headers || {}) };
  if (!generated || generated.method !== "POST") return { url, headers, options: {} };
  const contentType = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
  let body;
  if (generated.body !== undefined) {
    body = /application\/json/i.test(String(contentType))
      ? (typeof generated.body === "string" ? generated.body : JSON.stringify(generated.body))
      : (typeof generated.body === "string" ? generated.body : encodeFormBody(generated.body || {}, action));
  } else {
    body = /application\/json/i.test(String(contentType))
      ? JSON.stringify(generated.params || {})
      : encodeFormBody(generated.params || {}, action);
  }
  if (!contentType) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return {
    url,
    headers,
    options: { method: "POST", body, followPostRedirects: true },
  };
}

export function resolveBookTargetUrls(source, {
  keyWord = "",
  pageIndex = 1,
  limit = 4,
} = {}) {
  const urls = [];
  const seen = new Set();
  const actions = [
    ...Object.values(source?.bookWorld || {}).map((action) => ({ action, kind: "bookWorld" })),
    ...(source?.searchBook ? [{ action: source.searchBook, kind: "searchBook" }] : []),
  ];
  for (const { action, kind } of actions) {
    const bridge = executableBookAction(source, action);
    const actionKeyWord = String(action?._verifyKeyWord || (
      kind === "searchBook" ? (keyWord || defaultSearchKeyword(source?.sourceType)) : ""
    ));
    const target = resolveBookTargetUrl(action, bridge, { keyWord: actionKeyWord, pageIndex });
    if (!target || seen.has(target)) continue;
    try {
      const parsed = new URL(target);
      const sourceOrigin = new URL(source?.sourceUrl || source?.host || action?.host || target).origin;
      if (parsed.origin !== sourceOrigin) continue;
      seen.add(target);
      urls.push(target);
      if (urls.length >= limit) break;
    } catch {
      // Ignore malformed or cross-origin repair seeds.
    }
  }
  return urls;
}

export function resolveBookTargetRequests(source, {
  keyWord = "",
  pageIndex = 1,
  limit = 4,
} = {}) {
  const requests = [];
  const seen = new Set();
  const actions = [
    ...Object.entries(source?.bookWorld || {}).map(([actionName, action]) => ({
      action,
      actionName,
      section: "bookWorld",
    })),
    ...(source?.searchBook ? [{ action: source.searchBook, actionName: "", section: "searchBook" }] : []),
  ];
  for (const actionInfo of actions) {
    const { action, actionName, section } = actionInfo;
    const bridge = executableBookAction(source, action);
    const actionKeyWord = String(action?._verifyKeyWord || (
      section === "searchBook" ? (keyWord || defaultSearchKeyword(source?.sourceType)) : ""
    ));
    const request = resolveBookTargetRequest(source, action, bridge, {
      keyWord: actionKeyWord,
      pageIndex,
    });
    if (!request) continue;
    const key = requestIdentity(request, { includeRequestInfo: true });
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      ...request,
      action,
      actionName,
      section,
      requestInfo: /\/adapter\/books\?/i.test(String(action?.requestInfo || ""))
        ? ""
        : String(action?.requestInfo || ""),
    });
    if (requests.length >= limit) break;
  }
  return requests;
}

export function chapterPageCandidates(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return [];
  }
  const candidates = [parsed.toString()];
  if (/(?:^|\/)api\//i.test(parsed.pathname)) {
    const page = new URL(parsed);
    page.pathname = page.pathname.replace(/(^|\/)api\//i, "$1");
    page.search = "";
    page.hash = "";
    if (!candidates.includes(page.toString())) candidates.push(page.toString());
  }
  return candidates;
}

export function extractBookIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const page = new URL(raw);
    return page.searchParams.get("bookId")
      || page.searchParams.get("book_id")
      || page.searchParams.get("albumId")
      || page.searchParams.get("album_id")
      || page.searchParams.get("itemId")
      || page.searchParams.get("item_id")
      || page.searchParams.get("id")
      || (page.pathname.match(/\/(?:book|album|comic)\/(\d+)/i)?.[1] || "")
      || (page.pathname.match(/\/(\d+)(?:\/|$)/)?.[1] || "")
      || "";
  } catch {
    return raw.match(/[?&](?:book_?id|album_?id|item_?id|id)=(\d+)/i)?.[1] || "";
  }
}

/**
 * Resolve upstream TOC URLs for chapterList.requestInfo.
 * JSON API toc (e.g. getBookMenu?bookId=) is compiled to @js that builds the
 * menu URL from the detail page; verify must fetch that menu, not the detail JSON.
 */
export function resolveChapterListUrls(requestInfo, bookUrl, { pageIndex = 1 } = {}) {
  const source = String(requestInfo || "");
  const candidates = [];
  const seen = new Set();
  const push = (url) => {
    const value = String(url || "").trim();
    if (!value || !/^https?:\/\//i.test(value) || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  const bookId = extractBookIdFromUrl(bookUrl);
  const page = String(pageIndex || 1);
  let transformedTocUrl = "";
  if (/\/\*\s*read2xsgg:chapter-toc-url\s*\*\//.test(source)) {
    const expression = assignedExpression(source, "url");
    const transformed = portableUrlExpression(expression, {
      host: (() => { try { return new URL(bookUrl).origin; } catch { return ""; } })(),
      pageIndex,
      result: bookUrl,
      baseUrl: bookUrl,
    });
    if (transformed) {
      try { transformedTocUrl = new URL(transformed, bookUrl).toString(); } catch { /* ignore invalid result */ }
    }
  }
  const templateMatch = source.match(/var\s+url\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/);
  if (templateMatch && bookId && /__ID__/.test(templateMatch[1])) {
    try {
      const literal = templateMatch[1].startsWith("'")
        ? templateMatch[1].slice(1, -1).replace(/\\'/g, "'")
        : JSON.parse(templateMatch[1]);
      push(
        String(literal)
          .split("__ID__").join(encodeURIComponent(bookId))
          .split("__PAGE__").join(encodeURIComponent(page)),
      );
    } catch {
      // Fall through to detail-page candidates.
    }
  }

  // A generated adapter wrapper may still contain the original upstream
  // `var url` template. Prefer that direct menu request for verification, but
  // keep the adapter candidate for sources that have no portable upstream URL.
  const adapterChapter = source.match(
    /("(?:\\.|[^"\\])*\/adapter\/(?:chapters|toc|single-chapter|media-playlist|episode-list)\?[^"\\]*?url=")/i,
  );
  if (adapterChapter) {
    try {
      const prefix = JSON.parse(adapterChapter[1])
        .replace(/__PAGE__/g, page)
        .replace(/%@pageIndex/g, page)
        .replace(/%@offset/g, String(Math.max(0, Number(page) - 1)));
      push(`${prefix}${encodeURIComponent(transformedTocUrl || bookUrl)}`);
    } catch {
      // Fall through to ordinary chapter candidates.
    }
  }

  if (transformedTocUrl) push(transformedTocUrl);

  const regexRewrite = source.match(
    /return\s+u\.replace\(new RegExp\(("(?:\\.|[^"\\])*")\),\s*("(?:\\.|[^"\\])*")\);/,
  );
  if (regexRewrite) {
    try {
      const pattern = JSON.parse(regexRewrite[1]);
      const replacement = JSON.parse(regexRewrite[2]);
      push(String(bookUrl).replace(new RegExp(pattern), replacement));
    } catch {
      // Fall through to detail-page candidates.
    }
  }

  // Plain absolute menu URL embedded in requestInfo (rare offline shape).
  const absoluteMenu = source.match(/https?:\/\/[^\s"'\\]+(?:getBookMenu|getAlbumMenu|chapterList|toc)[^\s"'\\]*/i);
  if (absoluteMenu && bookId && !/\/adapter\/|__ID__|%@|\{\{/.test(absoluteMenu[0])) {
    push(absoluteMenu[0].replace(/([?&](?:book_?id|album_?id|item_?id|id)=)[^&]*/i, `$1${encodeURIComponent(bookId)}`)
      .replace(/([?&](?:pageNum|pageIndex|page)=)[^&]*/i, `$1${encodeURIComponent(page)}`));
  }

  if (/read2xsgg:\s*strip-api-path/i.test(source)) {
    for (const candidate of chapterPageCandidates(bookUrl).slice(1)) push(candidate);
  }
  push(bookUrl);
  return candidates;
}

function upstreamSectionsFromMenuBody(text) {
  try {
    const json = JSON.parse(String(text || ""));
    const value = Number(json.sections ?? json.data?.sections ?? json.total ?? json.data?.total);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function valuePresent(value) {
  if (Array.isArray(value)) return value.some(valuePresent);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return String(value ?? "").trim() !== "";
}

function sampledElementValue(value) {
  const raw = Array.isArray(value) ? value.find(valuePresent) : value;
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function semanticText(value) {
  return sampledElementValue(value)
    .replace(/^[\p{Cf}\p{Co}\p{Sk}\p{So}\s]+/u, "")
    .trim();
}

function recommendedElementPresent(field, value) {
  if (!valuePresent(value)) return false;
  const text = sampledElementValue(value);
  if (field === "cover") {
    return /^(?:https?:)?\/\//i.test(text) && usableCoverUrl(text);
  }
  if (field === "author") {
    return /[\p{L}\p{N}]/u.test(text)
      && text.length <= 50
      && !/^(?:未知|不詳|不详|佚名|unknown|anonymous|n\/a|null)$/i.test(text)
      && !/(?:作者福利|发布小说|作品集|请勿转载|未经.*许可|来源|点击|更新时间|字数|登录|注册|\d{4}[-/]\d{1,2})/i.test(text);
  }
  if (field === "cat") {
    return /[\p{L}\p{N}]/u.test(text)
      && text.length <= 40
      && !isDateOnlyMetadata(text)
      && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/i.test(text)
      && !/(?:收藏到|以下分[類类]|作品信息|返回[首頁页]|^(?:首頁|首页)$|登[錄录]|註冊|注册|取消|確定|确定|排行榜|(?:最後|最后|最近|最新|更新)?(?:更新|時間|时间)\s*[:：]|字[數数]\s*[:：]|人氣\s*[:：]|人气\s*[:：]|第.{0,24}[章節节回話话集卷])/i.test(text);
  }
  if (field === "lastChapterTitle") {
    const semantic = semanticText(text);
    return !isDateOnlyMetadata(semantic)
      && !/^(?:最新更新|最新章[節节]|更新至|最新)$/i.test(semantic)
      && !/^(?:返回頂部|返回顶部|回到頂部|回到顶部|回頂部|回顶部|置頂|置顶|首頁|首页|目錄|目录|開始閱讀|开始阅读|立即閱讀|立即阅读|點擊閱讀|点击阅读|上一[章節节頁页]?|下一[章節节頁页]?|加載更多|加载更多|聯絡我們|联系我们|關於我們|关于我们)\s*[↑⇧▲]?$/i.test(semantic);
  }
  return true;
}

function underlyingAdapterUrl(value) {
  let current = String(value || "").trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = new URL(current);
      const nested = parsed.searchParams.get("url") || parsed.searchParams.get("u");
      if (!nested || !/^https?:\/\//i.test(nested)) break;
      current = nested;
    } catch {
      break;
    }
  }
  return current;
}

export function usableComicPageUrl(value, cover = "") {
  const original = String(value || "").trim();
  if (!/^https?:\/\//i.test(original)) return false;
  const target = underlyingAdapterUrl(original);
  const coverTarget = underlyingAdapterUrl(cover);
  if (coverTarget) {
    const identity = (url) => String(url || "")
      .replace(/[?#].*$/, "")
      .replace(/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i, "");
    if (identity(target) === identity(coverTarget)) return false;
  }
  let parsed;
  try { parsed = new URL(target); } catch { return false; }
  if (!parsed.pathname || parsed.pathname === "/") return false;
  const identity = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  if (/(?:^|[\/_.-])(?:logo|icon|avatar|cover|copyright|banquan|disclaimer|notice|default|loading|placeholder|no[_-]?img|nopic|mascot|status|float[a-z0-9_-]*|cross|banner|guide|sprite|qrcode|qr-code)(?:[\/_.-]|$)/i.test(identity)) {
    return false;
  }
  const fileStem = (parsed.pathname.split("/").pop() || "")
    .replace(/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const hostLabels = parsed.hostname.toLowerCase().split(".")
    .filter((label) => label.length >= 4 && !/^(?:www\d*|static|assets?|images?|img|media|cdn\d*)$/.test(label));
  if (fileStem && hostLabels.includes(fileStem)) return false;
  if (!/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i.test(target)
    && /(?:^|\/)(?:watch|track|pixel|analytics|beacon)(?:\/|$)/i.test(parsed.pathname)) {
    return false;
  }
  return true;
}

export function usableComicContentReport(report, cover = "") {
  if (!report?.firstUrl) return false;
  let firstUrl = report.firstUrl;
  if (!/^https?:\/\//i.test(String(firstUrl))) {
    try {
      firstUrl = new URL(String(firstUrl), String(report.requestUrl || "")).toString();
    } catch {
      return false;
    }
  }
  if (!usableComicPageUrl(firstUrl, cover)) return false;
  return !(Number(report.itemCount) <= 1
    && /(?:^|[\/_-])(?:thumb(?:nail)?|small)(?:[\/_\-.]|$)/i.test(
      underlyingAdapterUrl(firstUrl),
    ));
}

async function comicImageRequestWorks(report, download, timeoutMs, signal) {
  if (!usableComicContentReport(report) || typeof download !== "function") return false;
  const response = await downloadAsFetch(download)(report.firstUrl, {
    method: "GET",
    headers: report.httpHeaders || {},
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return false;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  return contentType.startsWith("image/");
}

function requiredElementPresent(field, value) {
  if (!valuePresent(value)) return false;
  const text = sampledElementValue(value);
  if (field === "url") return /^https?:\/\//i.test(text);
  return text.length <= 160
    && !/^第\s*[\d一二三四五六七八九十百千零〇兩两]+\s*[章節节回話话集卷](?:\s*(?:完|終|终|end))?$/i.test(text)
    && !/^第.{0,24}[章節节回話话集卷](?:\s|：|:|[-—])+/i.test(text)
    && !/^(?:(?:在線|在线)?(?:書庫|书库|小說庫|小说库|小說網|小说网|漫畫網|漫画网|有聲網|有声网)|(?:VIP|免費|免费|付費|付费|熱門|热门|最新)?(?:小說|小说|漫畫|漫画|聽書|听书|視頻|视频|影視|影视)|網站首頁|网站首页|全部|全站|全部(?:小說|小说|漫畫|漫画|作品)|(?:周|月|總|总)(?:點擊|点击|鮮花|鲜花|收藏|字數|字数|下載|下载))$/i.test(text)
    && !/(?:^|\s)第.{0,24}[章节回话集卷].*(?:作者|来源|点击|\d{4}[-/]\d{1,2})/i.test(text)
    && !/^(?:首頁|首页|(?:返回|回到)(?:網站|网站)?(?:(?:首頁|首页)|主[頁页]|目[錄录])?|登[錄录]|註冊|注册|下一[頁页]|上一[頁页]|聯絡我們|联系我们|關於我們|关于我们)$/i.test(text);
}

export function usableChapterRow(item) {
  if (!item?.url || !item?.title || !/^https?:\/\//i.test(String(item.url))) return false;
  const title = semanticText(item.title);
  return Boolean(title)
    && !/^(?:(?:查看|檢視|检视|顯示|显示|展開|展开)?(?:全部|所有)?(?:章[節节]|目[錄录])|全部|點擊閱讀|点击阅读|開始閱讀|开始阅读|立即閱讀|立即阅读|回頂部|回顶部|返回頂部|返回顶部|(?:返回|回到)(?:網站|网站)?(?:(?:首頁|首页)|主[頁页]|目[錄录])?|返回(?:電腦版|电脑版|桌面版|手機版|手机版)?|首頁|首页|目錄|目录|上一[章節节頁页]?|下一[章節节頁页]?|加載更多|加载更多|聯絡我們|联系我们|關於我們|关于我们)$/i.test(title);
}

export function chapterUrlLooksLikeBookSibling(bookUrl, chapter) {
  let book;
  let target;
  try {
    book = new URL(String(bookUrl || ""));
    target = new URL(String(chapter?.url || ""), book);
  } catch {
    return false;
  }
  if (book.origin !== target.origin) return false;
  const bookPath = book.pathname.replace(/\/+$/, "") || "/";
  const targetPath = target.pathname.replace(/\/+$/, "") || "/";
  if (bookPath === targetPath) return true;
  const routeShape = (value) => value.replace(/\d+/g, ":id");
  if (routeShape(bookPath) !== routeShape(targetPath)) return false;
  const title = sampledElementValue(chapter?.title);
  return !/(?:第\s*.{0,24}[章節节回話话集卷]|\d+\s*[章節节回話话集卷]|番外|序章|終章|终章|episode|chapter)/i.test(title);
}

function comparableElementValue(value) {
  return sampledElementValue(value).replace(/[\s·・|｜:：,，/\\_-]+/g, "").toLowerCase();
}

export function bookElementReport(book) {
  const required = ["name", "url"];
  const recommended = ["cover", "author", "cat", "lastChapterTitle"];
  const category = comparableElementValue(book?.cat);
  const categoryDuplicates = category && [book?.name, book?.author, book?.lastChapterTitle]
    .some((value) => category === comparableElementValue(value));
  const recommendedValid = (field) => recommendedElementPresent(field, book?.[field])
    && (field !== "cat" || !categoryDuplicates);
  const missingRequired = required.filter((field) => !requiredElementPresent(field, book?.[field]));
  const missingRecommended = recommended.filter((field) => !recommendedValid(field));
  const values = Object.fromEntries([...required, ...recommended]
    .filter((field) => valuePresent(book?.[field]))
    .map((field) => [field, sampledElementValue(book[field])]));
  return {
    missingRequired,
    missingRecommended,
    present: [
      ...required.filter((field) => requiredElementPresent(field, book?.[field])),
      ...recommended.filter(recommendedValid),
    ],
    values,
  };
}

function chapterRowSignature(row) {
  if (!row || typeof row !== "object") return "";
  return [row.title || row.name || "", row.url || ""]
    .map((value) => String(value || "").trim().slice(0, 200))
    .join("|");
}

function chapterRowsMostlySame(leftRows, rightRows) {
  const left = (Array.isArray(leftRows) ? leftRows : [])
    .map(chapterRowSignature).filter(Boolean).slice(0, 50);
  const right = (Array.isArray(rightRows) ? rightRows : [])
    .map(chapterRowSignature).filter(Boolean).slice(0, 50);
  if (!left.length || !right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const signature of rightSet) {
    if (leftSet.has(signature)) overlap += 1;
  }
  return overlap >= Math.min(leftSet.size, rightSet.size);
}

async function fetchChapterPage(plan, targetUrl, download, { limit = 50, offset = 0 } = {}) {
  const page = await download(targetUrl, plan.headers || {});
  const responseUrl = String(page?.read2xsggResponseUrl || targetUrl);
  const text = decodeTextBuffer(page, {
    headers: page.httpHeaders || {},
    charsetHint: plan.charset || "",
  });
  if (plan.tocSelector) {
    const tocUrl = bridgeTocUrl(text, responseUrl, plan);
    if (tocUrl) {
      try {
        const tocPage = await download(tocUrl, plan.headers || {});
        const output = executeBridgePlan(decodeTextBuffer(tocPage, {
          headers: tocPage.httpHeaders || {},
          charsetHint: plan.charset || "",
        }), tocUrl, plan, { limit, offset });
        if (Array.isArray(output.data) && output.data.length) {
        return {
          output,
          responseUrl: String(tocPage.read2xsggResponseUrl || tocUrl),
          upstreamSections: upstreamSectionsFromMenuBody(text),
          pageCount: output.data.length,
        };
        }
      } catch {
        // Fall through to direct page parsing.
      }
    }
  }
  const output = executeBridgePlan(text, responseUrl, plan, { limit, offset });
  return {
    output,
    responseUrl,
    upstreamSections: upstreamSectionsFromMenuBody(text),
    pageCount: Array.isArray(output.data) ? output.data.length : 0,
  };
}

function resolveContextualChapterRows(source, rows, responseUrl, book) {
  const rule = String(source?.chapterList?.url || "");
  if (!rule.includes(CONTEXTUAL_CHAPTER_URL_MARKER)) return rows;
  const queryInfo = {
    ...(book && typeof book === "object" ? book : {}),
    detailUrl: String(book?.url || ""),
    url: String(book?.url || ""),
    chapterUrl: String(book?.url || ""),
    bookName: String(book?.name || ""),
  };
  const config = {
    host: String(source?.chapterList?.host || source?.sourceUrl || book?.url || ""),
  };
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== "object") return row;
    try {
      const value = executeXbsJavaScriptRule(rule, {
        config,
        params: { responseUrl: String(responseUrl || ""), queryInfo },
        result: row,
      });
      row.url = typeof value === "string" || typeof value === "number"
        ? String(value).trim()
        : String(value?.url || "").trim();
    } catch {
      row.url = "";
    }
    return row;
  });
}

async function executeDeclarativeUrl(plan, targetUrl, download, {
  chapters = false,
  limit = 3,
  requestHeaders = {},
  requestOptions = {},
} = {}) {
  const page = await download(
    targetUrl,
    refreshEphemeralHeaders({ ...(plan.headers || {}), ...requestHeaders }),
    requestOptions,
  );
  const responseUrl = String(page?.read2xsggResponseUrl || targetUrl);
  const text = decodeTextBuffer(page, {
    headers: page.httpHeaders || {},
    charsetHint: plan.charset || "",
  });
  if (chapters && plan.tocSelector) {
    const tocUrl = bridgeTocUrl(text, responseUrl, plan);
    if (tocUrl) {
      try {
        const tocPage = await download(tocUrl, refreshEphemeralHeaders(plan.headers || {}));
        const output = executeBridgePlan(decodeTextBuffer(tocPage, {
          headers: tocPage.httpHeaders || {},
          charsetHint: plan.charset || "",
        }), tocUrl, plan, { limit });
        if (Array.isArray(output.data) && output.data.length) return output;
      } catch {
        // Fall through to detail page chapters.
      }
    }
  }
  return executeBridgePlan(text, responseUrl, plan, { limit });
}

/**
 * Light verification: at least one book from category/search, then at least one chapter.
 * When the first TOC page is full (pageSize), also spot-check page 2 so paged
 * JSON menus like getBookMenu are not mistaken for single-chapter books.
 */
async function verifyConvertedSourceOnce(source, {
  download,
  keyWord = "",
  timeoutMs = 3_000,
  signal,
  onStage,
  requireBookWorld = false,
} = {}) {
  if (typeof download !== "function") {
    return { ok: false, reason: "rules-stale: empty-list", detail: "缺少下载器" };
  }
  const timedDownload = (url, headers = {}, options = {}) => withTimeoutSignal(
    signal,
    timeoutMs,
    (requestSignal) => download(url, headers, { ...options, signal: requestSignal }),
  );
  const markStage = (stage) => {
    try {
      onStage?.(stage);
    } catch {
      // Diagnostic callbacks must not affect verification.
    }
  };

  const worlds = [
    ...Object.entries(source?.bookWorld || {}).map(([name, action]) => ({
      action,
      kind: "bookWorld",
      name,
    })),
    ...(source?.searchBook ? [{ action: source.searchBook, kind: "searchBook", name: "搜索" }] : []),
  ];
  const hasExecutableBookWorld = worlds.some((entry) => {
    if (entry.kind !== "bookWorld") return false;
    const bridge = executableBookAction(source, entry.action);
    if (!bridge) return false;
    const actionKeyWord = String(entry.action?._verifyKeyWord || keyWord || "");
    return Boolean(resolveBookTargetRequest(source, entry.action, bridge, { keyWord: actionKeyWord }));
  });
  const defaultKeyWord = ({ comic: "漫画", audio: "广播剧", video: "视频" })[source?.sourceType] || "小说";
  let lastDetail = "";
  let lastFailure = null;
  let lastFailureRank = -1;
  let listRequestCount = 0;
  let listTimeoutCount = 0;
  let lastListTimeout = "";
  const failureRank = (reason) => {
    if (/empty-content/i.test(String(reason || ""))) return 4;
    if (/empty-toc/i.test(String(reason || ""))) return 3;
    if (/invalid-elements/i.test(String(reason || ""))) return 2;
    if (/empty-list/i.test(String(reason || ""))) return 1;
    return 0;
  };
  const rememberFailure = (reason, detail, extra = {}) => {
    const message = String(detail || "");
    lastDetail = message;
    const rank = failureRank(reason);
    // Trying multiple category/search entrances should not hide a deeper
    // failure from an earlier entrance.  For example, a category can reach a
    // book but have an empty comic body while the search URL itself is
    // temporarily empty; the content failure is the actionable repair stage.
    if (rank >= lastFailureRank) {
      lastFailureRank = rank;
      lastFailure = { ok: false, reason, detail: message, ...extra };
    }
  };
  for (const entry of worlds) {
    const { action, kind } = entry;
    // Browse/category and search are separate client capabilities. In strict
    // converter verification, search is never a substitute for bookWorld —
    // including when the source has no usable category entry at all.
    if (requireBookWorld && kind !== "bookWorld") continue;
    // Xiangse browse/category actions run without an implicit search query.
    // Injecting “小说/漫画/视频” into every bookWorld request made a search
    // endpoint masquerading as a category look healthy in verification, even
    // though the normal browse list returned zero. Only searchBook receives
    // the type-specific probe keyword unless the caller explicitly supplies
    // one for a bookWorld action.
    const actionKeyWord = String(
      action?._verifyKeyWord || keyWord || (kind === "searchBook" ? defaultKeyWord : ""),
    );
    const bookBridge = executableBookAction(source, action);
    if (!bookBridge) continue;
    const target = resolveBookTargetRequest(source, action, bookBridge, { keyWord: actionKeyWord });
    if (!target) continue;
    const targetUrl = target.url;
    let listResponseReceived = false;
    listRequestCount += 1;
    try {
      markStage("list");
      const bookPageSize = Math.min(200, Math.max(1, Number(action?.moreKeys?.pageSize) || 20));
      const books = await executeDeclarativeUrl(bookBridge.plan, targetUrl, timedDownload, {
        limit: Math.max(3, bookPageSize),
        requestHeaders: target.headers,
        requestOptions: target.options,
      });
      listResponseReceived = true;
      const page1Books = Array.isArray(books.data) ? books.data : [];
      const book = (books.data || []).find((item) => (
        item?.url && requiredElementPresent("name", item?.name) && requiredElementPresent("url", item?.url)
      ));
      if (!book) {
        rememberFailure("rules-stale: empty-list", "分类/搜索列表为空或无法抽测");
        continue;
      }
      let bookPage2Count = 0;
      if (page1Books.length >= bookPageSize && Number(action?.moreKeys?.maxPage) !== 1) {
        const secondTarget = resolveBookTargetRequest(source, action, bookBridge, { keyWord: actionKeyWord, pageIndex: 2 });
        if (secondTarget && secondTarget.url !== targetUrl) {
          markStage("list-page-2");
          const secondBooks = await executeDeclarativeUrl(bookBridge.plan, secondTarget.url, timedDownload, {
            limit: Math.max(3, bookPageSize),
            requestHeaders: secondTarget.headers,
            requestOptions: secondTarget.options,
          });
          const page2Books = Array.isArray(secondBooks.data) ? secondBooks.data : [];
          bookPage2Count = page2Books.length;
          if (bookPage2Count && chapterRowsMostlySame(page1Books, page2Books)) {
            rememberFailure(
              "rules-stale: empty-list",
              "书籍列表第 2 页与第 1 页重复，翻页无效",
              { bookUrl: book.url },
            );
            continue;
          }
        }
      }
      lastDetail = book.url;
      let detail = {};
      const detailBridge = executableDetailAction(source);
      if (detailBridge) {
        try {
          markStage("detail");
          detail = await executeDeclarativeUrl(detailBridge.plan, book.url, timedDownload, { limit: 1 });
          if (detailBridge.plan.latestChapter) {
            const adapterUrl = generatedAdapterUrl(detailBridge.requestInfo, "detail", book.url);
            if (adapterUrl) {
              const adapterPage = await timedDownload(adapterUrl, actionHeaders(source, source?.bookDetail));
              const adapterDetail = JSON.parse(decodeTextBuffer(adapterPage, {
                headers: adapterPage.httpHeaders || {},
              }));
              if (adapterDetail && typeof adapterDetail === "object" && !Array.isArray(adapterDetail)) {
                detail = { ...detail, ...adapterDetail };
              }
            }
          }
        } catch (error) {
          throwIfRequestTimedOut(error, signal);
          // Some detail actions use a separate API request that cannot be
          // reconstructed from the list URL. The catalogue may still live on it.
        }
      }
      const mergedBook = { ...book };
      for (const [field, value] of Object.entries(detail || {})) {
        if (!valuePresent(value)) continue;
        if (["name", "url"].includes(field) && requiredElementPresent(field, mergedBook[field])) continue;
        if (["cover", "author", "cat", "lastChapterTitle"].includes(field)
          && recommendedElementPresent(field, mergedBook[field])
          && !recommendedElementPresent(field, value)) continue;
        mergedBook[field] = value;
      }
      let bookElements = bookElementReport(mergedBook);
      const derivedRecommended = [];
      if (bookElements.missingRequired.length) {
        rememberFailure(
          "rules-stale: invalid-elements",
          `书籍必要元素解析错误：${bookElements.missingRequired.join("、")}`,
          { bookUrl: book.url, bookElements },
        );
        continue;
      }
      const chapterBridge = executableChapterAction(source);
      if (!chapterBridge) {
        rememberFailure("rules-stale: empty-toc", "章节动作无法抽测", { bookUrl: book.url });
        continue;
      }
      const singlePageMediaChapter = ["audio", "video"].includes(String(source?.sourceType || ""))
        && /\/adapter\/single-chapter\?/i.test(String(chapterBridge.requestInfo || ""));
      const pageSize = Number(source?.chapterList?.moreKeys?.pageSize) > 0
        ? Number(source.chapterList.moreKeys.pageSize)
        : 50;
      const chapterLimit = Math.min(200, Math.max(pageSize, 2));
      let firstChapter = null;
      let page1Rows = [];
      let page1Count = 0;
      let page2Count = 0;
      let upstreamSections = 0;
      const locallySliced = /\/adapter\/chapters\?[\s\S]*?[?&]slice=1(?:[&"']|$)/i.test(
        String(chapterBridge.requestInfo || ""),
      );
      const firstPageUrls = [detail?.tocUrl, ...resolveChapterListUrls(
        chapterBridge.requestInfo,
        book.url,
        { pageIndex: 1 },
      )].filter(Boolean);
      for (const chapterPageUrl of [...new Set(firstPageUrls)]) {
        try {
          markStage("chapter-list");
          const page1 = await fetchChapterPage(
            chapterBridge.plan,
            chapterPageUrl,
            timedDownload,
            { limit: locallySliced ? chapterLimit + 1 : chapterLimit },
          );
          page1Count = locallySliced ? Math.min(page1.pageCount, pageSize) : page1.pageCount;
          upstreamSections = page1.upstreamSections;
          const resolvedRows = resolveContextualChapterRows(
            source,
            page1.output.data,
            page1.responseUrl,
            book,
          );
          page1.output.data = resolvedRows;
          page1Rows = resolvedRows.slice(0, pageSize);
          firstChapter = resolvedRows.find((row) => (
            usableChapterRow(row)
            && (singlePageMediaChapter || !chapterUrlLooksLikeBookSibling(book.url, row))
          ));
          if (firstChapter) {
            if (locallySliced && page1.pageCount > pageSize) {
              markStage("chapter-list-page-2");
              const page2 = await fetchChapterPage(
                chapterBridge.plan,
                chapterPageUrl,
                timedDownload,
                { limit: pageSize, offset: pageSize },
              );
              page2.output.data = resolveContextualChapterRows(
                source,
                page2.output.data,
                page2.responseUrl,
                book,
              );
              page2Count = page2.pageCount;
              if (page2Count && chapterRowsMostlySame(page1Rows, page2.output.data)) {
                rememberFailure(
                  "rules-stale: empty-toc",
                  "目录本地切片第 2 页与第 1 页重复，翻页无效",
                  { bookUrl: book.url },
                );
                continue;
              }
            }
            break;
          }
        } catch (error) {
          throwIfRequestTimedOut(error, signal);
          // Try next candidate.
        }
      }
      if (!firstChapter) {
        rememberFailure("rules-stale: empty-toc", "目录解析为空", { bookUrl: book.url });
        continue;
      }
      if (!recommendedElementPresent("lastChapterTitle", mergedBook.lastChapterTitle)) {
        const latestTitle = orderChaptersAscending(page1Rows, {
          reverseHint: Boolean(source?.chapterList?.reverseChapters || source?.chapterList?.reverse),
        }).at(-1)?.title || "";
        if (recommendedElementPresent("lastChapterTitle", latestTitle)) {
          mergedBook.lastChapterTitle = latestTitle;
          bookElements = bookElementReport(mergedBook);
          derivedRecommended.push("lastChapterTitle");
        }
      }
      const firstPageUrlSet = new Set(firstPageUrls);
      const secondPageUrls = resolveChapterListUrls(
        chapterBridge.requestInfo,
        book.url,
        { pageIndex: 2 },
      ).filter((url) => !firstPageUrlSet.has(url));
      if (!locallySliced && page1Count >= pageSize && secondPageUrls.length) {
        let duplicatePage = false;
        for (const chapterPageUrl of secondPageUrls) {
          try {
            markStage("chapter-list-page-2");
            const page2 = await fetchChapterPage(
              chapterBridge.plan,
              chapterPageUrl,
              timedDownload,
              { limit: chapterLimit },
            );
            page2.output.data = resolveContextualChapterRows(
              source,
              page2.output.data,
              page2.responseUrl,
              book,
            );
            page2Count = page2.pageCount;
            duplicatePage = chapterRowsMostlySame(page1Rows, page2.output.data);
            if (page2Count > 0) break;
          } catch (error) {
            throwIfRequestTimedOut(error, signal);
            // Try next candidate.
          }
        }
        if (page2Count && duplicatePage) {
          rememberFailure(
            "rules-stale: empty-toc",
            "目录第 2 页与第 1 页重复，翻页无效",
            { bookUrl: book.url },
          );
          continue;
        }
      }
      const webViewMedia = ["audio", "video"].includes(String(source?.sourceType || ""))
        && usesWebViewMediaAction(source?.chapterContent);
      let contentReport;
      if (webViewMedia) {
        try {
          const page = await timedDownload(
            firstChapter.url,
            actionHeaders(source, source?.chapterContent),
          );
          const pageText = decodeTextBuffer(page, {
            headers: page.httpHeaders || {},
            charsetHint: source?.chapterContent?.charset || "",
          });
          if (!String(pageText || "").trim()) throw new Error("WebView 章节页为空");
          contentReport = {
            ok: true,
            itemCount: 1,
            firstUrl: "",
            requestUrl: String(page.read2xsggResponseUrl || firstChapter.url),
            webView: true,
          };
        } catch (error) {
          throwIfRequestTimedOut(error, signal);
          contentReport = { ok: false, error: error?.message || String(error) };
        }
      } else {
        markStage("chapter-content");
        contentReport = await runXbsChapterContent(source, {
          bookName: book.name,
          detailUrl: book.url,
          chapterTitle: firstChapter.title,
          chapterUrl: firstChapter.url,
        }, {
          fetchImpl: downloadAsFetch(timedDownload),
          timeoutMs,
          signal,
        });
      }
      if (!contentReport.ok) {
        if (isRequestTimeout(new Error(contentReport.error || ""))) {
          throw new Error(contentReport.error || "章节正文请求超时");
        }
        rememberFailure(
          "rules-stale: empty-content",
          contentReport.error || "正文解析为空",
          { bookUrl: book.url, chapterUrl: firstChapter.url },
        );
        continue;
      }
      if (String(source?.sourceType || "") === "comic"
        && !usableComicContentReport(contentReport, mergedBook.cover)) {
        rememberFailure(
          "rules-stale: empty-content",
          "漫画正文解析到封面、站点界面或占位图片，而非漫画页",
          { bookUrl: book.url, chapterUrl: firstChapter.url },
        );
        continue;
      }
      if (String(source?.sourceType || "") === "comic") markStage("comic-image");
      if (String(source?.sourceType || "") === "comic"
        && !await comicImageRequestWorks(contentReport, timedDownload, timeoutMs, signal)) {
        rememberFailure(
          "rules-stale: empty-content",
          "漫画首张正文图片请求失败或返回非图片内容",
          { bookUrl: book.url, chapterUrl: firstChapter.url },
        );
        continue;
      }
      if (["audio", "video"].includes(String(source?.sourceType || "")) && contentReport.firstUrl) {
        markStage("media-url");
        const mediaFetch = downloadAsFetch(timedDownload);
        let mediaResponse = await mediaFetch(contentReport.firstUrl, {
          method: "HEAD",
          headers: contentReport.httpHeaders || {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!isPlayableMediaResponse(mediaResponse, contentReport.firstUrl)) {
          mediaResponse = await mediaFetch(contentReport.firstUrl, {
            method: "GET",
            headers: { ...(contentReport.httpHeaders || {}), Range: "bytes=0-4095" },
            signal: AbortSignal.timeout(timeoutMs),
          });
        }
        if (!isPlayableMediaResponse(mediaResponse, contentReport.firstUrl)) {
          const contentType = mediaResponse.headers?.get?.("content-type") || "unknown";
          rememberFailure(
            "rules-stale: empty-content",
            mediaResponse.ok
              ? `播放地址返回非媒体类型：${contentType}`
              : `播放地址请求失败：HTTP ${mediaResponse.status}`,
            { bookUrl: book.url, chapterUrl: firstChapter.url },
          );
          continue;
        }
      }
      return {
        ok: true,
        entryKind: kind,
        bookUrl: book.url,
        chapterUrl: firstChapter.url,
        bookName: book.name,
        chapterTitle: firstChapter.title,
        page1Count,
        page2Count,
        bookPage1Count: page1Books.length,
        bookPage2Count,
        upstreamSections,
        bookElements,
        derivedRecommended,
        content: contentReport,
      };
    } catch (error) {
      if (signal?.aborted) throwIfRequestTimedOut(error, signal);
      const detail = error.message || String(error);
      if (!listResponseReceived && isRequestTimeout(error)) {
        listTimeoutCount += 1;
        lastListTimeout = detail;
        rememberFailure("rules-stale: empty-list", `入口请求超时，继续尝试其它分类/搜索入口：${detail}`);
      } else {
        rememberFailure("rules-stale: empty-list", detail);
      }
    }
  }
  if (listRequestCount > 0 && listTimeoutCount === listRequestCount) {
    return {
      ok: false,
      reason: "rules-stale: source-timeout",
      detail: `全部 ${listRequestCount} 个分类/搜索入口请求均超时：${lastListTimeout}`,
    };
  }
  if (requireBookWorld && !hasExecutableBookWorld) {
    return {
      ok: false,
      reason: "rules-stale: empty-list",
      detail: "缺少可执行分类/浏览入口；搜索入口不能替代分类列表",
    };
  }
  if (requireBookWorld && hasExecutableBookWorld) {
    return {
      ...(lastFailure || {}),
      ok: false,
      reason: lastFailure?.reason || "rules-stale: empty-list",
      detail: lastFailure?.detail
        ? `分类/浏览入口未通过完整验证：${lastFailure.detail}`
        : "分类/浏览入口未通过完整验证；搜索入口不能替代分类列表",
    };
  }
  return lastFailure || {
    ok: false,
    reason: "rules-stale: empty-list",
    detail: lastDetail || "分类/搜索列表为空或无法抽测",
  };
}

async function verifyConvertedSourceWithin(source, options) {
  let primary = await verifyConvertedSourceOnce(source, options);
  const sourceActions = [
    ...Object.values(source?.bookWorld || {}),
    source?.searchBook,
  ].filter(Boolean);
  const hasExecutableBookAction = sourceActions.some((action) => executableBookAction(source, action));
  const retryableReasons = new Set([
    "rules-stale: empty-list",
    "rules-stale: empty-toc",
    "rules-stale: empty-content",
  ]);
  if (!primary.ok && retryableReasons.has(primary.reason) && options.retryEmptyList !== false) {
    const transientTransportFailure = /(?:HTTP\s+(?:408|425|429|5\d{2})|\b(?:ECONNABORTED|ECONNRESET|EAI_AGAIN|ENETUNREACH)\b|socket hang up|connection reset|temporarily unavailable|network is unreachable)/i
      .test(String(primary.detail || ""));
    // A busy upstream or a locally bridged adapter can return one transient
    // 5xx while the same rule is valid.  Keep ordinary rule failures to the
    // historical single retry, but allow a bounded second retry for transport
    // failures.  Never retry timeouts here: the caller's source budget should
    // be able to skip a blocked site promptly.
    const retryCount = transientTransportFailure ? 3 : 1;
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const delayMs = transientTransportFailure
        ? Math.min(2_000, 300 * (2 ** attempt))
        : 150;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const retried = await verifyConvertedSourceOnce(source, options);
      if (retried.ok) return { ...retried, retryRecovered: true, retryCount: attempt + 1 };
      if (retried.detail) primary = retried;
    }
  }
  const runtimeOnlyFallback = primary.reason === "rules-stale: empty-list"
    && Boolean(source?.searchBook)
    && !hasExecutableBookAction;
  const sharedFallbackBudget = options.runtimeFallbackBudget
    && typeof options.runtimeFallbackBudget === "object"
    ? options.runtimeFallbackBudget
    : null;
  const sharedRemainingMs = Number(sharedFallbackBudget?.remainingMs);
  if (primary.ok || (Number.isFinite(sharedRemainingMs) && sharedRemainingMs <= 0)
    || (!runtimeOnlyFallback
    && !["rules-stale: empty-toc", "rules-stale: empty-content"].includes(primary.reason))) {
    return primary;
  }
  const timeoutMs = options.timeoutMs || 3_000;
  const sourceTimeoutMs = Math.max(
    timeoutMs,
    Number(options.sourceTimeoutMs) || Math.max(12_000, timeoutMs * 4),
  );
  const configuredFallbackTimeoutMs = Number(options.runtimeFallbackTimeoutMs);
  const runtimeFallbackTimeoutMs = Math.min(
    sourceTimeoutMs,
    configuredFallbackTimeoutMs > 0
      ? configuredFallbackTimeoutMs
      : Math.min(45_000, sourceTimeoutMs),
    Number.isFinite(sharedRemainingMs) ? Math.max(1, sharedRemainingMs) : Number.POSITIVE_INFINITY,
  );
  const runtimeFallbackStartedAt = Date.now();
  try {
    try { options.onStage?.("xbs-runtime-fallback"); } catch { /* diagnostics only */ }
    const report = await withTimeoutSignal(
      options.signal,
      runtimeFallbackTimeoutMs,
      (signal) => runXbsPipeline(source, {
        fetchImpl: downloadAsFetch(options.download),
        timeoutMs,
        signal,
        maxBookCandidates: Math.max(3, Number(options.attemptedBookCandidates) || 8),
        maxChapterCandidates: Math.max(3, Number(options.attemptedChapterCandidates) || 10),
      }),
      "XBS_RUNTIME_FALLBACK_BUDGET",
    );
    if (!report.ok) throwIfRequestTimedOut(new Error(report.error || ""), options.signal);
    const attempted = Math.max(
      Number(report.attemptedCandidates) || 0,
      Number(report.attemptedChapterCandidates) || 0,
      Number(report.attemptedWorlds) || 0,
    );
    if (!report.ok || (!runtimeOnlyFallback && attempted <= 1)) return primary;
    if (!requiredElementPresent("name", report.steps?.bookWorld?.bookName)
      || !requiredElementPresent("url", report.steps?.bookWorld?.detailUrl)) return primary;
    const fallbackChapter = {
      title: report.steps?.chapterList?.chapterTitle || "",
      url: report.steps?.chapterList?.chapterUrl || "",
    };
    const singlePageMediaChapter = ["audio", "video"].includes(String(source?.sourceType || ""))
      && /\/adapter\/single-chapter\?/i.test(String(source?.chapterList?.requestInfo || ""));
    if (!usableChapterRow(fallbackChapter)
      || (!singlePageMediaChapter
        && chapterUrlLooksLikeBookSibling(report.steps?.bookWorld?.detailUrl, fallbackChapter))) return primary;
    const fallbackBook = {
      name: report.steps?.bookDetail?.name || report.steps?.bookWorld?.bookName || "",
      url: report.steps?.bookWorld?.detailUrl || "",
      cover: report.steps?.bookDetail?.cover || "",
      author: report.steps?.bookDetail?.author || "",
      cat: report.steps?.bookDetail?.cat || "",
      lastChapterTitle: report.steps?.bookDetail?.lastChapterTitle || "",
    };
    if (String(source?.sourceType || "") === "comic"
      && !usableComicContentReport(report.steps?.chapterContent, fallbackBook.cover)) return primary;
    if (String(source?.sourceType || "") === "comic"
      && !await comicImageRequestWorks(
        report.steps?.chapterContent,
        options.download,
        timeoutMs,
        options.signal,
      )) return primary;
    const pageSize = Number(source?.chapterList?.moreKeys?.pageSize) || 0;
    const chapterCount = Number(report.steps?.chapterList?.listCount) || 0;
    // A full page still requires the explicit page-2 check in the primary
    // verifier; do not let candidate fallback bypass pagination validation.
    if (pageSize > 0 && chapterCount >= pageSize) return primary;
    return {
      ok: true,
      bookUrl: report.steps?.bookWorld?.detailUrl || "",
      chapterUrl: report.steps?.chapterList?.chapterUrl || "",
      bookName: report.steps?.bookWorld?.bookName || "",
      chapterTitle: report.steps?.chapterList?.chapterTitle || "",
      page1Count: chapterCount,
      page2Count: 0,
      upstreamSections: 0,
      candidateFallback: attempted,
      bookElements: bookElementReport(fallbackBook),
      derivedRecommended: report.steps?.bookDetail?.derivedFields || [],
      content: report.steps?.chapterContent || {},
    };
  } catch (error) {
    // Exhausting the local candidate scan is not proof that the site is
    // blocked. Return the original actionable rule failure so the caller can
    // continue content repair and whole-site recognition within the remaining
    // per-source budget. A parent/source timeout and real request timeout still
    // propagate through the normal skip path.
    if (error?.code === "XBS_RUNTIME_FALLBACK_BUDGET" && !options.signal?.aborted) {
      return primary;
    }
    throwIfRequestTimedOut(error, options.signal);
    return primary;
  } finally {
    if (sharedFallbackBudget && Number.isFinite(sharedRemainingMs)) {
      sharedFallbackBudget.remainingMs = Math.max(
        0,
        sharedRemainingMs - (Date.now() - runtimeFallbackStartedAt),
      );
    }
  }
}

export async function verifyConvertedSource(source, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 3_000);
  const sourceTimeoutMs = Math.max(
    timeoutMs,
    Number(options.sourceTimeoutMs) || Math.max(12_000, timeoutMs * 4),
  );
  try {
    return await withTimeoutSignal(options.signal, sourceTimeoutMs, (signal) => (
      verifyConvertedSourceWithin(source, { ...options, timeoutMs, signal })
    ));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      ok: false,
      reason: "rules-stale: empty-list",
      detail: error?.message || String(error),
    };
  }
}

export async function verifyConvertedSources(sources, options = {}) {
  const entries = Object.entries(sources || {});
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const kept = {};
  const failed = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length || 1) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = entries[index];
      const result = await verifyConvertedSource(source, options);
      if (result.ok) kept[name] = source;
      else failed.push({ source: name, reason: result.reason, detail: result.detail, host: source?.host });
    }
  });
  if (entries.length) await Promise.all(workers);
  return { sources: kept, failed };
}
