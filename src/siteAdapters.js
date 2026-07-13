/**
 * 对已知「规则与站点实际 DOM 不符」的阅读源，在转换前修正为可读的阅读规则，
 * 再走通用解析。这样 /xbs/?url=... 才能生成可用香色源。
 */
export function adaptLegadoSource(source) {
  if (!source || typeof source !== "object") return source;
  const host = String(source.bookSourceUrl ?? source.url ?? "");
  let hostname = "";
  try {
    hostname = new URL(host.split("#")[0]).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return source;
  }

  if (hostname === "alicesw.com") return adaptAlicesw(source);
  return source;
}

function adaptAlicesw(source) {
  const ua = source.httpUserAgent
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

  return {
    ...source,
    header: JSON.stringify({ "User-Agent": ua }),
    ruleSearch: {
      bookList: "class.list-group-item",
      name: "tag.h5@tag.a",
      bookUrl: "tag.h5@tag.a@href",
      author: "class.text-muted.0@tag.a@text",
      intro: "class.content-txt@text",
      coverUrl: "tag.img@src||https://www.alicesw.com/favicon.ico",
    },
    ruleExplore: {
      bookList: "class.rec_rullist@tag.ul",
      name: "class.two@tag.a",
      bookUrl: "class.two@tag.a@href",
      author: "class.four@text",
      lastChapter: "class.three@tag.a@text",
    },
    ruleBookInfo: {
      name: "class.novel_title@text",
      author: "class.novel_info@tag.p.0@tag.a@text",
      kind: "class.novel_info@tag.p.1@tag.a@text",
      status: "class.novel_info@tag.p.4@text",
      wordCount: "class.novel_info@tag.p.3@text",
      lastChapter: "class.novel_info@tag.p.5@tag.a@text",
      intro: "@XPath://h6[contains(.,'内容简介')]/following-sibling::*[1]/text()",
      coverUrl: "class.pic@tag.img@src",
      tocUrl: "text.查看所有章节@href",
    },
    ruleToc: {
      chapterList: "class.mulu_list@tag.li@tag.a",
      chapterName: "text",
      chapterUrl: "href",
    },
    ruleContent: {
      // 取段落文本；香色对纯元素节点经常取不到正文
      content: "class.read-content@tag.p@text",
      replaceRegex: [
        "^\\s+",
        "\\s*阅读更多请访问.*",
        "\\s*本书由网友上传.*",
        "\\s*所有小说中出现的人物均为18岁以上的成人.*",
      ],
    },
  };
}
