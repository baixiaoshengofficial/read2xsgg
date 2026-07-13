/**
 * 对已知「规则与站点实际 DOM 不符」的阅读源，在转换前修正为可读的阅读规则，
 * 再走通用解析。这样 /xbs/?url=... 才能生成可用香色源。
 */

function hostnameOf(source) {
  const host = String(source?.bookSourceUrl ?? source?.url ?? "");
  try {
    return new URL(host.split("#")[0]).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function adaptLegadoSource(source) {
  if (!source || typeof source !== "object") return source;
  const hostname = hostnameOf(source);
  if (hostname === "alicesw.com") return adaptAlicesw(source);
  return source;
}

/**
 * 香色没有可靠的 tocUrl 透传时，用站点可推导的目录页地址写 chapterList.requestInfo。
 * 返回 null 表示走通用 tocUrl / %@result 逻辑。
 */
export function chapterListRequestInfoOverride(source) {
  const hostname = hostnameOf(source);
  if (hostname === "alicesw.com") {
    // 详情页 /novel/{id}.html → 目录页 /other/chapters/id/{id}.html
    // 优先 detailUrl：queryInfo.url 在章节阶段常是首章 URL，不是详情页。
    // requestInfo 返回对象，兼容香色主流引擎。
    return [
      "@js:",
      'const host = "https://www.alicesw.com";',
      "const q = params.queryInfo || {};",
      "let u = \"\";",
      "if (typeof result === \"string\") u = result;",
      "else if (result && typeof result === \"object\") u = result.detailUrl || result.url || \"\";",
      "u = String(q.detailUrl || q.tocUrl || u || q.url || \"\");",
      "if (u && !/^https?:/i.test(u)) u = host + (u.startsWith(\"/\") ? u : \"/\" + u);",
      "const novel = u.match(/\\/novel\\/(\\d+)/i);",
      "if (novel) u = host + \"/other/chapters/id/\" + novel[1] + \".html\";",
      "return {\"url\": u, \"httpHeaders\": (config && config.httpHeaders) ? config.httpHeaders : {}};",
    ].join("\n");
  }
  return null;
}

function adaptAlicesw(source) {
  const ua = source.httpUserAgent
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

  return {
    ...source,
    header: JSON.stringify({ "User-Agent": ua }),
    ruleSearch: {
      bookList: "class.list-group-item",
      name: "tag.h5@tag.a@text",
      bookUrl: "tag.h5@tag.a@href",
      author: "class.text-muted.0@tag.a@text",
      intro: "class.content-txt@text",
      coverUrl: "tag.img@src||https://www.alicesw.com/favicon.ico",
    },
    ruleExplore: {
      bookList: "class.rec_rullist@tag.ul",
      name: "class.two@tag.a@text",
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
      // 必须定位到 a，否则 //*[contains] 会先命中 html/body，香色取首节点 @href 得到空
      tocUrl: "@XPath://a[contains(normalize-space(.),'查看所有章节')]/@href",
    },
    ruleToc: {
      // list 取 li，title/url 再取 a —— 避免 list=a 时 /text()、//@href 在真实 XPath 下取空/取到 CSS
      chapterList: "class.mulu_list@tag.li",
      chapterName: "tag.a@text",
      chapterUrl: "tag.a@href",
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
