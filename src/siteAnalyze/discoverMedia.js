import { detailCoverSelector, listCoverSelectorFromLinks } from "./coverSelectors.js";
import { discoverSearchRequest } from "./discoverSearch.js";
import {
  chapterAnchorSelectorFromLinks,
  classContainsXPath,
  linkHasNearbyCover,
  listSelectorFromLinks,
  loadDocument,
  pageAnchors,
  scoreLinkCluster,
  stableAnchorSelectorFromLinks,
  visibleText,
} from "./domUtil.js";
import { discoverSpaMedia } from "./spaMedia.js";
import { discoverPagedListUrl } from "./pagination.js";
import { encodeMediaExtractionPlan } from "../mediaPlan.js";
import { discoverSsrEpisodePlan, encodeSsrEpisodePlan } from "./ssrEpisodes.js";

const AUDIO_HREF = /\/(?:audio|ting|sound|music|radio|mp3|book)\/|(?:听书|有声)/i;
const VIDEO_HREF = /\/(?:video|vod|movie|play|film|drama|tv)\/|(?:影视|电影|剧集)/i;
const MEDIA_FILE = /\.(?:mp3|m4a|aac|ogg|wav|flac|mp4|m3u8|webm)(?:\?|$)/i;
const NON_CONTENT_PATH = /\/(?:about|agreement|privacy|policy|terms|help|support|contact|login|register|download|authors?|actors?|models?|stars?|directors?|categories|category|tags?|genres?|series)(?:\/|$)/i;

function mediaHrefPattern(kind) {
  return kind === "video" ? VIDEO_HREF : AUDIO_HREF;
}

function mediaKeyword(kind) {
  return kind === "video" ? /影视|电影|剧集|视频|播放/i : /听书|有声|音频|电台|广播/i;
}

function strongMediaLink(item, kind) {
  if (MEDIA_FILE.test(item.href) || mediaKeyword(kind).test(item.text)) return true;
  return kind === "video"
    ? /\/(?:video|vod|movie|play|film|drama|tv)(?:\/|$)/i.test(item.href)
    : /\/(?:audio|ting|sound|music|radio|mp3)(?:\/|$)/i.test(item.href);
}

function likelyMediaEpisode(item, detailUrl) {
  if (MEDIA_FILE.test(item.href)) return true;
  let detail;
  let target;
  try {
    detail = new URL(detailUrl);
    target = new URL(item.href, detail);
  } catch {
    return false;
  }
  if (NON_CONTENT_PATH.test(target.pathname)) return false;
  const detailPath = detail.pathname.replace(/\/+$/, "") || "/";
  const targetPath = target.pathname.replace(/\/+$/, "") || "/";
  if (detailPath === targetPath) return false;
  if (targetPath.startsWith(`${detailPath}/`)) return true;
  if (/\/(?:chapters?|episodes?|programs?|tracks?|play)(?:\/|$)/i.test(targetPath)) return true;
  const episodeTitle = /(?:第\s*.{0,20}[集章回话話期]|\d+\s*[集章回话話期]|番外|序章|episode|chapter)/i.test(item.text);
  const routeShape = (value) => value.replace(/\d+/g, ":id");
  if (routeShape(detailPath) === routeShape(targetPath)) return episodeTitle;
  return episodeTitle;
}

