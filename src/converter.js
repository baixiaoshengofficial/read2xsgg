import { convertRule, inferResponseType } from "./selectors.js";
import { convertRequest, parseHeaders, parseLooseJson } from "./requests.js";
import { detectLegadoCharset, xiangseEncodeFields } from "./charset.js";
import { adaptLegadoSource, bookDetailRequestInfoOverride, chapterListRequestInfoOverride } from "./siteAdapters.js";
import { decoderForLegadoImageRule } from "./imageDecoder.js";
import { compileComicExtractionPlan, encodeComicExtractionPlan } from "./comicPlan.js";
import {
  compileMediaExtractionPlan,
  encodeMediaExtractionPlan,
  mediaPlanHasResolution,
  mediaRuleNeedsPortabilityWarning,
  MEDIA_PORTABILITY_WARNING,
} from "./mediaPlan.js";
import { encodeCatalogPlan, normalizeCatalogPlan } from "./catalogPlan.js";
import { hasUnsupportedLegadoRuntime } from "./legadoJs.js";
import {
  compileBookBridgePlan,
  compileChapterBridgePlan,
  compileDetailBridgePlan,
  compileTextBridgePlan,
  encodeBridgePlan,
} from "./bridgePlan.js";

const EMPTY_ACTIONS = {
  relatedWord: { actionID: "relatedWord", parserID: "DOM" },
  searchShudan: { actionID: "searchShudan", parserID: "DOM" },
  shudanDetail: { actionID: "shudanDetail", parserID: "DOM" },
  shupingHome: { actionID: "shupingHome", parserID: "DOM" },
  shupingList: { actionID: "shupingList", parserID: "DOM" },
  shudanList: {},
};

function cleanBaseUrl(value) {
  const source = String(value ?? "").split("##")[0].split("\n")[0].trim();
  if (!source) return "";
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}`;
  } catch {
    return source.replace(/\/$/, "");
  }
}

function sourceType(source) {
  const type = source?.bookSourceType;
  if (type === 1 || type === "1") return "audio";
  if (type === 2 || type === "2") return "comic";
  // 新版/扩展阅读源已使用 4 表示影视，香色有原生 video 类型。
  if (type === 4 || type === "4") return "video";
  const group = String(source?.bookSourceGroup || "");
  const contentRules = getRules(source, "ruleContent", "contentRule");
  const contentRule = `${contentRules?.content || ""}\n${contentRules?.imageStyle || ""}\n${contentRules?.imageDecode || ""}`;
  // Some collections keep the old numeric type while grouping newer media
  // sources correctly. Infer capabilities from declarative metadata/rules, not
  // from a site name or domain.
  if (/(?:影视|视频|电影|直播)/i.test(group)) return "video";
  if (/(?:有声|音频|音乐|听书)/i.test(group)) return "audio";
  if (/(?:漫画|图片|图集|写真)/i.test(group)
    || ((type === 3 || type === "3") && /(?:\bimg\b|image|page-chapter|cp_img|data-original|imageStyle)/i.test(contentRule))) {
    return "comic";
  }
  // True file/download sources have no direct 香色 equivalent and remain text.
  if (type === 3 || type === "3") return "text";
  return "text";
}

function sourceWeight(source) {
  const raw = source.customOrder ?? source.weight ?? 100;
  const numeric = Number(raw);
  // 香色 2.56+：weight "0" 视为不可用，无法切换到该站点。
  if (!Number.isFinite(numeric) || numeric <= 0) return "100";
  return String(Math.min(9999, Math.floor(numeric)));
}

function minimumAppVersion(source) {
  const version = String(source.miniAppVersion ?? source.minAppVersion ?? "").trim();
  // 转换出的规则只使用基础字段；不要把开发/测试所用的客户端版本当成
  // 用户的最低版本，否则香色会显示已导入却拒绝启用该站点。
  return /^\d+(?:\.\d+){1,3}$/.test(version) ? version : "1.0.0";
}

function isDetailUrlAlias(rule) {
  const value = String(rule ?? "").trim();
  return /^(?:baseUrl|-|%@result)$/i.test(value);
}

function normalizeLegadoReplaceRegex(pattern) {
  let source = String(pattern ?? "").trim();
  let replacement = "";
  // Legado content.replaceRegex often stores `##pattern` or `##pattern##replacement`.
  if (source.startsWith("##")) {
    const rest = source.slice(2);
    const parts = rest.split("##");
    source = parts[0] || "";
    replacement = (parts[1] || "").replace(/#+$/, "");
  }
  return { source, replacement };
}

