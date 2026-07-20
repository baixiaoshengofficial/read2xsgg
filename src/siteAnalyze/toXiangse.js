function commonAction(actionID, host, responseFormatType = "html") {
  return {
    actionID,
    validConfig: "",
    host,
    responseFormatType,
    parserID: "DOM",
  };
}

/**
 * Build a minimal Xiangse source from novel discovery output.
 */
export function novelDiscoveryToXiangse(discovery, {
  sourceName = "",
  minVersion = "2.56.1",
} = {}) {
  if (!discovery?.host || !discovery.listSelector || !discovery.chapterListSelector || !discovery.contentSelector) {
    return null;
  }
  const host = discovery.host;
  const name = String(sourceName || discovery.title || host).trim() || host;
  return {
    sourceName: name,
    sourceType: "text",
    authorId: "",
    host,
    minVersion,
    bookWorld: {
      站点首页: {
        ...commonAction("bookWorld", host, "html"),
        requestInfo: discovery.listUrl || host,
        list: discovery.listSelector,
        bookName: discovery.bookNameSelector || ".",
        detailUrl: discovery.detailUrlSelector || "./@href",
        moreKeys: { pageSize: 20 },
        _sIndex: 0,
      },
    },
    searchBook: {
      ...commonAction("searchBook", host, "html"),
      requestInfo: discovery.listUrl || host,
      list: discovery.listSelector,
      bookName: discovery.bookNameSelector || ".",
      detailUrl: discovery.detailUrlSelector || "./@href",
      moreKeys: { pageSize: 20 },
    },
    bookDetail: {
      ...commonAction("bookDetail", host, "html"),
      requestInfo: "%@result",
      bookName: "//h1|//h2",
    },
    chapterList: {
      ...commonAction("chapterList", host, "html"),
      requestInfo: "%@result",
      list: `(${discovery.chapterListSelector})[self::a[@href] or .//a[@href]]`,
      title: discovery.chapterTitleSelector || ".",
      url: discovery.chapterUrlSelector || "./@href",
    },
    chapterContent: {
      ...commonAction("chapterContent", host, "html"),
      requestInfo: "%@result",
      content: discovery.contentSelector,
    },
  };
}
