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
  if (isMwwzSource(source)) return adaptMwwz(source);
  return source;
}

/** 《香色闺阁书源规则》§七：result = 书籍详情页 URL */
export function chapterListRequestInfoOverride(source) {
  if (hostnameOf(source) === "alicesw.com") return aliceswChapterListRequestInfo();
  if (isMwwzSource(source)) return mwwzChapterListRequestInfo();
  return null;
}

function aliceswChapterListRequestInfo() {
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

function mwwzChapterListRequestInfo() {
  // 搜索/分类项的详情是 /api/comic/{id} JSON，但目录在 /comic/{id} HTML。
  // 香色章节动作拿到的是详情 URL，不能直接重放 API 地址。
  return [
    "@js:",
    'var u = (typeof result == "string") ? result : "";',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'if (!u && params && params.queryInfo) u = params.queryInfo.detailUrl || params.queryInfo.url || "";',
    'u = String(u || "");',
    'var m = u.match(/\\/api\\/comic\\/(\\d+)/i) || u.match(/\\/comic\\/(\\d+)/i);',
    'return m ? config.host + "/comic/" + m[1] : u;',
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

function isMwwzSource(source) {
  const hostname = hostnameOf(source);
  const runtimeRules = `${source?.loginUrl || ""}\n${source?.ruleContent?.imageDecode || ""}\n${source?.ruleContent?.content || ""}`;
  return /(?:mwwz|manwake|manwapi|manwalu|mwmw|mwuu)\.cc$/i.test(hostname)
    || /(?:GLOBAL_IMAGE_ROUTES|api\/comic\/image|0B6666A0-BB59-1381-B746-a0E4C9AC)/i.test(runtimeRules);
}

function apiComicUrlRule(idRule) {
  return `${idRule} || @js:\nreturn config.host + "/api/comic/" + String(result || "").replace(/[^\\d]/g, "");`;
}

/**
 * 漫蛙阅读源将 Url()/source.getVariable() 混在链接规则中。在线服务已解决镜像，
 * 这里把剩余链路改成香色的 config.host，并保留默认图片线路的 AES 代理处理。
 */
function adaptMwwz(source) {
  const ruleSearch = source.ruleSearch ?? source.searchRule ?? {};
  const ruleExplore = source.ruleExplore ?? source.exploreRule ?? {};
  const ruleBookInfo = source.ruleBookInfo ?? source.bookInfoRule ?? {};
  const ruleToc = source.ruleToc ?? source.tocRule ?? {};
  return {
    ...source,
    searchUrl: String(source.searchUrl || "").replace(/\{\{\s*Url\(\)\s*\}\}/gi, "{{Get('url')}}"),
    ruleSearch: {
      ...ruleSearch,
      bookUrl: apiComicUrlRule("$.id"),
    },
    ruleExplore: {
      ...ruleExplore,
      bookUrl: apiComicUrlRule("$.url"),
    },
    ruleBookInfo: {
      ...ruleBookInfo,
      intro: "$.intro",
      // chapterListRequestInfoOverride() derives the matching HTML directory URL.
      tocUrl: "baseUrl",
    },
    ruleToc: {
      ...ruleToc,
      // 原规则 href##(\d+)$##/api/... 只替换末尾 ID，会保留前面的
      // /comic/{bookId}/，最终得到一个必然 404 的拼接地址。
      chapterUrl: [
        "href || @js:",
        "var m = String(result || \"\").match(/(\\d+)$/);",
        'return m ? config.host + "/api/comic/image/" + m[1] + "?page=1" : result;',
      ].join("\n"),
    },
  };
}
