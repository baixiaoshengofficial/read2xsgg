import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { decodeXbs } from "./xbs.js";

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

function xpathValues(document, expression) {
  const view = document.defaultView;
  const result = document.evaluate(expression, document, null, view.XPathResult.ANY_TYPE, null);
  if (result.resultType === view.XPathResult.STRING_TYPE) return [result.stringValue];
  if (result.resultType === view.XPathResult.NUMBER_TYPE) return [String(result.numberValue)];
  if (result.resultType === view.XPathResult.BOOLEAN_TYPE) return [String(result.booleanValue)];
  const values = [];
  let node;
  while ((node = result.iterateNext())) values.push(node);
  return values;
}

function htmlDocument(value, wrapItem = false) {
  if (!wrapItem) return new JSDOM(String(value || "")).window.document;
  const html = value?.outerHTML || value?.textContent || String(value || "");
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

function nodeValue(node, { content = false } = {}) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.nodeType === 2 || node.nodeType === 3) return String(node.nodeValue || "").trim();
  if (node.nodeType === 9) return String(node.documentElement?.textContent || "").trim();
  if (content && node.innerHTML != null) return String(node.innerHTML);
  return String(node.textContent || "").trim();
}

function htmlSelect(rule, input, { list = false, content = false, config, params } = {}) {
  const { selector, script } = splitPostScript(rule);
  let selected = [];
  if (selector) {
    const document = input?.nodeType ? htmlDocument(input, true) : htmlDocument(input);
    for (const alternative of selector.split(/\s*\|\|\s*/).filter(Boolean)) {
      try {
        selected = xpathValues(document, alternative.trim());
      } catch {
        selected = [];
      }
      if (selected.length) break;
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
  for (const key of normalized.split("/").filter(Boolean)) value = value?.[key];
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
  const init = { method, headers, redirect: "follow", signal: AbortSignal.timeout(context.timeoutMs || 20_000) };
  if (request.httpParams && method === "GET") {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(request.httpParams)) parsed.searchParams.set(key, String(value));
    url = parsed.href;
  } else if (request.httpParams && method === "POST") {
    const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
    if (/json/i.test(String(contentType))) init.body = JSON.stringify(request.httpParams);
    else {
      init.body = new URLSearchParams(Object.entries(request.httpParams).map(([key, value]) => [key, String(value)])).toString();
      if (!contentType) headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
  if (request.webView) throw new Error(`${action.actionID} 需要 WebView，当前 HTTP 验收器不能伪装为通过`);

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

export async function runXbsPipeline(source, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 20_000;
  const report = { source: source.sourceName, sourceType: source.sourceType || "text", ok: false, steps: {} };
  try {
    const worldEntries = Object.entries(source.bookWorld || {});
    const selectedWorld = worldEntries.find(([title]) => title === options.world) || worldEntries[0];
    if (!selectedWorld) throw new Error("bookWorld 没有可执行分类");
    const [worldTitle, world] = selectedWorld;
    const selectedFilter = filtersForAction(world, options.filter);
    const worldResponse = await requestAction(source, world, {
      pageIndex: options.pageIndex || 1,
      ...selectedFilter,
      timeoutMs,
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
    const detailResponse = await requestAction(source, detail, { result: detailUrl, queryInfo, timeoutMs }, fetchImpl);
    report.steps.bookDetail = {
      requestUrl: detailResponse.response.url,
      status: detailResponse.response.status,
      bytes: Buffer.byteLength(detailResponse.body),
    };

    const toc = source.chapterList || {};
    const tocResponse = await requestAction(source, toc, {
      result: detailUrl,
      queryInfo,
      responseUrl: detailResponse.response.url,
      timeoutMs,
    }, fetchImpl);
    const chapters = select(toc, toc.list, tocResponse.parsed, {
      list: true,
      config: tocResponse.config,
      params: { ...tocResponse.params, responseUrl: tocResponse.response.url },
    });
    const firstChapter = chapters[0];
    if (!firstChapter) throw new Error("chapterList.list 解析结果为 0");
    const tocParams = { ...tocResponse.params, responseUrl: tocResponse.response.url };
    const chapterTitle = firstString(select(toc, toc.title, firstChapter, { config: tocResponse.config, params: tocParams }));
    const rawChapterUrl = firstString(select(toc, toc.url, firstChapter, { config: tocResponse.config, params: tocParams }));
    const chapterUrl = absoluteUrl(rawChapterUrl, tocResponse.response.url);
    if (!chapterTitle) throw new Error("chapterList.title 解析为空");
    if (!chapterUrl) throw new Error("chapterList.url 解析为空");
    report.steps.chapterList = {
      requestUrl: tocResponse.response.url,
      status: tocResponse.response.status,
      bytes: Buffer.byteLength(tocResponse.body),
      listCount: chapters.length,
      chapterTitle,
      chapterUrl,
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
    if (summary.firstUrl && options.fetchMedia !== false) {
      const media = await fetchImpl(summary.firstUrl, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      const mediaBody = Buffer.from(await media.arrayBuffer());
      if (!media.ok || !mediaBody.length) throw new Error(`正文媒体请求失败：HTTP ${media.status}`);
      report.steps.media = {
        requestUrl: media.url,
        status: media.status,
        contentType: media.headers.get("content-type") || "",
        bytes: mediaBody.length,
      };
    }
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    // A category may contain a newly-added/deleted book with no chapters while
    // the source itself is healthy. Validate several independent books before
    // declaring the whole XBS source broken.
    if (!Number.isInteger(options.bookIndex)) {
      const maxCandidates = Math.max(1, Math.min(10, options.maxCandidates || 5));
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
