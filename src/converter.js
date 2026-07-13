import { convertRule, inferResponseType } from "./selectors.js";
import { convertRequest, parseHeaders } from "./requests.js";

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

function sourceType(type) {
  if (type === 1 || type === "1") return "audio";
  if (type === 2 || type === "2") return "comic";
  return undefined;
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

function commonAction(actionID, host, responseFormatType) {
  return { actionID, validConfig: "", host, responseFormatType, parserID: "DOM" };
}

function mapBookRules(rules, responseType, warningFor) {
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
      result[to] = convertRule(rules[from], { responseType, warn: warningFor(from, rules[from]) });
    }
  }
  return result;
}

function mapDetailRules(rules, responseType, warningFor) {
  const result = mapBookRules(rules, responseType, warningFor);
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
    ...mapBookRules(rules, responseType, warningFor),
  };
  if (rules.bookList && !action.moreKeys) action.moreKeys = { pageSize: 20 };
  return action;
}

function parseExploreEntries(exploreUrl, warningFor) {
  if (!exploreUrl || exploreUrl === "-") return [];
  if (Array.isArray(exploreUrl)) return exploreUrl.filter((item) => item?.title && item?.url);
  const source = String(exploreUrl).trim();
  if (source.startsWith("[")) {
    try {
      return JSON.parse(source).filter((item) => item?.title && item?.url);
    } catch {
      warningFor("exploreUrl", exploreUrl)("发现页配置看似 JSON，但解析失败，已尝试按 title::url 行解析");
    }
  }
  return source.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("::");
    return separator > 0 ? { title: line.slice(0, separator).trim(), url: line.slice(separator + 2).trim() } : null;
  }).filter((item) => item?.title && item?.url);
}

function buildBookWorld(source, context) {
  const { host, headers, warnings, sourceName } = context;
  const rules = getRules(source, "ruleExplore", "exploreRule");
  const warningFor = createWarningCollector(warnings, sourceName, "bookWorld");
  const entries = parseExploreEntries(source.exploreUrl, warningFor);
  const responseType = inferResponseType(rules);
  const result = {};
  entries.forEach((entry, index) => {
    const title = entry.title || `分类 ${index + 1}`;
    result[title] = {
      ...commonAction("bookWorld", host, responseType),
      ...convertRequest(entry.url, { headers, warn: warningFor("exploreUrl", entry.url), fallback: "" }),
      ...mapBookRules(rules, responseType, warningFor),
      moreKeys: { pageSize: 20 },
      _sIndex: index,
    };
  });
  return result;
}

function convertOne(source, warnings) {
  const sourceName = String(source.bookSourceName ?? source.name ?? "未命名书源").trim() || "未命名书源";
  const host = cleanBaseUrl(source.bookSourceUrl ?? source.url);
  const warningForSource = createWarningCollector(warnings, sourceName, "source");
  const headers = parseHeaders(source.header, warningForSource("header", source.header));
  if (!host) warningForSource("bookSourceUrl", source.bookSourceUrl)("缺少有效的 bookSourceUrl，生成源可能无法发起请求");
  if (source.bookSourceType === 3 || source.bookSourceType === "3") {
    warningForSource("bookSourceType", source.bookSourceType)("阅读的文件源类型在香色中没有直接等价类型，已按普通文本源输出");
  }

  const searchRules = getRules(source, "ruleSearch", "searchRule");
  const detailRules = getRules(source, "ruleBookInfo", "bookInfoRule");
  const tocRules = getRules(source, "ruleToc", "tocRule");
  const contentRules = getRules(source, "ruleContent", "contentRule");
  const context = { host, headers, warnings, sourceName };

  const detailResponseType = inferResponseType(detailRules);
  const detailWarningFor = createWarningCollector(warnings, sourceName, "bookDetail");
  const tocResponseType = inferResponseType(tocRules);
  const tocWarningFor = createWarningCollector(warnings, sourceName, "chapterList");
  const contentResponseType = inferResponseType(contentRules);
  const contentWarningFor = createWarningCollector(warnings, sourceName, "chapterContent");

  const converted = {
    sourceName,
    sourceUrl: host,
    weight: String(source.customOrder ?? source.weight ?? 0),
    enable: source.enabled === false ? 0 : 1,
    miniAppVersion: "2.56.1",
    lastModifyTime: xsggModifyTime(source.lastUpdateTime),
    authorId: "",
    ...(source.bookSourceComment ? { desc: String(source.bookSourceComment) } : {}),
    ...(sourceType(source.bookSourceType) ? { sourceType: sourceType(source.bookSourceType) } : {}),
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
    bookDetail: {
      ...commonAction("bookDetail", host, detailResponseType),
      requestInfo: "%@result",
      ...mapDetailRules(detailRules, detailResponseType, detailWarningFor),
    },
    chapterList: {
      ...commonAction("chapterList", host, tocResponseType),
      requestInfo: "%@result",
      ...mapTocRules(tocRules, tocResponseType, tocWarningFor),
    },
    chapterContent: {
      ...commonAction("chapterContent", host, contentResponseType),
      requestInfo: "%@result",
      ...(contentRules.content !== undefined ? {
        content: convertRule(contentRules.content, {
          responseType: contentResponseType,
          warn: contentWarningFor("content", contentRules.content),
        }),
      } : {}),
      ...(contentRules.nextContentUrl ? {
        nextPageUrl: convertRule(contentRules.nextContentUrl, {
          responseType: contentResponseType,
          warn: contentWarningFor("nextContentUrl", contentRules.nextContentUrl),
        }),
        moreKeys: { maxPage: 999 },
      } : {}),
    },
    bookWorld: buildBookWorld(source, context),
    ...structuredClone(EMPTY_ACTIONS),
  };

  if (!source.searchUrl) warningForSource("searchUrl", source.searchUrl)("缺少 searchUrl，转换后的源不能搜索");
  if (!converted.searchBook.list) warningForSource("ruleSearch.bookList", searchRules.bookList)("缺少搜索列表规则");
  if (!converted.chapterList.list) warningForSource("ruleToc.chapterList", tocRules.chapterList)("缺少目录列表规则");
  if (!converted.chapterContent.content) warningForSource("ruleContent.content", contentRules.content)("缺少正文规则");
  return converted;
}

export function convertLegado(input) {
  const warnings = [];
  const sources = {};
  for (const source of normalizeInput(input)) {
    if (!source || typeof source !== "object") continue;
    const converted = convertOne(source, warnings);
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
  return { sources, warnings: uniqueWarnings };
}
