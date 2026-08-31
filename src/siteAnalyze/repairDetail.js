import { decodeTextBuffer } from "../charset.js";
import {
  compileDetailBridgePlan,
  decodeBridgePlan,
  encodeBridgePlan,
  executeBridgePlan,
} from "../bridgePlan.js";
import { detailCoverSelector, usableCoverUrl } from "./coverSelectors.js";
import { isDateOnlyMetadata } from "../elementValidation.js";
import {
  chapterAnchorSelectorFromLinks,
  classContainsXPath,
  loadDocument,
  visibleText,
  xpathForElement as rawXPathForElement,
} from "./domUtil.js";

const AUTHOR_LABEL = /(?:作\s*者|作\s*家|播\s*音|主\s*播|演\s*播|author|writer|creator)\s*[:：]?/i;
const AUTHOR_VALUE_LABEL = /(?:作\s*者|作\s*家|播\s*音|主\s*播|演\s*播|author|writer|creator)\s*[:：]\s*\S/i;
const CATEGORY_LABEL = /(?:分\s*类|類\s*別|类\s*别|类\s*型|題\s*材|题\s*材|標\s*籤|标\s*签|category|genre|type)\s*[:：]?/i;
const CATEGORY_VALUE_LABEL = /(?:分\s*类|類\s*別|类\s*别|类\s*型|題\s*材|题\s*材|標\s*籤|标\s*签|category|genre|type)\s*[:：]\s*\S/i;
const CATEGORY_NOISE = /^(?:连载中|已完结|完结|连载|VIP|免费|付费|独家|签约|作品信息|小说|漫画|听书|视频)$/i;
const CHAPTER_TEXT = /(?:第.{0,24}[章節节回話话集卷]|最新[章節节]|最新更新)/;
const CHAPTER_NAV = /^(?:返回頂部|返回顶部|回到頂部|回到顶部|回頂部|回顶部|置頂|置顶|首頁|首页|目錄|目录|上一[章節节頁页]?|下一[章節节頁页]?|加載更多|加载更多|聯絡我們|联系我们|關於我們|关于我们)\s*[↑⇧▲]?$/i;
const CHAPTER_PLACEHOLDER = /^(?:最新更新|最新章[節节]|更新至|最新)$/i;

function usableText(element, maxLength = 120) {
  const text = visibleText(element);
  return text && text.length <= maxLength ? text : "";
}

function usableRepairedField(name, value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (name === "cover") {
    return /^(?:https?:)?\/\//i.test(text) && usableCoverUrl(text);
  }
  if (name === "author") {
    return /[\p{L}\p{N}]/u.test(text)
      && text.length <= 50
      && !/^(?:未知|不詳|不详|佚名|unknown|anonymous|n\/a|null)$/i.test(text)
      && !/(?:作者福利|发布小说|作品集|请勿转载|未经.*许可|来源|点击|更新时间|字数|登录|注册|\d{4}[-/]\d{1,2})/i.test(text);
  }
  if (name === "cat") {
    return /[\p{L}\p{N}]/u.test(text)
      && text.length <= 40
      && !isDateOnlyMetadata(text)
      && !/(?:收藏到|以下分[類类]|作品信息|返回[首頁页]|^(?:首頁|首页)$|登[錄录]|註冊|注册|取消|確定|确定|排行榜|字[數数]\s*[:：]|人氣\s*[:：]|人气\s*[:：]|點擊\s*[:：]|点击\s*[:：]|第.{0,24}[章節节回話话集卷])/i.test(text);
  }
  if (name === "lastChapterTitle") {
    return !CHAPTER_NAV.test(text) && !CHAPTER_PLACEHOLDER.test(text) && !isDateOnlyMetadata(text);
  }
  return true;
}

function semanticElement(document, pattern, maxLength = 120) {
  let best = null;
  for (const element of document.querySelectorAll("meta,span,a,p,div,li,dd")) {
    const identity = `${element.id || ""} ${element.className || ""} ${element.getAttribute?.("itemprop") || ""}`;
    const text = usableText(element, maxLength);
    if (!pattern.test(identity) || !text) continue;
    const childCount = element.querySelectorAll?.("*")?.length || 0;
    const score = (childCount === 0 ? 80 : 0)
      + (/^(?:SPAN|A|P|LI|DD)$/.test(element.tagName) ? 20 : 0)
      + Math.max(0, 60 - text.length)
      - Math.min(80, childCount * 4);
    if (!best || score > best.score) best = { element, score };
  }
  return best?.element || null;
}

