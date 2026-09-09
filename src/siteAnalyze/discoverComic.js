import { detailCoverSelector, listCoverSelectorFromLinks } from "./coverSelectors.js";
import { discoverSearchRequest } from "./discoverSearch.js";
import { discoverPagedListUrl } from "./pagination.js";
import {
  bookNameSelector,
  chapterAnchorSelectorFromLinks,
  linkHasNearbyCover,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  stableAnchorSelectorFromLinks,
  visibleText,
  xpathForElement,
} from "./domUtil.js";
import { dynamicHtmlRequestUrl } from "./dynamicHtml.js";
import { unpackDeanEdwards } from "../mediaPlan.js";

const COMIC_HREF = /\/(?:comic|comics|manga|manhua|mh|cartoon|chapter)\/|(?:漫画)/i;
const CHAPTER_HREF = /\/(?:comic|comics|manga|manhua|mh|chapter|view)\/|\/\d+(?:-\d+)?\.html?$|[?&](?:chapter|chapter_?slot|episode|episode_?slot|section_?slot)=/i;
const CHAPTER_TEXT = /(?:第\s*.{0,12}[話话章回卷集]|\d+\s*[話话章回卷集]|全[一1][話话]|番外|序章)/i;

function likelyComicChapter(item, detailUrl) {
  let target;
  let detail;
  try {
    target = new URL(item.href, detailUrl);
    detail = new URL(detailUrl);
  } catch {
    return false;
  }
  const targetPath = target.pathname.replace(/\/$/, "");
  const detailPath = detail.pathname.replace(/\/$/, "");
  const detailStem = detailPath.replace(/\.(?:html?|php|aspx?)$/i, "");
  if (!targetPath || targetPath === detailPath) return false;
  const childPath = targetPath.startsWith(`${detailPath}/`) || targetPath.startsWith(`${detailStem}/`);
  const explicitRoute = /\/(?:chapter|chapters|read|view)(?:[-_/]|$)/i.test(targetPath);
  const semanticQuery = [...target.searchParams.keys()]
    .some((key) => /^(?:chapter|chapter_?slot|episode|episode_?slot|section_?slot)$/i.test(key));
  return childPath || ((explicitRoute || semanticQuery) && CHAPTER_TEXT.test(item.text));
}

function imageCount(document) {
  return document.querySelectorAll("img[src], img[data-src], img[data-original], source[srcset]").length;
}

