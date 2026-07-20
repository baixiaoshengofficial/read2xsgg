import {
  absolute,
  classContainsXPath,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  visibleText,
  xpathForElement,
} from "./domUtil.js";

const BOOK_HREF = /(?:\/(?:book|novel|info|xiaoshuo|story|article)\/|\/\d{3,}\.html?$|\/read\/\d+)/i;
const CHAPTER_HREF = /(?:\/(?:chapter|chapters|read|book)\/|\/\d+\.html?$)/i;
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
export async function discoverNovel(originUrl, { download, maxPages = 4, homeHtml = "" } = {}) {
  if (typeof download !== "function") throw new TypeError("discoverNovel 需要 download");
  let origin;
  try {
    origin = new URL(originUrl);
  } catch {
    return null;
  }
  const homeUrl = `${origin.protocol}//${origin.host}/`;
  const html = homeHtml || (await download(homeUrl)).toString("utf8");
  const document = loadDocument(html, homeUrl);
  const anchors = pageAnchors(document, homeUrl, origin.origin);

  const bookLinks = anchors.filter((item) => BOOK_HREF.test(item.href) && item.text.length >= 2 && item.text.length <= 80);
  const cluster = scoreLinkCluster(bookLinks.length ? bookLinks : anchors.filter((a) => a.text.length >= 2), homeUrl)
    .slice(0, 30);
  if (cluster.length < 3) return null;

  const listSelector = listSelectorFromLinks(cluster.map((item) => item.el), document);
  const detailUrl = cluster.find((item) => BOOK_HREF.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) return null;

  const detailHtml = (await download(detailUrl)).toString("utf8");
  const detailDoc = loadDocument(detailHtml, detailUrl);
  const detailAnchors = pageAnchors(detailDoc, detailUrl, origin.origin);

  let chapterLinks = detailAnchors.filter((item) => CHAPTER_HREF.test(item.href) && item.text.length <= 60);
  if (chapterLinks.length < 3) {
    chapterLinks = scoreLinkCluster(detailAnchors.filter((a) => /\d|章|节|回/.test(a.text)), detailUrl);
  }
  if (chapterLinks.length < 2) return null;
  const chapterListSelector = listSelectorFromLinks(chapterLinks.map((item) => item.el), detailDoc);
  const chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;

  let contentSelector = "";
  if (maxPages >= 3) {
    const chapterHtml = (await download(chapterUrl)).toString("utf8");
    contentSelector = findContentSelector(loadDocument(chapterHtml, chapterUrl));
  }
  if (!contentSelector) contentSelector = "//*[@id='content']";

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;

  return {
    kind: "text",
    host: `${origin.protocol}//${origin.host}`,
    title,
    homeUrl,
    listUrl: homeUrl,
    listSelector,
    bookNameSelector: ".//a||normalize-space(/html/body/*)",
    detailUrlSelector: ".//a/@href||//@href",
    detailSampleUrl: detailUrl,
    chapterListSelector,
    chapterTitleSelector: "normalize-space(.//a)||normalize-space(/html/body/*)",
    chapterUrlSelector: ".//a/@href||./@href||//@href",
    chapterSampleUrl: chapterUrl,
    contentSelector,
    bookCount: cluster.length,
    chapterCount: chapterLinks.length,
  };
}

export { absolute, cssEscapeFallback } from "./domUtil.js";
