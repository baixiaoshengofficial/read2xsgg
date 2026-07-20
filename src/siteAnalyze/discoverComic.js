import {
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  visibleText,
} from "./domUtil.js";

const COMIC_HREF = /\/(?:comic|comics|manga|manhua|mh|cartoon|chapter)\/|(?:漫画)/i;
const CHAPTER_HREF = /\/(?:comic|comics|manga|manhua|mh|chapter|view)\/|\/\d+(?:-\d+)?\.html?$/i;

function imageCount(document) {
  return document.querySelectorAll("img[src], img[data-src], img[data-original], source[srcset]").length;
}

/**
 * Heuristic comic-site discovery: book list → chapter list → image-heavy page.
 */
export async function discoverComic(originUrl, { download, homeHtml = "" } = {}) {
  if (typeof download !== "function") throw new TypeError("discoverComic 需要 download");
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

  const comicLinks = anchors.filter((item) => (
    (COMIC_HREF.test(item.href) || /漫画|comic|manga/i.test(item.text))
    && item.text.length >= 2
    && item.text.length <= 80
  ));
  const cluster = scoreLinkCluster(
    comicLinks.length ? comicLinks : anchors.filter((a) => a.text.length >= 2 && a.text.length <= 60),
    homeUrl,
  ).slice(0, 30);
  if (cluster.length < 3) return null;

  const listSelector = listSelectorFromLinks(cluster.map((item) => item.el), document);
  const detailUrl = cluster.find((item) => COMIC_HREF.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) return null;

  const detailHtml = (await download(detailUrl)).toString("utf8");
  const detailDoc = loadDocument(detailHtml, detailUrl);
  const detailAnchors = pageAnchors(detailDoc, detailUrl, origin.origin);

  let chapterLinks = detailAnchors.filter((item) => CHAPTER_HREF.test(item.href) && item.text.length <= 60);
  if (chapterLinks.length < 2) {
    chapterLinks = scoreLinkCluster(
      detailAnchors.filter((a) => /\d|话|章|卷|回/.test(a.text)),
      detailUrl,
    );
  }
  if (chapterLinks.length < 2) return null;

  const chapterListSelector = listSelectorFromLinks(chapterLinks.map((item) => item.el), detailDoc);
  const chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;
  const chapterHtml = (await download(chapterUrl)).toString("utf8");
  const chapterDoc = loadDocument(chapterHtml, chapterUrl);
  if (imageCount(chapterDoc) < 3) return null;

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;
  return {
    kind: "comic",
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
    contentSelector: [
      "//img/@src|//img/@data-src|//img/@data-original||@js:",
      "var urls = Array.isArray(result)",
      "  ? result.map(function (item) { return String(item || \"\").trim(); }).filter(Boolean)",
      "  : String(result || \"\").split(/\\r?\\n/).map(function (line) {",
      "      return String(line || \"\").trim();",
      "    }).filter(Boolean);",
      "return JSON.stringify({ urls: urls, httpHeaders: {} });",
    ].join("\n"),
    bookCount: cluster.length,
    chapterCount: chapterLinks.length,
    imageCount: imageCount(chapterDoc),
  };
}
