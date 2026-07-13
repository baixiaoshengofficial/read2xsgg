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
 *
 * 注意：香色内置 JS 偏 ES5，避免 const/let/箭头函数；返回纯 URL 字符串兼容更广。
 */
export function chapterListRequestInfoOverride(source) {
  const hostname = hostnameOf(source);
  if (hostname === "alicesw.com") {
    return [
      "@js:",
      'var host = "https://www.alicesw.com";',
      "var q = params.queryInfo || {};",
      'var u = "";',
      'if (typeof result === "string") u = result;',
      'else if (result && typeof result === "object") u = result.detailUrl || result.url || "";',
      'u = String(q.detailUrl || q.tocUrl || u || q.url || "");',
      'if (u && !/^https?:/i.test(u)) u = host + (u.charAt(0) === "/" ? u : "/" + u);',
      // 已是目录页则直接用；详情 /novel/{id} 则改写到目录
      "if (/\\/other\\/chapters\\/id\\/\\d+/i.test(u)) return u;",
      "var novel = u.match(/\\/novel\\/(\\d+)/i);",
      'if (novel) return host + "/other/chapters/id/" + novel[1] + ".html";',
      "return u;",
    ].join("\n");
  }
  return null;
}

/** 把 /novel/{id}.html 改写成目录页，让后续详情/目录请求落在有 mulu_list 的页面上 */
function aliceswNovelToCatalogJs() {
  return [
    "@js:",
    'var host = "https://www.alicesw.com";',
    'var u = String(result || "");',
    'if (u && !/^https?:/i.test(u)) u = host + (u.charAt(0) === "/" ? u : "/" + u);',
    "var novel = u.match(/\\/novel\\/(\\d+)/i);",
    'if (novel) return host + "/other/chapters/id/" + novel[1] + ".html";',
    "return u;",
  ].join("\n");
}

function adaptAlicesw(source) {
  const ua = source.httpUserAgent
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const toCatalog = `\n${aliceswNovelToCatalogJs()}`;

  return {
    ...source,
    header: JSON.stringify({ "User-Agent": ua }),
    ruleSearch: {
      bookList: "class.list-group-item",
      name: "tag.h5@tag.a@text",
      // 关键：搜索结果的书籍链接直接改成目录页，避免香色打开详情后章节列表请求落在无 mulu_list 的 /novel/ 页
      bookUrl: `tag.h5@tag.a@href${toCatalog}`,
      author: "class.text-muted.0@tag.a@text",
      intro: "class.content-txt@text",
      coverUrl: "tag.img@src||https://www.alicesw.com/favicon.ico",
    },
    ruleExplore: {
      bookList: "class.rec_rullist@tag.ul",
      name: "class.two@tag.a@text",
      bookUrl: `class.two@tag.a@href${toCatalog}`,
      author: "class.four@text",
      lastChapter: "class.three@tag.a@text",
    },
    ruleBookInfo: {
      // 目录页有 h1 书名；若仍落到 /novel/ 则 novel_title 也可用
      name: "tag.h1@text||class.novel_title@text",
      author: "class.novel_info@tag.p.0@tag.a@text",
      kind: "class.novel_info@tag.p.1@tag.a@text",
      status: "class.novel_info@tag.p.4@text",
      wordCount: "class.novel_info@tag.p.3@text",
      lastChapter: "class.novel_info@tag.p.5@tag.a@text",
      intro: "@XPath://h6[contains(.,'内容简介')]/following-sibling::*[1]/text()",
      coverUrl: "class.pic@tag.img@src",
      tocUrl: "@XPath://a[contains(normalize-space(.),'查看所有章节')]/@href",
    },
    ruleToc: {
      chapterList: "@XPath://ul[contains(concat(' ', normalize-space(@class), ' '), ' mulu_list ')]/li",
      chapterName: "tag.a@text",
      chapterUrl: "tag.a@href",
    },
    ruleContent: {
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
