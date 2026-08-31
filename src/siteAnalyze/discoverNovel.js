import { detailCoverSelector, listCoverSelectorFromLinks } from "./coverSelectors.js";
import { discoverSearchRequest } from "./discoverSearch.js";
import { discoverPagedListUrl } from "./pagination.js";
import {
  absolute,
  bookNameSelector,
  chapterAnchorSelectorFromLinks,
  classContainsXPath,
  linkHasNearbyCover,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  stableAnchorSelectorFromLinks,
  visibleText,
  xpathForElement,
} from "./domUtil.js";

const BOOK_HREF = /(?:\/(?:book|novel|info|xiaoshuo|story|article)\/|\/\d{3,}\.html?$|\/read\/\d+)/i;
const CHAPTER_HREF = /(?:\/(?:chapter|chapters|read|book|view)\/|\/\d+\.html?$)/i;
const STRONG_CHAPTER_HREF = /\/view\/\d+(?:_\d+)?\.html?(?:$|[?#])/i;
const CHAPTER_TEXT = /(?:第.{0,24}[章节回话集卷]|^\s*\d+[.、\s]|序章|楔子|正文)/;
const CONTENT_SELECTORS = [
  "#content",
  "#chaptercontent",
  "#BookText",
  "#booktext",
  "#chapterContent",
  ".content",
  ".chapter-content",
  ".novel-content",
  "#htmlContent",
  "article",
];

function findContentSelector(document) {
  for (const selector of CONTENT_SELECTORS) {
    try {
      const node = document.querySelector(selector);
      if (node && visibleText(node).length >= 80) {
        if (selector.startsWith("#")) return `//*[@id='${selector.slice(1)}']`;
        if (selector.startsWith(".")) return classContainsXPath(selector.slice(1));
        return `//${selector}`;
      }
    } catch {
      // ignore invalid selector in odd documents
    }
  }
  let best = null;
  let bestLen = 0;
  for (const node of document.querySelectorAll("div, article, section")) {
    const text = visibleText(node);
    if (text.length > bestLen && text.length < 200_000) {
      best = node;
      bestLen = text.length;
    }
  }
  if (!best || bestLen < 80) return "";
  if (best.id) return `//*[@id='${best.id}']`;
  const className = String(best.className || "").trim().split(/\s+/).find(Boolean);
  if (className) return classContainsXPath(className);
  return xpathForElement(best, document);
}

/**
 * Heuristic novel-site discovery from live HTML pages.
 * Returns selectors + sample URLs, or null when confidence is too low.
 */
export async function discoverNovel(originUrl, {
  download,
  maxPages = 4,
  homeHtml = "",
  homeRequestInfo = "",
  homeResponseUrl = "",
  adapterBase = "",
  diagnostics = [],
} = {}) {
  if (typeof download !== "function") throw new TypeError("discoverNovel 需要 download");
  let origin;
  try {
    origin = new URL(originUrl);
  } catch {
    return null;
  }
  origin.hash = "";
  let homeUrl = String(homeResponseUrl || origin.toString());
  let html = homeHtml;
  if (!html) {
    const homePage = await download(homeUrl);
    html = homePage.toString("utf8");
    homeUrl = String(homePage.read2xsggResponseUrl || homeUrl);
  }
  const pageOrigin = new URL(homeUrl).origin;
  const document = loadDocument(html, homeUrl);
  const anchors = pageAnchors(document, homeUrl, pageOrigin);

  const readableLinks = anchors.filter((item) => item.text.length >= 2 && item.text.length <= 80);
  const coveredBookLinks = readableLinks.filter((item) => (
    !CHAPTER_TEXT.test(item.text)
    && linkHasNearbyCover(item)
    && !/(?:登录|注册|首页|分类|排行|更多|搜索|作者|更新|字数|状态)\s*[:：]?/.test(item.text)
  ));
  const bookLinks = readableLinks.filter((item) => BOOK_HREF.test(item.href));
  const semanticBookLinks = bookLinks.filter((item) => !CHAPTER_TEXT.test(item.text));
  const candidates = coveredBookLinks.length >= 2
    ? coveredBookLinks
    : semanticBookLinks.length >= 2 ? semanticBookLinks : bookLinks.length ? bookLinks : readableLinks;
  const cluster = scoreLinkCluster(candidates, homeUrl)
    .slice(0, 30);
  if (cluster.length < 2) {
    diagnostics.push("list: 书籍链接不足 2 条");
    return null;
  }

  const listLinks = cluster.map((item) => item.el);
  const stableListSelector = stableAnchorSelectorFromLinks(listLinks, document, homeUrl);
  const listSelector = stableListSelector || listSelectorFromLinks(listLinks, document);
  const listCoverSelector = listCoverSelectorFromLinks(listLinks);
  const pagedListUrl = await discoverPagedListUrl(document, homeUrl, {
    origin: pageOrigin,
    listSelector,
    download,
  });
  let detailUrl = cluster.find((item) => BOOK_HREF.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) {
    diagnostics.push("detail: 未取得详情 URL");
    return null;
  }

  const detailPage = await download(detailUrl);
  const detailHtml = detailPage.toString("utf8");
  detailUrl = String(detailPage.read2xsggResponseUrl || detailUrl);
  const detailDoc = loadDocument(detailHtml, detailUrl);
  const detailCover = detailCoverSelector(detailDoc);
  const detailOrigin = new URL(detailUrl).origin;
  const detailAnchors = pageAnchors(detailDoc, detailUrl, detailOrigin);

  let chapterDocument = detailDoc;
  let chapterPageUrl = detailUrl;
  let tocSelector = "";
  let chapterRequestInfo = "";
  let chapterLinks = detailAnchors.filter((item) => (
    CHAPTER_HREF.test(item.href)
    && (CHAPTER_TEXT.test(item.text) || STRONG_CHAPTER_HREF.test(item.href))
    && !/(?:\/cmt\/|\/comment)/i.test(item.href)
    && item.text.length <= 100
  ));
  if (chapterLinks.length < 3) {
    chapterLinks = scoreLinkCluster(
      detailAnchors.filter((item) => CHAPTER_TEXT.test(item.text) && !/(?:\/cmt\/|\/comment)/i.test(item.href)),
      detailUrl,
    );
  }
  if (chapterLinks.length < 2 && /^https?:\/\//i.test(String(adapterBase || ""))) {
    const catalogue = detailAnchors
      .map((item, order) => ({
        ...item,
        score: (/(?:章节目录|全部章节|目录列表|目录|catalog|directory|table\s+of\s+contents)/i.test(item.text) ? 1_000 : 0)
          + (/(?:catalog|chapter[-_/]?list|chapters|directory|mulu|\/i\/\d+)/i.test(item.href) ? 300 : 0)
          - (/(?:开始阅读|点击阅读|继续阅读|下一章|上一章|read\s*now)/i.test(item.text) ? 500 : 0)
          - order,
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0];
    if (catalogue) {
      try {
        const cataloguePage = await download(catalogue.href);
        const catalogueUrl = String(cataloguePage.read2xsggResponseUrl || catalogue.href);
        const catalogueHtml = cataloguePage.toString("utf8");
        const catalogueDoc = loadDocument(catalogueHtml, catalogueUrl);
        const catalogueAnchors = pageAnchors(catalogueDoc, catalogueUrl, new URL(catalogueUrl).origin);
        let linked = catalogueAnchors.filter((item) => (
          CHAPTER_HREF.test(item.href)
          && CHAPTER_TEXT.test(item.text)
          && !/(?:\/cmt\/|\/comment)/i.test(item.href)
          && item.text.length <= 100
        ));
        if (linked.length < 2) {
          linked = scoreLinkCluster(
            catalogueAnchors.filter((item) => CHAPTER_TEXT.test(item.text) && !/(?:\/cmt\/|\/comment)/i.test(item.href)),
            catalogueUrl,
          );
        }
        if (linked.length >= 2) {
          chapterLinks = linked;
          chapterDocument = catalogueDoc;
          chapterPageUrl = catalogueUrl;
          tocSelector = `${xpathForElement(catalogue.el, detailDoc)}/@href`;
          const endpoint = `${String(adapterBase).replace(/\/$/, "")}/adapter/toc?selector=${encodeURIComponent(tocSelector)}&url=`;
          chapterRequestInfo = [
            "@js:",
            "var q = params.queryInfo || {};",
            'var u = (typeof result === "string") ? result : "";',
            'if (!u && result && typeof result === "object") u = result.detailUrl || result.url || "";',
            'u = String(q.detailUrl || u || q.url || "");',
            `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
          ].join("\n");
        }
      } catch {
        // Continue with direct detail-page discovery diagnostics.
      }
    }
  }
  if (chapterLinks.length < 1) {
    diagnostics.push("toc: 详情页没有可用章节链接");
    return null;
  }
  const chapterElements = chapterLinks.map((item) => item.el);
  const stableChapterSelector = chapterLinks.length >= 2
    ? chapterAnchorSelectorFromLinks(chapterElements, chapterDocument, chapterPageUrl)
    : "";
  const chapterListSelector = stableChapterSelector || listSelectorFromLinks(chapterElements, chapterDocument);
  const chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;

  let contentSelector = "";
  if (maxPages >= 3) {
    const chapterHtml = (await download(chapterUrl)).toString("utf8");
    contentSelector = findContentSelector(loadDocument(chapterHtml, chapterUrl));
  }
  if (!contentSelector) contentSelector = "//*[@id='content']";

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;
  const search = discoverSearchRequest(document, homeUrl, { html });

  return {
    kind: "text",
    host: pageOrigin,
    title,
    homeUrl,
    listUrl: pagedListUrl || homeUrl,
    listRequestInfo: pagedListUrl ? "" : homeRequestInfo,
    listPageSize: pagedListUrl ? cluster.length : 20,
    listSelector,
    bookNameSelector: bookNameSelector(),
    detailUrlSelector: stableListSelector ? "./@href||//@href" : ".//a/@href||./@href||//@href",
    listCoverSelector,
    detailCoverSelector: detailCover,
    searchRequestInfo: search?.requestInfo || "",
    searchEncode: {
      ...(search?.requestParamsEncode ? { requestParamsEncode: search.requestParamsEncode } : {}),
      ...(search?.responseEncode ? { responseEncode: search.responseEncode } : {}),
    },
    detailSampleUrl: detailUrl,
    tocSelector,
    chapterRequestInfo,
    chapterListSelector,
    chapterTitleSelector: stableChapterSelector ? "normalize-space(.)||normalize-space(/html/body/*)" : "normalize-space(.//a)||normalize-space(/html/body/*)",
    chapterUrlSelector: stableChapterSelector ? "./@href||//@href" : ".//a/@href||./@href||//@href",
    chapterSampleUrl: chapterUrl,
    contentSelector,
    bookCount: cluster.length,
    chapterCount: chapterLinks.length,
  };
}

export { absolute, cssEscapeFallback } from "./domUtil.js";