function labeledElement(document, pattern, maxLength = 120) {
  let best = null;
  for (const element of document.querySelectorAll("span,a,p,div,li,dd")) {
    const text = usableText(element, maxLength);
    if (!text || !pattern.test(text)) continue;
    if (!best || text.length < best.text.length) best = { element, text };
  }
  return best?.element || null;
}

function stableElementSelector(element, document) {
  if (!element) return "";
  if (element.tagName === "A" && String(element.getAttribute("rel") || "").split(/\s+/).includes("category")) {
    return "//a[contains(concat(' ', normalize-space(@rel), ' '), ' category ')]";
  }
  const tokens = String(element.className || "").split(/\s+/).filter((token) => (
    /^[A-Za-z_][\w-]{2,}$/.test(token)
    && !/^(?:active|current|clearfix|container|content|item|left|list|menu|right|row|text|title)$/i.test(token)
  ));
  const token = tokens.find((value) => {
    try { return document.querySelectorAll(`[class~="${value}"]`).length <= 24; } catch { return false; }
  });
  return token ? classContainsXPath(token) : rawXPathForElement(element, document);
}

function xpathForElement(element, document) {
  return stableElementSelector(element, document);
}

function structuredDataAuthorRule(html) {
  for (const match of String(html || "").matchAll(/<script\b[^>]*\btype\s*=\s*["'][^"']*ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    const queue = [value];
    while (queue.length) {
      const item = queue.shift();
      if (Array.isArray(item)) {
        queue.push(...item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const author = item.author;
      const name = typeof author === "string"
        ? author
        : Array.isArray(author)
          ? author.find((entry) => typeof entry === "string" || entry?.name)
          : author?.name;
      const authorName = typeof name === "object" ? name?.name : name;
      if (usableRepairedField("author", authorName)) {
        return {
          selector: "//script[contains(translate(@type, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'ld+json')]",
          matchTemplate: {
            pattern: typeof author === "string"
              ? '"author"\\s*:\\s*"([^"\\\\]{1,80})"'
              : '"author"\\s*:[\\s\\S]{0,500}?"name"\\s*:\\s*"([^"\\\\]{1,80})"',
            prefix: "",
            suffix: "",
            hostPrefix: false,
          },
        };
      }
      queue.push(...Object.values(item).filter((entry) => entry && typeof entry === "object"));
    }
  }
  return "";
}

function authorSelector(document) {
  const meta = document.querySelector('meta[name="author" i],meta[property="book:author" i],meta[property="og:novel:author" i]');
  if (String(meta?.getAttribute("content") || "").trim()) {
    return "//meta[@name='author']/@content||//meta[@property='book:author']/@content||//meta[@property='og:novel:author']/@content";
  }
  let element = labeledElement(document, AUTHOR_VALUE_LABEL);
  if (element) {
    const selector = stableElementSelector(element, document);
    const delimiter = visibleText(element).includes("：") ? "：" : ":";
    return `normalize-space(substring-after(string(${selector}), '${delimiter}'))`;
  }
  element = null;
  let slashLength = Infinity;
  for (const candidate of document.querySelectorAll("span,p,div,li")) {
    const text = usableText(candidate, 100);
    if (text.length < slashLength
      && /^.{1,40}\s*[\/|]\s*(?:\d+(?:\.\d+)?\s*[万千]?(?:字|words?)|\d{2}[-/])/i.test(text)) {
      element = candidate;
      slashLength = text.length;
    }
  }
  if (element) {
    const xpath = xpathForElement(element, document);
    return `normalize-space(substring-before(concat(string(${xpath}), '/'), '/'))`;
  }
  element ||= semanticElement(document, /(?:author|writer|creator|anchor|speaker|narrator)/i);
  if (!element) return "";
  return `${xpathForElement(element, document)}||@js:\nreturn String(result || "").replace(/^[\\s\\S]*?(?:作者|作家|播音|主播|演播|author|writer|creator)\\s*[:：]\\s*/i, "").split(/[\\/|]/)[0].trim();`;
}

function normalizedCategoryRule(selector) {
  return {
    selector,
    replacements: [
      {
        pattern: "^[\\s\\S]*?(?:分\\s*类|類\\s*別|类\\s*别|类\\s*型|題\\s*材|题\\s*材|標\\s*籤|标\\s*签|category|genre|type)\\s*[:：]\\s*",
        replacement: "",
      },
      {
        pattern: "\\s+(?:字数|字數|人气|人氣|点击|點擊|状态|狀態|更新时间|更新時間|更新|作者|作家)\\s*[:：][\\s\\S]*$",
        replacement: "",
      },
    ],
  };
}

function categorySelector(document) {
  const meta = document.querySelector('meta[property="book:tag" i],meta[name="category" i],meta[property="article:section" i],meta[property="og:novel:category" i]');
  if (String(meta?.getAttribute("content") || "").trim()) {
    return "//meta[@property='book:tag']/@content||//meta[@name='category']/@content||//meta[@property='article:section']/@content||//meta[@property='og:novel:category']/@content";
  }
  const mediaWikiCategory = document.querySelector("#mw-normal-catlinks li a[href], #catlinks .mw-normal-catlinks li a[href]");
  if (usableText(mediaWikiCategory, 40)) {
    return "//*[@id='mw-normal-catlinks']//li[1]/a[1]||//*[@id='catlinks']//*[contains(concat(' ', normalize-space(@class), ' '), ' mw-normal-catlinks ')]//li[1]/a[1]";
  }
  let element = labeledElement(document, CATEGORY_VALUE_LABEL, 120);
  if (element) {
    const selector = rawXPathForElement(element, document);
    return normalizedCategoryRule(`string(${selector})`);
  }
  const heading = document.querySelector("h1,h2,[class*='title' i]");
  const root = heading?.parentElement?.parentElement || heading?.parentElement;
  if (root) {
    element = semanticElement(root, /(?:category|genre|book[-_]?type|novel[-_]?type|tags?)/i, 80);
  }
  element ||= semanticElement(document, /(?:category|genre|book[-_]?type|novel[-_]?type|tags?)/i, 80);
  if (element && (CATEGORY_NOISE.test(usableText(element, 80)) || /收藏到|以下分类/.test(usableText(element, 80)))) {
    element = null;
  }
  for (const candidate of element ? [] : (root?.querySelectorAll?.("span,label,a") || [])) {
    if (candidate === heading || candidate.contains?.(heading)) continue;
    const text = usableText(candidate, 16);
    if (!text || CATEGORY_NOISE.test(text) || AUTHOR_LABEL.test(text) || /\d|[:：/]/.test(text)) continue;
    element = candidate;
    break;
  }
  element ||= labeledElement(document, CATEGORY_LABEL, 80);
  if (!element) return "";
  return normalizedCategoryRule(xpathForElement(element, document));
}

function dominantChapterContainer(candidates, document) {
  if (candidates.length < 2) return null;
  const counts = new Map();
  for (const anchor of candidates) {
    let element = anchor.parentElement;
    while (element && element !== document.body) {
      if (/^(?:DIV|UL|OL|SECTION|MAIN|NAV|ARTICLE)$/.test(element.tagName)) {
        counts.set(element, (counts.get(element) || 0) + 1);
      }
      element = element.parentElement;
    }
  }
  const maximum = Math.max(0, ...counts.values());
  let best = null;
  for (const [element, count] of counts) {
    if (count < 2 || count < Math.ceil(maximum * 0.5)) continue;
    const anchorCount = element.querySelectorAll("a[href]").length || 1;
    const density = count / anchorCount;
    const identity = `${element.id || ""} ${element.className || ""}`;
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
    const score = (/(?:chapter|chapters|episode|episodes|catalog|toc|volume|section)/i.test(identity)
      ? 1_500
      : /(?:list|menu)/i.test(identity) ? 300 : 0)
      + density * 300
      + depth * 4
      - (maximum - count) * 0.2;
    if (!best || score > best.score) best = { element, score };
  }
  return best?.element || null;
}

function chapterContainerSelector(element, document) {
  const id = String(element?.id || "");
  if (/^[A-Za-z_][\w:.-]*$/.test(id)) return `//*[@id='${id}']`;
  return stableElementSelector(element, document);
}

function latestChapterSelector(document) {
  const playlist = [...document.querySelectorAll("*[data-address],*[data-audio],*[data-playlist]")]
    .map((element) => ({
      element,
      attribute: ["data-title", "data-titles", "data-name", "data-names"].find((name) => (
        String(element.getAttribute(name) || "").split(/[|\r\n]+/).filter(Boolean).length >= 2
      )),
    }))
    .find((item) => item.attribute);
  if (playlist) {
    return [
      `//*[@${playlist.attribute}]/@${playlist.attribute}||@js:`,
      'var rows = String(result || "").split(/[|\\r\\n]+/).map(function (v) { return v.trim(); }).filter(Boolean);',
      'return rows.length ? rows[rows.length - 1] : "";',
    ].join("\n");
  }
  let element = semanticElement(document, /(?:latest|new[-_]?chapter|last[-_]?chapter|update)/i, 180);
  if (element && (!CHAPTER_TEXT.test(visibleText(element))
    || CHAPTER_NAV.test(visibleText(element))
    || isDateOnlyMetadata(visibleText(element)))) element = null;
  if (!element) {
    const candidates = [...document.querySelectorAll("a[href]")]
      .filter((anchor) => CHAPTER_TEXT.test(visibleText(anchor))
        && !CHAPTER_NAV.test(visibleText(anchor))
        && visibleText(anchor).length <= 180);
    const container = dominantChapterContainer(candidates, document);
    const scopedCandidates = container
      ? candidates.filter((anchor) => container.contains(anchor))
      : candidates;
    const scope = container ? chapterContainerSelector(container, document) : "";
    const semanticPath = ["chapters", "episodes", "programs", "tracks", "play", "video", "media", "watch", "read"]
      .find((segment) => scopedCandidates.filter((anchor) => new RegExp(`/${segment}/`, "i").test(anchor.href)).length >= 2);
    if (semanticPath) {
      return `(${scope}//a[contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/${semanticPath}/') and normalize-space(.) != ''])[last()]`;
    }
    const stable = chapterAnchorSelectorFromLinks(scopedCandidates, document, document.URL);
    const scopedStable = scope && stable.startsWith("//") ? `${scope}${stable}` : stable;
    const chapterNumber = (anchor) => {
      const match = visibleText(anchor).match(/第\s*(\d{1,8})\s*[章節节回話话集卷]/i);
      return match ? Number(match[1]) : null;
    };
    const numbered = scopedCandidates
      .map((anchor, index) => ({ anchor, index, number: chapterNumber(anchor) }))
      .filter((item) => Number.isFinite(item.number));
    const descending = numbered.length >= 2 && numbered[0].number > numbered.at(-1).number;
    if (scopedStable) return `(${scopedStable})[${descending ? "1" : "last()"}]`;
    element = numbered.length
      ? numbered.reduce((best, item) => item.number > best.number ? item : best).anchor
      : scopedCandidates.at(-1) || null;
  }
  return element ? xpathForElement(element, document) : "";
}

function embeddedTocSelector(source) {
  const direct = String(source?.bookDetail?.tocUrl || "").trim();
  if (direct && !/^@js:/i.test(direct)) return direct.split(/\|\|?\s*@js:/i, 1)[0].trim();
  const requestInfo = String(source?.chapterList?.requestInfo || "");
  const encoded = requestInfo.match(/\/adapter\/toc\?selector=([^&"'\s]+)/i)?.[1] || "";
  if (!encoded) return "";
  try { return decodeURIComponent(encoded); } catch { return ""; }
}

function parsedJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function jsonDetailFieldSelector(value, field) {
  if (!value || typeof value !== "object") return "";
  let best = null;
  const exactKeys = {
    cover: /^(?:cover|coverUrl|coverImage|imageUrl|picUrl|poster|thumbnail)$/i,
    author: /^(?:author|authorName|writer|writerName|creator|speaker|anchor|narrator)$/i,
    cat: /^(?:cat|category|categoryName|genre|genres|tag|tags|typeName)$/i,
    lastChapterTitle: /^(?:lastChapterTitle|latestChapterTitle|newChapterTitle|currentChapterTitle|chapterTitle|chapterName|latestChapter|newChapter|currentChapter)$/i,
  };
  const semanticKeys = {
    cover: /(?:cover|poster|thumbnail|image|pic)/i,
    author: /(?:author|writer|creator|speaker|anchor|narrator)/i,
    cat: /(?:category|genre|tags?|type)/i,
    lastChapterTitle: /(?:last|latest|new|current|chapter|episode|section|volume|name)/i,
  };
  const visit = (item, path = [], depth = 0) => {
    if (!item || typeof item !== "object" || depth > 8) return;
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key];
      if (child && typeof child === "object") {
        visit(child, next, depth + 1);
        continue;
      }
      const text = String(child ?? "").replace(/\s+/g, " ").trim();
      if (!usableRepairedField(field, text)) continue;
      let score = exactKeys[field]?.test(key) ? 180 : semanticKeys[field]?.test(key) ? 80 : 0;
      if (field === "cover") {
        if (!/^https?:\/\//i.test(text)) continue;
        if (/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(text)) score += 40;
      } else if (field === "lastChapterTitle") {
        if (CHAPTER_TEXT.test(text)) score += 120;
        else if (!exactKeys.lastChapterTitle.test(key)) continue;
      } else if (!score) {
        continue;
      }
      score -= next.length;
      if (!best || score > best.score) best = { selector: next.join("/"), score };
    }
  };
  visit(value);
  return best?.selector || "";
}

function matchingJsonPath(value, target) {
  if (!value || typeof value !== "object" || !target) return "";
  let best = null;
  const visit = (item, path = [], depth = 0) => {
    if (!item || typeof item !== "object" || depth > 8) return;
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key];
      if ((typeof child === "string" || typeof child === "number") && String(child) === target) {
        const score = (/^id$/i.test(key) ? 80 : /(?:entity|book|album).*id$/i.test(key) ? 70 : /id$/i.test(key) ? 50 : 0)
          - next.length;
        if (!best || score > best.score) best = { selector: next.join("/"), score };
      }
      if (child && typeof child === "object") visit(child, next, depth + 1);
    }
  };
  visit(value);
  return best?.selector || "";
}

function totalJsonPath(value) {
  if (!value || typeof value !== "object") return "";
  let best = null;
  const visit = (item, path = [], depth = 0) => {
    if (!item || typeof item !== "object" || depth > 7) return;
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key];
      const number = Number(child);
      if (Number.isFinite(number) && number > 1
        && /^(?:sections|total|totalCount|recordCount|chapterCount|episodeCount|trackCount|count)$/i.test(key)) {
        const score = (/^(?:sections|total|totalCount|chapterCount|episodeCount|trackCount)$/i.test(key) ? 80 : 50)
          - next.length;
        if (!best || score > best.score) best = { selector: next.join("/"), score };
      }
      if (child && typeof child === "object") visit(child, next, depth + 1);
    }
  };
  visit(value);
  return best?.selector || "";
}

function jsonMenuTemplate(action) {
  const script = String(action?.requestInfo || "");
  const literal = script.match(/\bvar\s+url\s*=\s*("(?:\\.|[^"\\])*")\s*;/)?.[1] || "";
  if (!literal) return null;
  let urlTemplate;
  try { urlTemplate = JSON.parse(literal); } catch { return null; }
  if (!/^https?:\/\//i.test(urlTemplate) || !urlTemplate.includes("__ID__")) return null;
  const token = script.match(/\/adapter\/chapters\?plan=([A-Za-z0-9_-]+)/i)?.[1] || "";
  if (!token) return null;
  try {
    const plan = decodeBridgePlan(token);
    const title = String(plan.fields?.title?.selector || "").trim();
    if (plan.responseType !== "json" || !plan.list || !title) return null;
    return { urlTemplate, plan, title };
  } catch {
    return null;
  }
}

async function jsonLatestChapterDescriptor(source, bookUrl, detailBody, download) {
  const action = source?.chapterList;
  if (!action || String(action.responseFormatType || "").toLowerCase() !== "json") return null;
  const menu = jsonMenuTemplate(action);
  const detail = parsedJson(detailBody);
  if (!menu || !detail) return null;
  let targetId = "";
  try {
    const url = new URL(bookUrl);
    for (const [name, value] of url.searchParams) {
      if (/id$/i.test(name) && /^\d+$/.test(value)) {
        targetId = value;
        break;
      }
    }
  } catch {
    // Matching a declarative menu requires a stable ID from the detail URL.
  }
  const idSelector = matchingJsonPath(detail, targetId);
  if (!idSelector) return null;
  const pageSize = Math.max(1, Math.min(200, Number(action.moreKeys?.pageSize) || 50));
  const pageOneUrl = menu.urlTemplate
    .split("__ID__").join(encodeURIComponent(targetId))
    .split("__PAGE__").join("1");
  let menuBody;
  try {
    const page = await download(pageOneUrl, {
      ...(source?.httpHeaders || {}),
      ...(action.httpHeaders || {}),
    });
    menuBody = decodeTextBuffer(page, { headers: page.httpHeaders || {} });
  } catch {
    return null;
  }
  const count = totalJsonPath(parsedJson(menuBody));
  if (!count) return null;
  return {
    urlTemplate: menu.urlTemplate.replaceAll("__ID__", "{{entityId}}"),
    responseType: "json",
    list: menu.plan.list,
    title: menu.title,
    count,
    countSource: "menu",
    values: { entityId: idSelector },
    pageSize,
  };
}

async function latestChapterDescriptor(source, bookUrl, detailBody, download) {
  const action = source?.chapterList;
  if (!action) return null;
  const dynamicHtml = /\/adapter\/toc\?[\s\S]*?\bresolve=html(?:&|["'])/i.test(
    String(action.requestInfo || ""),
  );
  const responseType = String(action.responseFormatType || "html").toLowerCase();
  if (responseType === "json") {
    const template = await jsonLatestChapterDescriptor(source, bookUrl, detailBody, download);
    if (template) return template;
  }
  const adapterToken = String(action.requestInfo || "")
    .match(/\/adapter\/chapters\?plan=([A-Za-z0-9_-]+)/i)?.[1] || "";
  if (adapterToken) {
    try {
      const plan = decodeBridgePlan(adapterToken);
      const title = plan.fields?.title;
      const url = plan.fields?.url;
      if (plan.kind === "chapters" && plan.responseType === "html" && plan.list && title && url) {
        return {
          responseType: "html",
          tocSelector: plan.tocSelector || "",
          samePage: !plan.tocSelector,
          list: plan.list,
          title,
          url,
          reverse: Boolean(plan.reverse),
          pageSize: Number(action.moreKeys?.pageSize) || 100,
        };
      }
      if (plan.kind === "chapters" && plan.responseType === "json" && plan.list && title && url) {
        return {
          mode: "direct",
          responseType: "json",
          list: plan.list,
          title,
          url,
          reverse: Boolean(plan.reverse),
          pageSize: Number(action.moreKeys?.pageSize) || 100,
        };
      }
    } catch {
      // Continue with native chapter actions when an old adapter plan is stale.
    }
  }
  if (responseType !== "html") return null;
  const list = String(action.list || "").trim();
  const title = String(action.title || "").trim();
  const url = String(action.url || "").trim();
  if (!list || !title || !url || [list, title, url].some((value) => /^@js:/i.test(value))) return null;
  const previousToc = existingDetailPlan(source)?.fields?.tocUrl;
  const tocSelector = String(previousToc?.selector || embeddedTocSelector(source) || "").trim();
  return {
    responseType: "html",
    tocSelector,
    samePage: !tocSelector,
    dynamicHtml,
    list,
    title,
    url,
    reverse: Boolean(action.reverse || action.reverseChapters),
    pageSize: Number(action.moreKeys?.pageSize) || 100,
  };
}

function adapterRequestInfo(adapterBase, plan) {
  const endpoint = `${String(adapterBase).replace(/\/$/, "")}/adapter/detail?plan=${encodeBridgePlan(plan)}&url=`;
  return [
    "@js:",
    "var q = (params && params.queryInfo) || {};",
    'var u = q.detailUrl || q.url || (typeof result == "string" ? result : "");',
    'if (!u && result && typeof result == "object") u = result.detailUrl || result.url || "";',
    'u = String(u || "").trim();',
    'if (u.indexOf("//") == 0) u = "https:" + u;',
    'else if (u && !/^https?:\\/\\//i.test(u)) u = config.host + (u.charAt(0) == "/" ? u : "/" + u);',
    `return ${JSON.stringify(endpoint)} + encodeURIComponent(u);`,
  ].join("\n");
}

function bridgeDetailWithLatest(source, action, descriptor, adapterBase) {
  if (!/^https?:\/\//i.test(String(adapterBase || ""))) {
    const ruleFields = new Set(["bookName", "author", "desc", "cat", "lastChapterTitle", "cover", "status", "wordCount", "tocUrl"]);
    return Object.fromEntries(Object.entries(action).map(([key, value]) => {
      if (!ruleFields.has(key) || !value || typeof value !== "object" || Array.isArray(value)) return [key, value];
      return [key, String(value.selector || "")];
    }));
  }
  const plan = compileDetailBridgePlan(action, {
    ...(source?.httpHeaders || {}),
    ...(action?.httpHeaders || {}),
  });
  if (descriptor) plan.latestChapter = descriptor;
  const mapped = {
    name: "bookName",
    author: "author",
    desc: "desc",
    cat: "cat",
    cover: "cover",
    status: "status",
    wordCount: "wordCount",
    tocUrl: "tocUrl",
  };
  const result = {
    ...action,
    actionID: "bookDetail",
    responseFormatType: "json",
    parserID: "DOM",
    requestInfo: adapterRequestInfo(adapterBase, plan),
    lastChapterTitle: "$.lastChapterTitle",
  };
  for (const [field, target] of Object.entries(mapped)) {
    if (plan.fields[field]) result[target] = `$.${field}`;
  }
  return result;
}

function existingDetailPlan(source) {
  const token = String(source?.bookDetail?.requestInfo || "")
    .match(/\/adapter\/detail\?plan=([A-Za-z0-9_-]+)/i)?.[1] || "";
  if (!token) return null;
  try { return decodeBridgePlan(token); } catch { return null; }
}

/** Repair missing book-detail element rules from one real detail response. */
export async function repairDetailFromBook(source, bookUrl, missingFields = [], { download, adapterBase = "" } = {}) {
  if (typeof download !== "function" || !bookUrl) return null;
  let page;
  try {
    page = await download(bookUrl, {
      ...(source?.httpHeaders || {}),
      ...(source?.bookDetail?.httpHeaders || {}),
    });
  } catch {
    return null;
  }
  const responseUrl = String(page.read2xsggResponseUrl || bookUrl);
  let host;
  try { host = new URL(responseUrl).origin; } catch { return null; }
  const detailBody = decodeTextBuffer(page, { headers: page.httpHeaders || {} });
  const detailJson = parsedJson(detailBody);
  const detailResponseType = detailJson ? "json" : "html";
  const document = detailJson ? null : loadDocument(detailBody, responseUrl);
  const missing = new Set(missingFields);
  const fields = {};
  const sampledValues = {};
  const preservedFields = new Set();
  let structuredAuthor = "";
  let semanticAuthor = "";
  if (detailJson) {
    for (const field of ["cover", "author", "cat", "lastChapterTitle"]) {
      fields[field] = jsonDetailFieldSelector(detailJson, field);
    }
  } else {
    fields.cover = detailCoverSelector(document);
    semanticAuthor = authorSelector(document);
    structuredAuthor = structuredDataAuthorRule(detailBody);
    fields.author = semanticAuthor || structuredAuthor;
    fields.cat = categorySelector(document);
    fields.lastChapterTitle = latestChapterSelector(document);
  }
  const selectorFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => Boolean(value)));
  if (Object.keys(selectorFields).length) {
    try {
      const sampled = executeBridgePlan(detailBody, responseUrl, compileDetailBridgePlan({
        actionID: "bookDetail",
        host,
        responseFormatType: detailResponseType,
        parserID: "DOM",
        requestInfo: "%@result",
        ...selectorFields,
      }));
      for (const name of Object.keys(selectorFields)) {
        if (!usableRepairedField(name, sampled?.[name])) delete fields[name];
        else sampledValues[name] = String(sampled[name]).replace(/\s+/g, " ").trim();
      }
    } catch {
      for (const name of Object.keys(selectorFields)) delete fields[name];
    }
  }
  if (!fields.author && semanticAuthor && structuredAuthor) {
    try {
      const sampled = executeBridgePlan(detailBody, responseUrl, compileDetailBridgePlan({
        actionID: "bookDetail",
        host,
        responseFormatType: detailResponseType,
        parserID: "DOM",
        requestInfo: "%@result",
        author: structuredAuthor,
      }));
      if (usableRepairedField("author", sampled?.author)) {
        fields.author = structuredAuthor;
        sampledValues.author = String(sampled.author).replace(/\s+/g, " ").trim();
      }
    } catch {
      // The normal adapter fallback below still supplies a valid author value.
    }
  }
  const previousPlan = existingDetailPlan(source);
  if (previousPlan) {
    try {
      const sampled = executeBridgePlan(detailBody, responseUrl, previousPlan);
      for (const field of ["cover", "author", "cat", "lastChapterTitle"]) {
        if (!previousPlan.fields?.[field]) continue;
        if (usableRepairedField(field, sampled?.[field])) {
          if (!fields[field] || !missing.has(field)) fields[field] = previousPlan.fields[field];
          if (!missing.has(field)) preservedFields.add(field);
          sampledValues[field] = String(sampled[field]).replace(/\s+/g, " ").trim();
        }
      }
    } catch {
      // Invalid historical plans are replaced by newly discovered fields below.
    }
  }
  if (document && sampledValues.author) {
    const heading = usableText(document.querySelector("h1,h2,[itemprop='name']"), 160);
    if (heading && sampledValues.author.toLocaleLowerCase() === heading.toLocaleLowerCase()) {
      delete fields.author;
      delete sampledValues.author;
    }
  }
  if (sampledValues.cat && sampledValues.author
    && sampledValues.cat.toLocaleLowerCase() === sampledValues.author.toLocaleLowerCase()) {
    delete fields.cat;
  }
  // Verification already proved every non-missing merged element. Replacing
  // those fields while repairing another one can trade an author failure for a
  // category failure, so only modify the requested recommended fields.
  for (const field of ["cover", "author", "cat", "lastChapterTitle"]) {
    if (!missing.has(field) && !preservedFields.has(field)) delete fields[field];
  }
  if (/^https?:\/\//i.test(String(adapterBase || ""))) {
    const withFallback = (field, fallback) => {
      if (!field) return { constant: fallback };
      if (typeof field !== "object") return { selector: field, fallback };
      if (Object.hasOwn(field, "constant")) return field;
      return { ...field, fallback };
    };
    if (missing.has("cover") && !fields.cover) {
      const kind = ["text", "comic", "audio", "video"].includes(String(source?.sourceType || ""))
        ? String(source.sourceType)
        : "text";
      fields.cover = { constant: `${String(adapterBase).replace(/\/$/, "")}/adapter/cover?kind=${kind}` };
    }
    if (missing.has("cover") && fields.cover) {
      const kind = ["text", "comic", "audio", "video"].includes(String(source?.sourceType || ""))
        ? String(source.sourceType)
        : "text";
      fields.cover = withFallback(
        fields.cover,
        `${String(adapterBase).replace(/\/$/, "")}/adapter/cover?kind=${kind}`,
      );
    }
    if (missing.has("author")) fields.author = withFallback(fields.author, "原站未标注");
    if (missing.has("cat") && !fields.cat) {
      const category = ({ text: "小说", comic: "漫画", audio: "音频", video: "视频" })[source?.sourceType] || "其他";
      fields.cat = { constant: category };
    }
    if (missing.has("cat") && fields.cat) {
      const category = ({ text: "小说", comic: "漫画", audio: "音频", video: "视频" })[source?.sourceType] || "其他";
      fields.cat = withFallback(fields.cat, category);
    }
    if (missing.has("lastChapterTitle")
      && ["audio", "video"].includes(String(source?.sourceType || ""))
      && /\/adapter\/single-chapter\?/i.test(String(source?.chapterList?.requestInfo || ""))) {
      fields.lastChapterTitle = { constant: "播放" };
    }
  }
  for (const [name, value] of Object.entries(fields)) if (!value) delete fields[name];
  const latestDescriptor = missing.has("lastChapterTitle")
    ? await latestChapterDescriptor(source, bookUrl, detailBody, download)
    : null;
  if (!Object.keys(fields).length && !latestDescriptor) return null;
  const detailAction = {
    ...(source?.bookDetail || {}),
    actionID: "bookDetail",
    host,
    responseFormatType: detailResponseType,
    parserID: "DOM",
    requestInfo: "%@result",
    ...(previousPlan?.fields?.name ? { bookName: previousPlan.fields.name } : {}),
    ...(previousPlan?.fields?.desc ? { desc: previousPlan.fields.desc } : {}),
    ...(previousPlan?.fields?.status ? { status: previousPlan.fields.status } : {}),
    ...(previousPlan?.fields?.wordCount ? { wordCount: previousPlan.fields.wordCount } : {}),
    ...(previousPlan?.fields?.tocUrl ? { tocUrl: previousPlan.fields.tocUrl } : {}),
    ...fields,
  };
  for (const field of ["cover", "author", "cat", "lastChapterTitle"]) {
    if (Object.hasOwn(fields, field) || !Object.hasOwn(detailAction, field)) continue;
    try {
      const sampled = executeBridgePlan(detailBody, responseUrl, compileDetailBridgePlan({
        actionID: "bookDetail",
        host,
        responseFormatType: detailResponseType,
        parserID: "DOM",
        requestInfo: "%@result",
        [field]: detailAction[field],
      }));
      if (!usableRepairedField(field, sampled?.[field])) delete detailAction[field];
    } catch {
      delete detailAction[field];
    }
  }
  for (const field of missing) {
    if (!Object.hasOwn(fields, field)) delete detailAction[field];
  }
  return {
    ...source,
    bookDetail: bridgeDetailWithLatest(source, detailAction, latestDescriptor, adapterBase),
  };
}
