const LRTS_HOST_RE = /(?:^|\.)lrts\.me$/i;
const LRTS_HEADERS = {
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  Accept: "*/*",
  "User-Agent": "Mozilla/5.0 (Linux; Android 9; MIX 2S Build/PKQ1.180729.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/72.0.3626.121 Mobile Safari/537.36",
  Referer: "https://m.lrts.me/",
  "X-Requested-With": "kaixin.diantai",
};

/** @type {Map<string, { bookIds: number[], expiresAt: number }>} */
const resourceBookIdsCache = new Map();
const RESOURCE_CACHE_TTL_MS = 15 * 60 * 1000;

export function isLrtsSource(source) {
  const raw = String(source?.bookSourceUrl || source?.sourceUrl || source?.host || "").trim();
  if (!raw) return false;
  try {
    return LRTS_HOST_RE.test(new URL(raw.split("#", 1)[0]).hostname);
  } catch {
    return /lrts\.me/i.test(raw);
  }
}

export function lrtsDefaultHeaders(extra = {}) {
  return { ...LRTS_HEADERS, ...extra };
}

function categoryEntityId(item) {
  const raw = String(item?.url ?? item?.id ?? "").trim();
  if (/^\d+$/.test(raw)) return raw;
  return "";
}

function walkBookTypeEntries(nodes, group = "", entries = []) {
  for (const node of nodes || []) {
    const name = String(node?.name || "").trim();
    const entityId = categoryEntityId(node);
    const subList = Array.isArray(node?.subList) ? node.subList : [];
    if (subList.length) {
      walkBookTypeEntries(subList, group ? `${group}·${name}` : name, entries);
      continue;
    }
    if (!name || !entityId) continue;
    entries.push({
      title: name,
      group: group || "",
      entityId,
    });
  }
  return entries;
}

export function lrtsExploreEntriesFromCategory(payload, adapterBase) {
  const base = String(adapterBase || "").replace(/\/$/, "");
  const bookTypes = payload?.data?.bookTypeList;
  if (!Array.isArray(bookTypes) || !bookTypes.length || !base) return [];
  const entries = walkBookTypeEntries(bookTypes);
  return entries.map((entry) => ({
    title: entry.title,
    group: entry.group,
    url: `${base}/adapter/lrts-books?entityId=${encodeURIComponent(entry.entityId)}&page=__READ2XSGG_PAGE__&pageSize=20`,
    pageSize: 20,
  }));
}

/**
 * Replace dynamic @js explore (java.ajax getCategory) with portable category URLs.
 */
export async function enrichLrtsSource(source, { download, imageProxyBase = "" } = {}) {
  if (!isLrtsSource(source) || typeof download !== "function") return source;
  const explore = String(source.exploreUrl || "");
  if (!/getCategory|bookTypeList/i.test(explore)) return source;

  const base = String(imageProxyBase || "").replace(/\/$/, "");
  if (!base) return source;

  try {
    const page = await download("https://m.lrts.me/ajax/getCategory", lrtsDefaultHeaders());
    const payload = JSON.parse(page.toString("utf8"));
    const entries = lrtsExploreEntriesFromCategory(payload, base);
    if (!entries.length) return source;
    return {
      ...source,
      exploreUrl: entries,
      ruleExplore: {
        ...(source.ruleExplore || source.exploreRule || {}),
        bookList: "$.data",
        name: "$.name",
        bookUrl: "https://m.lrts.me/ajax/getBookDetail?bookId={{$.id}}",
        author: "{{$.author}}  演播：{{$.announcer}}",
        coverUrl: "$.cover",
        intro: "$.desc",
        kind: "{{$.tags[*].name}}\n{{$.score}}分",
        lastChapter: "$.sections",
      },
    };
  } catch {
    return source;
  }
}

export function rememberLrtsBookIds(entityId, bookIds) {
  const key = String(entityId || "").trim();
  if (!key || !Array.isArray(bookIds) || !bookIds.length) return;
  resourceBookIdsCache.set(key, {
    bookIds: bookIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0),
    expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS,
  });
}

export function lrtsBookIdsForEntity(entityId) {
  const key = String(entityId || "").trim();
  const cached = resourceBookIdsCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    resourceBookIdsCache.delete(key);
    return null;
  }
  return cached.bookIds;
}

export function lrtsBooksFromPayload(payload, host = "https://m.lrts.me") {
  const books = Array.isArray(payload?.books) ? payload.books : [];
  const data = books.map((book) => {
    const id = book?.id ?? book?.baseEntityId;
    const name = String(book?.name || "").trim();
    if (!id || !name) return null;
    return {
      name,
      url: `${host.replace(/\/$/, "")}/ajax/getBookDetail?bookId=${encodeURIComponent(String(id))}`,
      author: book?.author ? String(book.author) : "",
      desc: book?.desc ? String(book.desc) : "",
      cover: book?.cover ? String(book.cover) : "",
      cat: Array.isArray(book?.tags) ? book.tags.map((tag) => tag?.name).filter(Boolean).join(" ") : "",
      lastChapterTitle: book?.sections != null ? String(book.sections) : "",
      status: "",
      wordCount: "",
    };
  }).filter(Boolean);
  return data;
}

export async function fetchLrtsResourceBooks(entityId, pageIndex, pageSize, download) {
  const entity = String(entityId || "").trim();
  const page = Math.max(1, Number(pageIndex) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const headers = lrtsDefaultHeaders();

  if (page === 1) {
    const firstUrl = `https://m.lrts.me/ajax/getResourceList?dsize=${size}&entityId=${encodeURIComponent(entity)}&entityType=1&pageNum=1&showFilters=1`;
    const raw = await download(firstUrl, headers);
    const payload = JSON.parse(raw.toString("utf8"));
    if (Array.isArray(payload?.bookIds) && payload.bookIds.length) {
      rememberLrtsBookIds(entity, payload.bookIds);
    }
    const data = lrtsBooksFromPayload(payload);
    const total = lrtsBookIdsForEntity(entity)?.length || payload?.bookCount || data.length;
    return {
      data,
      hasMore: total > data.length,
      offset: 0,
      pageSize: size,
    };
  }

  const bookIds = lrtsBookIdsForEntity(entity);
  if (!bookIds?.length) {
    return { data: [], hasMore: false, offset: (page - 1) * size, pageSize: size };
  }
  const start = (page - 1) * size;
  const slice = bookIds.slice(start, start + size);
  if (!slice.length) {
    return { data: [], hasMore: false, offset: start, pageSize: size };
  }
  const nextUrl = `https://m.lrts.me/ajax/getResourceList?dsize=${size}&entityId=0&entityType=0&pageNum=0&showFilters=0&bookIds=${encodeURIComponent(JSON.stringify(slice))}`;
  const raw = await download(nextUrl, headers);
  const payload = JSON.parse(raw.toString("utf8"));
  const data = lrtsBooksFromPayload(payload);
  return {
    data,
    hasMore: start + data.length < bookIds.length,
    offset: start,
    pageSize: size,
  };
}

export function lrtsListenPathContent() {
  return [
    "@js:",
    'var body = (typeof result === "string") ? JSON.parse(result) : result;',
    'var url = String((body && body.data && body.data.path) || "").trim();',
    'if (!url) return "";',
    "return JSON.stringify({",
    "  url: encodeURI(url),",
    "  httpHeaders: config.httpHeaders,",
    "  forbidCache: true",
    "});",
  ].join("\n");
}
