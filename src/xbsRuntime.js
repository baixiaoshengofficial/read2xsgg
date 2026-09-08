import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { decodeXbs } from "./xbs.js";
import { encodeFormBody } from "./charset.js";
import { orderChaptersAscending } from "./bridgePlan.js";

function splitPostScript(rule) {
  const source = String(rule || "").trim();
  // Pure client script (common for audio/video direct URL payloads).
  if (/^@js:/i.test(source)) {
    return { selector: "", script: source.replace(/^@js:\s*/i, "").trim() };
  }
  // Match the 2.56.1-compatible form used by the maintained public corpus.
  // Keeping the validator strict prevents generated single-pipe rules from
  // passing our tests while producing empty fields in the real client.
  const match = source.match(/\|\|\s*@js:/i);
  if (!match) return { selector: source, script: "" };
  return {
    selector: source.slice(0, match.index).trim(),
    script: source.slice(match.index + match[0].length).trim(),
  };
}

function runJavaScript(script, config, params, result) {
  if (!String(script || "").trim()) return result;
  return new Function("config", "params", "result", String(script))(config, params, result);
}

function xpathValues(document, expression, context = document) {
  const view = document.defaultView;
  const result = document.evaluate(expression, context, null, view.XPathResult.ANY_TYPE, null);
  if (result.resultType === view.XPathResult.STRING_TYPE) return [result.stringValue];
  if (result.resultType === view.XPathResult.NUMBER_TYPE) return [String(result.numberValue)];
  if (result.resultType === view.XPathResult.BOOLEAN_TYPE) return [String(result.booleanValue)];
  const values = [];
  let node;
  while ((node = result.iterateNext())) values.push(node);
  return values;
}

function htmlDocument(value, wrapItem = false) {
  const sanitize = (html) => String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, "");
  if (!wrapItem) return new JSDOM(sanitize(value)).window.document;
  const html = value?.outerHTML || value?.textContent || String(value || "");
  return new JSDOM(`<!doctype html><html><body>${sanitize(html)}</body></html>`).window.document;
}

function xpathNeedsIsolatedItem(expression) {
  const value = String(expression || "").trim();
  return /(?:^|[\s(=,|])\/\//.test(value)
    || /(?:^|[\s(=,|])\/html(?:\/|\b)/i.test(value);
}

function nodeValue(node, { content = false } = {}) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.nodeType === 2 || node.nodeType === 3) return String(node.nodeValue || "").trim();
  if (node.nodeType === 9) return String(node.documentElement?.textContent || "").trim();
  if (content && node.innerHTML != null) return String(node.innerHTML);
  return String(node.textContent || "").trim();
}

function htmlSelect(rule, input, {
  list = false,
  content = false,
  config,
  params,
  document: preparedDocument,
} = {}) {
  const { selector, script } = splitPostScript(rule);
  if (!selector && script && !list) {
    const result = typeof input === "string"
      ? input
      : nodeValue(input, { content });
    return runJavaScript(script, config, params, result);
  }
  let selected = [];
  if (selector) {
    const itemInput = Boolean(input?.nodeType && input.nodeType !== 9);
    const document = preparedDocument
      || (itemInput ? (input.ownerDocument || input) : input?.nodeType === 9 ? input : htmlDocument(input));
    for (const alternative of selector.split(/\s*\|\|\s*/).filter(Boolean)) {
      try {
        let expression = alternative.trim();
        let evaluationDocument = document;
        let evaluationContext = itemInput ? input : document;
        if (itemInput) {
          if (expression.startsWith("//@")) expression = `descendant-or-self::*/${expression.slice(2)}`;
          else if (expression.startsWith("//")) expression = `descendant-or-self::${expression.slice(2)}`;
          else if (/^\/(?:@|text\(\)|node\(\))/.test(expression)) expression = `.${expression}`;
          else if (expression.startsWith("(.//")) expression = `(descendant-or-self::${expression.slice(4)}`;
          else if (xpathNeedsIsolatedItem(expression)) {
            // Xiangse evaluates scalar rules against the serialized list item.
            // Keep that behavior for absolute paths nested in functions such as
            // normalize-space(//a), while common relative rules reuse the page DOM.
            evaluationDocument = htmlDocument(input, true);
            evaluationContext = evaluationDocument;
          }
        }
        const candidate = xpathValues(evaluationDocument, expression, evaluationContext);
        const usable = list
          ? candidate.some((value) => value?.nodeType === 1)
          : candidate.some((value) => nodeValue(value, { content }).trim());
        selected = candidate;
        if (usable) break;
      } catch {
        selected = [];
      }
    }
  }
  if (list) return selected.filter((value) => value?.nodeType === 1);
  let result;
  if (content) {
    result = selected.map((value) => nodeValue(value, { content: true })).filter(Boolean);
  } else {
    result = selected.map((value) => nodeValue(value)).filter(Boolean);
  }
  result = result.length <= 1 ? (result[0] ?? "") : result;
  return script ? runJavaScript(script, config, params, result) : result;
}