function findMediaUrl(document, pageUrl, rawHtml = "") {
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
  if (match?.[0]) return match[0];
  const semantic = String(rawHtml || "").match(
    /["'](?:audio|sound|voice|track|play|video|media|stream|hls)[\w-]*(?:url|uri|src|path)?["']\s*:\s*["']((?:https?:)?\\?\/\\?\/[^"']+)["']/i,
  );
  return semantic?.[1]?.replace(/\\\//g, "/") || "";
}

function delimitedMediaPlaylist(rawHtml, pageUrl, kind) {
  const extension = kind === "video"
    ? /\.(?:m3u8|mp4|m4v|mov|mkv|ts|webm)(?:[?#]|$)/i
    : /\.(?:aac|flac|m3u8|m4a|m4b|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i;
  let best = [];
  for (const tag of String(rawHtml || "").matchAll(/<[a-z][\w:-]*\b([^>]*)>/gi)) {
    for (const attribute of tag[1].matchAll(/\b([\w:-]{1,80})\s*=\s*(["'])([\s\S]*?)\2/g)) {
      if (!/(?:address|audio|sound|voice|track|play|video|media|stream|source|src|url)/i.test(attribute[1])) continue;
      const urls = attribute[3].replace(/&amp;/gi, "&").split(/[|\r\n]+/).flatMap((value) => {
        try {
          const url = new URL(value.trim(), pageUrl).toString();
          return extension.test(url) ? [url] : [];
        } catch { return []; }
      });
      if (urls.length > best.length) best = urls;
    }
  }
  return best;
}

function sharedClassToken(elements) {
  if (!elements.length) return "";
  const first = String(elements[0].className || "").split(/\s+/).filter(Boolean);
  return first.find((token) => token.length >= 3
    && elements.every((element) => element.classList?.contains(token))) || "";
}

function repeatedContentCards(document, baseUrl, origin) {
  const containers = [...document.querySelectorAll("article,a[class*='item' i],a[class*='card' i]")];
  const rows = [];
  const seen = new Set();
  for (const container of containers) {
    const anchor = container.matches("a[href]")
      ? container
      : container.querySelector("h1 a[href],h2 a[href],h3 a[href],h4 a[href],a[rel='bookmark'],a[href][title],a[href]:has(img)");
    if (!anchor) continue;
    let href;
    try { href = new URL(anchor.getAttribute("href"), baseUrl).toString(); } catch { continue; }
    if (new URL(href).origin !== origin || seen.has(href) || NON_CONTENT_PATH.test(new URL(href).pathname)) continue;
    const titleNode = container.querySelector?.("h1,h2,h3,h4,[class*='title' i]");
    const text = visibleText(titleNode || anchor);
    if (text.length < 2 || text.length > 120) continue;
    seen.add(href);
    rows.push({ container, anchor, href, text, el: anchor });
  }
  if (rows.length < 2) return null;
  const groups = new Map();
  const addToGroup = (key, row, className = "") => {
    const group = groups.get(key) || { rows: [], className };
    group.rows.push(row);
    groups.set(key, group);
  };
  for (const row of rows) {
    const tagName = row.container.tagName?.toLowerCase();
    if (!tagName) continue;
    if (tagName === "article") {
      addToGroup("article", row);
      continue;
    }
    const tokens = String(row.container.className || "").split(/\s+/)
      .filter((token) => token.length >= 3 && !/^(?:active|current|first|last|item|card)$/i.test(token));
    for (const token of tokens) addToGroup(`${tagName}.${token}`, row, token);
  }
  const selectedGroup = groups.get("article")?.rows?.length >= 2
    ? groups.get("article")
    : [...groups.values()].filter((group) => group.rows.length >= 2)
      .sort((left, right) => right.rows.length - left.rows.length)[0];
  if (!selectedGroup) return null;
  const selected = selectedGroup.rows;
  const elements = selected.map((row) => row.container);
  const tag = elements[0].tagName.toLowerCase();
  const className = selectedGroup.className || sharedClassToken(elements);
  const listSelector = className
    ? `${classContainsXPath(className).replace(/^\/\/\*/, `//${tag}`)}`
    : tag === "article" ? "//article" : "";
  if (!listSelector) return null;
  const directAnchor = tag === "a";
  return {
    rows: selected,
    listSelector,
    bookNameSelector: directAnchor
      ? ".//*[contains(concat(' ', normalize-space(@class), ' '), ' title ')][1]||normalize-space(.)"
      : ".//h1/a||.//h2/a||.//h3/a||.//h4/a||.//a[@rel='bookmark']||.//a[@title]",
    detailUrlSelector: directAnchor
      ? "./@href||//@href"
      : ".//h1/a/@href||.//h2/a/@href||.//h3/a/@href||.//h4/a/@href||.//a[@rel='bookmark']/@href||.//a[@title]/@href",
  };
}

function adapterRequest(prefix, { preferDetail = false, includeReferer = false } = {}) {
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    preferDetail
      ? 'var u = String(q.detailUrl || q.url || result || "").trim();'
      : 'var u = String(q.chapterUrl || q.url || result || "").trim();',
    ...(includeReferer ? ['var ref = String(q.detailUrl || q.url || "").trim();'] : []),
    `return ${JSON.stringify(prefix)} + encodeURIComponent(u)${includeReferer ? ' + (ref ? "&referer=" + encodeURIComponent(ref) : "")' : ""};`,
  ].join("\n");
}

function pagedDetailAdapterRequest(prefix) {
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var u = String(q.detailUrl || q.url || result || "").trim();',
    'var p = String((params && params.pageIndex) || 1);',
    `return ${JSON.stringify(prefix)}.replace("__PAGE__", p) + encodeURIComponent(u);`,
  ].join("\n");
}

/**
 * Heuristic audio/video discovery: catalog → episode list → playable URL on page or as chapter link.
 */
export async function discoverMedia(originUrl, kind, {
  download,
  homeHtml = "",
  homeRequestInfo = "",
  homeResponseUrl = "",
  adapterBase = "",
  repairSource = null,
  diagnostics = [],
} = {}) {
  if (kind !== "audio" && kind !== "video") return null;
  if (typeof download !== "function") throw new TypeError("discoverMedia 需要 download");
  let requestedHome;
  try {
    requestedHome = new URL(originUrl);
  } catch {
    return null;
  }
  requestedHome.hash = "";
  let homeUrl = String(homeResponseUrl || requestedHome.toString());
  let html = homeHtml;
  if (!html) {
    const page = await download(homeUrl);
    html = page.toString("utf8");
    homeUrl = String(page.read2xsggResponseUrl || homeUrl);
  }
  let origin;
  try {
    origin = new URL(homeUrl);
  } catch {
    return null;
  }
  origin.hash = "";
  const document = loadDocument(html, homeUrl);
  const anchors = pageAnchors(document, homeUrl, origin.origin);
  const hrefRe = mediaHrefPattern(kind);
  const textRe = mediaKeyword(kind);

  const usableAnchors = anchors.filter((item) => !NON_CONTENT_PATH.test(new URL(item.href).pathname));
  const cards = repeatedContentCards(document, homeUrl, origin.origin);
  const mediaLinks = usableAnchors.filter((item) => (
    (hrefRe.test(item.href) || textRe.test(item.text) || MEDIA_FILE.test(item.href))
    && item.text.length >= 2
    && item.text.length <= 80
  ));
  const strongLinks = mediaLinks.filter((item) => strongMediaLink(item, kind));
  const coveredLinks = strongLinks.filter(linkHasNearbyCover);
  const spa = cards ? null : await discoverSpaMedia(originUrl, kind, {
    download,
    homeHtml: html,
    homeResponseUrl,
    adapterBase,
    repairSource,
    diagnostics,
  });
  if (spa) return spa;
  const cluster = cards?.rows?.length ? cards.rows : scoreLinkCluster(
    coveredLinks.length >= 2 ? coveredLinks
      : strongLinks.length ? strongLinks
      : (mediaLinks.length ? mediaLinks : usableAnchors.filter((a) => a.text.length >= 2 && a.text.length <= 60)),
    homeUrl,
  ).slice(0, 30);
  // Audio/video home pages are often SPA shells with few static anchors.
  // Prefer a short cluster over giving up when the page already looks media-like.
  const minCluster = mediaLinks.length >= 1 || mediaKeyword(kind).test(html) ? 1 : 2;
  if (cluster.length < minCluster) {
    diagnostics.push(`list: 媒体链接不足 ${minCluster} 条`);
    return null;
  }

  const listLinks = cluster.map((item) => item.el);
  const stableListSelector = cards ? "" : stableAnchorSelectorFromLinks(listLinks, document, homeUrl);
  const listSelector = cards?.listSelector || stableListSelector || listSelectorFromLinks(listLinks, document);
  const listCoverSelector = listCoverSelectorFromLinks(listLinks);
  const detailUrl = cluster.find((item) => hrefRe.test(item.href) || MEDIA_FILE.test(item.href))?.href || cluster[0].href;
  if (!detailUrl) {
    diagnostics.push("detail: 未取得媒体详情 URL");
    return null;
  }

  const detailHtml = (await download(detailUrl)).toString("utf8");
  const detailDoc = loadDocument(detailHtml, detailUrl);
  const detailCover = detailCoverSelector(detailDoc);
  const detailAnchors = pageAnchors(detailDoc, detailUrl).filter((item) => {
    if (MEDIA_FILE.test(item.href)) return true;
    try { return new URL(item.href).origin === origin.origin; } catch { return false; }
  });

  let chapterLinks = detailAnchors.filter((item) => (
    likelyMediaEpisode(item, detailUrl)
    && item.text.length <= 80
  ));
  if (chapterLinks.length < 2) {
    chapterLinks = scoreLinkCluster(
      detailAnchors.filter((item) => item.text.length >= 1 && likelyMediaEpisode(item, detailUrl)),
      detailUrl,
    );
  }

  let chapterListSelector = "";
  let stableChapterSelector = "";
  let chapterUrl = "";
  let directMedia = findMediaUrl(detailDoc, detailUrl, detailHtml);
  const playlist = delimitedMediaPlaylist(detailHtml, detailUrl, kind);
  let singleChapter = false;
  let ssrEpisodes = null;
  if (adapterBase) {
    try {
      ssrEpisodes = await discoverSsrEpisodePlan(detailHtml, detailUrl, { download });
    } catch {
      // Static HTML/native chapter discovery remains available below.
    }
  }

  const directChapterLinks = chapterLinks.filter((item) => MEDIA_FILE.test(item.href));
  if (ssrEpisodes?.sampleRows?.length >= 2) {
    chapterUrl = ssrEpisodes.sampleRows[0].url;
    chapterListSelector = "$.data";
    try {
      const chapterHtml = (await download(chapterUrl)).toString("utf8");
      directMedia = findMediaUrl(loadDocument(chapterHtml, chapterUrl), chapterUrl, chapterHtml) || directMedia;
    } catch {
      // Runtime verification will reject the candidate if playback is stale.
    }
  } else if (playlist.length >= 2 && adapterBase) {
    chapterUrl = playlist[0];
    directMedia = playlist[0];
    chapterListSelector = "$.data";
  } else if (directChapterLinks.length >= 2) {
    chapterLinks = directChapterLinks;
    const chapterElements = chapterLinks.map((item) => item.el);
    stableChapterSelector = chapterAnchorSelectorFromLinks(chapterElements, detailDoc, detailUrl);
    chapterListSelector = stableChapterSelector || listSelectorFromLinks(chapterElements, detailDoc);
    chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;
    directMedia = chapterUrl;
  } else if (directMedia && adapterBase) {
    singleChapter = true;
    chapterUrl = detailUrl;
    chapterListSelector = "$.data";
  } else if (chapterLinks.length >= 2) {
    const chapterElements = chapterLinks.map((item) => item.el);
    stableChapterSelector = chapterAnchorSelectorFromLinks(chapterElements, detailDoc, detailUrl);
    chapterListSelector = stableChapterSelector || listSelectorFromLinks(chapterElements, detailDoc);
    chapterUrl = chapterLinks[Math.min(1, chapterLinks.length - 1)].href;
    if (!MEDIA_FILE.test(chapterUrl)) {
      const chapterHtml = (await download(chapterUrl)).toString("utf8");
      directMedia = findMediaUrl(loadDocument(chapterHtml, chapterUrl), chapterUrl, chapterHtml) || directMedia;
    } else {
      directMedia = chapterUrl;
    }
  } else {
    diagnostics.push("toc/content: 未发现分集或可播放媒体");
    return null;
  }

  if (!directMedia && !MEDIA_FILE.test(chapterUrl)) {
    // Still allow export: chapter URL may resolve via client; require at least a chapter list.
    if (!chapterListSelector) return null;
  }

  const title = visibleText(document.querySelector("title")).slice(0, 40) || origin.host;
  const search = discoverSearchRequest(document, homeUrl, { html });
  const adapter = String(adapterBase || "").replace(/\/$/, "");
  const mediaPlan = encodeMediaExtractionPlan({ kind, properties: [], attributes: [], urlHints: [], headers: {} });
  const chapterRequestInfo = singleChapter && adapter
    ? adapterRequest(`${adapter}/adapter/single-chapter?url=`, { preferDetail: true })
    : ssrEpisodes && adapter
      ? pagedDetailAdapterRequest(`${adapter}/adapter/episode-list?plan=${encodeSsrEpisodePlan(ssrEpisodes)}&page=__PAGE__&url=`)
    : playlist.length >= 2 && adapter
      ? adapterRequest(`${adapter}/adapter/media-playlist?kind=${kind}&url=`, { preferDetail: true })
    : "";
  const playlistTitleElement = [...detailDoc.querySelectorAll("*[data-address],*[data-audio],*[data-playlist]")]
    .find((element) => ["data-title", "data-titles", "data-name", "data-names"]
      .some((attribute) => String(element.getAttribute(attribute) || "").split(/[|\r\n]+/).filter(Boolean).length >= 2));
  const playlistTitleAttribute = playlistTitleElement
    ? ["data-title", "data-titles", "data-name", "data-names"]
      .find((attribute) => String(playlistTitleElement.getAttribute(attribute) || "").split(/[|\r\n]+/).filter(Boolean).length >= 2)
    : "";
  const observedChapterSelector = chapterLinks.length >= 2
    ? chapterAnchorSelectorFromLinks(chapterLinks.map((item) => item.el), detailDoc, detailUrl)
    : "";
  const semanticChapterPath = ["chapters", "episodes", "programs", "tracks", "play"]
    .find((segment) => chapterLinks.filter((item) => new RegExp(`/${segment}/`, "i").test(item.href)).length >= 2);
  const detailLastChapterSelector = singleChapter
    ? "string('播放')"
    : playlistTitleAttribute
      ? `//*[@${playlistTitleAttribute}]/@${playlistTitleAttribute}||@js:\nvar rows = String(result || "").split(/[|\\r\\n]+/).map(function (v) { return v.trim(); }).filter(Boolean);\nreturn rows.length ? rows[rows.length - 1] : "";`
    : semanticChapterPath
      ? `(//a[contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/${semanticChapterPath}/') and normalize-space(.) != ''])[last()]`
      : observedChapterSelector ? `(${observedChapterSelector})[last()]` : "";
  const contentRequestInfo = adapter
    ? adapterRequest(`${adapter}/adapter/media?kind=${kind}&plan=${mediaPlan}&url=`, { includeReferer: true })
    : "";
  const pagedListUrl = await discoverPagedListUrl(document, homeUrl, {
    origin: origin.origin,
    listSelector,
    download,
  });
  const contentDirect = [
    "@js:",
    'var q = (typeof params !== "undefined" && params.queryInfo) || {};',
    'var url = String(q.chapterUrl || q.url || q.detailUrl || "").trim();',
    'if (!url && typeof result === "string" && /^(?:https?:)?\\/\\//i.test(result.trim())) url = result.trim();',
    'if (url.indexOf("//") === 0) url = "https:" + url;',
    'else if (url && !/^https?:\\/\\//i.test(url)) url = config.host + (url.charAt(0) === "/" ? url : "/" + url);',
    "return JSON.stringify({",
    "  url: (function () { try { return encodeURI(decodeURI(url)); } catch (e) { return encodeURI(url); } })(),",
    "  httpHeaders: (config && config.httpHeaders) || {},",
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
    "  url: (function () { try { return encodeURI(decodeURI(url)); } catch (e) { return encodeURI(url); } })(),",
    "  httpHeaders: (config && config.httpHeaders) || {},",
    "  forbidCache: true",
    "});",
  ].join("\n");
  const contentFromAdapter = [
    "@js:",
    'var item = result || {};',
    'if (typeof item === "string") { try { item = JSON.parse(item); } catch (e) { item = { url: item }; } }',
    'var url = String(item.url || "").trim();',
    'if (!url) return "";',
    'var headers = {};',
    'var baseHeaders = (config && config.httpHeaders) || {};',
    'var mediaHeaders = item.httpHeaders || item.headers || {};',
    'for (var key in baseHeaders) headers[key] = baseHeaders[key];',
    'for (var name in mediaHeaders) headers[name] = mediaHeaders[name];',
    "return JSON.stringify({",
    "  url: (function () { try { return encodeURI(decodeURI(url)); } catch (e) { return encodeURI(url); } })(),",
    "  httpHeaders: headers,",
    "  forbidCache: true",
    "});",
  ].join("\n");

  return {
    kind,
    host: origin.origin,
    title,
    homeUrl,
    listUrl: homeUrl,
    listRequestInfo: pagedListUrl || homeRequestInfo,
    listSelector,
    bookNameSelector: cards?.bookNameSelector || (stableListSelector ? "normalize-space(.)||normalize-space(/html/body/*)" : ".//a||normalize-space(/html/body/*)"),
    detailUrlSelector: cards?.detailUrlSelector || (stableListSelector ? "./@href||//@href" : ".//a/@href||//@href"),
    listCoverSelector,
    detailCoverSelector: detailCover,
    detailLastChapterSelector,
    searchRequestInfo: search?.requestInfo || "",
    searchEncode: {
      ...(search?.requestParamsEncode ? { requestParamsEncode: search.requestParamsEncode } : {}),
      ...(search?.responseEncode ? { responseEncode: search.responseEncode } : {}),
    },
    detailSampleUrl: detailUrl,
    chapterListSelector,
    chapterRequestInfo,
    chapterResponseFormatType: singleChapter || playlist.length >= 2 || ssrEpisodes ? "json" : "html",
    chapterTitleSelector: singleChapter || playlist.length >= 2 || ssrEpisodes ? "title" : stableChapterSelector ? "normalize-space(.)||normalize-space(/html/body/*)" : "normalize-space(.//a)||normalize-space(/html/body/*)",
    chapterUrlSelector: singleChapter || playlist.length >= 2 || ssrEpisodes ? "url" : stableChapterSelector ? "./@href||//@href" : ".//a/@href||./@href||//@href",
    chapterPageSize: ssrEpisodes?.pageSize || 0,
    chapterMaxPage: ssrEpisodes?.total && ssrEpisodes?.pageSize
      ? Math.ceil(ssrEpisodes.total / ssrEpisodes.pageSize)
      : 0,
    chapterSampleUrl: chapterUrl,
    contentRequestInfo,
    contentResponseFormatType: contentRequestInfo ? "json" : "html",
    contentSelector: contentRequestInfo
      ? contentFromAdapter
      : MEDIA_FILE.test(chapterUrl) || !directMedia ? contentDirect : contentFromPage,
    bookCount: cluster.length,
    chapterCount: Math.max(ssrEpisodes?.total || 0, playlist.length, chapterLinks.length, 1),
    mediaSampleUrl: directMedia || chapterUrl,
  };
}
