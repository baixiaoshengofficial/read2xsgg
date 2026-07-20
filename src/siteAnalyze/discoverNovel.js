import { JSDOM } from "jsdom";

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

function absolute(href, baseUrl) {
  try { return new URL(String(href || "").trim(), baseUrl).toString(); } catch { return ""; }
}

function visibleText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function scoreLinkCluster(links, baseUrl) {
  const samePathPrefix = new Map();
  for (const link of links) {
    let pathname = "";
    try { pathname = new URL(link.href, baseUrl).pathname; } catch { continue; }
    const parts = pathname.split("/").filter(Boolean);
    // Cluster by the first path segment (e.g. /book/1.html and /book/2.html
    // share "book"). Using two segments made every numbered page its own bucket.
    const key = parts[0] || "/";
    const bucket = samePathPrefix.get(key) || [];
    bucket.push(link);
    samePathPrefix.set(key, bucket);
  }
  let best = [];
  for (const bucket of samePathPrefix.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  return best;
}

function xpathForElement(el, document) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) {
    const safeId = String(el.id).replace(/'/g, "");
    if (safeId && document.querySelectorAll(`[id="${cssEscapeFallback(safeId)}"]`).length === 1) {
      return `//*[@id='${safeId}']`;
    }
  }
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent || parent === document.documentElement) return `//${tag}`;
  const siblings = [...parent.children].filter((node) => node.tagName === el.tagName);
  if (siblings.length === 1) {
    const parentPath = xpathForElement(parent, document);
    return parentPath ? `${parentPath}/${tag}` : `//${tag}`;
  }
  const index = siblings.indexOf(el) + 1;
  const parentPath = xpathForElement(parent, document);
  return parentPath ? `${parentPath}/${tag}[${index}]` : `//${tag}[${index}]`;
}

function cssEscapeFallback(value) {
  return String(value).replace(/(["\\])/g, "\\$1");
}

function classContainsXPath(className) {
  return `//*[contains(concat(' ', normalize-space(@class), ' '), ' ${className} ')]`;
}

function listSelectorFromLinks(links, document) {
  if (!links.length) return "";
  const parents = new Map();
  for (const link of links) {
    const parent = link.parentElement;
    if (!parent) continue;
    const key = parent.className || parent.id || parent.tagName;
    const bucket = parents.get(parent) || [];
    bucket.push(link);
    parents.set(parent, bucket);
  }
  let bestParent = null;
  let bestCount = 0;
  for (const [parent, bucket] of parents) {
    if (bucket.length > bestCount) {
      bestParent = parent;
      bestCount = bucket.length;
    }
  }
  if (!bestParent) return "//a";
  if (bestParent.id) return `//*[@id='${bestParent.id}']//a`;
  const className = String(bestParent.className || "").trim().split(/\s+/).find(Boolean);
  if (className) return `${classContainsXPath(className)}//a`;
  return `${xpathForElement(bestParent, document)}//a`;
}

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
export async function discoverNovel(originUrl, { download, maxPages = 4 } = {}) {
  if (typeof download !== "function") throw new TypeError("discoverNovel 需要 download");
  let origin;
  try {
    origin = new URL(originUrl);
  } catch {
    return null;
  }
  const homeUrl = `${origin.protocol}//${origin.host}/`;
  const homeBuf = await download(homeUrl);
  const homeHtml = homeBuf.toString("utf8");
  const homeDom = new JSDOM(homeHtml, { url: homeUrl });
  const { document } = homeDom.window;

  const anchors = [...document.querySelectorAll("a[href]")].map((a) => ({
    href: absolute(a.getAttribute("href"), homeUrl),
    text: visibleText(a),
    el: a,
  })).filter((item) => item.href && item.href.startsWith(origin.protocol));

  const bookLinks = anchors.filter((item) => BOOK_HREF.test(item.href) && item.text.length >= 2 && item.text.length <= 80);
  const cluster = scoreLinkCluster(bookLinks.length ? bookLinks : anchors.filter((a) => a.text.length >= 2), homeUrl)
    .slice(0, 30);
  if (cluster.length < 3) return null;

  const listSelector = listSelectorFromLinks(cluster.map((item) => item.el), document);
  const detailUrl = cluster.find((item) => BOOK_HREF.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) return null;

  const detailBuf = await download(detailUrl);
  const detailHtml = detailBuf.toString("utf8");
  const detailDom = new JSDOM(detailHtml, { url: detailUrl });
  const detailDoc = detailDom.window.document;
  const detailAnchors = [...detailDoc.querySelectorAll("a[href]")].map((a) => ({
    href: absolute(a.getAttribute("href"), detailUrl),
    text: visibleText(a),
    el: a,
  })).filter((item) => item.href && item.text);

  let chapterLinks = detailAnchors.filter((item) => CHAPTER_HREF.test(item.href) && item.text.length <= 60);
  if (chapterLinks.length < 3) {
    chapterLinks = scoreLinkCluster(detailAnchors.filter((a) => /\d|章|节|回/.test(a.text)), detailUrl);
  }
  if (chapterLinks.length < 2) return null;
  const chapterListSelector = listSelectorFromLinks(chapterLinks.map((item) => item.el), detailDoc);
  const chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;

  let contentSelector = "";
  if (maxPages >= 3) {
    const chapterBuf = await download(chapterUrl);
    const chapterDom = new JSDOM(chapterBuf.toString("utf8"), { url: chapterUrl });
    contentSelector = findContentSelector(chapterDom.window.document);
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
    bookNameSelector: ".",
    detailUrlSelector: "./@href",
    detailSampleUrl: detailUrl,
    chapterListSelector,
    chapterTitleSelector: ".",
    chapterUrlSelector: "./@href",
    chapterSampleUrl: chapterUrl,
    contentSelector,
    bookCount: cluster.length,
    chapterCount: chapterLinks.length,
  };
}

export { cssEscapeFallback };
