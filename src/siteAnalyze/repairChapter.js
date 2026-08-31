import {
  chapterAnchorSelectorFromLinks,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  xpathForElement,
} from "./domUtil.js";
import { decodeTextBuffer } from "../charset.js";
import {
  compileChapterBridgePlan,
  decodeBridgePlan,
  encodeBridgePlan,
} from "../bridgePlan.js";

const CHAPTER_HREF = /(?:\/(?:c|chapter|chapters|read|view|content|book)\/|\/\d+(?:[-_]\d+)?\.html?$)/i;
const CHAPTER_TEXT = /(?:\d|章|节|回|话|集|卷|序|楔子|正文)/;
const STRONG_CHAPTER_TEXT = /(?:第.{0,20}[章节回话集卷]|^\s*\d+[.、\s]|序章|楔子)/;

function discoveredChapterRules(html, pageUrl) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  const document = loadDocument(html, pageUrl);
  const anchors = pageAnchors(document, pageUrl, origin)
    .filter((item) => item.text.length <= 100);
  let chapterLinks = anchors.filter((item) => {
    try {
      return CHAPTER_HREF.test(new URL(item.href).pathname) && CHAPTER_TEXT.test(item.text);
    } catch {
      return false;
    }
  });
  if (chapterLinks.length < 2) {
    chapterLinks = scoreLinkCluster(
      anchors.filter((item) => STRONG_CHAPTER_TEXT.test(item.text)),
      pageUrl,
    );
  }
  if (chapterLinks.length < 2) return null;
  chapterLinks = chapterLinks.slice(0, 200);
  const elements = chapterLinks.map((item) => item.el);
  const stable = chapterAnchorSelectorFromLinks(elements, document, pageUrl);
  return {
    list: stable || listSelectorFromLinks(elements, document),
    title: stable
      ? "normalize-space(.)||normalize-space(/html/body/*)"
      : "normalize-space(.//a)||normalize-space(/html/body/*)",
    url: stable ? "./@href||//@href" : ".//a/@href||./@href||//@href",
  };
}

