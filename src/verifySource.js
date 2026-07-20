import {
  compileBookBridgePlan,
  compileChapterBridgePlan,
  decodeBridgePlan,
  executeBridgePlan,
  bridgeTocUrl,
} from "./bridgePlan.js";

function firstRequestFilter(action) {
  const filters = String(action?.moreKeys?.requestFilters || "");
  const line = filters.split("\n").find((item) => item.includes("::"));
  if (!line) return "";
  return line.slice(line.indexOf("::") + 2).trim();
}

function declarativeBridgeAction(action, type) {
  const requestInfo = String(action?.requestInfo || "");
  // Allow paging/query params between plan= and url= (e.g. &page=&pageSize=&slice=1).
  const match = requestInfo.match(new RegExp(`/adapter/${type}\\?plan=([A-Za-z0-9_-]+)[^"'\\\\\\s]*?&url=`));
  if (!match) return null;
  try {
    return { plan: decodeBridgePlan(match[1]), requestInfo };
  } catch {
    return null;
  }
}

function actionHeaders(source, action) {
  return { ...(source?.httpHeaders || {}), ...(action?.httpHeaders || {}) };
}

function executableBookAction(source, action) {
  const bridged = declarativeBridgeAction(action, "books");
  if (bridged) return bridged;
  const requestInfo = String(action?.requestInfo || "");
  if (!requestInfo || /^@js:/i.test(requestInfo.trim())) return null;
  try {
    const plan = compileBookBridgePlan(action, actionHeaders(source, action));
    if (!plan.list || !plan.fields.name || !plan.fields.url) return null;
    return { plan, requestInfo };
  } catch {
    return null;
  }
}

function executableChapterAction(source) {
  const action = source?.chapterList;
  const bridged = declarativeBridgeAction(action, "chapters");
  if (bridged) return bridged;
  try {
    const plan = compileChapterBridgePlan(action, { headers: actionHeaders(source, source?.chapterList) });
    if (!plan.list || !plan.fields.title || !plan.fields.url) return null;
    return { plan, requestInfo: String(action?.requestInfo || "") };
  } catch {
    return null;
  }
}

/**
 * Resolve the upstream page URL embedded in a bridged or plain requestInfo.
 * Supports literal templates and the `@js` wrappers that only substitute page/filter.
 */