function compileReplaceRegexStatement(pattern, warn) {
  const { source, replacement } = normalizeLegadoReplaceRegex(pattern);
  if (!source) return "";
  if (/\{\{\s*book\.durChapterTitle\s*\}\}/i.test(source)) {
    warn("正文 replaceRegex 含章节标题模板，已改为香色 queryInfo.chapterTitle 运行时替换");
    const template = source.replace(/\{\{\s*book\.durChapterTitle\s*\}\}/gi, "__READ2XSGG_CHAPTER_TITLE__");
    return [
      'var __chapterTitle = String((params.queryInfo && (params.queryInfo.chapterTitle || params.queryInfo.chapterName || params.queryInfo.title)) || "");',
      `var __replacePat = ${JSON.stringify(template)}.replace(/__READ2XSGG_CHAPTER_TITLE__/g, __chapterTitle.replace(/[.*+?^$\{}()|[\\]\\\\]/g, "\\\\$&"));`,
      `result = String(result).replace(new RegExp(__replacePat, "g"), ${JSON.stringify(replacement)});`,
    ].join("\n");
  }
  if (/\{\{/.test(source)) {
    warn("正文 replaceRegex 含无法移植的阅读模板，已忽略该清理规则");
    return "";
  }
  try {
    new RegExp(source);
  } catch {
    warn("正文 replaceRegex 无法解析，已原样写入转换结果");
  }
  return `result = String(result).replace(new RegExp(${JSON.stringify(source)}, "g"), ${JSON.stringify(replacement)});`;
}

/**
 * 部分阅读文本源只是用 java.getString('CSS 选择器') 包装 DOM 提取。
 * 香色不能执行 Android JavaScript，但选择器本身是可移植的；仅提取没有
 * 动态拼接的首个 getString，复杂 Java 流程仍保留并给出告警。
 */
function portableJavaGetStringRule(rule, warn) {
  const source = String(rule ?? "").trim();
  if (!/^@js:/i.test(source) || !/\bjava\.getString\s*\(/i.test(source)) return null;
  const match = source.match(/\bjava\.getString\s*\(\s*(['"])([^'"\\\r\n]+)\1(?:\s*,[^)]*)?\)/i);
  if (!match?.[2]) return null;
  const selector = match[2].trim();
  if (!selector || /(?:\bjava\.|\bPackages\b|\+|;)/i.test(selector)) return null;
  warn("已将 java.getString(...) 的静态 DOM 选择器转换为香色规则；其中的动态 Java 回退逻辑无法执行");
  return selector;
}

/** 漫画正文：若规则取出的是图片 URL 列表，包成 <img> 供香色 comic 渲染。 */
function wrapComicImageContent(contentRule) {
  if (!contentRule || /<img\s/i.test(contentRule)) return contentRule;
  if (!/@(?:src|data-original|data-src)\b/i.test(contentRule) && !/\/@(?:src|data-original|data-src)\b/i.test(contentRule)) {
    return contentRule;
  }
  if (/\|\|?\s*@js:/i.test(contentRule)) return contentRule;
  const wrapJs = [
    "@js:",
    "var text = String(result || \"\").trim();",
    "if (!text) return text;",
    "if (/<img\\s/i.test(text)) return text;",
    "return text.split(/\\r?\\n+/).map(function (line) {",
    "  line = line.trim();",
    "  if (!line) return \"\";",
    "  if (/^https?:\\/\\//i.test(line) || line.charAt(0) === \"/\") {",
    "    return \"<img src=\\\"\" + line + \"\\\">\";",
    "  }",
    "  return line;",
    "}).filter(Boolean).join(\"\\n\");",
  ].join("\n");
  return `${contentRule}||${wrapJs}`;
}

/**
 * 有声/视频正文：香色期望 content 最终给出可播媒体 JSON。
 * 直接返回播放地址并带上源站 httpHeaders（Referer/Cookie）。不要默认走 /media：
 * 代理会把 Referer 改成 CDN 自身域名，反而触发防盗链导致「能列目录却听不了」。
 */
function wrapMediaContent(contentRule, imageProxyBase = "") {
  if (!contentRule) return contentRule;
  if (/JSON\.stringify\s*\(\s*\{[\s\S]*\burl\b/i.test(contentRule)) return contentRule;
  if (/forbidCache/i.test(contentRule) && /\burl\s*:/i.test(contentRule)) return contentRule;
  void imageProxyBase;
  const wrapJs = [
    "@js:",
    "var url = String(result || \"\").trim();",
    "if (!url) return url;",
    "if (url.charAt(0) === \"{\") return url;",
    "var m = url.match(/https?:\\/\\/[^\\s\"'<>]+\\.(?:mp3|m4a|aac|ogg|wav|flac|mp4|m3u8|m4v|webm)(?:\\?[^\\s\"'<>]*)?/i)",
    "  || url.match(/https?:\\/\\/[^\\s\"'<>]+/i)",
    "  || (url.charAt(0) === \"/\" ? [null, url] : null);",
    "if (m) url = m[1] || m[0];",
    "url = encodeURI(url);",
    "return JSON.stringify({",
    "  url: url,",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");
  if (/\|\|?\s*@js:/i.test(contentRule)) return contentRule;
  return `${contentRule}||${wrapJs}`;
}

/** Audio/video sources often put the playable URL directly in chapterUrl. */
function directMediaContent(imageProxyBase = "") {
  void imageProxyBase;
  return [
    "@js:",
    'var q = (typeof params !== "undefined" && params.queryInfo) || {};',
    'var url = String(q.url || q.detailUrl || q.chapterUrl || "").trim();',
    'if (!url && typeof result === "string" && /^(?:https?:)?\\/\\//i.test(result.trim())) url = result.trim();',
    'if (url.indexOf("//") === 0) url = "https:" + url;',
    'else if (url && !/^https?:\\/\\//i.test(url)) url = config.host + (url.charAt(0) === "/" ? url : "/" + url);',
    "url = encodeURI(url);",
    "return JSON.stringify({",
    "  url: url,",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");
}

/** A known encrypted comic API can be rendered through the server image proxy. */
function proxiedJsonImageContent(imageProxyBase, decoder) {
  const endpoint = `${String(imageProxyBase).replace(/\/$/, "")}/image/${decoder}?url=`;
  return [
    "$.data.images||@js:",
    "var images = Array.isArray(result) ? result : [];",
    `var endpoint = ${JSON.stringify(endpoint)};`,
    "var urls = images.map(function (item) {",
    "  var url = String((item && (item.url || item.src)) || \"\");",
    "  return url ? endpoint + encodeURIComponent(url) : \"\";",
    "}).filter(Boolean);",
    // 香色 comic 正文要求 URL 列表（或含 urls 的 JSON），不能返回 <img> HTML。
    "return JSON.stringify({urls: urls, httpHeaders: {}});",
  ].join("\n");
}

/** Replace Legado's baseUrl/src image-wrapper JS with portable 香色 image markup. */
function proxiedLineImageContent(contentRule, imageProxyBase, decoder) {
  const selector = String(contentRule || "").split(/\|\|?\s*@js:/i, 1)[0];
  const endpoint = `${String(imageProxyBase).replace(/\/$/, "")}/image/${decoder}?url=`;
  const proxyJs = [
    "@js:",
    "var text = String(result || \"\").trim();",
    "if (!text) return text;",
    `var endpoint = ${JSON.stringify(endpoint)};`,
    "var toImage = function (url) { return '<img src=\"' + endpoint + encodeURIComponent(url) + '\">'; };",
    "if (/<img\\s/i.test(text)) {",
    "  return text.replace(/(<img\\b[^>]*\\bsrc=[\"'])([^\"']+)([\"'])/gi, function (_, before, url, after) {",
    "    return before + endpoint + encodeURIComponent(url) + after;",
    "  });",
    "}",
    "var urls = text.split(/\\r?\\n+/).map(function (line) { return line.trim(); }).filter(function (url) { return /^https?:\\/\\//i.test(url); });",
    "return urls.length ? urls.map(toImage).join(\"\\n\") : text;",
  ].join("\n");
  return selector ? `${selector}||${proxyJs}` : proxyJs;
}

function nativeJmRequestInfo() {
  return [
    "@js:",
    'var q = (params && params.queryInfo) || {};',
    // chapterUrl/url changes with the active action; detailUrl remains the
    // book page for the whole chain and must therefore be the last fallback.
    'var u = q.chapterUrl || q.url || q.detailUrl || "";',
    'if (!u) u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (u == "%@result") u = "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    "return encodeURI(u);",
  ].join("\n");
}

/** Generic action URL resolver for clients that leave %@result as a literal. */
function actionPageSize(action, fallback = 20) {
  const configured = Number(action?.moreKeys?.pageSize);
  return Number.isInteger(configured) && configured > 0 ? Math.min(200, configured) : fallback;
}

function requestHasUpstreamPaging(requestInfo, action = null) {
  const source = String(requestInfo || "");
  if (/%@pageIndex\b|params\.pageIndex\b|__PAGE__/.test(source)) return true;
  if (action?.nextPageUrl) return true;
  return false;
}

function adapterEndpointWithPaging(endpoint, { pageSize = 20, serverPaging = false } = {}) {
  const base = String(endpoint || "").replace(/&url=$/, "").replace(/\?url=$/, "?");
  const join = base.includes("?") ? "&" : "?";
  if (serverPaging) {
    return `${base}${join}page=%@pageIndex&pageSize=${pageSize}&slice=1&url=`;
  }
  return `${base}${join}pageSize=${pageSize}&url=`;
}

function finalizeAdapterUrlExpression(endpoint) {
  return `(${JSON.stringify(endpoint)}).replace(/%@pageIndex/g, String((params && params.pageIndex) || 1))`;
}

function runtimeAdapterRequestInfo(endpoint) {
  return [
    "@js:",
    'var q = (params && params.queryInfo) || {};',
    'var u = q.chapterUrl || q.url || q.detailUrl || "";',
    'if (!u) u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (u == "%@result") u = "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    `return ${finalizeAdapterUrlExpression(endpoint)} + encodeURIComponent(u);`,
  ].join("\n");
}

function bridgeRequestInfo(requestInfo, endpoint, { pageSize = 20, serverPaging = false } = {}) {
  const source = String(requestInfo || "").trim();
  if (!source) return "";
  const pagedEndpoint = adapterEndpointWithPaging(endpoint, { pageSize, serverPaging });
  if (source === "%@result") return runtimeAdapterRequestInfo(pagedEndpoint);
  // POST / httpParams / webView cannot be safely re-fetched by the GET-only
  // adapter. Keep the native Xiangse request (caller skips bridging on "").
  if (/^@js:/i.test(source)) {
    const effectiveSource = source.replace(/\bPOST\s*:\s*false\b/g, "");
    if (/\b(?:POST|httpParams|requestBody|webView)\b/.test(effectiveSource)) return "";
    return [
      "@js:",
      'var q = (params && params.queryInfo) || {};',
      'var seed = q.chapterUrl || q.url || q.detailUrl || result || "";',
      "var u = (function (result) {",
      source.replace(/^@js:\s*/i, ""),
      "}).call(this, seed);",
      'if (u && typeof u == "object") u = u.url || "";',
      'u = String(u || "").trim();',
      `return ${finalizeAdapterUrlExpression(pagedEndpoint)} + encodeURIComponent(u);`,
    ].join("\n");
  }
  // Plain request templates still carry 香色 placeholders. Substitute them in
  // @js before encoding; a literal `%@pageIndex` inside `url=` is invalid
  // percent-encoding and the adapter rejects the whole category request.
  if (/%@(?:pageIndex|keyWord|filter|offset)\b/.test(source) || serverPaging) {
    return [
      "@js:",
      `var u = ${JSON.stringify(source)};`,
      'u = String(u)',
      '.replace(/%@pageIndex/g, String((params && params.pageIndex) || 1))',
      '.replace(/%@offset/g, String((params && params.offset) || 0))',
      '.replace(/%@keyWord/g, encodeURIComponent((params && params.keyWord) || ""))',
      '.replace(/%@filter/g, String((params && params.filters && params.filters.category) || (params && params.filter) || ""));',
      'u = String(u || "").trim();',
      'if (u.indexOf("//") == 0) u = "https:" + u;',
      'else if (u && !/^https?:\\/\\//i.test(u)) u = (config.host || "") + (u.charAt(0) == "/" ? u : "/" + u);',
      `return ${finalizeAdapterUrlExpression(pagedEndpoint)} + encodeURIComponent(u);`,
    ].join("\n");
  }
  // The adapter reads everything after `url=` verbatim, so target query
  // parameters may remain unescaped and XSGG can still substitute placeholders.
  return `${pagedEndpoint}${source}`;
}

function bridgeEndpoint(base, type, plan) {
  return `${String(base).replace(/\/$/, "")}/adapter/${type}?plan=${encodeBridgePlan(plan)}&url=`;
}

function preserveEncode(from, to) {
  if (!from || !to) return to;
  const out = { ...to };
  if (from.requestParamsEncode) out.requestParamsEncode = from.requestParamsEncode;
  if (from.responseEncode) out.responseEncode = from.responseEncode;
  return out;
}

function bridgeBookAction(action, bridgeBase, headers) {
  if (!action?.list || !action?.bookName || !action?.detailUrl || !action?.requestInfo) return action;
  const catalogFilters = String(action?.moreKeys?.requestFilters || "");
  // Declarative /adapter/catalog plans already return normalized JSON book rows.
  if (/\/adapter\/catalog\?/i.test(catalogFilters) || /\/adapter\/catalog\?/i.test(String(action.requestInfo))) {
    return preserveEncode(action, {
      ...commonAction(action.actionID || "bookWorld", action.host, "json"),
      requestInfo: action.requestInfo,
      list: "$.data",
      bookName: "name",
      detailUrl: "url",
      author: "author",
      desc: "desc",
      cat: "cat",
      lastChapterTitle: "lastChapterTitle",
      cover: "cover",
      status: "status",
      wordCount: "wordCount",
      moreKeys: action.moreKeys,
      ...(action._sIndex !== undefined ? { _sIndex: action._sIndex } : {}),
    });
  }
  const plan = compileBookBridgePlan(action, { ...headers, ...(action.httpHeaders || {}) });
  if (!plan.list || !plan.fields.name || !plan.fields.url) return action;
  const endpoint = bridgeEndpoint(bridgeBase, "books", plan);
  const pageSize = actionPageSize(action, 20);
  const serverPaging = !requestHasUpstreamPaging(action.requestInfo, action);
  const requestInfo = bridgeRequestInfo(action.requestInfo, endpoint, { pageSize, serverPaging });
  if (!requestInfo) return action;
  const moreKeys = {
    ...(action.moreKeys || {}),
    pageSize,
    ...(serverPaging ? { maxPage: Number(action.moreKeys?.maxPage) > 0 ? action.moreKeys.maxPage : 200 } : {}),
  };
  return preserveEncode(action, {
    ...commonAction(action.actionID || "bookWorld", action.host, "json"),
    requestInfo,
    list: "$.data",
    bookName: "name",
    detailUrl: "url",
    author: "author",
    desc: "desc",
    cat: "cat",
    lastChapterTitle: "lastChapterTitle",
    ...(plan.fields.cover ? { cover: "cover" } : {}),
    status: "status",
    wordCount: "wordCount",
    moreKeys,
    ...(action._sIndex !== undefined ? { _sIndex: action._sIndex } : {}),
  });
}

function bridgeDetailAction(action, bridgeBase, headers) {
  if (!action?.bookName || !action?.requestInfo) return action;
  const plan = compileDetailBridgePlan(action, { ...headers, ...(action.httpHeaders || {}) });
  if (!plan.fields.name) return action;
  const endpoint = bridgeEndpoint(bridgeBase, "detail", plan);
  const requestInfo = bridgeRequestInfo(action.requestInfo, endpoint);
  if (!requestInfo) return action;
  return preserveEncode(action, {
    ...commonAction("bookDetail", action.host, "json"),
    requestInfo,
    bookName: "$.name",
    author: "$.author",
    desc: "$.desc",
    cat: "$.cat",
    lastChapterTitle: "$.lastChapterTitle",
    ...(plan.fields.cover ? { cover: "$.cover" } : {}),
    status: "$.status",
    wordCount: "$.wordCount",
  });
}

function bridgeChapterAction(action, bridgeBase, { tocSelector = "", headers = {} } = {}) {
  if (!action?.list || !action?.title || !action?.url) return action;
  // Only HTML link selectors belong in plan.tocSelector. JSON/API tocUrl is
  // already compiled into requestInfo (absolute getBookMenu-style URLs).
  const htmlTocSelector = String(tocSelector || "").trim();
  const useHtmlToc = Boolean(
    htmlTocSelector
    && !/^@js:/i.test(htmlTocSelector)
    && !/^https?:\/\//i.test(htmlTocSelector)
    && !/\{\{|result\./i.test(htmlTocSelector),
  );
  const plan = compileChapterBridgePlan(action, {
    tocSelector: useHtmlToc ? htmlTocSelector : "",
    headers: { ...headers, ...(action.httpHeaders || {}) },
    reverse: Boolean(action.reverseChapters || action.reverse),
  });
  if (!plan.list || !plan.fields.title || !plan.fields.url) return action;
  const endpoint = bridgeEndpoint(bridgeBase, "chapters", plan);
  const pageSize = actionPageSize(action, 100);
  const serverPaging = !requestHasUpstreamPaging(action.requestInfo || "%@result", action);
  const requestInfo = useHtmlToc
    ? runtimeAdapterRequestInfo(adapterEndpointWithPaging(endpoint, { pageSize, serverPaging }))
    : bridgeRequestInfo(action.requestInfo || "%@result", endpoint, { pageSize, serverPaging });
  if (!requestInfo) return action;
  const { reverseChapters: _reverseChapters, reverse: _reverse, ...rest } = action;
  return preserveEncode(rest, {
    ...commonAction("chapterList", action.host, "json"),
    requestInfo,
    list: "$.data",
    title: "title",
    url: "url",
    updateTime: "updateTime",
    ...(action.nextPageUrl ? { nextPageUrl: action.nextPageUrl } : {}),
    moreKeys: {
      ...(action.moreKeys || {}),
      pageSize,
      ...(serverPaging ? { maxPage: Number(action.moreKeys?.maxPage) > 0 ? action.moreKeys.maxPage : 300 } : {}),
    },
  });
}

function bridgeTextAction(action, bridgeBase, headers) {
  if (!action?.content || /^@js:/i.test(String(action.content).trim())) return action;
  const plan = compileTextBridgePlan(action, { ...headers, ...(action.httpHeaders || {}) });
  if (!plan.fields.content) return action;
  const endpoint = bridgeEndpoint(bridgeBase, "text", plan);
  const requestInfo = bridgeRequestInfo(action.requestInfo || "%@result", endpoint);
  if (!requestInfo) return action;
  return preserveEncode(action, {
    ...commonAction("chapterContent", action.host, "json"),
    requestInfo,
    content: "$.content",
  });
}

function tocLinkHint(rule) {
  const source = String(rule || "");
  return source.match(/(?:text\(\)|text\.)\s*(?:=|,)?\s*["']([^"']{1,32})["']/i)?.[1]
    || source.match(/["']([^"']*(?:章节|目录|chapter|catalog)[^"']*)["']/i)?.[1]
    || "";
}

/**
 * Strip trailing Legado request options (`,{headers:{...}}`) and return them.
 * Also recognizes the common cover-image idiom that appends the same options via
 * JavaScript string concatenation: `result.cover + ',{"headers":{"Referer":"..."}}'`.
 */
function splitLegadoUrlOptions(rule) {
  const source = String(rule || "").trim();
  if (!source) return { url: "", options: {} };

  const trailing = source.match(/^(.*?)(,\s*\{[\s\S]*\})\s*$/);
  if (trailing) {
    return { url: trailing[1].trim(), options: parseLooseJson(trailing[2].replace(/^,\s*/, ""), () => {}) };
  }

  const concat = source.match(
    /^(.*?)\s*\+\s*(['"]),(\{\s*"headers?"\s*:\s*\{[\s\S]*?\}\s*\})\2\s*;?\s*$/i,
  );
  if (concat) {
    return {
      url: concat[1].trim().replace(/^\(?/, "").replace(/\)$/, ""),
      options: parseLooseJson(concat[3], () => {}),
    };
  }

  const embedded = source.match(/(['"]),(\{\s*"headers?"\s*:\s*\{[\s\S]*?\}\s*\})\1/);
  if (embedded) {
    const options = parseLooseJson(embedded[2], () => {});
    const cleaned = source
      .replace(/\s*\+\s*(['"]),\{\s*"headers?"\s*:\s*\{[\s\S]*?\}\s*\}\1/gi, "")
      .replace(/(['"]),\{\s*"headers?"\s*:\s*\{[\s\S]*?\}\s*\}\1/gi, "\"\"")
      .trim();
    return { url: cleaned || source, options };
  }

  return { url: source, options: {} };
}

/**
 * Cover/detail URL rules that only read `result.field` (optionally after the
 * Legado header-suffix strip) become plain JSON field paths for 香色.
 */
function portableResultFieldRule(rule, responseType) {
  if (responseType !== "json") return "";
  const source = String(rule || "").trim()
    .replace(/^@js:\s*/i, "")
    .replace(/^return\s+/i, "")
    .replace(/;?\s*$/, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .trim();
  const field = source.match(/^result\.([A-Za-z_$][\w$]*)$/)?.[1];
  return field || "";
}

/**
 * Absolute JSON API tocUrl templates (…?bookId={{$.id}}&pageNum=1) → chapterList requestInfo.
 * Xiangse §七 uses detail URL as result; these menus need the book id + page instead.
 */
function upstreamPageSizeFromTocUrl(tocUrl) {
  const { url: raw } = splitLegadoUrlOptions(tocUrl);
  const match = String(raw || "").match(/[?&]pageSize=(\d{1,4})\b/i);
  const size = match ? Number(match[1]) : 0;
  return Number.isInteger(size) && size > 0 ? Math.min(200, size) : 0;
}

function buildJsonApiTocRequestInfo(tocUrl) {
  const { url: raw } = splitLegadoUrlOptions(tocUrl);
  if (!/^https?:\/\//i.test(raw)) return "";
  if (!/\{\{\s*\$\.[A-Za-z_$][\w$]*\s*\}\}|\{(?:\$\.)?[A-Za-z_$][\w$]*\}/.test(raw)) return "";

  let template = raw
    .replace(/\{\{\s*page\s*\}\}/gi, "__PAGE__")
    .replace(/([?&](?:pageNum|pageIndex|page)=)(?:1|\{\{\s*page\s*\}\})/gi, "$1__PAGE__");

  const idFields = [];
  template = template.replace(/\{\{\s*\$\.([A-Za-z_$][\w$]*)\s*\}\}/g, (_, field) => {
    if (!idFields.includes(field)) idFields.push(field);
    return "__ID__";
  });
  template = template.replace(/\{(?:\$\.)?([A-Za-z_$][\w$]*)\}/g, (_, field) => {
    if (!idFields.includes(field)) idFields.push(field);
    return "__ID__";
  });
  if (!template.includes("__ID__")) return "";

  return [
    "@js:",
    "var q = (typeof params !== \"undefined\" && params.queryInfo) || {};",
    "var u = String(q.detailUrl || q.url || q.chapterUrl || \"\");",
    "if (!u && typeof result === \"string\") u = result;",
    "if (!u && result && typeof result === \"object\") u = String(result.detailUrl || result.url || \"\");",
    "if (/(?:getBookMenu|getAlbumMenu|chapterList|toc)\\?/i.test(u) && /[?&](?:pageNum|pageIndex|page)=\\d+/i.test(u)) return u;",
    "var id = String(q.bookId || q.id || \"\").trim();",
    "if (!id) {",
    "  var m = u.match(/[?&](?:bookId|albumId|id)=(\\d+)/i)",
    "    || u.match(/\\/(?:book|album|comic)\\/(\\d+)/i)",
    "    || u.match(/\\/(\\d+)(?:\\/?(?:\\?|$))/);",
    "  if (m) id = m[1];",
    "}",
    "if (!id) return \"\";",
    "var page = String((params && params.pageIndex) || 1);",
    `var url = ${JSON.stringify(template)};`,
    "url = url.split(\"__ID__\").join(encodeURIComponent(id));",
    "if (url.indexOf(\"__PAGE__\") >= 0) url = url.split(\"__PAGE__\").join(encodeURIComponent(page));",
    "return url;",
  ].join("\n");
}

function buildJsonApiTocNextPageUrl(tocUrl) {
  const { url: raw } = splitLegadoUrlOptions(tocUrl);
  if (!/^https?:\/\//i.test(raw)) return "";
  if (!/\{\{\s*\$\.[A-Za-z_$][\w$]*\s*\}\}|\{(?:\$\.)?[A-Za-z_$][\w$]*\}/.test(raw)) return "";
  const requestInfo = buildJsonApiTocRequestInfo(tocUrl);
  if (!requestInfo) return "";
  return [
    "@js:",
    "var q = (typeof params !== \"undefined\" && params.queryInfo) || {};",
    "var current = String((typeof result === \"string\" && result) || params.responseUrl || q.url || q.chapterUrl || q.detailUrl || \"\");",
    "if (/(?:getBookMenu|getAlbumMenu|chapterList|toc)\\?/i.test(current)) {",
    "  if (/[?&](pageNum|pageIndex|page)=\\d+/i.test(current)) {",
    "    return current.replace(/([?&](?:pageNum|pageIndex|page)=)(\\d+)/i, function (_, prefix, value) {",
    "      return prefix + String((Number(value) || 1) + 1);",
    "    });",
    "  }",
    "  return current;",
    "}",
    requestInfo.replace(/^@js:\s*/i, ""),
  ].join("\n");
}

/**
 * Turn absolute HTTP chapter URL templates into a bridge urlTemplate field.
 * Query values may come from the toc page URL (e.g. bookId=) or each row.
 */
function compileHttpChapterUrlField(chapterUrl) {
  const { url: raw } = splitLegadoUrlOptions(chapterUrl);
  if (!/^https?:\/\//i.test(raw)) return null;
  if (!/\{\{\s*\$\./.test(raw) && !/baseUrl\.match/.test(raw)) return null;

  let template = raw;
  // baseUrl.match(/bookId=(\d+)/)[1] → {{base:bookId}}
  template = template.replace(
    /\{\{\s*baseUrl\.match\(\/((?:\\.|[^/])+)\/\)\[1\]\s*\}\}/gi,
    () => "{{base:bookId}}",
  );
  template = template.replace(/\{\{\s*java\.get\(\s*["']entityType["']\s*\)\s*\}\}/gi, "1");
  template = template.replace(/\{\{\s*\$\.([A-Za-z_$][\w$]*)\s*\}\}/g, "{{$1}}");
  if (!/\{\{[A-Za-z_]/.test(template)) return null;

  const primary = (template.match(/\{\{(id)\}\}/i) || template.match(/\{\{(section|url|path)\}\}/i))?.[1] || "id";
  return {
    selector: primary,
    replacements: [],
    hostPrefix: false,
    matchTemplate: null,
    urlTemplate: template.slice(0, 2_048),
  };
}

function mergeLegadoUrlOptionHeaders(headers, ...rules) {
  const merged = { ...headers };
  for (const rule of rules) {
    if (rule === undefined || rule === null || rule === "") continue;
    const { options } = splitLegadoUrlOptions(rule);
    const extra = parseHeaders(options.headers || options.header || {}, () => {});
    Object.assign(merged, extra);
  }
  return merged;
}

// 香色对 XPath 选中的元素会读取完整 textContent；阅读的 @text 也包含
// 后代文本。直译成 /text() 只会取直接文本节点，标题里有 span 时就会变空。
function compatibleTextRule(original, converted) {
  const source = String(original || "").trim();
  const result = String(converted || "");
  if (!result) return result;
  const fromTextProperty = /(?:^|@)(?:text|textNodes|ownText)$/i.test(source.split("##", 1)[0].trim());
  // Also normalize native XPath that already ends in /text() — 香色 and the
  // bridge executor both prefer element textContent over direct text nodes.
  if (fromTextProperty || /\/text\(\)\s*$/.test(result.split("||", 1)[0].trim()) || /\/text\(\)/.test(result)) {
    if (result === "/text()") return ".";
    return result
      .split("||")
      .map((part) => part
        .split(/\s+\|\s+/)
        .map((piece) => {
          const trimmed = piece.trim();
          if (trimmed === "/text()") return ".";
          return trimmed.replace(/\/text\(\)(?=\s*$)/g, "") || ".";
        })
        .join(" | "))
      .join("||");
  }
  return result;
}

function nativeJmChapterList(host) {
  return {
    // 与已可用的 6444 相同：香色直接按详情 URL 拉取 HTML 目录。
    // 禁漫的原始规则 list 已定位到 <a>，再写 //a/@href 会在香色中错失当前节点。
    ...commonAction("chapterList", host, "html"),
    // 不能写成 "%@result"：部分香色漫画动作不会展开这个占位符，
    // 会实际请求 https://host/%@result。按 6444 的运行时方式显式取值。
    requestInfo: nativeJmRequestInfo(),
    list: "//ul[contains(@class, 'btn-toolbar')]//a | //a[contains(@class, 'reading')]",
    title: "//h3/text() || //a/text() || @js:\nreturn String(result || '').trim();",
    url: "//@href",
  };
}

/**
 * Generic HTML-comic bridge. The service extracts lazy/direct page images and
 * returns {urls}; 香色 receives its native comic payload after image proxying.
 */
function proxiedHtmlComicChapterContent(host, imageProxyBase, decoder = "auto", extractionPlan = null) {
  const base = String(imageProxyBase).replace(/\/$/, "");
  const encodedPlan = encodeComicExtractionPlan(extractionPlan);
  const endpoint = `${base}/adapter/images?${encodedPlan ? `plan=${encodedPlan}&` : ""}url=`;
  const imageEndpoint = `${base}/image/${decoder}?url=`;
  return {
    ...commonAction("chapterContent", host, "json"),
    requestInfo: runtimeAdapterRequestInfo(endpoint),
    content: [
      "$.urls||@js:",
      'var images = Array.isArray(result) ? result : [];',
      `var endpoint = ${JSON.stringify(imageEndpoint)};`,
      'var urls = images.map(function (url) { return endpoint + encodeURIComponent(String(url || "")); }).filter(Boolean);',
      'return JSON.stringify({urls: urls, httpHeaders: {}});',
    ].join("\n"),
  };
}

/** Generic server-side audio/video URL extraction. Play URL is returned with
 * source httpHeaders so the client can satisfy Referer/Cookie anti-leech. */
function proxiedMediaChapterContent(host, imageProxyBase, kind, extractionPlan) {
  const base = String(imageProxyBase).replace(/\/$/, "");
  const encodedPlan = encodeMediaExtractionPlan(extractionPlan);
  const endpoint = `${base}/adapter/media?kind=${kind}&plan=${encodedPlan}&url=`;
  return {
    ...commonAction("chapterContent", host, "json"),
    requestInfo: runtimeAdapterRequestInfo(endpoint),
    content: [
      "@js:",
      'var payload = (typeof result === "string") ? JSON.parse(result) : result;',
      'var url = String((payload && payload.url) || "").trim();',
      "return JSON.stringify({",
      "  url: encodeURI(url),",
      "  httpHeaders: config.httpHeaders,",
      "  forbidCache: true",
      "});",
    ].join("\n"),
  };
}

function xsggModifyTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return String(Math.floor(Date.now() / 1000));
  return String(Math.floor(numeric > 100_000_000_000 ? numeric / 1000 : numeric));
}

function normalizeInput(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") throw new TypeError("阅读源 JSON 必须是对象或数组");
  if (input.bookSourceUrl || input.bookSourceName) return [input];
  for (const key of ["sources", "bookSources", "data"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  const values = Object.values(input);
  if (values.length && values.every((value) => value && typeof value === "object")) return values;
  throw new TypeError("没有在输入 JSON 中找到阅读书源");
}

function getRules(source, modern, legacy) {
  return source[modern] ?? source[legacy] ?? {};
}

function splitStoredEntries(value) {
  const entries = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim()) entries.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function storedMappings(rule) {
  const mappings = new Map();
  for (const match of String(rule || "").matchAll(/@put:\{([\s\S]*?)\}(?=(?:\s*##|\s*@js:|\s*<js>|\s*$))/gi)) {
    const parsed = parseLooseJson(`{${match[1]}}`, () => {});
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length) {
      for (const [key, value] of Object.entries(parsed)) mappings.set(key, String(value));
      continue;
    }
    for (const entry of splitStoredEntries(match[1])) {
      const pair = entry.match(/^\s*([A-Za-z_$][\w$-]*)\s*:\s*([\s\S]+?)\s*$/);
      if (!pair) continue;
      let value = pair[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        try {
          value = value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1).replace(/\\'/g, "'");
        } catch {
          value = value.slice(1, -1);
        }
      }
      mappings.set(pair[1], String(value));
    }
  }
  return mappings;
}

function jsonStoredTemplate(selector) {
  const value = String(selector || "").trim().replace(/^@json:/i, "");
  if (/^\$\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(value)) return `{{${value}}}`;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(value)) return `{{$.${value}}}`;
  return "";
}

function resolveStoredRule(rule, mappings) {
  if (typeof rule !== "string") return rule;
  const withoutPut = rule.replace(/@put:\{[\s\S]*?\}(?=(?:\s*##|\s*@js:|\s*<js>|\s*$))/gi, "").trim();
  return withoutPut.replace(/@get:\{\s*([A-Za-z_$][\w$-]*)\s*\}/gi, (token, key, offset, whole) => {
    const selector = mappings.get(key);
    if (!selector) return token;
    const before = whole.slice(0, offset).trim();
    const after = whole.slice(offset + token.length).trim();
    if (!before && (!after || /^(?:##|@js:|<js>)/i.test(after))) return selector;
    return jsonStoredTemplate(selector) || token;
  });
}

function resolveLegadoStoredRules(source) {
  const keys = ["ruleSearch", "searchRule", "ruleExplore", "exploreRule", "ruleBookInfo", "bookInfoRule", "ruleToc", "tocRule", "ruleContent", "contentRule"];
  const groups = keys.map((key) => [key, source[key]]).filter(([, rules]) => rules && typeof rules === "object" && !Array.isArray(rules));
  const candidates = new Map();
  const locals = new Map();
  for (const [key, rules] of groups) {
    const mapping = new Map();
    for (const value of Object.values(rules)) {
      for (const [name, selector] of storedMappings(value)) {
        mapping.set(name, selector);
        if (!candidates.has(name)) candidates.set(name, new Set());
        candidates.get(name).add(selector);
      }
    }
    locals.set(key, mapping);
  }
  const unique = new Map([...candidates].filter(([, values]) => values.size === 1).map(([name, values]) => [name, [...values][0]]));
  let changed = 0;
  const result = { ...source };
  for (const [key, rules] of groups) {
    const mappings = new Map([...unique, ...locals.get(key)]);
    const resolved = {};
    for (const [field, value] of Object.entries(rules)) {
      const next = resolveStoredRule(value, mappings);
      if (next !== value) changed += 1;
      resolved[field] = next;
    }
    result[key] = resolved;
  }
  return { source: result, changed };
}

function createWarningCollector(warnings, sourceName, section) {
  return (field, rule) => (message) => warnings.push({ source: sourceName, section, field, message, rule });
}

function portableHeaders(input, host, warningFor) {
  const result = {};
  for (const [name, rawValue] of Object.entries(input || {})) {
    if (rawValue === undefined || rawValue === null) continue;
    let value = String(rawValue)
      .replace(/\{\{\s*baseUrl\s*\}\}/gi, host)
      .replace(/\{\{\s*bookSourceUrl\s*\}\}/gi, host)
      .replace(/\{\{\s*(?:Get|get)\(\s*["']url["']\s*\)\s*\}\}/g, host);
    if (/\{\{/.test(value)) {
      warningFor("header", `${name}: ${rawValue}`)(`请求头 ${name} 含无法移植的阅读模板，已忽略该请求头`);
      continue;
    }
    value = value.replace(/[\r\n]+/g, " ").trim();
    if (value) result[String(name)] = value;
  }
  return result;
}

function commonAction(actionID, host, responseFormatType) {
  return { actionID, validConfig: "", host, responseFormatType, parserID: "DOM" };
}

function simpleJsonPath(rule) {
  const value = String(rule ?? "").trim().replace(/^@json:/i, "");
  const match = value.match(/^\$\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
  return match ? match[1].replace(/\./g, "/") : "";
}

/**
 * 阅读漫画源常用 `$.tags + java.timeFormat(...)` 作为分类展示。
 * 香色没有 java.timeFormat；保留 tags 才能让客户端对书籍类型/分类做匹配。
 */
function portableKindRule(rule, responseType, warningFor, initPath = "") {
  const source = String(rule ?? "");
  if (/^@js:/i.test(source) && /java\.timeFormat/i.test(source)) {
    const field = source.match(/\$\.([A-Za-z_$][\w$]*)/)?.[1];
    if (field) {
      warningFor("kind", rule)(`分类规则含阅读 java.timeFormat，已保留可移植字段 ${initPath ? `${initPath}/` : ""}${field}`);
      return `${initPath ? `${initPath}/` : ""}${field}`;
    }
  }
  return convertRule(rule, { responseType, warn: warningFor("kind", rule) });
}

function portableCoverRule(rule) {
  const source = String(rule ?? "").trim();
  if (!source) return "";
  const quoted = source.match(/^@js:\s*['"](https?:\/\/[^'"]+)['"]\s*;?\s*$/i);
  if (quoted) return quoted[1];
  const returned = source.match(/^@js:\s*return\s*\(?\s*['"](https?:\/\/[^'"]+)['"]\s*\)?\s*;?\s*$/i);
  if (returned) return returned[1];
  if (/^https?:\/\//i.test(source) && !/[|@]|##/.test(source)) return source;
  return "";
}

/**
 * Drop Legado image-request header suffixes from cover rules and prefer a plain
 * JSON field when the remainder is only `result.cover_pic`.
 */
function convertCoverRule(rule, responseType, warningFor) {
  const original = String(rule ?? "").trim();
  if (!original) return "";
  const constantCover = portableCoverRule(original);
  if (constantCover) return constantCover;

  const { url: stripped, options } = splitLegadoUrlOptions(original);
  const hadHeaderSuffix = Boolean(options.headers || options.header);
  const working = hadHeaderSuffix ? stripped : original;
  if (hadHeaderSuffix) {
    warningFor("coverUrl", original)(
      "封面规则中的阅读 headers 附加段已并入源 httpHeaders，并去掉 URL 尾缀以免香色把配置当成地址的一部分",
    );
  }

  const field = portableResultFieldRule(working, responseType);
  if (field) return field;

  return compatibleTextRule(
    working,
    convertRule(working, { responseType, warn: warningFor("coverUrl", original) }),
  );
}

function mapBookRules(rules, responseType, warningFor, { initPath = "", listContext = false } = {}) {
  const mapping = {
    bookList: "list",
    name: "bookName",
    author: "author",
    intro: "desc",
    kind: "cat",
    lastChapter: "lastChapterTitle",
    bookUrl: "detailUrl",
    coverUrl: "cover",
    wordCount: "wordCount",
    status: "status",
  };
  const result = {};
  for (const [from, to] of Object.entries(mapping)) {
    if (rules[from] !== undefined && rules[from] !== "") {
      if (from === "coverUrl") {
        const convertedCover = convertCoverRule(rules[from], responseType, warningFor);
        if (convertedCover) result[to] = convertedCover;
        continue;
      }
      if (from === "kind") {
        const convertedKind = portableKindRule(rules[from], responseType, warningFor, initPath);
        if (listContext && /^\s*@js:/i.test(convertedKind) && /(?:\bjava\.|\bPackages\b|\bsource\.|\bbook\.)/i.test(convertedKind)) {
          warningFor("kind", rules[from])("列表分类字段依赖阅读专用 JavaScript，已忽略以避免香色丢弃整个列表");
          continue;
        }
        result[to] = convertedKind;
        continue;
      }
      const convertedRule = compatibleTextRule(
        rules[from],
        convertRule(rules[from], { responseType, warn: warningFor(from, rules[from]) }),
      );
      // 阅读 ruleBookInfo.init 会将后续 JSONPath 的根切换到该节点。
      // 香色没有 init 字段，因此对无歧义的简单 JSONPath 显式补回前缀。
      const rulePath = initPath && responseType === "json" ? simpleJsonPath(rules[from]) : "";
      const resolvedRule = rulePath && rulePath !== initPath && !rulePath.startsWith(`${initPath}/`)
        ? `${initPath}/${rulePath}`
        : convertedRule;
      result[to] = resolvedRule;
    }
  }
  return result;
}

function mapDetailRules(rules, responseType, warningFor) {
  const result = mapBookRules(rules, responseType, warningFor, { initPath: simpleJsonPath(rules.init) });
  if (rules.init) {
    warningFor("init", rules.init)("详情页 init 规则没有直接等价字段，已忽略；请检查详情页请求与解析结果");
  }
  return result;
}

function mapTocRules(rules, responseType, warningFor) {
  const mapping = {
    chapterList: "list",
    chapterName: "title",
    chapterUrl: "url",
    updateTime: "updateTime",
    nextTocUrl: "nextPageUrl",
  };
  const result = {};
  // Legado: chapterList 首字符 `-` 表示目录倒序。必须先剥掉再转换选择器，
  // 否则 `-//li` / `-$.data` 会被误解析成残缺 XPath 或 `-$/data`。
  let chapterListRule = rules.chapterList;
  let reverseChapters = false;
  if (typeof chapterListRule === "string") {
    const stripped = chapterListRule.match(/^\s*-(?=[@.#/:*\[$a-zA-Z])([\s\S]*)$/);
    if (stripped) {
      reverseChapters = true;
      chapterListRule = stripped[1].trim();
    }
  }
  for (const [from, to] of Object.entries(mapping)) {
    const raw = from === "chapterList" ? chapterListRule : rules[from];
    if (raw !== undefined && raw !== "") {
      result[to] = compatibleTextRule(
        raw,
        convertRule(raw, { responseType, warn: warningFor(from, raw) }),
      );
    }
  }
  // Legado silently ignores chapter group/header rows whose URL field is empty.
  // 香色 may keep such rows and then fail on the first title. Filter HTML list
  // nodes to entries that actually contain a link whenever chapterUrl is href.
  if (responseType === "html" && result.list && /(?:^|@)href(?:$|##)/i.test(String(rules.chapterUrl || ""))) {
    result.list = `(${result.list})[self::a[@href] or .//a[@href]]`;
  }
  if (reverseChapters) result.reverseChapters = true;
  return result;
}

function buildBookAction({ actionID, host, request, rules, headers, warnings, sourceName, section }) {
  const responseType = inferResponseType(rules);
  const warningFor = createWarningCollector(warnings, sourceName, section);
  const action = {
    ...commonAction(actionID, host, responseType),
    ...convertRequest(request, { headers, warn: warningFor("request", request), fallback: actionID === "searchBook" ? "" : "%@result" }),
    ...mapBookRules(rules, responseType, warningFor, { listContext: true }),
  };
  if (rules.bookList && !action.moreKeys) {
    action.moreKeys = { pageSize: listPageSizeForRequest(action.requestInfo || request, null) };
  }
  return action;
}

/** Decorative explore headers like `°・*.☆ 全部榜单 ☆.*・°` are not real groups. */
function isOrnamentalExploreHeader(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/[☆★°・＊※◆◇■□▲△]/.test(text)) return true;
  const stripped = text.replace(/[\s\-—－_=.*·]+/g, "");
  return stripped.length > 0 && stripped.length < 2;
}

function extractTitleUrlLinesFromText(text) {
  let group = "";
  return String(text || "").split(/\r?\n/).map((line) => {
    const value = line.trim();
    const separator = value.indexOf("::");
    if (separator > 0 && !value.slice(separator + 2).trim()) {
      const header = value.slice(0, separator).replace(/[—－\-\s]/g, "");
      if (header && !isOrnamentalExploreHeader(value.slice(0, separator))) group = header;
      return null;
    }
    if (separator <= 0) {
      if (value && !isOrnamentalExploreHeader(value)) {
        group = value.replace(/[—－\-\s]/g, "") || group;
      }
      return null;
    }
    const title = value.slice(0, separator).trim();
    const url = value.slice(separator + 2).trim();
    if (!title || !url) return null;
    if (!/^(?:\/|https?:\/\/)/i.test(url) && !/\{\{\s*page\s*\}\}|%@pageIndex/i.test(url)) return null;
    return { title, url, group };
  }).filter((item) => item?.title && item?.url);
}

/**
 * 香色用 moreKeys.pageSize 判断「本页条数 < pageSize ⇒ 没有下一页」。
 * 上游自带 page 占位时，默认 10（国内列表站常见页长），避免默认 20 导致只加载第一页。
 */
function listPageSizeForRequest(template, configured) {
  const numeric = Number(configured);
  if (Number.isInteger(numeric) && numeric > 0) return Math.min(200, numeric);
  const source = String(template || "");
  const querySize = source.match(/[?&]pageSize=(\d{1,3})\b/i);
  if (querySize) {
    const parsed = Number(querySize[1]);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(200, parsed);
  }
  const dsize = source.match(/[?&]dsize=(\d{1,3})\b/i);
  if (dsize) {
    const parsed = Number(dsize[1]);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(200, parsed);
  }
  if (/__READ2XSGG_PAGE__|\{\{\s*page\s*\}\}|%@pageIndex|params\.pageIndex/i.test(source)) {
    return 10;
  }
  return 20;
}

/**
 * Many Legado sources embed plain `标题::/path/{{page}}` tables inside @js
 * template strings (not executable discovery). Extract those statically.
 */
function extractExploreEntriesFromJs(script) {
  const entries = [];
  const seen = new Set();
  const pushAll = (chunk) => {
    for (const entry of extractTitleUrlLinesFromText(chunk)) {
      const key = `${entry.group || ""}|${entry.title}|${entry.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  };
  for (const match of String(script || "").matchAll(/`([\s\S]*?)`/g)) pushAll(match[1]);
  for (const match of String(script || "").matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
    try {
      pushAll(JSON.parse(match[0].replace(/^'/, '"').replace(/'$/, '"')));
    } catch {
      pushAll(match[0].slice(1, -1));
    }
  }
  if (!entries.length) pushAll(script);
  return entries;
}

function materializeCatalogExploreEntries(source, imageProxyBase, warningFor) {
  const plan = normalizeCatalogPlan(source?.read2xsgg?.catalogPlan);
  if (!plan) return null;
  const raw = Array.isArray(source.exploreUrl) ? source.exploreUrl : [];
  const entityEntries = raw.filter((item) => item?.title && (item.entityId != null && String(item.entityId).trim() !== ""));
  if (!entityEntries.length) return null;
  if (!imageProxyBase) {
    warningFor("exploreUrl", source.exploreUrl)(
      "源含声明式 catalogPlan，但当前转换没有公开代理地址；分类分页无法物化为通用 catalog 适配器，请用在线转换或传入 imageProxyBase",
    );
    return null;
  }
  let encoded;
  try {
    encoded = encodeCatalogPlan(plan);
  } catch (error) {
    warningFor("read2xsgg.catalogPlan", plan)(`分类目录计划无效：${error.message}`);
    return null;
  }
  const base = String(imageProxyBase).replace(/\/$/, "");
  warningFor("exploreUrl", source.exploreUrl)(
    `已将 ${entityEntries.length} 个声明式分类绑定到通用 catalog 适配器（idList 计划）`,
  );
  return entityEntries.map((entry) => {
    const pageSize = Math.min(50, Math.max(1, Number(entry.pageSize) || plan.pageSize || 20));
    return {
      title: String(entry.title).trim(),
      group: entry.group ? String(entry.group).trim() : "",
      pageSize,
      url: `${base}/adapter/catalog?plan=${encoded}&entityId=${encodeURIComponent(String(entry.entityId).trim())}&page=__READ2XSGG_PAGE__&pageSize=${pageSize}`,
    };
  });
}

function parseExploreEntries(exploreUrl, warningFor) {
  if (!exploreUrl || exploreUrl === "-") return [];
  const validEntries = (entries) => entries
    .filter((item) => item?.title && item?.url)
    .map((item) => ({ ...item, title: String(item.title).trim(), url: String(item.url).trim() }))
    .filter((item) => item.title && item.url);
  if (Array.isArray(exploreUrl)) return validEntries(exploreUrl);
  const source = String(exploreUrl).trim();
  if (/^(?:@js:|<js>)/i.test(source)) {
    const extracted = extractExploreEntriesFromJs(source);
    if (extracted.length) {
      warningFor("exploreUrl", exploreUrl)(
        `已从发现页脚本中静态提取 ${extracted.length} 个 title::url 分类`,
      );
      return extracted;
    }
    warningFor("exploreUrl", exploreUrl)("发现页依赖阅读 Android JavaScript，无法安全执行；将尝试生成通用搜索入口分类");
    return [];
  }
  if (source.startsWith("[")) {
    const parsed = parseLooseJson(source, () => {});
    if (Array.isArray(parsed)) {
      const entries = validEntries(parsed);
      if (entries.length) return entries;
    }
    warningFor("exploreUrl", exploreUrl)("发现页配置看似 JSON，但宽松解析后仍无有效分类，已尝试按 title::url 行解析");
  }
  return extractTitleUrlLinesFromText(source);
}

function compactCategoryTemplate(value, host) {
  let template = String(value || "").trim();
  if (!template || /^(?:@js:|<js>)/i.test(template) || /,\s*\{[\s\S]*\}\s*$/.test(template)) return "";
  // requestFilters can substitute page numbers but cannot represent Legado's
  // page-1-vs-later `<first,following>` branch. Keep these as individual
  // actions so convertRequest() can emit the correct conditional URL.
  if (/<[^<>]*,[^<>]*>/.test(template)) return "";
  template = template
    .replace(/^\{\{\s*(?:Get|get)\(\s*["']url["']\s*\)\s*\}\}/i, "")
    .replace(/^\{\{\s*(?:baseUrl|bookSourceUrl)\s*\}\}/i, "");
  if (host && template.startsWith(host)) template = template.slice(host.length) || "/";
  template = template
    .replace(/\{\{\s*page\s*\}\}/gi, "__READ2XSGG_PAGE__")
    .replace(/%@pageIndex/g, "__READ2XSGG_PAGE__");
  if (/\{\{|%@(?:keyWord|filter)/i.test(template)) return "";
  return template;
}

/**
 * 大型阅读源集合常带几十个甚至几百个普通 GET 分类。逐项展开为独立
 * bookWorld action 会让 XBS 膨胀数十倍，也会触发香色的导入/切换异常。
 * 用香色原生 requestFilters 保存分类值，运行时只保留一个 action。
 */
function compactBookWorld(entries, { host, rules, responseType, warningFor }) {
  if (entries.length < 7) return null;
  const templates = entries.map((entry) => compactCategoryTemplate(entry.url, host));
  if (templates.some((template) => !template)) return null;

  const seenLabels = new Map();
  const labels = entries.map((entry, index) => {
    const label = entry.group ? `${entry.group}·${entry.title}` : entry.title;
    const base = String(label || `分类 ${index + 1}`).replace(/::|[\r\n]/g, " ");
    const occurrence = (seenLabels.get(base) || 0) + 1;
    seenLabels.set(base, occurrence);
    return `${occurrence === 1 ? base : `${base} (${occurrence})`}::${index}`;
  });
  const pageSize = listPageSizeForRequest(templates[0], entries[0]?.pageSize);
  const requestFilters = labels.map((label, index) => (
    `${label.slice(0, label.lastIndexOf("::") + 2)}${templates[index]}`
  ));

  warningFor("exploreUrl", `${entries.length} entries`)(
    `已将 ${entries.length} 个普通 GET 分类压缩为香色 requestFilters，避免分类动作过多导致导入或切换异常`,
  );
  return {
    分类: {
      ...commonAction("bookWorld", host, responseType),
      // 香色不会保证对 `%@filter` 注入值中的 `%@pageIndex` 做第二轮
      // 占位符替换。改用文档化的多键 params.filters，并由单个 JS 在
      // 运行时替换内部哨兵，避免实际请求残留字面量 `%@pageIndex`。
      requestInfo: [
        "@js:",
        'var f = (params.filters && params.filters.category) || params.filter || "";',
        'if (!f && params.filters) {',
        "  for (var k in params.filters) { if (params.filters[k]) { f = params.filters[k]; break; } }",
        "}",
        'return String(f).replace(/__READ2XSGG_PAGE__/g, String(params.pageIndex || 1));',
      ].join("\n"),
      ...mapBookRules(rules, responseType, warningFor, { listContext: true }),
      moreKeys: { pageSize, requestFilters: `_category\n${requestFilters.join("\n")}` },
      _sIndex: 0,
    },
  };
}

function buildBookWorld(source, context) {
  const { host, headers, warnings, sourceName, imageProxyBase = "" } = context;
  const exploreRules = getRules(source, "ruleExplore", "exploreRule");
  const searchRules = getRules(source, "ruleSearch", "searchRule");
  const warningFor = createWarningCollector(warnings, sourceName, "bookWorld");
  let entries = materializeCatalogExploreEntries(source, imageProxyBase, warningFor)
    || parseExploreEntries(source.exploreUrl, warningFor);
  const exploreUrlMissing = source.exploreUrl === undefined
    || source.exploreUrl === null
    || source.exploreUrl === "-"
    || (typeof source.exploreUrl === "string" && !source.exploreUrl.trim())
    || (Array.isArray(source.exploreUrl) && !source.exploreUrl.length);
  let useSearchRulesOnly = false;
  const exploreCoreComplete = Boolean(exploreRules.bookList && exploreRules.name && exploreRules.bookUrl);
  if (!entries.length) {
    const testKeyword = String(searchRules.checkKeyWord || "")
      .split(/[|,，\n]/)[0]
      .trim()
      // Only invent a keyword when a homepage crawl would otherwise be created
      // from explore rules with no exploreUrl — those selectors often match nav.
      || (exploreUrlMissing && exploreRules.bookList ? "小说" : "");
    const canSearchEntry = Boolean(
      source.searchUrl
      && searchRules.bookList
      && searchRules.name
      && searchRules.bookUrl
      && testKeyword
      && !/^(?:@js:|<js>)/i.test(String(source.searchUrl)),
    );
    if (canSearchEntry) {
      const request = String(source.searchUrl).replace(/\{\{\s*key\s*\}\}/gi, encodeURIComponent(testKeyword));
      entries = [{ title: "搜索入口", url: request }];
      useSearchRulesOnly = true;
      warningFor("exploreUrl", source.exploreUrl)(
        `缺少可移植发现分类，已使用搜索规则和测试关键词“${testKeyword}”生成分类入口`,
      );
    } else if (exploreUrlMissing && exploreCoreComplete && host) {
      entries = [{ title: "站点首页", url: host }];
      warningFor("exploreUrl", source.exploreUrl)("发现地址为空且原发现规则完整，已使用原发现规则生成站点首页入口");
    } else if (source.searchUrl && searchRules.bookList && searchRules.name && searchRules.bookUrl) {
      if (!testKeyword) {
        warningFor("exploreUrl", source.exploreUrl)("缺少可移植发现分类，搜索规则也没有测试关键词；不再生成必为空的伪分类");
        return {};
      }
      warningFor("exploreUrl", source.exploreUrl)("搜索请求依赖阅读 Android JavaScript，不能用它伪造可用分类");
      return {};
    }
  }

  const rules = { ...searchRules };
  if (!useSearchRulesOnly) {
    for (const [key, value] of Object.entries(exploreRules)) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      const searchFallback = searchRules[key];
      if (hasUnsupportedLegadoRuntime(String(value))
        && searchFallback !== undefined
        && searchFallback !== null
        && String(searchFallback).trim() !== ""
        && !hasUnsupportedLegadoRuntime(String(searchFallback))) {
        createWarningCollector(warnings, sourceName, "bookWorld")(`ruleExplore.${key}`, value)(
          `发现规则 ${key} 依赖阅读 Android 运行时，已自动回退到可执行的搜索规则`,
        );
        continue;
      }
      rules[key] = value;
    }
  } else if (exploreRules.coverUrl && !searchRules.coverUrl) {
    // 分类入口借用了搜索请求，但仍可沿用发现页的封面规则（常见为 img@src）。
    rules.coverUrl = exploreRules.coverUrl;
  }
  const effectiveCoreComplete = Boolean(rules.bookList && rules.name && rules.bookUrl);
  if (entries.length && !exploreCoreComplete && effectiveCoreComplete && !useSearchRulesOnly) {
    warningFor("ruleExplore", exploreRules)("发现页规则不完整，已用搜索规则补齐列表、书名或详情地址");
  }
  const responseType = inferResponseType(rules);
  const compacted = compactBookWorld(entries, { host, rules, responseType, warningFor });
  if (compacted) return compacted;
  const result = {};
  entries.forEach((entry, index) => {
    const baseTitle = entry.group ? `${entry.group}·${entry.title}` : (entry.title || `分类 ${index + 1}`);
    let title = baseTitle;
    let duplicate = 2;
    while (Object.hasOwn(result, title)) {
      title = `${baseTitle} (${duplicate})`;
      duplicate += 1;
    }
    const pageSize = listPageSizeForRequest(entry.url, entry.pageSize);
    result[title] = {
      ...commonAction("bookWorld", host, responseType),
      ...convertRequest(entry.url, { headers, warn: warningFor("exploreUrl", entry.url), fallback: "" }),
      ...mapBookRules(rules, responseType, warningFor, { listContext: true }),
      moreKeys: { pageSize },
      _sIndex: index,
    };
  });
  return result;
}

function convertOne(source, warnings, options = {}) {
  const adaptedFrom = String(source.bookSourceUrl ?? "");
  source = adaptLegadoSource(source);
  const sourceName = String(source.bookSourceName ?? source.name ?? "未命名书源").trim() || "未命名书源";
  const stored = resolveLegadoStoredRules(source);
  source = stored.source;
  const host = cleanBaseUrl(source.bookSourceUrl ?? source.url);
  const warningForSource = createWarningCollector(warnings, sourceName, "source");
  if (stored.changed) {
    warningForSource("storedRules", `${stored.changed} fields`)("已将阅读 @put/@get 状态规则编译为当前列表项或详情页的静态选择器/JSON 字段模板");
  }
  if (/alicesw\.com/i.test(adaptedFrom)) {
    warningForSource("siteAdapter", adaptedFrom)("已按 alicesw.com 实际页面结构修正阅读规则后再转换");
  }
  if (/(?:jmcomic|18comic|comic18j)/i.test(adaptedFrom)) {
    warningForSource("siteAdapter", adaptedFrom)("已提取禁漫动态发现分类，并显式补齐分类列表规则");
  }
  const searchRules = getRules(source, "ruleSearch", "searchRule");
  const detailRules = getRules(source, "ruleBookInfo", "bookInfoRule");
  const tocRules = getRules(source, "ruleToc", "tocRule");
  const exploreRulesEarly = getRules(source, "ruleExplore", "exploreRule");
  const headers = portableHeaders(mergeLegadoUrlOptionHeaders({
    ...parseHeaders(source.header, warningForSource("header", source.header)),
    ...(source.httpUserAgent ? { "User-Agent": String(source.httpUserAgent) } : {}),
  }, tocRules.chapterUrl, source.searchUrl, searchRules.coverUrl, detailRules.coverUrl, exploreRulesEarly.coverUrl), host, warningForSource);
  if (!host) warningForSource("bookSourceUrl", source.bookSourceUrl)("缺少有效的 bookSourceUrl，生成源可能无法发起请求");
  const resolvedType = sourceType(source);
  if ((source.bookSourceType === 3 || source.bookSourceType === "3") && resolvedType === "text") {
    warningForSource("bookSourceType", source.bookSourceType)("阅读的文件源类型在香色中没有直接等价类型，已按普通文本源输出");
  }
  if (![1, 2, 4, "1", "2", "4"].includes(source.bookSourceType) && resolvedType !== "text") {
    warningForSource("bookSourceType", source.bookSourceType)(`已根据源分组和正文媒体规则自动识别为 ${resolvedType}`);
  }
  if (source.loginUrl || source.loginUi || source.loginCheckJs) {
    warningForSource("loginUrl", source.loginUrl || source.loginUi)(
      "阅读源含登录/分流 UI（loginUrl/loginUi），香色无等价流程；Get('url') 已尽量回退为 config.host，镜像与登录态需手工处理",
    );
  }
  const contentRules = getRules(source, "ruleContent", "contentRule");
  const imageDecoder = decoderForLegadoImageRule(contentRules.imageDecode);
  const comicExtractionPlan = compileComicExtractionPlan(contentRules.content, headers);
  const explicitMediaResolution = contentRules.mediaResolution
    || source.read2xsgg?.mediaResolution
    || null;
  const mediaExtractionPlan = (resolvedType === "audio" || resolvedType === "video")
    ? compileMediaExtractionPlan(
      `${contentRules.content || ""}\n${tocRules.chapterUrl || ""}`,
      resolvedType,
      headers,
      {
        sourceRegex: contentRules.sourceRegex || "",
        resolution: explicitMediaResolution,
      },
    )
    : null;
  const isJmComic = resolvedType === "comic" && (
    ["jm-scramble", "id-md5-reverse-tiles"].includes(imageDecoder)
      || String(imageDecoder || "").startsWith("id-md5-reverse-tiles-")
      || /(?:jmcomic|18comic|comic18j)/i.test(adaptedFrom)
  );
  const isPrefixAesDecoder = imageDecoder === "mwwz-aes" || String(imageDecoder || "").startsWith("aes-cbc-prefix-iv-");
  if (contentRules.imageDecode) {
    const warning = createWarningCollector(warnings, sourceName, "chapterContent")("imageDecode", contentRules.imageDecode);
    if (imageDecoder && options.imageProxyBase) {
      warning(`已识别为 ${imageDecoder}；正文图片将通过 read2xsgg 图片解码代理加载`);
    } else if (imageDecoder) {
      warning(`已识别为 ${imageDecoder}，但当前转换没有公开图片代理地址；请用 HTTP 在线转换接口，或传入 imageProxyBase`);
    } else {
      warning("阅读 imageDecode（常见于漫画图片解扰）在香色无 Android 图形库，已忽略；混淆图需专用适配或手工规则");
    }
  }
  if (contentRules.imageStyle) {
    createWarningCollector(warnings, sourceName, "chapterContent")("imageStyle", contentRules.imageStyle)(
      "阅读 imageStyle 在香色无直接字段，已忽略",
    );
  }
  const context = { host, headers, warnings, sourceName, imageProxyBase: options.imageProxyBase || "" };

  const detailResponseType = inferResponseType(detailRules);
  const detailWarningFor = createWarningCollector(warnings, sourceName, "bookDetail");
  const tocResponseType = inferResponseType(tocRules);
  const tocWarningFor = createWarningCollector(warnings, sourceName, "chapterList");
  // 漫蛙 AES 规则的正文端点返回 {data:{images,pagination}} JSON；原 content
  // 只有 @js，单靠规则推断会误判为 HTML，导致香色先做 DOM 解析后正文为空。
  const contentResponseType = isPrefixAesDecoder && resolvedType === "comic"
    ? "json"
    : inferResponseType(contentRules);
  // Online comic conversion is rule-driven: the server receives a declarative
  // plan compiled from the original content rule and can parse HTML, JSON,
  // hydration scripts or plain URL lists without checking the source domain.
  const useHtmlComicImageAdapter = resolvedType === "comic" && Boolean(options.imageProxyBase)
    && Boolean(contentRules.content);
  const contentWarningFor = createWarningCollector(warnings, sourceName, "chapterContent");

  const bookDetail = {
    ...commonAction("bookDetail", host, detailResponseType),
    // 禁漫和香色的漫画详情动作不会可靠展开 %@result；使用与目录相同的运行时 URL 解析。
    requestInfo: isJmComic ? nativeJmRequestInfo() : (bookDetailRequestInfoOverride(source) || "%@result"),
    ...mapDetailRules(detailRules, detailResponseType, detailWarningFor),
  };

  // 《香色闺阁书源规则》§七：chapterList.requestInfo 的 result = 书籍详情页 URL。
  // 站点适配可覆盖 requestInfo，把详情 URL 改写成独立目录页。
  // 官方 bookDetail 无 tocUrl；若阅读源带 tocUrl，仅作额外提取字段，不能代替 §七 的 result 语义。
  const requestInfoOverride = chapterListRequestInfoOverride(source);
  let chapterListRequestInfo = requestInfoOverride || "%@result";
  let jsonApiToc = false;
  if (detailRules.tocUrl) {
    if (isDetailUrlAlias(detailRules.tocUrl)) {
      // tocUrl = baseUrl 表示目录就在详情页，不要转成 //baseUrl 这种假 XPath
      detailWarningFor("tocUrl", detailRules.tocUrl)(
        "阅读 tocUrl 为 baseUrl（目录即详情页），章节列表直接请求详情 URL",
      );
      chapterListRequestInfo = requestInfoOverride || "%@result";
    } else {
      const absoluteTocRequest = buildJsonApiTocRequestInfo(detailRules.tocUrl);
      if (absoluteTocRequest && !requestInfoOverride) {
        chapterListRequestInfo = absoluteTocRequest;
        jsonApiToc = true;
        detailWarningFor("tocUrl", detailRules.tocUrl)(
          "阅读 JSON API tocUrl 已编译为目录请求（从详情 URL / bookId 取 id，并用 pageIndex 翻页）",
        );
      } else {
        bookDetail.tocUrl = convertRule(detailRules.tocUrl, {
          responseType: detailResponseType,
          warn: detailWarningFor("tocUrl", detailRules.tocUrl),
        });
        if (!requestInfoOverride) {
          const nameTemplate = String(detailRules.name || "").trim().match(/^\{\{\s*([\s\S]*?)\s*\}\}$/)?.[0];
          const tocTemplate = String(detailRules.tocUrl || "");
          if (nameTemplate && tocTemplate.includes(nameTemplate)) {
            const request = tocTemplate.split(nameTemplate).join("{{book.name}}");
            chapterListRequestInfo = convertRequest(request, {
              headers,
              warn: tocWarningFor("request", request),
              fallback: "%@result",
            }).requestInfo;
            detailWarningFor("tocUrl", detailRules.tocUrl)("目录 URL 与详情书名使用同一字段，已改为从香色 queryInfo.bookName 构造目录请求");
          } else {
            // 非官方字段兜底：部分客户端若把 tocUrl 写入 queryInfo 则可直连目录
            chapterListRequestInfo = [
              "@js:",
              "var q = params.queryInfo || {};",
              'var u = (typeof result === "string") ? result : "";',
              'if (!u && result && typeof result === "object") u = result.detailUrl || result.url || "";',
              "u = String(q.tocUrl || q.detailUrl || u || q.url || \"\");",
              "return u;",
            ].join("\n");
          }
        }
        detailWarningFor("tocUrl", detailRules.tocUrl)(
          "阅读源含 tocUrl：已写入 bookDetail.tocUrl；章节请求仍以书源规则§七的 result（详情 URL）为准，请实测目录页",
        );
      }
    }
  }
  if (detailRules.tocUrl && detailResponseType === "html" && options.imageProxyBase
    && !jsonApiToc
    && !/^(?:@js:|<js>|https?:\/\/|\{\{)/i.test(String(detailRules.tocUrl).trim())) {
    const base = String(options.imageProxyBase).replace(/\/$/, "");
    const hint = tocLinkHint(detailRules.tocUrl);
    const selector = String(bookDetail.tocUrl || "");
    chapterListRequestInfo = runtimeAdapterRequestInfo(
      `${base}/adapter/toc?hint=${encodeURIComponent(hint)}&selector=${encodeURIComponent(selector)}&url=`,
    );
    detailWarningFor("tocUrl", detailRules.tocUrl)("HTML 详情页的独立目录链接已改由通用目录跳转器解析，避免依赖非标准 queryInfo.tocUrl");
  }

  const portableContent = portableJavaGetStringRule(
    contentRules.content,
    contentWarningFor("content", contentRules.content),
  );
  let content = contentRules.content !== undefined
    ? convertRule(portableContent ?? contentRules.content, {
      responseType: contentResponseType,
      warn: contentWarningFor("content", contentRules.content),
    })
    : undefined;
  if (isPrefixAesDecoder && options.imageProxyBase && resolvedType === "comic") {
    // This API returns JSON {data:{images:[{url}]}}. Rebuild the small result in
    // 香色 JS instead of preserving Legado's src/source.getVariable() runtime calls.
    content = proxiedJsonImageContent(options.imageProxyBase, imageDecoder);
  } else if ((["jm-scramble", "id-md5-reverse-tiles"].includes(imageDecoder)
    || String(imageDecoder || "").startsWith("id-md5-reverse-tiles-"))
    && options.imageProxyBase && resolvedType === "comic") {
    content = proxiedLineImageContent(content, options.imageProxyBase, imageDecoder);
  } else if (content && resolvedType === "comic") {
    content = wrapComicImageContent(content);
  }
  if (content && (resolvedType === "audio" || resolvedType === "video")) {
    content = wrapMediaContent(content, options.imageProxyBase);
  }

  const converted = {
    sourceName,
    sourceUrl: host,
    weight: sourceWeight(source),
    enable: source.enabled === false ? 0 : 1,
    miniAppVersion: minimumAppVersion(source),
    lastModifyTime: xsggModifyTime(source.lastUpdateTime),
    authorId: "",
    sourceType: resolvedType,
    ...(source.bookSourceComment ? { desc: String(source.bookSourceComment) } : {}),
    ...(Object.keys(headers).length ? { httpHeaders: headers } : {}),
    searchBook: buildBookAction({
      actionID: "searchBook",
      host,
      request: source.searchUrl,
      rules: searchRules,
      headers,
      warnings,
      sourceName,
      section: "searchBook",
    }),
    bookDetail,
    chapterList: {
      ...commonAction("chapterList", host, tocResponseType),
      requestInfo: chapterListRequestInfo,
      ...(() => {
        const mapped = mapTocRules(tocRules, tocResponseType, tocWarningFor);
        const httpChapterUrl = options.imageProxyBase
          ? compileHttpChapterUrlField(tocRules.chapterUrl)
          : null;
        if (httpChapterUrl) {
          mapped.url = httpChapterUrl;
          tocWarningFor("chapterUrl", tocRules.chapterUrl)(
            "章节播放地址模板已编译为桥接 urlTemplate（bookId 取自目录页 URL）",
          );
        }
        if (jsonApiToc) {
          // 香色：本页条数 < pageSize ⇒ 没有下一页。必须与上游 pageSize 对齐，
          // 否则 getBookMenu?pageSize=50 却声明 100，会在第一页后停止翻页。
          const upstreamSize = upstreamPageSizeFromTocUrl(detailRules.tocUrl) || 50;
          mapped.nextPageUrl = buildJsonApiTocNextPageUrl(detailRules.tocUrl);
          mapped.moreKeys = {
            ...(mapped.moreKeys || {}),
            pageSize: upstreamSize,
            maxPage: 500,
          };
        }
        return mapped;
      })(),
    },
    chapterContent: {
      ...commonAction("chapterContent", host, contentResponseType),
      // 禁漫正文 URL 与详情/目录一样必须从香色运行时上下文取值，不能裸用 %@result。
      requestInfo: isJmComic ? nativeJmRequestInfo() : "%@result",
      ...(content !== undefined ? { content } : {}),
      ...((contentRules.nextContentUrl || contentRules.nextUrl) ? {
        nextPageUrl: convertRule(contentRules.nextContentUrl || contentRules.nextUrl, {
          responseType: contentResponseType,
          warn: contentWarningFor("nextContentUrl", contentRules.nextContentUrl || contentRules.nextUrl),
        }),
        moreKeys: { maxPage: 50 },
      } : {}),
    },
    bookWorld: buildBookWorld(source, context),
    ...structuredClone(EMPTY_ACTIONS),
  };

  if (isJmComic) {
    // 7584 参照 6444 使用香色原生 HTML 目录动作，避免 JSON 动作在部分版本中空列表。
    converted.chapterList = nativeJmChapterList(host);
  }
  if (useHtmlComicImageAdapter) {
    converted.chapterContent = proxiedHtmlComicChapterContent(
      host,
      options.imageProxyBase,
      imageDecoder || "auto",
      comicExtractionPlan,
    );
  }
  const hasSourceRegex = Boolean(String(contentRules.sourceRegex || "").trim());
  const mediaRuleNeedsServer = contentResponseType === "json"
    || hasSourceRegex
    || /(?:\bjava\.|\bPackages\b|\bandroid\.|\bsource\.|\bbook\.|\bjavaScript\.)/i
      .test(String(contentRules.content || ""))
    || mediaPlanHasResolution(mediaExtractionPlan)
    || (mediaExtractionPlan?.properties || []).some((name) => /(?:path|url|uri|play|track|src|stream)/i.test(name));
  const hasMediaChapterUrl = Boolean(tocRules.chapterUrl && String(tocRules.chapterUrl).trim() !== "-");
  if ((resolvedType === "audio" || resolvedType === "video") && !contentRules.content && hasMediaChapterUrl) {
    converted.chapterContent.content = directMediaContent(options.imageProxyBase);
    contentWarningFor("content", contentRules.content)("正文为空但章节规则提供媒体 URL，已自动将章节 URL 作为播放地址");
  }
  if (resolvedType === "comic" && converted.chapterList.list && !converted.chapterList.url) {
    converted.chapterList.url = [
      "@js:",
      "var q = params.queryInfo || {};",
      'return String(q.detailUrl || q.url || params.responseUrl || config.host || "");',
    ].join("\n");
    tocWarningFor("chapterUrl", tocRules.chapterUrl)("单章节图片源没有 chapterUrl，已使用当前详情页作为章节地址");
  }
  if ((resolvedType === "audio" || resolvedType === "video") && options.imageProxyBase && mediaRuleNeedsServer) {
    converted.chapterContent = proxiedMediaChapterContent(
      host,
      options.imageProxyBase,
      resolvedType,
      mediaExtractionPlan,
    );
    if (mediaPlanHasResolution(mediaExtractionPlan)) {
      contentWarningFor("content", contentRules.content)(
        "已将正文多步媒体流程编译为声明式媒体解析计划（页面取值 → 二次请求 → 选择 URL）",
      );
    } else if (mediaRuleNeedsPortabilityWarning(contentRules, tocRules, mediaExtractionPlan)) {
      contentWarningFor("content", contentRules.content)(MEDIA_PORTABILITY_WARNING);
    } else {
      contentWarningFor("content", contentRules.content)(
        hasSourceRegex
          ? "阅读 sourceRegex 扩展名已编入媒体提取计划，正文改由通用媒体适配器解析播放地址（直连 CDN + 源站 httpHeaders）"
          : "正文为 JSON 媒体接口或依赖阅读 Android API，已改由通用媒体提取器解析播放地址",
      );
    }
  } else if ((resolvedType === "audio" || resolvedType === "video") && hasSourceRegex) {
    // Offline / no proxy: enable 香色 webView so the chapter page can load like
    // Legado's interceptor path; play URL still comes from content / wrapMediaContent.
    converted.chapterContent.requestInfo = [
      "@js:",
      'var u = String(result || "");',
      "if (!u && typeof params !== \"undefined\" && params.queryInfo) {",
      '  var q = params.queryInfo;',
      '  u = String(q.url || q.chapterUrl || q.detailUrl || "");',
      "}",
      "return {url: u, webView: true};",
    ].join("\n");
    if (mediaRuleNeedsPortabilityWarning(contentRules, tocRules, mediaExtractionPlan)) {
      contentWarningFor("sourceRegex", contentRules.sourceRegex)(MEDIA_PORTABILITY_WARNING);
    } else {
      contentWarningFor("sourceRegex", contentRules.sourceRegex)(
        "阅读 sourceRegex 已改由香色 webView 加载正文页；无转换站代理时无法服务端拦截网络流",
      );
    }
  }

  // apply replaceRegex / replaceRegex array onto content field. 2.56.1 的
  // 可用参考源统一用 `selector||@js:` 传递选择器结果。
  const replaceRegex = contentRules.replaceRegex ?? contentRules.replace;
  if (converted.chapterContent.content && replaceRegex) {
    const patterns = Array.isArray(replaceRegex) ? replaceRegex : [replaceRegex];
    const body = patterns
      .map((pattern) => compileReplaceRegexStatement(String(pattern), contentWarningFor("replaceRegex", pattern)))
      .filter(Boolean)
      .join("\n");
    if (body) {
      const current = String(converted.chapterContent.content);
      const marker = current.match(/\|\|\s*@js:/i);
      if (marker) {
        const selector = current.slice(0, marker.index).trim();
        const previous = current.slice(marker.index + marker[0].length).trim();
        converted.chapterContent.content = [
          `${selector}||@js:`,
          "var __read2xsggPrevious = (function (result) {",
          previous,
          "})(result);",
          'if (typeof __read2xsggPrevious !== "undefined") result = __read2xsggPrevious;',
          body,
          "return result;",
        ].join("\n");
      } else {
        converted.chapterContent.content += `||@js:\n${body}\nreturn result;`;
      }
    }
  }

  // Propagate site charset (often only declared on searchUrl) to every action so
  // Xiangse and /adapter bridges decode GBK pages instead of UTF-8 mojibake.
  const encoding = xiangseEncodeFields(detectLegadoCharset(source));
  if (Object.keys(encoding).length) {
    converted.searchBook = { ...converted.searchBook, ...encoding };
    converted.bookDetail = { ...converted.bookDetail, ...encoding };
    converted.chapterList = { ...converted.chapterList, ...encoding };
    converted.chapterContent = { ...converted.chapterContent, ...encoding };
    converted.bookWorld = Object.fromEntries(Object.entries(converted.bookWorld || {}).map(([title, action]) => (
      [title, { ...action, ...encoding }]
    )));
  }

  if (options.imageProxyBase) {
    converted.bookWorld = Object.fromEntries(Object.entries(converted.bookWorld || {}).map(([title, action]) => ([
      title,
      bridgeBookAction(action, options.imageProxyBase, headers),
    ])));
    converted.searchBook = bridgeBookAction(converted.searchBook, options.imageProxyBase, headers);
    converted.bookDetail = bridgeDetailAction(converted.bookDetail, options.imageProxyBase, headers);
    converted.chapterList = bridgeChapterAction(converted.chapterList, options.imageProxyBase, {
      tocSelector: jsonApiToc ? "" : (bookDetail.tocUrl || ""),
      headers,
    });
    if (resolvedType === "text") {
      converted.chapterContent = bridgeTextAction(converted.chapterContent, options.imageProxyBase, headers);
    }
  }
  // reverseChapters is only meaningful inside the bridge plan; never ship it to Xiangse.
  if (converted.chapterList && "reverseChapters" in converted.chapterList) {
    delete converted.chapterList.reverseChapters;
  }

  if (!source.searchUrl) warningForSource("searchUrl", source.searchUrl)("缺少 searchUrl，转换后的源不能搜索");
  if (!converted.searchBook.list) warningForSource("ruleSearch.bookList", searchRules.bookList)("缺少搜索列表规则");
  if (!converted.chapterList.list) warningForSource("ruleToc.chapterList", tocRules.chapterList)("缺少目录列表规则");
  if (!converted.chapterContent.content) warningForSource("ruleContent.content", contentRules.content)("缺少正文规则");
  return converted;
}

function completePortableAction(action, fields) {
  if (!action) return false;
  return fields.every((field) => (
    typeof action[field] === "string"
    && action[field].trim() !== ""
    && !hasUnsupportedLegadoRuntime(action[field])
  ));
}

function sanitizePortableAction(action, requiredFields, warnings, sourceName, section) {
  if (!action || typeof action !== "object") return action;
  const cleaned = { ...action };
  for (const [field, value] of Object.entries(cleaned)) {
    if (requiredFields.includes(field) || !hasUnsupportedLegadoRuntime(typeof value === "string" ? value : JSON.stringify(value))) continue;
    delete cleaned[field];
    warnings.push({
      source: sourceName,
      section,
      field,
      message: "该可选字段仍依赖阅读 Android 运行时，已删除字段并保留可执行的核心动作",
      rule: value,
    });
  }
  // Only chapter content used maxPage without nextPageUrl as a stale Legado leftover.
  // bookWorld/search/chapterList may intentionally set maxPage for adapter-side paging.
  if (
    section === "chapterContent"
    && !cleaned.nextPageUrl
    && cleaned.moreKeys
    && typeof cleaned.moreKeys === "object"
  ) {
    const moreKeys = { ...cleaned.moreKeys };
    delete moreKeys.maxPage;
    if (Object.keys(moreKeys).length) cleaned.moreKeys = moreKeys;
    else delete cleaned.moreKeys;
  }
  return cleaned;
}

function sanitizeConvertedActions(source, warnings) {
  const name = source.sourceName;
  const specs = {
    searchBook: ["requestInfo", "list", "bookName", "detailUrl"],
    bookDetail: ["requestInfo"],
    chapterList: ["requestInfo", "list", "title", "url"],
    chapterContent: ["requestInfo", "content"],
  };
  for (const [section, required] of Object.entries(specs)) {
    source[section] = sanitizePortableAction(source[section], required, warnings, name, section);
  }
  source.bookWorld = Object.fromEntries(Object.entries(source.bookWorld || {}).map(([title, action]) => ([
    title,
    sanitizePortableAction(
      action,
      ["requestInfo", "list", "bookName", "detailUrl"],
      warnings,
      name,
      `bookWorld.${title}`,
    ),
  ])));
  return source;
}

export function portableConvertedSource(source) {
  const world = Object.values(source?.bookWorld || {}).some((action) => (
    completePortableAction(action, ["requestInfo", "list", "bookName", "detailUrl"])
  ));
  const search = completePortableAction(source?.searchBook, ["requestInfo", "list", "bookName", "detailUrl"]);
  const detail = completePortableAction(source?.bookDetail, ["requestInfo"]);
  const toc = completePortableAction(source?.chapterList, ["requestInfo", "list", "title", "url"]);
  const content = completePortableAction(source?.chapterContent, ["requestInfo", "content"]);
  // 发现分类可选：无 bookWorld 但搜索可用时仍可导入。
  return {
    portable: Boolean(source?.sourceUrl && search && detail && toc && content),
    world,
    search,
    detail,
    toc,
    content,
  };
}

/**
 * Audio/video use the same core-chain / portable checks as text. sourceRegex and
 * Android JS rules are rewritten to the generic media adapter + /media proxy
 * (or 香色 webView when offline), so they are no longer omitted here.
 */
function nonPortableOnlineMediaReason() {
  return "";
}

function hasAdaptedMirrorHost(source) {
  const blob = [
    source?.bookSourceUrl,
    source?.bookSourceName,
    source?.loginUrl,
    source?.ruleContent?.imageDecode,
  ].join("\n");
  // 在线适配可能把 bookSourceUrl 改写成临时镜像域名，因此同时看名称/登录脚本/解扰特征。
  if (/(?:jmcomic|18comic|comic18j|mwwz|manwake|漫蛙|禁漫)/i.test(blob)) return true;
  if (/BitmapFactory|Canvas\s*\(\s*img\s*\)|GLOBAL_IMAGE_ROUTES|api\/comic\/image/i.test(blob)) return true;
  const decoder = decoderForLegadoImageRule(source?.ruleContent?.imageDecode);
  if (!decoder) return false;
  return decoder === "jm-scramble"
    || decoder === "mwwz-aes"
    || String(decoder).startsWith("id-md5-reverse-tiles")
    || String(decoder).startsWith("aes-cbc-prefix-iv-");
}

function sourceUsesLoginGet(source) {
  const blob = [
    source?.searchUrl,
    source?.exploreUrl,
    JSON.stringify(source?.ruleSearch || {}),
    JSON.stringify(source?.ruleToc || {}),
    JSON.stringify(source?.ruleContent || {}),
    JSON.stringify(source?.ruleBookInfo || {}),
  ].join("\n");
  return /\{\{\s*(?:Get|get)\s*\(/i.test(blob) || /(?:^|[^.\w])Get\s*\(/i.test(blob);
}

function nonPortableImageDecodeReason(source, options = {}) {
  const contentRules = getRules(source, "ruleContent", "contentRule");
  if (!contentRules.imageDecode) return "";
  const imageDecoder = decoderForLegadoImageRule(contentRules.imageDecode);
  if (!imageDecoder) {
    return "未知 imageDecode，漫画图片将花屏";
  }
  if (!options.imageProxyBase) {
    return "已识别 imageDecode，但缺少图片解码代理（imageProxyBase），在线转换才能安全导出";
  }
  return "";
}

function nonPortableLoginReason(source) {
  if (!(source?.loginUrl || source?.loginUi || source?.loginCheckJs)) return "";
  if (hasAdaptedMirrorHost(source)) return "";
  if (!sourceUsesLoginGet(source)) return "";
  return "依赖登录/分流变量 Get(...)，香色无法复现阅读登录 UI";
}

function nonPortableEmptyRequestReason(converted) {
  const worlds = Object.values(converted?.bookWorld || {});
  const actions = [...worlds, converted?.searchBook].filter(Boolean);
  for (const action of actions) {
    const info = String(action?.requestInfo || "").trim();
    if (!info) return "分类/搜索请求地址为空";
    // Unconvertible Legado search JS often collapses to `let url = ""` with POST.
    if (/^@js:/i.test(info) && /\blet\s+url\s*=\s*""\s*;/.test(info) && /\bPOST\s*:\s*true\b/.test(info)) {
      return "搜索/分类请求无法生成有效 URL（阅读 JavaScript 不可移植）";
    }
  }
  return "";
}

function nonPortableOmitReason(source, converted, options = {}) {
  return nonPortableOnlineMediaReason(source, converted)
    || nonPortableImageDecodeReason(source, options)
    || nonPortableLoginReason(source)
    || nonPortableEmptyRequestReason(converted);
}

export function convertLegado(input, options = {}) {
  const warnings = [];
  const sources = {};
  const skipped = [];
  for (const source of normalizeInput(input)) {
    if (!source || typeof source !== "object") continue;
    const converted = convertOne(source, warnings, options);
    if (options.omitNonPortable) {
      const mediaReason = nonPortableOmitReason(source, converted, options);
      if (mediaReason) {
        skipped.push({ source: converted.sourceName, reason: mediaReason });
        warnings.push({
          source: converted.sourceName,
          section: "source",
          field: "compatibility",
          message: `已从在线 XBS 跳过，避免导入不可用源：${mediaReason}`,
          rule: "",
        });
        continue;
      }
      sanitizeConvertedActions(converted, warnings);
      converted.bookWorld = Object.fromEntries(Object.entries(converted.bookWorld || {}).filter(([, action]) => (
        completePortableAction(action, ["requestInfo", "list", "bookName", "detailUrl"])
      )));
      const compatibility = portableConvertedSource(converted);
      if (!compatibility.portable) {
        const failed = Object.entries(compatibility)
          .filter(([key, value]) => key !== "portable" && !value)
          .map(([key]) => key)
          .join(", ");
        skipped.push({ source: converted.sourceName, reason: `香色核心链路不可执行：${failed}` });
        warnings.push({
          source: converted.sourceName,
          section: "source",
          field: "compatibility",
          message: `已从在线 XBS 跳过，避免导入不可用源：${failed}`,
          rule: "",
        });
        continue;
      }
    }
    let name = converted.sourceName;
    let suffix = 2;
    while (sources[name]) {
      name = `${converted.sourceName} (${suffix})`;
      suffix += 1;
    }
    if (name !== converted.sourceName) {
      warnings.push({
        source: converted.sourceName,
        section: "source",
        field: "bookSourceName",
        message: `存在重名书源，已重命名为 ${name}`,
        rule: converted.sourceName,
      });
      converted.sourceName = name;
    }
    sources[name] = converted;
  }
  const seenWarnings = new Set();
  const uniqueWarnings = warnings.filter((warning) => {
    const key = JSON.stringify(warning);
    if (seenWarnings.has(key)) return false;
    seenWarnings.add(key);
    return true;
  });
  return { sources, warnings: uniqueWarnings, skipped, skippedBuckets: skippedBuckets(skipped) };
}

/** 将 skipped 条目按原因分桶，便于聚合源质量报告。 */
export function skippedBuckets(skipped = []) {
  const buckets = {};
  for (const item of skipped) {
    const reason = String(item?.reason || "unknown");
    let key = "other";
    if (/上游站点不可访问|没有数据|dead-origin/i.test(reason)) key = "dead-origin";
    else if (/imageDecode|花屏|解码代理/i.test(reason)) key = "imageDecode";
    else if (/登录|分流|Get\s*\(/i.test(reason)) key = "login";
    else if (/sourceRegex|媒体流|可播放|媒体/i.test(reason)) key = "media";
    else if (/有效 URL|请求地址为空|不可移植/i.test(reason)) key = "core-chain";
    else if (/核心链路/i.test(reason)) key = "core-chain";
    else if (/rules-stale/i.test(reason)) key = "rules-stale";
    else if (/analyze-failed/i.test(reason)) key = "analyze-failed";
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return buckets;
}