function catalogueCandidates(html, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const document = loadDocument(html, pageUrl);
  return pageAnchors(document, pageUrl, origin)
    .map((item, order) => {
      let score = -order;
      const catalogPath = /(?:mainindex|rcatalog|catalog|chapter[-_/]?list|chapters|directory|mulu|\/i\/\d+)/i.test(item.href);
      if (/(?:章节目录|全部章节|目录列表|目录|chapter\s*list|catalog|directory|table\s+of\s+contents)/i.test(item.text)) score += 1_000;
      if (catalogPath) score += 800;
      if (/(?:点击阅读|开始阅读|立即阅读|继续阅读|下一章|上一章|read\s*now)/i.test(item.text) && !catalogPath) score -= 500;
      if (CHAPTER_HREF.test(new URL(item.href).pathname)) score -= 250;
      return {
        ...item,
        score,
        selector: `${xpathForElement(item.el, document)}/@href`,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function replaceChapterBridgePlan(source, host, rules, tocSelector) {
  const previous = source?.chapterList || {};
  const match = String(previous.requestInfo || "").match(/\/adapter\/chapters\?plan=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try { decodeBridgePlan(match[1]); } catch { return null; }
  const plan = compileChapterBridgePlan({
    host,
    responseFormatType: "html",
    list: rules.list,
    title: rules.title,
    url: rules.url,
  }, {
    tocSelector,
    headers: { ...(source?.httpHeaders || {}), ...(previous.httpHeaders || {}) },
  });
  const token = encodeBridgePlan(plan);
  const clone = structuredClone(source);
  clone.chapterList.requestInfo = String(clone.chapterList.requestInfo).split(match[1]).join(token);
  if (clone.chapterList.nextPageUrl) {
    clone.chapterList.nextPageUrl = String(clone.chapterList.nextPageUrl).split(match[1]).join(token);
  }
  return clone;
}

function tocAdapterRequestInfo(adapterBase, selector) {
  const base = String(adapterBase || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return "";
  const endpoint = `${base}/adapter/toc?selector=${encodeURIComponent(selector)}&url=`;
  return [
    "@js:",
    "var q = params.queryInfo || {};",
    'var u = (typeof result === "string") ? result : "";',
    'if (!u && result && typeof result === "object") u = result.detailUrl || result.url || "";',
    'u = String(q.detailUrl || u || q.url || "");',
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
  ].join("\n");
}

function apiHtmlCandidateUrl(value) {
  try {
    const page = new URL(String(value || ""));
    if (!/(?:^|\/)api\//i.test(page.pathname)) return "";
    page.pathname = page.pathname.replace(/(^|\/)api\//i, "$1");
    page.search = "";
    page.hash = "";
    return page.toString();
  } catch {
    return "";
  }
}

function directChapterAdapterRequestInfo(adapterBase, planToken, { stripApi = false } = {}) {
  const base = String(adapterBase || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return "";
  const endpoint = `${base}/adapter/chapters?plan=${planToken}&pageSize=200&url=`;
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var u = (typeof result == "string" && result && result != "%@result") ? result : "";',
    'if (!u) u = q.detailUrl || q.url || q.chapterUrl || "";',
    'if (!u && result && typeof result == "object") u = result.url || result.detailUrl || "";',
    'u = String(u || "").trim();',
    ...(stripApi ? [
      "// read2xsgg: strip-api-path",
      'u = u.replace(/^(https?:\\/\\/[^/]+)\\/api\\//i, "$1/");',
    ] : []),
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
  ].join("\n");
}

function replaceDirectChapterAction(source, host, rules, adapterBase, options = {}) {
  const plan = compileChapterBridgePlan({
    host,
    responseFormatType: "html",
    list: rules.list,
    title: rules.title,
    url: rules.url,
  }, {
    headers: { ...(source?.httpHeaders || {}), ...(source?.chapterList?.httpHeaders || {}) },
  });
  const requestInfo = directChapterAdapterRequestInfo(adapterBase, encodeBridgePlan(plan), options);
  if (!requestInfo) return null;
  const clone = structuredClone(source);
  clone.chapterList = {
    ...(clone.chapterList || {}),
    actionID: "chapterList",
    host,
    responseFormatType: "json",
    parserID: "DOM",
    requestInfo,
    list: "$.data",
    title: "title",
    url: "url",
    moreKeys: { ...(clone.chapterList?.moreKeys || {}), pageSize: 200 },
  };
  delete clone.chapterList.nextPageUrl;
  return clone;
}

function replaceLinkedChapterAction(source, host, rules, tocSelector, adapterBase) {
  const requestInfo = tocAdapterRequestInfo(adapterBase, tocSelector);
  if (!requestInfo) return null;
  const clone = structuredClone(source);
  clone.chapterList = {
    ...(clone.chapterList || {}),
    actionID: "chapterList",
    host,
    responseFormatType: "html",
    parserID: "DOM",
    requestInfo,
    list: rules.list,
    title: rules.title,
    url: rules.url,
  };
  delete clone.chapterList.nextPageUrl;
  return clone;
}

/** Repair only the catalogue action after a converted list produced a real book URL. */
export async function repairChapterFromBook(source, bookUrl, { download, adapterBase = "" } = {}) {
  if (typeof download !== "function") return null;
  try {
    new URL(bookUrl);
  } catch {
    return null;
  }
  const headers = {
    ...(source?.httpHeaders || {}),
    ...(source?.chapterList?.httpHeaders || {}),
  };
  const queue = [{ url: bookUrl, stripApi: false }];
  const initialHtmlUrl = apiHtmlCandidateUrl(bookUrl);
  if (initialHtmlUrl) queue.push({ url: initialHtmlUrl, stripApi: true });
  const seen = new Set();
  while (queue.length) {
    const candidatePage = queue.shift();
    if (!candidatePage?.url || seen.has(candidatePage.url)) continue;
    seen.add(candidatePage.url);
    let page;
    try {
      page = await download(candidatePage.url, headers);
    } catch {
      continue;
    }
    const detailUrl = String(page.read2xsggResponseUrl || candidatePage.url);
    const detailHtml = decodeTextBuffer(page, { headers: page.httpHeaders || {} });
    const redirectedHtmlUrl = apiHtmlCandidateUrl(detailUrl);
    if (redirectedHtmlUrl && !seen.has(redirectedHtmlUrl)) {
      queue.push({ url: redirectedHtmlUrl, stripApi: true });
    }
    const rules = discoveredChapterRules(detailHtml, detailUrl);
    if (rules) {
      if (candidatePage.stripApi || candidatePage.url !== bookUrl) {
        const adapted = replaceDirectChapterAction(
          source,
          new URL(detailUrl).origin,
          rules,
          adapterBase,
          { stripApi: candidatePage.stripApi },
        );
        if (adapted) return adapted;
      }
      const previous = source?.chapterList || {};
      return {
        ...source,
        chapterList: {
          ...previous,
          actionID: "chapterList",
          host: new URL(detailUrl).origin,
          responseFormatType: "html",
          parserID: "DOM",
          requestInfo: "%@result",
          list: rules.list,
          title: rules.title,
          url: rules.url,
        },
      };
    }
    for (const candidate of catalogueCandidates(detailHtml, detailUrl)) {
      let cataloguePage;
      try {
        cataloguePage = await download(candidate.href, headers);
      } catch {
        continue;
      }
      const catalogueUrl = String(cataloguePage.read2xsggResponseUrl || candidate.href);
      const linkedRules = discoveredChapterRules(
        decodeTextBuffer(cataloguePage, { headers: cataloguePage.httpHeaders || {} }),
        catalogueUrl,
      );
      if (!linkedRules) continue;
      const bridged = replaceChapterBridgePlan(
        source,
        new URL(catalogueUrl).origin,
        linkedRules,
        candidate.selector,
      );
      if (bridged) return bridged;
      const adapted = replaceLinkedChapterAction(
        source,
        new URL(catalogueUrl).origin,
        linkedRules,
        candidate.selector,
        adapterBase,
      );
      if (adapted) return adapted;
    }
  }
  return null;
}
