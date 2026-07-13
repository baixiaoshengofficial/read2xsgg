/**
 * alicesw 适配 —— 必须以 iOS/香色客户端 UA 见到的 DOM 为准。
 *
 * 实测：
 * - iPhone UA 目录页：ul.section-list（无 mulu_list）
 * - Desktop UA 目录页：ul.mulu_list
 * - 详情在 /novel/{id}.html（有封面 og:image / 最新章）；目录在 /other/chapters/id/{id}.html
 *
 * 因此：
 * 1) 搜索 detailUrl 保持 /novel/（不要改成目录，否则封面/最新章丢失）
 * 2) chapterList.requestInfo 按书源规则§七用 result（详情 URL）改写成目录页
 * 3) list 同时兼容 section-list 与 mulu_list
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
  if (hostnameOf(source) === "alicesw.com") return adaptAlicesw(source);
  return source;
}

/** 《香色闺阁书源规则》§七：result = 书籍详情页 URL */
export function chapterListRequestInfoOverride(source) {
  if (hostnameOf(source) !== "alicesw.com") return null;
  return [
    "@js:",
    'var host = "https://www.alicesw.com";',
    'var u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (!u && params && params.queryInfo) u = params.queryInfo.detailUrl || params.queryInfo.url || "";',
    "u = String(u || \"\");",
    'if (u && u.indexOf("http") != 0) u = host + (u.charAt(0) == "/" ? u : "/" + u);',
    "var m = u.match(/\\/novel\\/(\\d+)/i);",
    'if (m) return host + "/other/chapters/id/" + m[1] + ".html";',
    "return u;",
  ].join("\n");
}

function absolutizeUrlJs() {
  return [
    "@js:",
    'var host = "https://www.alicesw.com";',
    'var u = String(result || "");',
    "if (!u) return u;",
    'if (u.indexOf("http") == 0) return u;',
    'if (u.indexOf("//") == 0) return "https:" + u;',
    'return host + (u.charAt(0) == "/" ? u : "/" + u);',
  ].join("\n");
}

function adaptAlicesw(source) {
  // 与香色 iOS 接近的 UA；站点对 UA 会切换模板，规则已对 desktop/mobile 双写
  const ua = source.httpUserAgent
    || "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

  return {
    ...source,
    header: JSON.stringify({ "User-Agent": ua }),
    ruleSearch: {
      bookList: "class.list-group-item",
      // h5/a 内有 <em>，取元素文本不要只用 /text() 第一段
      name: "@XPath://h5/a",
      bookUrl: "tag.h5@tag.a@href",
      author: "class.text-muted.0@tag.a@text",
      intro: "class.content-txt@text",
      coverUrl: "tag.img@src||https://www.alicesw.com/favicon.ico",
    },
    ruleExplore: {
      bookList: "class.rec_rullist@tag.ul||class.section-list@tag.li",
      name: "class.two@tag.a@text||tag.a@text",
      bookUrl: "class.two@tag.a@href||tag.a@href",
      author: "class.four@text",
      lastChapter: "class.three@tag.a@text",
    },
    ruleBookInfo: {
      name: "tag.h1@text||class.novel_title@text||class.xs-title@text",
      author: "class.info@tag.a.0@text||class.novel_info@tag.p.0@tag.a@text",
      kind: "class.novel_info@tag.p.1@tag.a@text",
      status: "class.novel_info@tag.p.4@text",
      wordCount: "class.novel_info@tag.p.3@text",
      // 手机端「最新」后第一个 /book/ 链；桌面端 novel_info p5
      lastChapter: "@XPath://a[contains(@href,'/book/')][1]/text()||class.novel_info@tag.p.5@tag.a@text",
      intro: "@XPath://meta[@property='og:description']/@content||//h6[contains(.,'内容简介')]/following-sibling::*[1]//text()",
      // 手机端常用 og:image（相对路径）；桌面端 pic img
      coverUrl: `@XPath://meta[@property='og:image']/@content||//*[contains(@class,'pic')]//img/@src||//img[contains(@src,'cdn')]/@src\n${absolutizeUrlJs()}`,
    },
    ruleToc: {
      // iPhone: section-list；Desktop: mulu_list（§十 || 备选）
      chapterList: "@XPath://ul[contains(@class,'section-list')]/li || //ul[@class='mulu_list']/li",
      chapterName: "tag.a@text",
      chapterUrl: "tag.a@href",
    },
    ruleContent: {
      content: "class.read-content@tag.p@text",
      replaceRegex: [
        "^\\s+",
        "\\s*点击返回上一章.*",
        "\\s*阅读更多请访问.*",
        "\\s*本书由网友上传.*",
        "\\s*所有小说中出现的人物均为18岁以上的成人.*",
      ],
    },
  };
}
