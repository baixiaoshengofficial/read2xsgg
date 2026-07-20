import { detailCoverSelector, listCoverSelectorFromLinks } from "./coverSelectors.js";
import { discoverSearchRequest } from "./discoverSearch.js";
import {
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  visibleText,
} from "./domUtil.js";

const AUDIO_HREF = /\/(?:audio|ting|sound|music|radio|mp3|book)\/|(?:听书|有声)/i;
const VIDEO_HREF = /\/(?:video|vod|movie|play|film|drama|tv)\/|(?:影视|电影|剧集)/i;
const MEDIA_FILE = /\.(?:mp3|m4a|aac|ogg|wav|flac|mp4|m3u8|webm)(?:\?|$)/i;

function mediaHrefPattern(kind) {
  return kind === "video" ? VIDEO_HREF : AUDIO_HREF;
}

function mediaKeyword(kind) {
  return kind === "video" ? /影视|电影|剧集|视频|播放/i : /听书|有声|音频|电台|广播/i;
}

function findMediaUrl(document, pageUrl) {
  for (const el of document.querySelectorAll("audio[src], video[src], source[src], a[href]")) {
    const raw = el.getAttribute("src") || el.getAttribute("href") || "";
    if (!raw) continue;
    let href = "";
    try { href = new URL(raw, pageUrl).toString(); } catch { continue; }
    if (MEDIA_FILE.test(href) || el.tagName === "AUDIO" || el.tagName === "VIDEO" || el.tagName === "SOURCE") {
      return href;
    }
  }
  const html = document.documentElement?.innerHTML || "";
  const match = html.match(/https?:\/\/[^"'\\s<>]+\.(?:mp3|m4a|aac|ogg|wav|flac|mp4|m3u8|webm)(?:\?[^"'\\s<>]*)?/i);
  return match?.[0] || "";
}

/**
 * Heuristic audio/video discovery: catalog → episode list → playable URL on page or as chapter link.
 */
export async function discoverMedia(originUrl, kind, { download, homeHtml = "" } = {}) {
  if (kind !== "audio" && kind !== "video") return null;
  if (typeof download !== "function") throw new TypeError("discoverMedia 需要 download");
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
  const hrefRe = mediaHrefPattern(kind);
  const textRe = mediaKeyword(kind);

  const mediaLinks = anchors.filter((item) => (
    (hrefRe.test(item.href) || textRe.test(item.text) || MEDIA_FILE.test(item.href))
    && item.text.length >= 2
    && item.text.length <= 80
  ));
  const cluster = scoreLinkCluster(
    mediaLinks.length ? mediaLinks : anchors.filter((a) => a.text.length >= 2 && a.text.length <= 60),
    homeUrl,
  ).slice(0, 30);
  if (cluster.length < 3) return null;

  const listLinks = cluster.map((item) => item.el);
  const listSelector = listSelectorFromLinks(listLinks, document);
  const listCoverSelector = listCoverSelectorFromLinks(listLinks);
  const detailUrl = cluster.find((item) => hrefRe.test(item.href) || MEDIA_FILE.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) return null;

  const detailHtml = (await download(detailUrl)).toString("utf8");
  const detailDoc = loadDocument(detailHtml, detailUrl);
  const detailCover = detailCoverSelector(detailDoc);
  const detailAnchors = pageAnchors(detailDoc, detailUrl, origin.origin);

  let chapterLinks = detailAnchors.filter((item) => (
    (hrefRe.test(item.href) || MEDIA_FILE.test(item.href) || /\d|集|章|回|话/.test(item.text))
    && item.text.length <= 80
  ));
  if (chapterLinks.length < 2) {
    chapterLinks = scoreLinkCluster(detailAnchors.filter((a) => a.text.length >= 1), detailUrl);
  }

  let chapterListSelector = "";
  let chapterUrl = "";
  let directMedia = findMediaUrl(detailDoc, detailUrl);

  if (chapterLinks.length >= 2) {
    chapterListSelector = listSelectorFromLinks(chapterLinks.map((item) => item.el), detailDoc);
    chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;
    if (!MEDIA_FILE.test(chapterUrl)) {
      const chapterHtml = (await download(chapterUrl)).toString("utf8");
      directMedia = findMediaUrl(loadDocument(chapterHtml, chapterUrl), chapterUrl) || directMedia;
    } else {
      directMedia = chapterUrl;
    }
  } else if (directMedia) {
    // Detail page itself is playable — treat catalog item URL as the only "chapter".
    chapterListSelector = listSelector;
    chapterUrl = detailUrl;
  } else {
    return null;
  }

  if (!directMedia && !MEDIA_FILE.test(chapterUrl)) {
    // Still allow export: chapter URL may resolve via client; require at least a chapter list.
    if (!chapterListSelector) return null;
  }

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;
  const search = discoverSearchRequest(document, homeUrl, { html });
  const contentDirect = [
    "@js:",
    'var q = (typeof params !== "undefined" && params.queryInfo) || {};',
    'var url = String(q.url || q.detailUrl || q.chapterUrl || "").trim();',
    'if (!url && typeof result === "string" && /^(?:https?:)?\\/\\//i.test(result.trim())) url = result.trim();',
    'if (url.indexOf("//") === 0) url = "https:" + url;',
    'else if (url && !/^https?:\\/\\//i.test(url)) url = config.host + (url.charAt(0) === "/" ? url : "/" + url);',
    "return JSON.stringify({",
    "  url: encodeURI(url),",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");

  const contentFromPage = [
    "//audio/@src|//video/@src|//source/@src||@js:",
    "var url = String(result || \"\").trim().split(/\\r?\\n/).map(function (line) {",
    "  return String(line || \"\").trim();",
    "}).filter(Boolean)[0] || \"\";",
    "if (!url) return \"\";",
    "return JSON.stringify({",
    "  url: encodeURI(url),",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");

  return {
    kind,
    host: `${origin.protocol}//${origin.host}`,
    title,
    homeUrl,
    listUrl: homeUrl,
    listSelector,
    bookNameSelector: ".//a||normalize-space(/html/body/*)",
    detailUrlSelector: ".//a/@href||//@href",
    listCoverSelector,
    detailCoverSelector: detailCover,
    searchRequestInfo: search?.requestInfo || "",
    searchEncode: {
      ...(search?.requestParamsEncode ? { requestParamsEncode: search.requestParamsEncode } : {}),
      ...(search?.responseEncode ? { responseEncode: search.responseEncode } : {}),
    },
    detailSampleUrl: detailUrl,
    chapterListSelector,
    chapterTitleSelector: "normalize-space(.//a)||normalize-space(/html/body/*)",
    chapterUrlSelector: ".//a/@href||./@href||//@href",
    chapterSampleUrl: chapterUrl,
    contentSelector: MEDIA_FILE.test(chapterUrl) || !directMedia ? contentDirect : contentFromPage,
    bookCount: cluster.length,
    chapterCount: Math.max(chapterLinks.length, 1),
    mediaSampleUrl: directMedia || chapterUrl,
  };
}
