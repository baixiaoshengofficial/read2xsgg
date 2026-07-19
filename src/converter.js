import { convertRule, inferResponseType } from "./selectors.js";
import { convertRequest, parseHeaders } from "./requests.js";
import { adaptLegadoSource, bookDetailRequestInfoOverride, chapterListRequestInfoOverride } from "./siteAdapters.js";
import { decoderForLegadoImageRule } from "./imageDecoder.js";
import { compileComicExtractionPlan, encodeComicExtractionPlan } from "./comicPlan.js";
import { compileMediaExtractionPlan, encodeMediaExtractionPlan } from "./mediaPlan.js";
import { hasUnsupportedLegadoRuntime } from "./legadoJs.js";

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
  if (/\|@js:/.test(contentRule)) return contentRule;
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
  return `${contentRule}|${wrapJs}`;
}

/**
 * 有声正文：香色 audio 期望 content 最终给出可播媒体。
 * 参考官方样例（海洋听书/老白故事）：返回 JSON 字符串 {url, httpHeaders, forbidCache}。
 */
function wrapMediaContent(contentRule) {
  if (!contentRule) return contentRule;
  // 已显式构造播放 JSON 的 JS，不再二次包装
  if (/JSON\.stringify\s*\(\s*\{[\s\S]*\burl\b/i.test(contentRule)) return contentRule;
  if (/forbidCache/i.test(contentRule) && /\burl\s*:/i.test(contentRule)) return contentRule;
  const wrapJs = [
    "@js:",
    "var url = String(result || \"\").trim();",
    "if (!url) return url;",
    "if (url.charAt(0) === \"{\") return url;",
    // 正文里偶发 <audio src> / 纯链接混排，取第一个像媒体的 URL
    "var m = url.match(/https?:\\/\\/[^\\s\"'<>]+\\.(?:mp3|m4a|aac|ogg|wav|flac)(?:\\?[^\\s\"'<>]*)?/i)",
    "  || url.match(/https?:\\/\\/[^\\s\"'<>]+/i)",
    "  || (url.charAt(0) === \"/\" ? [null, url] : null);",
    "if (m) url = m[1] || m[0];",
    "return JSON.stringify({",
    "  url: encodeURI(url),",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");
  if (/\|@js:/.test(contentRule)) {
    // 已有后处理：在末尾再叠一层播放包装（香色多段 |@js 取最后 result 链）
    return `${contentRule}|${wrapJs}`;
  }
  return `${contentRule}|${wrapJs}`;
}

/** Audio/video sources often put the playable URL directly in chapterUrl. */
function directMediaContent() {
  return [
    "@js:",
    'var q = (typeof params !== "undefined" && params.queryInfo) || {};',
    'var url = String(q.url || q.detailUrl || q.chapterUrl || "").trim();',
    'if (!url && typeof result === "string" && /^(?:https?:)?\\/\\//i.test(result.trim())) url = result.trim();',
    'if (url.indexOf("//") === 0) url = "https:" + url;',
    'else if (url && !/^https?:\\/\\//i.test(url)) url = config.host + (url.charAt(0) === "/" ? url : "/" + url);',
    "return JSON.stringify({",
    "  url: encodeURI(url),",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");
}

/** A known encrypted comic API can be rendered through the server image proxy. */
function proxiedJsonImageContent(imageProxyBase, decoder) {
  const endpoint = `${String(imageProxyBase).replace(/\/$/, "")}/image/${decoder}?url=`;
  return [
    "@js:",
    "var payload = (typeof result === \"string\") ? JSON.parse(result) : result;",
    "var images = payload && payload.data && Array.isArray(payload.data.images) ? payload.data.images : [];",
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
  const selector = String(contentRule || "").split("|@js:", 1)[0];
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
  return selector ? `${selector}|${proxyJs}` : proxyJs;
}

function nativeJmRequestInfo() {
  return [
    "@js:",
    'var u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (u == "%@result") u = "";',
    'if (!u && params && params.queryInfo) u = params.queryInfo.detailUrl || params.queryInfo.url || "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    "return encodeURI(u);",
  ].join("\n");
}

/** Generic action URL resolver for clients that leave %@result as a literal. */
function runtimeAdapterRequestInfo(endpoint) {
  return [
    "@js:",
    'var u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (u == "%@result") u = "";',
    'if (!u && params && params.queryInfo) u = params.queryInfo.detailUrl || params.queryInfo.url || "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
  ].join("\n");
}

function tocLinkHint(rule) {
  const source = String(rule || "");
  return source.match(/(?:text\(\)|text\.)\s*(?:=|,)?\s*["']([^"']{1,32})["']/i)?.[1]
    || source.match(/["']([^"']*(?:章节|目录|chapter|catalog)[^"']*)["']/i)?.[1]
    || "";
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
      "@js:",
      'var payload = (typeof result === "string") ? JSON.parse(result) : result;',
      'var images = payload && Array.isArray(payload.urls) ? payload.urls : [];',
      `var endpoint = ${JSON.stringify(imageEndpoint)};`,
      'var urls = images.map(function (url) { return endpoint + encodeURIComponent(String(url || "")); }).filter(Boolean);',
      'return JSON.stringify({urls: urls, httpHeaders: {}});',
    ].join("\n"),
  };
}

/** Generic server-side audio/video URL extraction for JSON and Android-only rules. */
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
      if (from === "kind") {
        const convertedKind = portableKindRule(rules[from], responseType, warningFor, initPath);
        if (listContext && /^\s*@js:/i.test(convertedKind) && /(?:\bjava\.|\bPackages\b|\bsource\.|\bbook\.)/i.test(convertedKind)) {
          warningFor("kind", rules[from])("列表分类字段依赖阅读专用 JavaScript，已忽略以避免香色丢弃整个列表");
          continue;
        }
        result[to] = convertedKind;
        continue;
      }
      const convertedRule = convertRule(rules[from], { responseType, warn: warningFor(from, rules[from]) });
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
  for (const [from, to] of Object.entries(mapping)) {
    if (rules[from] !== undefined && rules[from] !== "") {
      result[to] = convertRule(rules[from], { responseType, warn: warningFor(from, rules[from]) });
    }
  }
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
  if (rules.bookList && !action.moreKeys) action.moreKeys = { pageSize: 20 };
  return action;
}

function parseExploreEntries(exploreUrl, warningFor) {
  if (!exploreUrl || exploreUrl === "-") return [];
  if (Array.isArray(exploreUrl)) return exploreUrl.filter((item) => item?.title && item?.url);
  const source = String(exploreUrl).trim();
  if (/^(?:@js:|<js>)/i.test(source)) {
    warningFor("exploreUrl", exploreUrl)("发现页依赖阅读 Android JavaScript，无法安全执行；将尝试生成通用搜索入口分类");
    return [];
  }
  if (source.startsWith("[")) {
    try {
      return JSON.parse(source).filter((item) => item?.title && item?.url);
    } catch {
      warningFor("exploreUrl", exploreUrl)("发现页配置看似 JSON，但解析失败，已尝试按 title::url 行解析");
    }
  }
  let group = "";
  return source.split(/\r?\n/).map((line) => {
    const value = line.trim();
    const separator = value.indexOf("::");
    if (separator <= 0) {
      // 阅读发现页常以“——总点击——”这类无 URL 的行分组；保留它，
      // 否则后面重复的“玄幻”等名称会在香色对象中互相覆盖。
      if (value) group = value.replace(/[—－\-\s]/g, "") || group;
      return null;
    }
    return { title: value.slice(0, separator).trim(), url: value.slice(separator + 2).trim(), group };
  }).filter((item) => item?.title && item?.url);
}

function buildBookWorld(source, context) {
  const { host, headers, warnings, sourceName } = context;
  const exploreRules = getRules(source, "ruleExplore", "exploreRule");
  const searchRules = getRules(source, "ruleSearch", "searchRule");
  const rules = { ...searchRules };
  for (const [key, value] of Object.entries(exploreRules)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") rules[key] = value;
  }
  const warningFor = createWarningCollector(warnings, sourceName, "bookWorld");
  let entries = parseExploreEntries(source.exploreUrl, warningFor);
  const exploreCoreComplete = Boolean(exploreRules.bookList && exploreRules.name && exploreRules.bookUrl);
  const effectiveCoreComplete = Boolean(rules.bookList && rules.name && rules.bookUrl);
  if (entries.length && !exploreCoreComplete && effectiveCoreComplete) {
    warningFor("ruleExplore", exploreRules)("发现页规则不完整，已用搜索规则补齐列表、书名或详情地址");
  }
  if (!entries.length) {
    if (effectiveCoreComplete && exploreRules.bookList && host) {
      entries = [{ title: "站点首页", url: host }];
      warningFor("exploreUrl", source.exploreUrl)("缺少可移植发现分类，已使用原发现规则生成站点首页入口");
    } else if (source.searchUrl && searchRules.bookList && searchRules.name && searchRules.bookUrl) {
      const testKeyword = String(searchRules.checkKeyWord || "")
        .split(/[|,，\n]/)[0]
        .trim();
      let request = String(source.searchUrl);
      if (/^(?:@js:|<js>)/i.test(request)) {
        warningFor("exploreUrl", source.exploreUrl)("搜索请求依赖阅读 Android JavaScript，不能用它伪造可用分类");
        return {};
      } else {
        request = request.replace(/\{\{\s*key\s*\}\}/gi, encodeURIComponent(testKeyword));
      }
      entries = [{ title: "搜索入口", url: request }];
      warningFor("exploreUrl", source.exploreUrl)(
        testKeyword
          ? `缺少可移植发现分类，已使用搜索规则和测试关键词“${testKeyword}”生成分类入口`
          : "缺少可移植发现分类，已使用搜索规则生成分类入口",
      );
    }
  }
  const responseType = inferResponseType(rules);
  const result = {};
  entries.forEach((entry, index) => {
    const baseTitle = entry.group ? `${entry.group}·${entry.title}` : (entry.title || `分类 ${index + 1}`);
    let title = baseTitle;
    let duplicate = 2;
    while (Object.hasOwn(result, title)) {
      title = `${baseTitle} (${duplicate})`;
      duplicate += 1;
    }
    const configuredPageSize = Number(entry.pageSize);
    const pageSize = Number.isInteger(configuredPageSize) && configuredPageSize > 0 ? configuredPageSize : 20;
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
  const host = cleanBaseUrl(source.bookSourceUrl ?? source.url);
  const warningForSource = createWarningCollector(warnings, sourceName, "source");
  if (/alicesw\.com/i.test(adaptedFrom)) {
    warningForSource("siteAdapter", adaptedFrom)("已按 alicesw.com 实际页面结构修正阅读规则后再转换");
  }
  if (/(?:jmcomic|18comic|comic18j)/i.test(adaptedFrom)) {
    warningForSource("siteAdapter", adaptedFrom)("已提取禁漫动态发现分类，并显式补齐分类列表规则");
  }
  const headers = portableHeaders({
    ...parseHeaders(source.header, warningForSource("header", source.header)),
    ...(source.httpUserAgent ? { "User-Agent": String(source.httpUserAgent) } : {}),
  }, host, warningForSource);
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

  const searchRules = getRules(source, "ruleSearch", "searchRule");
  const detailRules = getRules(source, "ruleBookInfo", "bookInfoRule");
  const tocRules = getRules(source, "ruleToc", "tocRule");
  const contentRules = getRules(source, "ruleContent", "contentRule");
  const imageDecoder = decoderForLegadoImageRule(contentRules.imageDecode);
  const comicExtractionPlan = compileComicExtractionPlan(contentRules.content);
  const mediaExtractionPlan = (resolvedType === "audio" || resolvedType === "video")
    ? compileMediaExtractionPlan(`${contentRules.content || ""}\n${tocRules.chapterUrl || ""}`, resolvedType)
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
  const context = { host, headers, warnings, sourceName };

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
  if (detailRules.tocUrl) {
    if (isDetailUrlAlias(detailRules.tocUrl)) {
      // tocUrl = baseUrl 表示目录就在详情页，不要转成 //baseUrl 这种假 XPath
      detailWarningFor("tocUrl", detailRules.tocUrl)(
        "阅读 tocUrl 为 baseUrl（目录即详情页），章节列表直接请求详情 URL",
      );
      chapterListRequestInfo = requestInfoOverride || "%@result";
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
  if (detailRules.tocUrl && detailResponseType === "html" && options.imageProxyBase
    && !/^(?:@js:|<js>|https?:\/\/|\{\{)/i.test(String(detailRules.tocUrl).trim())) {
    const base = String(options.imageProxyBase).replace(/\/$/, "");
    const hint = tocLinkHint(detailRules.tocUrl);
    chapterListRequestInfo = runtimeAdapterRequestInfo(
      `${base}/adapter/toc?hint=${encodeURIComponent(hint)}&url=`,
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
    content = wrapMediaContent(content);
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
      ...mapTocRules(tocRules, tocResponseType, tocWarningFor),
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
        moreKeys: { maxPage: 999 },
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
  const mediaRuleNeedsServer = contentResponseType === "json"
    || /(?:\bjava\.|\bPackages\b|\bandroid\.|\bsource\.|\bbook\.|\bjavaScript\.)/i
      .test(String(contentRules.content || ""));
  const hasMediaChapterUrl = Boolean(tocRules.chapterUrl && String(tocRules.chapterUrl).trim() !== "-");
  if ((resolvedType === "audio" || resolvedType === "video") && !contentRules.content && hasMediaChapterUrl) {
    converted.chapterContent.content = directMediaContent();
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
  if ((resolvedType === "audio" || resolvedType === "video") && options.imageProxyBase
    && hasMediaChapterUrl && mediaRuleNeedsServer) {
    converted.chapterContent = proxiedMediaChapterContent(
      host,
      options.imageProxyBase,
      resolvedType,
      mediaExtractionPlan,
    );
    contentWarningFor("content", contentRules.content)("正文为 JSON 媒体接口或依赖阅读 Android API，已改由通用媒体提取器解析播放地址");
  }

  // apply replaceRegex / replaceRegex array onto content field
  // 香色后处理语法是「xpath|@js:」（单竖线）；「||@js:」会被当成备选规则导致正文为空。
  const replaceRegex = contentRules.replaceRegex ?? contentRules.replace;
  if (converted.chapterContent.content && replaceRegex) {
    const patterns = Array.isArray(replaceRegex) ? replaceRegex : [replaceRegex];
    const body = patterns
      .map((pattern) => `result = String(result).replace(new RegExp(${JSON.stringify(String(pattern))}, "g"), "");`)
      .join("\n");
    converted.chapterContent.content += `|@js:\n${body}\nreturn result;`;
  }

  if (!source.searchUrl) warningForSource("searchUrl", source.searchUrl)("缺少 searchUrl，转换后的源不能搜索");
  if (!converted.searchBook.list) warningForSource("ruleSearch.bookList", searchRules.bookList)("缺少搜索列表规则");
  if (!converted.chapterList.list) warningForSource("ruleToc.chapterList", tocRules.chapterList)("缺少目录列表规则");
  if (!converted.chapterContent.content) warningForSource("ruleContent.content", contentRules.content)("缺少正文规则");
  return converted;
}

function completePortableAction(action, fields) {
  if (!action || hasUnsupportedLegadoRuntime(JSON.stringify(action))) return false;
  return fields.every((field) => typeof action[field] === "string" && action[field].trim() !== "");
}

export function portableConvertedSource(source) {
  const world = Object.values(source?.bookWorld || {}).some((action) => (
    completePortableAction(action, ["requestInfo", "list", "bookName", "detailUrl"])
  ));
  const search = completePortableAction(source?.searchBook, ["requestInfo", "list", "bookName", "detailUrl"]);
  const detail = completePortableAction(source?.bookDetail, ["requestInfo"]);
  const toc = completePortableAction(source?.chapterList, ["requestInfo", "list", "title", "url"]);
  const content = completePortableAction(source?.chapterContent, ["requestInfo", "content"]);
  return { portable: Boolean(source?.sourceUrl && world && search && detail && toc && content), world, search, detail, toc, content };
}

export function convertLegado(input, options = {}) {
  const warnings = [];
  const sources = {};
  const skipped = [];
  for (const source of normalizeInput(input)) {
    if (!source || typeof source !== "object") continue;
    const converted = convertOne(source, warnings, options);
    if (options.omitNonPortable) {
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
  return { sources, warnings: uniqueWarnings, skipped };
}
