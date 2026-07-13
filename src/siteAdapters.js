/**
 * 对已知「规则与站点实际 DOM 不符」的阅读源，在转换前修正为可读的阅读规则，
 * 再走通用解析。适配逻辑必须符合 docs/xiangse/香色闺阁书源规则.md。
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
 * 按《香色闺阁书源规则》§七：
 * chapterList.requestInfo 的 result = 书籍详情页 URL；可在此改写成真正的目录页。
 * 按 §九：@js 返回带 url 的请求对象（也可返回 URL 字符串）。
 */
export function chapterListRequestInfoOverride(source) {
  const hostname = hostnameOf(source);
  if (hostname === "alicesw.com") {
    // 详情 https://www.alicesw.com/novel/{id}.html
    // 目录 https://www.alicesw.com/other/chapters/id/{id}.html
    return [
      "@js:",
      'var host = (config && config.host) ? String(config.host).replace(/\\/$/, "") : "https://www.alicesw.com";',
      // §七：result 为书籍详情页 URL
      'var u = (typeof result === "string") ? result : "";',
      'if (!u && result && typeof result === "object") u = result.detailUrl || result.url || "";',
      // 兼容部分客户端把详情放在 queryInfo.detailUrl
      "if (!u && params && params.queryInfo) u = params.queryInfo.detailUrl || params.queryInfo.url || \"\";",
      "u = String(u || \"\");",
      'if (u && !/^https?:/i.test(u)) u = host + (u.charAt(0) === "/" ? u : "/" + u);',
      "var novel = u.match(/\\/novel\\/(\\d+)/i);",
      'if (novel) u = host + "/other/chapters/id/" + novel[1] + ".html";',
      'return {"url": u, "httpHeaders": (config && config.httpHeaders) ? config.httpHeaders : {}};',
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
      // §五 detailUrl = 书籍详情页，保持 /novel/{id}.html，不改写成目录
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
      // §六：详情页元信息（alicesw 详情在 /novel/）
      name: "class.novel_title@text",
      author: "class.novel_info@tag.p.0@tag.a@text",
      kind: "class.novel_info@tag.p.1@tag.a@text",
      status: "class.novel_info@tag.p.4@text",
      wordCount: "class.novel_info@tag.p.3@text",
      lastChapter: "class.novel_info@tag.p.5@tag.a@text",
      intro: "@XPath://h6[contains(.,'内容简介')]/following-sibling::*[1]/text()",
      coverUrl: "class.pic@tag.img@src",
    },
    ruleToc: {
      // 精华书阁示例同构：list=行容器，title/url 再取 a（书源规则 §七示例）
      chapterList: "@XPath://ul[contains(concat(' ', normalize-space(@class), ' '), ' mulu_list ')]/li",
      chapterName: "tag.a@text",
      chapterUrl: "tag.a@href",
    },
    ruleContent: {
      // §八 / §十：正文后处理用 |@js:（与精华书阁 demo 一致）
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