function jsonPathValue(input, path) {
  let value = input;
  const normalized = String(path || "")
    .trim()
    .replace(/^@json:/i, "")
    .replace(/^\$\.?/, "")
    .replace(/\[\*\]/g, "")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\./g, "/");
  for (const key of normalized.split("/").filter(Boolean)) {
    if (Array.isArray(value) && !/^\d+$/.test(key)) {
      value = value.flatMap((item) => {
        const child = item?.[key];
        if (child === undefined || child === null) return [];
        return Array.isArray(child) ? child : [child];
      });
    } else {
      value = value?.[key];
    }
  }
  return value;
}

function jsonSelect(rule, input, { list = false, config, params } = {}) {
  const { selector, script } = splitPostScript(rule);
  let result = input;
  if (selector) {
    result = undefined;
    for (const alternative of selector.split(/\s*\|\|\s*/).filter(Boolean)) {
      const candidate = jsonPathValue(input, alternative);
      if (candidate !== undefined && candidate !== null && candidate !== ""
        && (!Array.isArray(candidate) || candidate.length)) {
        result = candidate;
        break;
      }
    }
  }
  if (list) return Array.isArray(result) ? result : [];
  return script ? runJavaScript(script, config, params, result) : result;
}

function actionConfig(source, action) {
  return {
    ...action,
    host: action?.host || source.sourceUrl,
    httpHeaders: { ...(source.httpHeaders || {}), ...(action?.httpHeaders || {}) },
  };
}

function filtersForAction(action, preferredTitle = "") {
  const raw = action?.moreKeys?.requestFilters;
  if (!raw) return { filter: "", filters: {}, title: "" };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw);
    const selected = entries.find(([title]) => title === preferredTitle) || entries[0] || ["", ""];
    return { title: selected[0], filter: selected[1], filters: {} };
  }
  if (Array.isArray(raw)) {
    const filters = {};
    let title = "";
    for (const group of raw) {
      const item = group?.items?.find((entry) => entry.title === preferredTitle) || group?.items?.[0];
      if (item) {
        filters[group.key] = item.value;
        title ||= item.title;
      }
    }
    return { title, filter: Object.values(filters)[0] || "", filters };
  }

  const lines = String(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const simpleItems = lines.filter((line) => line.includes("::"));
  const simpleSelected = simpleItems.find((line) => line.slice(0, line.indexOf("::")) === preferredTitle)
    || simpleItems[0] || "";
  const simpleTitle = simpleSelected.slice(0, simpleSelected.indexOf("::"));
  const simpleValue = simpleSelected.slice(simpleSelected.indexOf("::") + 2);

  const filters = {};
  let key = "";
  let selectedKey = "";
  for (const line of lines) {
    if (!line.includes("::")) {
      key = line.replace(/^_/, "");
      continue;
    }
    if (line === simpleSelected) selectedKey = key;
    if (key && filters[key] === undefined) filters[key] = line.slice(line.indexOf("::") + 2);
  }
  if (selectedKey) filters[selectedKey] = simpleValue;
  return { title: simpleTitle, filter: simpleValue, filters };
}

function substituteRequest(template, values) {
  return String(template || "")
    .replaceAll("%@keyWord", encodeURIComponent(values.keyWord || ""))
    .replaceAll("%@pageIndex", String(values.pageIndex || 1))
    .replaceAll("%@offset", String(values.offset || 0))
    .replaceAll("%@result", String(values.result || ""))
    .replaceAll("%@filter", String(values.filter || ""));
}

function absoluteUrl(value, base) {
  const url = String(value || "").trim();
  if (!url) return "";
  return new URL(url, base).href;
}