export function resolveBookTargetUrl(action, bridge, {
  keyWord = "小说",
  pageIndex = 1,
  filter = "",
} = {}) {
  if (!bridge) return "";
  const requestInfo = String(bridge.requestInfo || action?.requestInfo || "").trim();
  const host = bridge.plan?.host || action?.host || "";

  if (/^@js:/i.test(requestInfo)) {
    const literal = requestInfo.match(/var\s+u\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/);
    if (literal) {
      let target = "";
      try {
        target = JSON.parse(literal[1].replace(/^'/, '"').replace(/'$/, '"'));
      } catch {
        try { target = Function(`return (${literal[1]})`)(); } catch { return ""; }
      }
      target = String(target || "")
        .replace(/%@pageIndex/g, String(pageIndex))
        .replace(/%@offset/g, "0")
        .replace(/%@keyWord/g, encodeURIComponent(keyWord))
        .replace(/%@filter/g, filter || firstRequestFilter(action));
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    const filterJs = requestInfo.match(/params\.filters[\s\S]{0,200}?return\s+String\(f\)/);
    if (filterJs) {
      const value = filter || firstRequestFilter(action);
      if (!value) return "";
      const target = String(value).replace(/__READ2XSGG_PAGE__/g, String(pageIndex));
      try { return new URL(target, host).toString(); } catch { return ""; }
    }
    // Bridged wrapper that encodes an upstream URL into adapter?plan=...&url=
    const encoded = requestInfo.match(/&url="\s*\+\s*encodeURIComponent\(u\)|plan=[A-Za-z0-9_-]+&url=/);
    if (encoded && /encodeURIComponent\(u\)/.test(requestInfo)) {
      // Need the inner u; already handled by literal branch when present.
    }
  }

  const marker = "&url=";
  const index = requestInfo.indexOf(marker);
  const embedded = index >= 0;
  let target = (embedded ? requestInfo.slice(index + marker.length) : requestInfo)
    .replace(/^@js:[\s\S]*$/i, "")
    .replaceAll("%@filter", filter || firstRequestFilter(action))
    .replaceAll("%@pageIndex", String(pageIndex))
    .replaceAll("%@offset", "0")
    .replaceAll("%@keyWord", encodeURIComponent(keyWord));
  if (!target || /%@|\{\{|<[^>]*>|^@js:/i.test(target)) return "";
  if (embedded) {
    try { target = decodeURIComponent(target); } catch { return ""; }
  }
  try { return new URL(target, host).toString(); } catch { return ""; }
}

export function chapterPageCandidates(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return [];
  }
  const candidates = [parsed.toString()];
  if (/(?:^|\/)api\//i.test(parsed.pathname)) {
    const page = new URL(parsed);
    page.pathname = page.pathname.replace(/(^|\/)api\//i, "$1");
    page.search = "";
    page.hash = "";
    if (!candidates.includes(page.toString())) candidates.push(page.toString());
  }
  return candidates;
}

async function executeDeclarativeUrl(plan, targetUrl, download, { chapters = false, limit = 3 } = {}) {
  const page = await download(targetUrl, plan.headers || {});
  const text = page.toString("utf8");
  if (chapters && plan.tocSelector) {
    const tocUrl = bridgeTocUrl(text, targetUrl, plan);
    if (tocUrl) {
      try {
        const tocPage = await download(tocUrl, plan.headers || {});
        const output = executeBridgePlan(tocPage.toString("utf8"), tocUrl, plan, { limit });
        if (Array.isArray(output.data) && output.data.length) return output;
      } catch {
        // Fall through to detail page chapters.
      }
    }
  }
  return executeBridgePlan(text, targetUrl, plan, { limit });
}

/**
 * Light verification: at least one book from category/search, then at least one chapter.
 * Does not require chapter content (keeps aggregate conversion affordable).
 */
export async function verifyConvertedSource(source, {
  download,
  keyWord = "小说",
  timeoutMs = 3_000,
} = {}) {
  if (typeof download !== "function") {
    return { ok: false, reason: "rules-stale: empty-list", detail: "缺少下载器" };
  }
  const timedDownload = async (url, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await download(url, headers, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const worlds = [
    ...Object.values(source?.bookWorld || {}).slice(0, 2),
    ...(source?.searchBook ? [source.searchBook] : []),
  ];
  let lastDetail = "";
  for (const action of worlds) {
    const bookBridge = executableBookAction(source, action);
    if (!bookBridge) continue;
    const targetUrl = resolveBookTargetUrl(action, bookBridge, { keyWord });
    if (!targetUrl) continue;
    try {
      const books = await executeDeclarativeUrl(bookBridge.plan, targetUrl, timedDownload, { limit: 3 });
      const book = (books.data || []).find((item) => item?.url && item?.name);
      if (!book) continue;
      lastDetail = book.url;
      const chapterBridge = executableChapterAction(source);
      if (!chapterBridge) {
        return { ok: false, reason: "rules-stale: empty-toc", detail: "章节动作无法抽测", bookUrl: book.url };
      }
      for (const chapterPageUrl of chapterPageCandidates(book.url)) {
        try {
          const chapters = await executeDeclarativeUrl(
            chapterBridge.plan,
            chapterPageUrl,
            timedDownload,
            { chapters: true, limit: 2 },
          );
          const chapter = (chapters.data || []).find((item) => item?.url && item?.title);
          if (chapter) {
            return {
              ok: true,
              bookUrl: book.url,
              chapterUrl: chapter.url,
              bookName: book.name,
              chapterTitle: chapter.title,
            };
          }
        } catch {
          // Try next candidate.
        }
      }
      return { ok: false, reason: "rules-stale: empty-toc", detail: "目录解析为空", bookUrl: book.url };
    } catch (error) {
      lastDetail = error.message || String(error);
    }
  }
  return {
    ok: false,
    reason: "rules-stale: empty-list",
    detail: lastDetail || "分类/搜索列表为空或无法抽测",
  };
}

export async function verifyConvertedSources(sources, options = {}) {
  const entries = Object.entries(sources || {});
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const kept = {};
  const failed = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length || 1) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [name, source] = entries[index];
      const result = await verifyConvertedSource(source, options);
      if (result.ok) kept[name] = source;
      else failed.push({ source: name, reason: result.reason, detail: result.detail, host: source?.host });
    }
  });
  if (entries.length) await Promise.all(workers);
  return { sources: kept, failed };
}