function packedImageCount(html) {
  let best = 0;
  for (const match of String(html || "").matchAll(
    /<script\b[^>]*>([\s\S]*?eval\(function\(p,a,c,k,e,[dr]\)[\s\S]*?)<\/script>/gi,
  )) {
    const unpacked = unpackDeanEdwards(match[1]);
    if (!unpacked) continue;
    const urls = new Set();
    for (const urlMatch of unpacked.matchAll(/https?:\/\/[^\s"'<>$|,;\\\]]+/gi)) {
      if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(urlMatch[0])) {
        urls.add(urlMatch[0]);
      }
    }
    best = Math.max(best, urls.size);
  }
  return best;
}

/**
 * Heuristic comic-site discovery: book list → chapter list → image-heavy page.
 */
export async function discoverComic(originUrl, {
  download,
  homeHtml = "",
  homeRequestInfo = "",
  homeResponseUrl = "",
  adapterBase = "",
  diagnostics = [],
} = {}) {
  if (typeof download !== "function") throw new TypeError("discoverComic 需要 download");
  let requestedHome;
  let origin;
  try {
    requestedHome = new URL(originUrl);
    origin = new URL(homeResponseUrl || originUrl);
  } catch {
    return null;
  }
  origin.hash = "";
  const homeUrl = origin.toString();
  requestedHome.hash = "";
  const html = homeHtml || (await download(requestedHome.toString())).toString("utf8");
  const document = loadDocument(html, homeUrl);
  const allAnchors = pageAnchors(document, homeUrl);
  const sameOriginAnchors = allAnchors.filter((item) => new URL(item.href).origin === origin.origin);

  const comicLinksByOrigin = new Map();
  for (const item of allAnchors.filter((candidate) => (
    (COMIC_HREF.test(candidate.href) || /漫画|comic|manga/i.test(candidate.text))
    && candidate.text.length >= 2
    && candidate.text.length <= 80
  ))) {
    const itemOrigin = new URL(item.href).origin;
    const rows = comicLinksByOrigin.get(itemOrigin) || [];
    rows.push(item);
    comicLinksByOrigin.set(itemOrigin, rows);
  }
  const rankedComicOrigins = [...comicLinksByOrigin.entries()]
    .sort((left, right) => {
      const covered = (rows) => rows.filter(linkHasNearbyCover).length;
      const leftScore = covered(left[1]) * 100 + left[1].length + (left[0] === origin.origin ? 20 : 0);
      const rightScore = covered(right[1]) * 100 + right[1].length + (right[0] === origin.origin ? 20 : 0);
      return rightScore - leftScore;
    });
  const rankedComicOrigin = rankedComicOrigins[0];
  const dominantSemanticOrigin = rankedComicOrigin
    && rankedComicOrigin[0] !== origin.origin
    && rankedComicOrigin[1].length >= 8
    && rankedComicOrigin[1].length >= ((rankedComicOrigins[1]?.[1]?.length || 0) * 2);
  const acceptedComicOrigin = rankedComicOrigin
    && (rankedComicOrigin[0] === origin.origin
      || rankedComicOrigin[1].filter(linkHasNearbyCover).length >= 5
      || dominantSemanticOrigin);
  const comicLinks = rankedComicOrigin
    && acceptedComicOrigin
    ? rankedComicOrigin[1]
    : comicLinksByOrigin.get(origin.origin) || [];
  const contentOrigin = acceptedComicOrigin ? rankedComicOrigin[0] : origin.origin;
  const coveredComicLinks = comicLinks.filter((item) => (
    linkHasNearbyCover(item)
    && !CHAPTER_TEXT.test(item.text)
    && !/\/(?:chapter|chapters|read|view)(?:[-_/]|$)/i.test(new URL(item.href).pathname)
  ));
  const semanticComicLinks = comicLinks.filter((item) => (
    !CHAPTER_TEXT.test(item.text)
    && !/\/(?:chapter|chapters|read|view)(?:[-_/]|$)/i.test(new URL(item.href).pathname)
  ));
  const listCandidates = coveredComicLinks.length >= 2
    ? coveredComicLinks
    : semanticComicLinks.length >= 2 ? semanticComicLinks : comicLinks;
  const cluster = scoreLinkCluster(
    listCandidates.length ? listCandidates : sameOriginAnchors.filter((a) => a.text.length >= 2 && a.text.length <= 60),
    homeUrl,
  ).slice(0, 30);
  if (cluster.length < 2) {
    diagnostics.push("list: 漫画链接不足 2 条");
    return null;
  }

  const listLinks = cluster.map((item) => item.el);
  const stableListSelector = stableAnchorSelectorFromLinks(listLinks, document, homeUrl);
  const listSelector = stableListSelector || listSelectorFromLinks(listLinks, document);
  const listCoverSelector = listCoverSelectorFromLinks(listLinks);
  const pagedListUrl = await discoverPagedListUrl(document, homeUrl, {
    origin: contentOrigin,
    listSelector,
    download,
  });
  const detailUrl = cluster.find((item) => COMIC_HREF.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) {
    diagnostics.push("detail: 未取得漫画详情 URL");
    return null;
  }

  const detailPage = await download(detailUrl);
  const detailResponseUrl = String(detailPage.read2xsggResponseUrl || detailUrl);
  const detailHtml = detailPage.toString("utf8");
  const detailDoc = loadDocument(detailHtml, detailResponseUrl);
  const detailCover = detailCoverSelector(detailDoc);
  const detailAnchors = pageAnchors(detailDoc, detailResponseUrl, new URL(detailResponseUrl).origin);

  let chapterDocument = detailDoc;
  let chapterListPageUrl = detailResponseUrl;
  let chapterRequestInfo = "";
  let tocSelector = "";
  let chapterLinks = detailAnchors.filter((item) => (
    CHAPTER_HREF.test(item.href)
    && item.text.length <= 60
    && likelyComicChapter(item, detailResponseUrl)
  ));
  if (chapterLinks.length < 2) {
    chapterLinks = scoreLinkCluster(
      detailAnchors.filter((item) => CHAPTER_TEXT.test(item.text) && likelyComicChapter(item, detailResponseUrl)),
      detailResponseUrl,
    );
  }
  if (chapterLinks.length < 2) {
    const catalogue = detailAnchors
      .map((item, order) => ({
        ...item,
        score: (/(?:章节目录|全部章节|目录列表|目录|catalog|directory|chapter\s*list)/i.test(item.text) ? 1_000 : 0)
          + (/(?:catalog|chapter[-_/]?list|chapters|directory|mulu)/i.test(item.href) ? 300 : 0)
          - order,
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0];
    if (catalogue) {
      try {
        const cataloguePage = await download(catalogue.href);
        const catalogueUrl = String(cataloguePage.read2xsggResponseUrl || catalogue.href);
        let catalogueHtml = cataloguePage.toString("utf8");
        let parsedUrl = catalogueUrl;
        let parsedDoc = loadDocument(catalogueHtml, parsedUrl);
        let parsedAnchors = pageAnchors(parsedDoc, parsedUrl, new URL(parsedUrl).origin);
        let linked = parsedAnchors.filter((item) => (
          CHAPTER_HREF.test(item.href)
          && item.text.length <= 60
          && likelyComicChapter(item, detailResponseUrl)
        ));
        const dynamicUrl = linked.length < 2 ? dynamicHtmlRequestUrl(catalogueHtml, catalogueUrl) : "";
        if (dynamicUrl) {
          const dynamicPage = await download(dynamicUrl, { Referer: catalogueUrl });
          catalogueHtml = dynamicPage.toString("utf8");
          parsedUrl = String(dynamicPage.read2xsggResponseUrl || dynamicUrl);
          parsedDoc = loadDocument(catalogueHtml, parsedUrl);
          parsedAnchors = pageAnchors(parsedDoc, parsedUrl, new URL(parsedUrl).origin);
          linked = parsedAnchors.filter((item) => (
            CHAPTER_HREF.test(item.href)
            && item.text.length <= 60
            && likelyComicChapter(item, detailResponseUrl)
          ));
        }
        if (linked.length >= 1) {
          chapterLinks = linked;
          chapterDocument = parsedDoc;
          chapterListPageUrl = parsedUrl;
          tocSelector = `${xpathForElement(catalogue.el, detailDoc)}/@href`;
          if (/^https?:\/\//i.test(String(adapterBase || ""))) {
            const endpoint = `${String(adapterBase).replace(/\/$/, "")}/adapter/toc?resolve=html&selector=${encodeURIComponent(tocSelector)}&url=`;
            chapterRequestInfo = [
              "@js:",
              "var q = params.queryInfo || {};",
              'var u = (typeof result === "string") ? result : "";',
              'if (!u && result && typeof result === "object") u = result.detailUrl || result.url || "";',
              'u = String(q.detailUrl || u || q.url || "");',
              `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
            ].join("\n");
          }
        }
      } catch {
        // Continue to the standard insufficient-TOC diagnostic.
      }
    }
  }
  if (chapterLinks.length < 2) {
    diagnostics.push("toc: 漫画章节链接不足 2 条");
    return null;
  }

  const chapterElements = chapterLinks.map((item) => item.el);
  const stableChapterSelector = chapterAnchorSelectorFromLinks(chapterElements, chapterDocument, chapterListPageUrl);
  const chapterListSelector = stableChapterSelector || listSelectorFromLinks(chapterElements, chapterDocument);
  const chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;
  const chapterPage = await download(chapterUrl);
  const chapterResponseUrl = String(chapterPage.read2xsggResponseUrl || chapterUrl);
  const chapterHtml = chapterPage.toString("utf8");
  const chapterDoc = loadDocument(chapterHtml, chapterResponseUrl);
  let discoveredImageCount = Math.max(imageCount(chapterDoc), packedImageCount(chapterHtml));
  let dynamicChapterContent = false;
  const dynamicChapterUrl = dynamicHtmlRequestUrl(chapterHtml, chapterResponseUrl);
  if (dynamicChapterUrl) {
    try {
      const dynamicPage = await download(dynamicChapterUrl, { Referer: chapterResponseUrl });
      const dynamicResponseUrl = String(dynamicPage.read2xsggResponseUrl || dynamicChapterUrl);
      const dynamicHtml = dynamicPage.toString("utf8");
      const dynamicCount = Math.max(
        imageCount(loadDocument(dynamicHtml, dynamicResponseUrl)),
        packedImageCount(dynamicHtml),
      );
      if (dynamicCount >= 2) {
        discoveredImageCount = Math.max(discoveredImageCount, dynamicCount);
        dynamicChapterContent = true;
      }
    } catch {
      // The static page and the strict repair pass remain available.
    }
  }
  if (discoveredImageCount < 2) {
    diagnostics.push("content: 章节图片不足 2 张");
    return null;
  }

  let contentRequestInfo = "";
  let contentResponseFormatType = "html";
  let contentSelector = [
    "//img/@src|//img/@data-src|//img/@data-original||@js:",
    "var urls = Array.isArray(result)",
    "  ? result.map(function (item) { return String(item || \"\").trim(); }).filter(Boolean)",
    "  : String(result || \"\").split(/\\r?\\n/).map(function (line) {",
    "      return String(line || \"\").trim();",
    "    }).filter(Boolean);",
    "return JSON.stringify({ urls: urls, httpHeaders: {} });",
  ].join("\n");
  if (dynamicChapterContent && /^https?:\/\//i.test(String(adapterBase || ""))) {
    const endpoint = `${String(adapterBase).replace(/\/$/, "")}/adapter/images?v=2&url=`;
    contentRequestInfo = [
      "@js:",
      "var q = (params && params.queryInfo) || {};",
      'var u = (typeof result === "string") ? result : "";',
      'if (!u) u = q.chapterUrl || q.url || q.detailUrl || "";',
      `return ${JSON.stringify(endpoint)} + encodeURIComponent(String(u || "")) + "&referer=" + encodeURIComponent(String(u || ""));`,
    ].join("\n");
    contentResponseFormatType = "json";
    contentSelector = [
      "$.proxyUrls||$.urls||@js:",
      "var urls = Array.isArray(result) ? result.map(function (item) { return String(item || \"\"); }).filter(Boolean) : [];",
      "return JSON.stringify({ urls: urls, httpHeaders: {} });",
    ].join("\n");
  }

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;
  const search = discoverSearchRequest(document, homeUrl, { html });
  return {
    kind: "comic",
    host: contentOrigin,
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
    detailSampleUrl: detailResponseUrl,
    tocSelector,
    chapterRequestInfo,
    chapterListSelector,
    chapterTitleSelector: stableChapterSelector ? "normalize-space(.)||normalize-space(/html/body/*)" : "normalize-space(.//a)||normalize-space(/html/body/*)",
    chapterUrlSelector: stableChapterSelector ? "./@href||//@href" : ".//a/@href||./@href||//@href",
    chapterSampleUrl: chapterResponseUrl,
    contentRequestInfo,
    contentResponseFormatType,
    contentSelector,
    bookCount: cluster.length,
    chapterCount: chapterLinks.length,
    imageCount: discoveredImageCount,
  };
}
