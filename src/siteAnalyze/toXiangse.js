function commonAction(actionID, host, responseFormatType = "html") {
  return {
    actionID,
    validConfig: "",
    host,
    responseFormatType,
    parserID: "DOM",
  };
}

const KIND_LABEL = {
  text: "小说",
  comic: "漫画",
  audio: "听书",
  video: "影视",
};

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind;
}

/**
 * Xiangse content selectors often return element innerHTML. Strip tags for
 * novel text while keeping paragraph breaks from <br>/<p>/<div>.
 */
export function withNovelHtmlStripped(contentRule) {
  const selector = String(contentRule || "").trim();
  if (!selector) return selector;
  if (/\|\|\s*@js:/i.test(selector)) return selector;
  return [
    selector,
    "||@js:",
    "var text = Array.isArray(result) ? result.join(\"\\n\") : String(result || \"\");",
    "text = text",
    "  .replace(/<(?:script|style)[\\s\\S]*?<\\/(?:script|style)>/gi, \"\")",
    "  .replace(/<(?:br|hr)\\s*\\/?>/gi, \"\\n\")",
    "  .replace(/<\\/(?:p|div|h[1-6]|li|tr|blockquote)>/gi, \"\\n\")",
    "  .replace(/<[^>]+>/g, \"\")",
    "  .replace(/&nbsp;/gi, \" \")",
    "  .replace(/&lt;/gi, \"<\")",
    "  .replace(/&gt;/gi, \">\")",
    "  .replace(/&quot;/gi, \"\\\"\")",
    "  .replace(/&#39;/gi, \"'\")",
    "  .replace(/&amp;/gi, \"&\")",
    "  .replace(/&#(\\d+);/g, function (_m, code) { return String.fromCharCode(Number(code)); })",
    "  .replace(/[ \\t]+\\n/g, \"\\n\")",
    "  .replace(/\\n{3,}/g, \"\\n\\n\")",
    "  .trim();",
    "return text;",
  ].join("\n");
}

function baseSource(discovery, { sourceName = "", miniAppVersion = "2.56.1", sourceType = "text" } = {}) {
  if (!discovery?.host || !discovery.listSelector || !discovery.chapterListSelector) return null;
  const host = discovery.host;
  const name = String(sourceName || discovery.title || host).trim() || host;
  const listCover = String(discovery.listCoverSelector || "").trim();
  const detailCover = String(discovery.detailCoverSelector || "").trim();
  const searchRequest = String(discovery.searchRequestInfo || "").trim();
  const encode = discovery.searchEncode && typeof discovery.searchEncode === "object"
    ? discovery.searchEncode
    : {};
  const listFields = {
    list: discovery.listSelector,
    bookName: discovery.bookNameSelector || ".//a||normalize-space(/html/body/*)",
    detailUrl: discovery.detailUrlSelector || ".//a/@href||//@href",
    ...(listCover ? { cover: listCover } : {}),
  };
  return {
    sourceName: name,
    sourceUrl: host,
    weight: 0,
    enable: 1,
    miniAppVersion,
    authorId: "",
    sourceType,
    bookWorld: {
      站点首页: {
        ...commonAction("bookWorld", host, "html"),
        requestInfo: discovery.listUrl || host,
        ...listFields,
        ...encode,
        moreKeys: { pageSize: 20 },
        _sIndex: 0,
      },
    },
    searchBook: {
      ...commonAction("searchBook", host, "html"),
      // Never reuse the homepage URL as "search" — without %@keyWord / params.keyWord
      // the client cannot inject the query and search appears broken.
      requestInfo: searchRequest || `${host}/search?q=%@keyWord`,
      ...listFields,
      ...encode,
      moreKeys: { pageSize: 20 },
    },
    bookDetail: {
      ...commonAction("bookDetail", host, "html"),
      requestInfo: "%@result",
      bookName: "//h1|//h2",
      ...(detailCover ? { cover: detailCover } : listCover ? { cover: listCover } : {}),
      ...encode,
    },
    chapterList: {
      ...commonAction("chapterList", host, "html"),
      requestInfo: "%@result",
      list: discovery.chapterListSelector,
      title: discovery.chapterTitleSelector || "normalize-space(.//a)||normalize-space(/html/body/*)",
      url: discovery.chapterUrlSelector || ".//a/@href||./@href||//@href",
      ...encode,
    },
  };
}

/**
 * Build a minimal Xiangse source from novel discovery output.
 */
export function novelDiscoveryToXiangse(discovery, options = {}) {
  const base = baseSource(discovery, { ...options, sourceType: "text" });
  if (!base || !discovery.contentSelector) return null;
  return {
    ...base,
    chapterContent: {
      ...commonAction("chapterContent", discovery.host, "html"),
      requestInfo: "%@result",
      content: withNovelHtmlStripped(discovery.contentSelector),
    },
  };
}

export function comicDiscoveryToXiangse(discovery, options = {}) {
  const base = baseSource(discovery, { ...options, sourceType: "comic" });
  if (!base || !discovery.contentSelector) return null;
  return {
    ...base,
    chapterContent: {
      ...commonAction("chapterContent", discovery.host, "html"),
      requestInfo: "%@result",
      responseFormatType: "html",
      content: discovery.contentSelector,
    },
  };
}

export function mediaDiscoveryToXiangse(discovery, options = {}) {
  const kind = discovery?.kind === "video" ? "video" : "audio";
  const base = baseSource(discovery, { ...options, sourceType: kind });
  if (!base || !discovery.contentSelector) return null;
  return {
    ...base,
    chapterContent: {
      ...commonAction("chapterContent", discovery.host, "html"),
      requestInfo: "%@result",
      content: discovery.contentSelector,
    },
  };
}

export function discoveryToXiangse(discovery, options = {}) {
  if (!discovery?.kind) return null;
  if (discovery.kind === "text") return novelDiscoveryToXiangse(discovery, options);
  if (discovery.kind === "comic") return comicDiscoveryToXiangse(discovery, options);
  if (discovery.kind === "audio" || discovery.kind === "video") {
    return mediaDiscoveryToXiangse(discovery, options);
  }
  return null;
}
