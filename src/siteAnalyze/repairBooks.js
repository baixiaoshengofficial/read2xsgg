import { compileBookBridgePlan, decodeBridgePlan, encodeBridgePlan, executeBridgePlan } from "../bridgePlan.js";
import { decodeTextBuffer } from "../charset.js";
import { resolveBookTargetRequests, resolveChapterListUrls } from "../verifySource.js";
import { listCoverSelectorFromLinks } from "./coverSelectors.js";
import {
  bookNameSelector,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  stableAnchorSelectorFromLinks,
  visibleText,
} from "./domUtil.js";

const BOOK_PATH = /(?:\/(?:book|novel|info|detail|story|read|comic|manga|vod|video|album|audio|show)\/|\/\d{2,}(?:\/|\.html?|$)|[?&](?:book|novel|comic|album|vod)?id=)/i;
const NAV_TEXT = /^(?:全部|[首頁页]|主[頁页]|分[類类]|排行|排行榜|登[錄录]|註冊|注册|充值|書架|书架|歷史|历史|更多|下一[頁页]|上一[頁页]|下[頁页]|上[頁页]|末[頁页]|尾[頁页]|男生|女生|小說|小说|漫畫|漫画|聽書|听书|視頻|视频|影視|影视)$/i;
const PURE_CHAPTER_TEXT = /^(?:(?:第\s*)?\d+(?:\.\d+)?\s*(?:[章節节回話话集卷]|p)(?:\s*(?:完|終|终|end|[（(][^)）]{1,20}[)）]))?|\d+\s*[~～-]\s*\d+\s*p|(?:開始|开始|立即|點擊|点击)閱讀)$/i;

function likelyBookPath(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const leaf = parts.at(-1) || "";
  const parent = parts.at(-2) || "";
  if (parts.length >= 3 && /^\d+\.html?$/i.test(leaf)
    && !/(?:book|novel|comic|manga|detail|info)/i.test(parent)) return false;
  if (BOOK_PATH.test(parsed.toString())) return true;
  return parsed.pathname.endsWith("/")
    && parts.length >= 2
    && !/^\d+$/.test(leaf)
    && !/^(?:tag|tags|category|categories|class|type|genre|search|page|static|assets?)$/i.test(parent);
}

function anchorBookText(anchor) {
  return visibleText(anchor)
    || String(anchor?.getAttribute?.("title") || "").trim()
    || String(anchor?.querySelector?.("img")?.getAttribute?.("alt") || "").trim();
}