async function requestAction(source, action, context, fetchImpl) {
  const config = actionConfig(source, action);
  const params = {
    pageIndex: context.pageIndex || 1,
    offset: context.offset || 0,
    keyWord: context.keyWord || "",
    filter: context.filter || "",
    filters: context.filters || {},
    queryInfo: context.queryInfo || {},
    responseUrl: context.responseUrl || "",
    lastResponse: context.lastResponse || {},
  };
  const previous = context.result || "";
  let request = action?.requestInfo;
  if (!request || request === "%@result") request = previous;
  else if (/^@js:/i.test(String(request).trim())) {
    request = runJavaScript(String(request).trim().replace(/^@js:\s*/i, ""), config, params, previous);
  } else {
    request = substituteRequest(request, { ...params, result: previous });
  }
  if (typeof request === "string") request = { url: request };
  if (!request?.url) throw new Error(`${action?.actionID || "action"}.requestInfo 没有产生 URL`);

  const method = request.POST ? "POST" : "GET";
  const headers = { ...config.httpHeaders, ...(request.httpHeaders || {}) };
  let url = absoluteUrl(request.url, config.host || source.sourceUrl);
  const timeoutSignal = AbortSignal.timeout(context.timeoutMs || 20_000);
  const signal = context.signal
    ? AbortSignal.any([context.signal, timeoutSignal])
    : timeoutSignal;
  const init = { method, headers, redirect: "follow", signal };
  if (request.httpParams && method === "GET") {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(request.httpParams)) parsed.searchParams.set(key, String(value));
    url = parsed.href;
  } else if (request.httpParams && method === "POST") {
    const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
    if (/json/i.test(String(contentType))) init.body = JSON.stringify(request.httpParams);
    else {
      init.body = encodeFormBody(request.httpParams, action);
      if (!contentType) headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${action.actionID} 请求失败：HTTP ${response.status} ${response.url}`);
  let parsed = body;
  if (action.responseFormatType === "json") {
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`${action.actionID} 声明 JSON，但响应无法解析：${error.message}`);
    }
  }
  return { response, body, parsed, config, params, requestUrl: url };
}

function select(action, rule, input, options = {}) {
  if (!rule) return options.list ? [] : "";
  const config = options.config;
  const params = options.params;
  return action.responseFormatType === "json"
    ? jsonSelect(rule, input, { ...options, config, params })
    : htmlSelect(rule, input, { ...options, config, params });
}

function firstString(value) {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function contentSummary(sourceType, value) {
  let parsed = value;
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { parsed = JSON.parse(value); } catch { /* Keep original content. */ }
  }
  if (sourceType === "comic") {
    const urls = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.urls) ? parsed.urls : []);
    return { count: urls.length, firstUrl: firstString(urls), value: parsed };
  }
  if (sourceType === "audio" || sourceType === "video") {
    const url = typeof parsed === "object" ? firstString(parsed?.url) : firstString(parsed);
    return { count: url ? 1 : 0, firstUrl: url, value: parsed };
  }
  const text = Array.isArray(parsed) ? parsed.join("\n") : firstString(parsed);
  return { count: text.length, firstUrl: "", value: parsed };
}

const MEDIA_EXTENSION = /\.(?:mp3|m4a|aac|ogg|oga|wav|flac|opus|mp4|m4v|webm|mkv|ts|m3u8|mpd)(?:[?#]|$)/i;
const MEDIA_CONTENT_TYPE = /^(?:audio|video)\//i;
const STREAM_CONTENT_TYPE = /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/mpegurl)/i;
const NON_MEDIA_CONTENT_TYPE = /^(?:text\/(?:html|plain)|application\/(?:json|problem\+json|xml|xhtml\+xml))/i;

export function isPlayableMediaResponse(response, requestedUrl = "") {
  if (!response?.ok) return false;
  const contentType = String(response.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (NON_MEDIA_CONTENT_TYPE.test(contentType)) return false;
  if (MEDIA_CONTENT_TYPE.test(contentType) || STREAM_CONTENT_TYPE.test(contentType)) return true;
  const finalUrl = String(response.url || requestedUrl || "");
  if (MEDIA_EXTENSION.test(finalUrl)) return !contentType || contentType === "application/octet-stream";
  return false;
}

async function probeMedia(fetchImpl, url, headers, timeoutMs, signal) {
  const request = async (method, extraHeaders = {}) => fetchImpl(url, {
    method,
    headers: { ...headers, ...extraHeaders },
    redirect: "follow",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  let head;
  try {
    head = await request("HEAD");
    if (isPlayableMediaResponse(head, url)) {
      return {
        response: head,
        bytes: Number(head.headers?.get?.("content-length")) || 0,
        method: "HEAD",
      };
    }
  } catch {
    // HEAD is optional and may have different routing/content from GET.
  }

  const response = await request("GET", { Range: "bytes=0-4095" });
  if (!response.ok) throw new Error(`正文媒体请求失败：HTTP ${response.status}`);
  if (!isPlayableMediaResponse(response, url)) {
    const contentType = response.headers?.get?.("content-type") || "unknown";
    throw new Error(`正文媒体返回非媒体类型：${contentType}`);
  }
  let bytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunk = await reader.read();
    bytes = chunk.value?.byteLength || 0;
    await reader.cancel().catch(() => {});
  } else {
    bytes = Buffer.from(await response.arrayBuffer()).length;
  }
  if (!bytes) throw new Error("正文媒体响应为空");
  return { response, bytes, method: "GET" };
}

/** Execute only chapterContent after list/catalogue verification found a real chapter. */
export async function runXbsChapterContent(source, {
  bookName = "",
  detailUrl = "",
  chapterTitle = "",
  chapterUrl = "",
} = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 20_000;
  const report = { ok: false, itemCount: 0, firstUrl: "", error: "" };
  try {
    if (!chapterUrl) throw new Error("chapterContent 缺少章节 URL");
    const content = source.chapterContent || {};
    const queryInfo = {
      bookName,
      name: bookName,
      detailUrl,
      url: detailUrl,
      chapterTitle,
      chapterUrl,
    };
    const response = await requestAction(source, content, {
      result: chapterUrl,
      queryInfo,
      responseUrl: detailUrl,
      timeoutMs,
      signal: options.signal,
    }, fetchImpl);
    const value = select(content, content.content, response.parsed, {
      content: (source.sourceType || "text") === "text",
      config: response.config,
      params: { ...response.params, responseUrl: response.response.url },
    });
    const summary = contentSummary(source.sourceType || "text", value);
    if (!summary.count) throw new Error("chapterContent.content 解析为空");
    report.ok = true;
    report.itemCount = summary.count;
    report.firstUrl = summary.firstUrl;
    report.requestUrl = response.response.url;
    if (["audio", "video"].includes(source.sourceType)
      && summary.value && typeof summary.value === "object" && !Array.isArray(summary.value)) {
      report.httpHeaders = { ...(summary.value.httpHeaders || summary.value.headers || {}) };
    }
  } catch (error) {
    report.error = String(error?.message || error);
  }
  return report;
}

export async function runXbsPipeline(source, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 20_000;
  const report = { source: source.sourceName, sourceType: source.sourceType || "text", ok: false, steps: {} };
  try {
    const worldEntries = Object.entries(source.bookWorld || {});
    const selectedWorld = (options.useSearch && source.searchBook ? ["搜索", source.searchBook] : null)
      || worldEntries.find(([title]) => title === options.world)
      || worldEntries[0]
      || (source.searchBook ? ["搜索", source.searchBook] : null);
    if (!selectedWorld) throw new Error("bookWorld/searchBook 没有可执行入口");
    const [worldTitle, world] = selectedWorld;
    const usingSearch = world === source.searchBook;
    const defaultKeyWord = ({ comic: "漫画", audio: "广播剧", video: "视频" })[source?.sourceType] || "小说";
    const selectedFilter = filtersForAction(world, options.filter);
    const worldResponse = await requestAction(source, world, {
      pageIndex: options.pageIndex || 1,
      keyWord: usingSearch ? (options.keyWord || defaultKeyWord) : "",
      ...selectedFilter,
      timeoutMs,
      signal: options.signal,
    }, fetchImpl);
    const books = select(world, world.list, worldResponse.parsed, {
      list: true,
      config: worldResponse.config,
      params: { ...worldResponse.params, responseUrl: worldResponse.response.url },
    });
    const candidateIndex = Number.isInteger(options.bookIndex) ? options.bookIndex : 0;
    const firstBook = books[candidateIndex];
    if (!firstBook) throw new Error("bookWorld.list 解析结果为 0");
    const fieldParams = { ...worldResponse.params, responseUrl: worldResponse.response.url };
    const bookName = firstString(select(world, world.bookName, firstBook, { config: worldResponse.config, params: fieldParams }));
    const rawDetailUrl = firstString(select(world, world.detailUrl, firstBook, { config: worldResponse.config, params: fieldParams }));
    const detailUrl = absoluteUrl(rawDetailUrl, worldResponse.response.url);
    if (!bookName) throw new Error("bookWorld.bookName 解析为空");
    if (!detailUrl) throw new Error("bookWorld.detailUrl 解析为空");
    const queryInfo = { bookName, name: bookName, detailUrl, url: detailUrl };
    report.steps.bookWorld = {
      title: worldTitle,
      filter: selectedFilter.title,
      requestUrl: worldResponse.response.url,
      status: worldResponse.response.status,
      bytes: Buffer.byteLength(worldResponse.body),
      listCount: books.length,
      bookName,
      detailUrl,
      candidateIndex,
    };

    const detail = source.bookDetail || {};
    const detailResponse = await requestAction(source, detail, {
      result: detailUrl,
      queryInfo,
      timeoutMs,
      signal: options.signal,
    }, fetchImpl);
    const detailParams = {
      ...detailResponse.params,
      responseUrl: detailResponse.response.url,
    };
    const detailDocument = detail.responseFormatType === "html"
      ? htmlDocument(detailResponse.parsed)
      : null;
    const detailValues = {};
    for (const [name, ruleName] of [
      ["name", "bookName"],
      ["cover", "cover"],
      ["author", "author"],
      ["cat", "cat"],
      ["lastChapterTitle", "lastChapterTitle"],
    ]) {
      if (!detail?.[ruleName]) continue;
      const value = firstString(select(detail, detail[ruleName], detailResponse.parsed, {
        config: detailResponse.config,
        params: detailParams,
        document: detailDocument,
      }));
      if (value) detailValues[name] = name === "cover"
        ? absoluteUrl(value, detailResponse.response.url)
        : value;
    }
    report.steps.bookDetail = {
      requestUrl: detailResponse.response.url,
      status: detailResponse.response.status,
      bytes: Buffer.byteLength(detailResponse.body),
      ...detailValues,
    };

    const toc = source.chapterList || {};
    const tocResponse = await requestAction(source, toc, {
      result: detailUrl,
      queryInfo,
      responseUrl: detailResponse.response.url,
      timeoutMs,
      signal: options.signal,
    }, fetchImpl);
    const tocDocument = toc.responseFormatType === "html"
      ? htmlDocument(tocResponse.parsed)
      : null;
    const chapters = select(toc, toc.list, tocResponse.parsed, {
      list: true,
      config: tocResponse.config,
      params: { ...tocResponse.params, responseUrl: tocResponse.response.url },
      document: tocDocument,
    });
    const chapterIndex = Number.isInteger(options.chapterIndex) ? options.chapterIndex : 0;
    const firstChapter = chapters[chapterIndex];
    if (!firstChapter) throw new Error("chapterList.list 解析结果为 0");
    const tocParams = { ...tocResponse.params, responseUrl: tocResponse.response.url };
    const chapterTitle = firstString(select(toc, toc.title, firstChapter, { config: tocResponse.config, params: tocParams }));
    const rawChapterUrl = firstString(select(toc, toc.url, firstChapter, { config: tocResponse.config, params: tocParams }));
    const chapterUrl = absoluteUrl(rawChapterUrl, tocResponse.response.url);
    if (!chapterTitle) throw new Error("chapterList.title 解析为空");
    if (!chapterUrl) throw new Error("chapterList.url 解析为空");
    if (!report.steps.bookDetail.lastChapterTitle) {
      const chapterRows = chapters.map((item) => ({
        title: firstString(select(toc, toc.title, item, { config: tocResponse.config, params: tocParams })),
      })).filter((item) => item.title);
      report.steps.bookDetail.lastChapterTitle = orderChaptersAscending(chapterRows, {
        reverseHint: Boolean(toc.reverseChapters || toc.reverse),
      }).at(-1)?.title || "";
      if (report.steps.bookDetail.lastChapterTitle) {
        report.steps.bookDetail.derivedFields = ["lastChapterTitle"];
      }
    }
    report.steps.chapterList = {
      requestUrl: tocResponse.response.url,
      status: tocResponse.response.status,
      bytes: Buffer.byteLength(tocResponse.body),
      listCount: chapters.length,
      chapterTitle,
      chapterUrl,
      candidateIndex: chapterIndex,
    };

    const content = source.chapterContent || {};
    // Match real Xiangse: keep book-level queryInfo.url/detailUrl, pass the
    // chapter address primarily through `result` (+ optional chapterUrl).
    const contentQuery = { ...queryInfo, chapterTitle, chapterUrl };
    const contentResponse = await requestAction(source, content, {
      result: chapterUrl,
      queryInfo: contentQuery,
      responseUrl: tocResponse.response.url,
      timeoutMs,
      signal: options.signal,
    }, fetchImpl);
    const contentParams = { ...contentResponse.params, responseUrl: contentResponse.response.url };
    const contentValue = select(content, content.content, contentResponse.parsed, {
      content: source.sourceType === "text",
      config: contentResponse.config,
      params: contentParams,
    });
    const summary = contentSummary(source.sourceType || "text", contentValue);
    if (!summary.count) throw new Error("chapterContent.content 解析为空");
    report.steps.chapterContent = {
      requestUrl: contentResponse.response.url,
      status: contentResponse.response.status,
      bytes: Buffer.byteLength(contentResponse.body),
      itemCount: summary.count,
      firstUrl: summary.firstUrl,
    };
    if (summary.firstUrl
      && ["audio", "video"].includes(source.sourceType)
      && options.fetchMedia !== false) {
      const mediaHeaders = summary.value && typeof summary.value === "object" && !Array.isArray(summary.value)
        ? (summary.value.httpHeaders || summary.value.headers || {})
        : {};
      const probe = await probeMedia(fetchImpl, summary.firstUrl, mediaHeaders, timeoutMs, options.signal);
      const media = probe.response;
      report.steps.media = {
        requestUrl: media.url,
        status: media.status,
        contentType: media.headers.get("content-type") || "",
        bytes: probe.bytes,
        method: probe.method,
      };
    }
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    if (!options.world && !options.useSearch && !options._worldFallback) {
      const maxWorldCandidates = Math.max(1, Math.min(12, options.maxWorldCandidates || 8));
      const alternatives = Object.keys(source.bookWorld || {}).slice(1, maxWorldCandidates);
      for (const world of alternatives) {
        const candidate = await runXbsPipeline(source, {
          ...options,
          world,
          _worldFallback: true,
        });
        if (candidate.ok) {
          candidate.attemptedWorlds = alternatives.indexOf(world) + 2;
          return candidate;
        }
      }
      if (source.searchBook) {
        const candidate = await runXbsPipeline(source, {
          ...options,
          useSearch: true,
          _worldFallback: true,
        });
        if (candidate.ok) {
          candidate.attemptedWorlds = alternatives.length + 1;
          return candidate;
        }
      }
    }
    if (!Number.isInteger(options.chapterIndex)
      && Number(report.steps?.chapterList?.listCount || 0) > 1) {
      const maxCandidates = Math.max(1, Math.min(20,
        options.maxChapterCandidates || options.maxCandidates || 5));
      for (let index = 1; index < maxCandidates; index += 1) {
        const candidate = await runXbsPipeline(source, { ...options, chapterIndex: index });
        if (candidate.ok) {
          candidate.attemptedChapterCandidates = index + 1;
          return candidate;
        }
      }
    }
    // A category may contain a newly-added/deleted book with no chapters while
    // the source itself is healthy. Validate several independent books before
    // declaring the whole XBS source broken.
    if (!Number.isInteger(options.bookIndex) && !Number.isInteger(options.chapterIndex)) {
      const maxCandidates = Math.max(1, Math.min(50,
        options.maxBookCandidates || options.maxCandidates || 5));
      for (let index = 1; index < maxCandidates; index += 1) {
        const candidate = await runXbsPipeline(source, { ...options, bookIndex: index });
        if (candidate.ok) {
          candidate.attemptedCandidates = index + 1;
          return candidate;
        }
      }
    }
  }
  return report;
}

export async function loadXbsSources(location, fetchImpl = fetch) {
  let buffer;
  if (/^https?:\/\//i.test(String(location))) {
    const response = await fetchImpl(String(location));
    if (!response.ok) throw new Error(`XBS 下载失败：HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    buffer = await readFile(location);
  }
  return JSON.parse(decodeXbs(buffer).toString("utf8"));
}
