/**
 * 对已知「规则与站点实际 DOM 不符」的阅读源，在转换前修正为可读的阅读规则。
 * 对齐 docs/xiangse/香色闺阁书源规则.md。
 *
 * alicesw：章节在独立目录页 `/other/chapters/id/{id}.html`，不在 `/novel/{id}.html`。
 * 策略（尽量不依赖 chapterList @js，贴近精华书阁「子页用 %@result」）：
 * 1) 搜索 detailUrl 字段用 |@js: 把 /novel/{id} 改写成目录页（§五/§十）
 * 2) chapterList.requestInfo = %@result（与常见 demo 一致，无脚本）
 * 3) 仍保留一个极简 @js 兜底：若 result 仍是 /novel/ 则改写（旧书架缓存）
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
 * alicesw 已在搜索 detailUrl 用 |@js: 改写成目录页。
 * 之后 bookDetail / chapterList 都走 %@result，与精华书阁 demo 一致，避免 chapterList @js 兼容问题。
 */
export function chapterListRequestInfoOverride(source) {
  if (hostnameOf(source) !== "alicesw.com") return null;
  return null;
}

function novelToCatalogJs() {
  // §十 |@js: 字段后处理，result 为 xpath 取出的 href
  return [
    "@js:",
    'var host = "https://www.alicesw.com";',
    'var u = String(result || "");',
    'if (u && u.indexOf("http") != 0) u = host + (u.charAt(0) == "/" ? u : "/" + u);',
    "var m = u.match(/\\/novel\\/(\\d+)/i);",
    'if (m) return host + "/other/chapters/id/" + m[1] + ".html";',
    "return u;",
  ].join("\n");
}

function adaptAlicesw(source) {
  const ua = source.httpUserAgent
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const toCatalog = `\n${novelToCatalogJs()}`;

  return {
    ...source,
    header: JSON.stringify({ "User-Agent": ua }),
    ruleSearch: {
      bookList: "class.list-group-item",
      name: "tag.h5@tag.a@text",
      // 目录页同时能提供书名(h1)+章节列表，当作进入书籍的落地页
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
      // 目录页用 h1；若仍落到 /novel/ 则用 novel_title
      name: "tag.h1@text||class.novel_title@text",
      author: "class.novel_info@tag.p.0@tag.a@text",
      kind: "class.novel_info@tag.p.1@tag.a@text",
      status: "class.novel_info@tag.p.4@text",
      wordCount: "class.novel_info@tag.p.3@text",
      lastChapter: "class.novel_info@tag.p.5@tag.a@text",
      intro: "@XPath://h6[contains(.,'内容简介')]/following-sibling::*[1]//text()",
      coverUrl: "class.pic@tag.img@src",
    },
    ruleToc: {
      // 精华书阁示例：list=li，title/url=a（§七）
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