function preciseBookSelector(selector, document, baseUrl) {
  if (!selector) return "";
  try {
    const view = document.defaultView;
    const result = document.evaluate(
      selector,
      document,
      null,
      view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    let usable = 0;
    for (let index = 0; index < result.snapshotLength; index += 1) {
      const anchor = result.snapshotItem(index);
      const text = anchorBookText(anchor);
      let href = "";
      try { href = new URL(anchor?.getAttribute?.("href") || "", baseUrl).toString(); } catch { continue; }
      if (text.length >= 2 && text.length <= 100
        && !NAV_TEXT.test(text)
        && !PURE_CHAPTER_TEXT.test(text)
        && likelyBookPath(href)) usable += 1;
    }
    return usable >= 2 && usable >= Math.ceil(result.snapshotLength * 0.7) ? selector : "";
  } catch {
    return "";
  }
}

function objectArrays(value, path = "$", depth = 0, output = []) {
  if (depth > 6 || !value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (rows.length) output.push({ path, rows: rows.slice(0, 20) });
    for (const item of value.slice(0, 3)) objectArrays(item, path, depth + 1, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    objectArrays(item, path === "$" ? `$.${key}` : `${path}.${key}`, depth + 1, output);
  }
  return output;
}

function leafValues(row, prefix = "", depth = 0, output = []) {
  if (!row || typeof row !== "object" || depth > 2) return output;
  for (const [key, value] of Object.entries(row)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) leafValues(value, path, depth + 1, output);
    else if (["string", "number"].includes(typeof value)) output.push({ path, value: String(value).trim() });
  }
  return output;
}

function valueMap(rows) {
  const values = new Map();
  for (const row of rows.slice(0, 12)) {
    for (const item of leafValues(row)) {
      const bucket = values.get(item.path) || [];
      if (item.value) bucket.push(item.value);
      values.set(item.path, bucket);
    }
  }
  return values;
}

function bestField(values, patterns, valueScore, { requirePattern = false } = {}) {
  let best = null;
  for (const [path, items] of values) {
    if (!items.length) continue;
    const leaf = path.split(".").at(-1) || path;
    let score = items.length;
    let matched = false;
    patterns.forEach((pattern, index) => {
      if (pattern.test(leaf)) {
        matched = true;
        score += (patterns.length - index) * 20;
      }
    });
    if (requirePattern && !matched) continue;
    score += items.reduce((sum, item) => sum + valueScore(item), 0) / items.length;
    if (!best || score > best.score) best = { path, score };
  }
  return best?.path || "";
}

function inferredFields(rows, previous = {}) {
  const values = valueMap(rows);
  const previousName = String(previous.name?.selector || "").replace(/^\$\.?/, "");
  const name = (values.has(previousName) ? previousName : "") || bestField(
    values,
    [/^(?:book|novel|comic)?_?name$/i, /title|bookname|novelname|comicname/i],
    (value) => (!/^https?:|^\//i.test(value) && value.length >= 2 && value.length <= 100 ? 25 : -20),
  );
  const detailValues = new Map([...values].filter(([path]) => (
    !/(?:cover|image|img|pic|thumb|avatar|icon|logo|banner)/i.test(path)
  )));
  const previousUrl = String(previous.url?.selector || "").replace(/^\$\.?/, "");
  const directUrl = (detailValues.has(previousUrl) ? previousUrl : "") || bestField(
    detailValues,
    [/^(?:book|detail)?_?url$/i, /url|href|link|path|uri/i],
    (value) => (/^(?:https?:)?\/\//i.test(value) ? 35 : (/^\//.test(value) ? 25 : -15)),
  );
  const id = bestField(
    values,
    [/^(?:book|novel|comic|album|entity)?_?id$/i, /id$/i],
    (value) => (/^[A-Za-z0-9_-]{1,80}$/.test(value) ? 20 : -20),
    { requirePattern: true },
  );
  const usesTemplate = Boolean(previous.url?.urlTemplate || previous.url?.matchTemplate);
  const url = usesTemplate ? (values.has(previousUrl) ? previousUrl : id) : directUrl;
  if (!name || !url || (!directUrl && !usesTemplate)) return null;
  const optional = {
    cover: [[/cover|pic|image|img|thumb|icon/i], (value) => /^(?:https?:)?\/\/|^\//i.test(value) ? 20 : -10],
    author: [[/author|writer|creator/i], (value) => value.length <= 80 ? 10 : -10],
    cat: [[/category|categoryname|cat|type|genre|class/i], (value) => value.length <= 80 ? 10 : -10],
    lastChapterTitle: [[/last.*(?:chapter|title)|latest|newchapter/i], (value) => value.length <= 120 ? 10 : -10],
    desc: [[/intro|summary|description|desc|synopsis/i], (value) => value.length >= 5 ? 10 : 0],
  };
  const fields = {
    ...previous,
    name: { ...(previous.name || {}), selector: name },
    url: {
      ...(previous.url || {}),
      selector: url,
      ...(!usesTemplate ? { hostPrefix: false, matchTemplate: null } : {}),
    },
  };
  for (const [field, [patterns, scorer]] of Object.entries(optional)) {
    const selector = bestField(values, patterns, scorer, { requirePattern: true });
    if (selector) fields[field] = { ...(previous[field] || {}), selector };
  }
  return fields;
}

function adapterPlan(action) {
  const requestInfo = String(action?.requestInfo || "");
  const match = requestInfo.match(/\/adapter\/books\?plan=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    return { token: match[1], plan: decodeBridgePlan(match[1]) };
  } catch {
    return null;
  }
}

function chapterAdapterPlan(action) {
  const requestInfo = String(action?.requestInfo || "");
  const match = requestInfo.match(/\/adapter\/chapters\?plan=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    return { token: match[1], plan: decodeBridgePlan(match[1]) };
  } catch {
    return null;
  }
}

function inferredChapterFields(rows, previous = {}) {
  const values = valueMap(rows);
  const previousTitle = String(previous.title?.selector || "").replace(/^\$\.?/, "");
  const title = (values.has(previousTitle) ? previousTitle : "") || bestField(
    values,
    [/^(?:chapter|section|episode)?_?(?:name|title)$/i, /chapter|section|episode|title|name/i],
    (value) => (!/^https?:|^\//i.test(value) && value.length >= 1 && value.length <= 160 ? 20 : -20),
  );
  const detailValues = new Map([...values].filter(([path]) => (
    !/(?:cover|image|img|pic|thumb|avatar|icon|logo|banner)/i.test(path)
  )));
  const previousUrl = String(previous.url?.selector || "").replace(/^\$\.?/, "");
  const directUrl = (detailValues.has(previousUrl) ? previousUrl : "") || bestField(
    detailValues,
    [/^(?:chapter|section|episode)?_?(?:url|link|path|uri)$/i, /url|href|link|path|uri/i],
    (value) => (/^(?:https?:)?\/\//i.test(value) ? 35 : (/^\//.test(value) ? 25 : -15)),
  );
  const id = bestField(
    values,
    [/^(?:chapter|section|episode|entity)?_?id$/i, /id$/i],
    (value) => (/^[A-Za-z0-9_-]{1,100}$/.test(value) ? 20 : -20),
    { requirePattern: true },
  );
  const usesTemplate = Boolean(previous.url?.urlTemplate || previous.url?.matchTemplate);
  const url = usesTemplate ? (values.has(previousUrl) ? previousUrl : id) : directUrl;
  if (!title || !url || (!directUrl && !usesTemplate)) return null;
  return {
    ...previous,
    title: { ...(previous.title || {}), selector: title },
    url: {
      ...(previous.url || {}),
      selector: url,
      ...(!usesTemplate ? { hostPrefix: false, matchTemplate: null } : {}),
    },
  };
}

function actionAt(source, request) {
  if (request.section === "searchBook") return source.searchBook;
  return source.bookWorld?.[request.actionName];
}

function decodedPageText(page) {
  return decodeTextBuffer(page, { headers: page?.httpHeaders || {} });
}

function rebaseActionToResponse(action, requestedUrl, responseUrl) {
  let requestedOrigin;
  let responseOrigin;
  try {
    requestedOrigin = new URL(requestedUrl).origin;
    responseOrigin = new URL(responseUrl).origin;
  } catch {
    return;
  }
  if (requestedOrigin === responseOrigin) return;
  action.host = responseOrigin;
  for (const field of ["requestInfo", "nextPageUrl"]) {
    if (typeof action[field] === "string") {
      action[field] = action[field].split(requestedOrigin).join(responseOrigin);
    }
  }
}

function htmlBookCluster(page, requestedUrl) {
  const responseUrl = String(page?.read2xsggResponseUrl || requestedUrl || "");
  let origin = "";
  try { origin = new URL(responseUrl).origin; } catch { return null; }
  const document = loadDocument(decodedPageText(page), responseUrl);
  const anchors = pageAnchors(document, responseUrl, origin).filter((item) => (
    item.text.length >= 2
    && item.text.length <= 100
    && !NAV_TEXT.test(item.text)
    && !PURE_CHAPTER_TEXT.test(item.text)
    && !/^\d+$/.test(item.text)
    && !/^(?:javascript:|#)/i.test(item.href)
  ));
  const likely = anchors.filter((item) => likelyBookPath(item.href));
  const cluster = scoreLinkCluster(likely.length >= 2 ? likely : anchors, responseUrl).slice(0, 40);
  if (cluster.length < 2) return null;
  const links = cluster.map((item) => item.el);
  const stable = preciseBookSelector(
    stableAnchorSelectorFromLinks(links, document, responseUrl),
    document,
    responseUrl,
  );
  const list = stable || listSelectorFromLinks(links, document);
  if (!list) return null;
  return {
    list,
    bookName: bookNameSelector(),
    detailUrl: stable ? "./@href||//@href" : ".//a/@href||./@href||//@href",
    cover: listCoverSelectorFromLinks(links),
  };
}

function legacyUnicodeRequestInfo(requestInfo, page) {
  const template = String(requestInfo || "").trim();
  const html = decodedPageText(page);
  if (!template.includes("%@keyWord")
    || !/[?&](?:key|keyword|q|searchkey)=%u[\da-f]{4}/i.test(html)) return "";
  return [
    "@js:",
    `var url = ${JSON.stringify(template)}`,
    '  .replace("%@keyWord", escape(String(params.keyWord || "小说")))',
    '  .replace("%@pageIndex", String(params.pageIndex || 1));',
    "return url;",
  ].join("\n");
}

async function repairHtmlBooks(source, request, action, download) {
  let page;
  try {
    page = await download(request.url, request.headers || {}, request.options || {});
  } catch {
    return null;
  }
  const rewritten = legacyUnicodeRequestInfo(action.requestInfo, page);
  if (rewritten) {
    const clone = structuredClone(source);
    const repaired = actionAt(clone, request);
    if (!repaired) return null;
    repaired.requestInfo = rewritten;
    return clone;
  }
  const fields = htmlBookCluster(page, request.url);
  if (!fields) return null;
  const clone = structuredClone(source);
  const repaired = actionAt(clone, request);
  if (!repaired) return null;
  const responseUrl = String(page.read2xsggResponseUrl || request.url);
  rebaseActionToResponse(repaired, request.url, responseUrl);
  if (request.rootFallback) {
    repaired.requestInfo = responseUrl;
    try { repaired.host = new URL(repaired.requestInfo).origin; } catch { return null; }
    delete repaired.nextPageUrl;
  }
  repaired.responseFormatType = "html";
  repaired.parserID = "DOM";
  repaired.list = fields.list;
  repaired.bookName = fields.bookName;
  repaired.detailUrl = fields.detailUrl;
  if (fields.cover) repaired.cover = fields.cover;
  try {
    const output = executeBridgePlan(
      decodedPageText(page),
      responseUrl,
      compileBookBridgePlan(repaired, {
        ...(source?.httpHeaders || {}),
        ...(repaired.httpHeaders || {}),
      }),
      { limit: 8 },
    );
    const usable = (output.data || []).filter((item) => (
      item?.url
      && item?.name
      && !NAV_TEXT.test(String(item.name).trim())
      && !PURE_CHAPTER_TEXT.test(String(item.name).trim())
      && likelyBookPath(String(item.url))
    ));
    if (usable.length < 2) return null;
  } catch {
    return null;
  }
  return clone;
}

/** Repair stale HTML/JSON list fields without changing site-specific behavior. */
export async function repairBooksFromRequests(source, { download } = {}) {
  if (typeof download !== "function") return null;
  for (const request of resolveBookTargetRequests(source, { limit: 8 })) {
    const action = request.action || actionAt(source, request);
    if (!action) continue;
    if (String(action.responseFormatType || "html").toLowerCase() !== "json") {
      const repaired = await repairHtmlBooks(source, request, action, download);
      if (repaired) return repaired;
      continue;
    }
    let page;
    try {
      page = await download(request.url, request.headers || {}, request.options || {});
    } catch {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(decodedPageText(page));
    } catch {
      continue;
    }
    const bridge = adapterPlan(action);
    const previousFields = bridge?.plan?.fields || {};
    for (const candidate of objectArrays(payload).sort((a, b) => b.rows.length - a.rows.length)) {
      const fields = inferredFields(candidate.rows, previousFields);
      if (!fields) continue;
      if (bridge) {
        const plan = { ...bridge.plan, list: candidate.path, fields };
        let output;
        try {
          output = executeBridgePlan(decodedPageText(page), request.url, plan, { limit: 3 });
        } catch {
          continue;
        }
        if (!(output.data || []).some((item) => item?.name && item?.url)) continue;
        const clone = structuredClone(source);
        const repaired = actionAt(clone, request);
        if (!repaired) continue;
        repaired.requestInfo = String(repaired.requestInfo).split(bridge.token).join(encodeBridgePlan(plan));
        return clone;
      }
      const clone = structuredClone(source);
      const repaired = actionAt(clone, request);
      if (!repaired) continue;
      repaired.list = candidate.path;
      repaired.bookName = fields.name.selector;
      repaired.detailUrl = fields.url.selector;
      if (fields.cover?.selector) repaired.cover = fields.cover.selector;
      if (fields.author?.selector) repaired.author = fields.author.selector;
      if (fields.cat?.selector) repaired.cat = fields.cat.selector;
      if (fields.lastChapterTitle?.selector) repaired.lastChapterTitle = fields.lastChapterTitle.selector;
      return clone;
    }
  }
  const sourceUrl = String(source?.sourceUrl || source?.host || "").trim();
  if (/^https?:\/\//i.test(sourceUrl)) {
    const firstWorld = Object.entries(source?.bookWorld || {})[0];
    const section = firstWorld ? "bookWorld" : "searchBook";
    const actionName = firstWorld?.[0] || "";
    const action = firstWorld?.[1] || source?.searchBook;
    if (action) {
      const repaired = await repairHtmlBooks(source, {
        url: sourceUrl,
        headers: { ...(source?.httpHeaders || {}), ...(action.httpHeaders || {}) },
        options: {},
        section,
        actionName,
        rootFallback: true,
      }, action, download);
      if (repaired) return repaired;
    }
  }
  return null;
}

/** Repair a stale JSON catalogue plan using its live detail/menu response. */
export async function repairChaptersFromBookJson(source, bookUrl, { download } = {}) {
  if (typeof download !== "function") return null;
  const action = source?.chapterList;
  if (!action) return null;
  const bridge = chapterAdapterPlan(action);
  const headers = { ...(source?.httpHeaders || {}), ...(action?.httpHeaders || {}) };
  const urls = resolveChapterListUrls(action.requestInfo, bookUrl, { pageIndex: 1 });
  for (const url of urls) {
    let page;
    try {
      page = await download(url, headers);
    } catch {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(decodedPageText(page));
    } catch {
      continue;
    }
    for (const candidate of objectArrays(payload).sort((a, b) => b.rows.length - a.rows.length)) {
      const fields = inferredChapterFields(candidate.rows, bridge?.plan?.fields || {});
      if (!fields) continue;
      if (bridge) {
        const plan = { ...bridge.plan, list: candidate.path, fields };
        let output;
        try {
          output = executeBridgePlan(decodedPageText(page), url, plan, { limit: 3 });
        } catch {
          continue;
        }
        if (!(output.data || []).some((item) => item?.title && item?.url)) continue;
        const clone = structuredClone(source);
        clone.chapterList.requestInfo = String(clone.chapterList.requestInfo)
          .split(bridge.token).join(encodeBridgePlan(plan));
        return clone;
      }
      if (String(action.responseFormatType || "").toLowerCase() !== "json") continue;
      const clone = structuredClone(source);
      clone.chapterList.list = candidate.path;
      clone.chapterList.title = fields.title.selector;
      clone.chapterList.url = fields.url.selector;
      return clone;
    }
  }
  return null;
}
