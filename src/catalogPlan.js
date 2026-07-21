import { responseText } from "./httpTransport.js";

const MAX_PLAN_CHARS = 24_576;
const SAFE_NAME = /^[A-Za-z_$][\w$-]{0,63}$/;
const BLOCKED_HEADERS = /^(?:host|content-length|transfer-encoding|connection|te|trailer|upgrade|proxy-|sec-websocket-)/i;
const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z_$][\w$-]{0,63})\s*\}\}/g;

function safeHeaders(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName || "").trim();
    const headerValue = String(rawValue ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || BLOCKED_HEADERS.test(name)) continue;
    if (!headerValue || headerValue.length > 2_048) continue;
    result[name] = headerValue;
    if (Object.keys(result).length >= 16) break;
  }
  return result;
}

function safeTemplate(value) {
  const text = String(value ?? "");
  if (!text || text.length > 2_048) return "";
  if (/[<>\r\n]/.test(text)) return "";
  return text;
}

function interpolate(template, vars, { encode = false } = {}) {
  return String(template || "").replace(TEMPLATE_TOKEN, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return "";
    const value = String(vars[name] ?? "");
    // Keep origin raw so https://host stays a usable URL prefix.
    if (!encode || name === "origin") return value;
    return encodeURIComponent(value);
  });
}

function normalizeRequestSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const url = safeTemplate(raw.url);
  if (!url) return null;
  const itemsProperty = String(raw.itemsProperty || "books").trim();
  if (!SAFE_NAME.test(itemsProperty)) return null;
  const idsProperty = String(raw.idsProperty || "").trim();
  if (idsProperty && !SAFE_NAME.test(idsProperty)) return null;
  return {
    url,
    itemsProperty,
    ...(idsProperty ? { idsProperty } : {}),
  };
}

function normalizeItemMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { id: "id", name: "name", detailUrl: "{{origin}}/item/{{id}}" };
  }
  const pick = (key, fallback = "") => {
    const value = String(raw[key] ?? fallback).trim();
    return value && value.length <= 2_048 ? value : fallback;
  };
  const id = pick("id", "id");
  const name = pick("name", "name");
  const detailUrl = safeTemplate(raw.detailUrl) || "{{origin}}/item/{{id}}";
  if (!SAFE_NAME.test(id) || !SAFE_NAME.test(name)) {
    return { id: "id", name: "name", detailUrl };
  }
  const optional = {};
  for (const key of ["author", "desc", "cover", "lastChapterTitle", "kind"]) {
    const value = pick(key);
    if (!value) continue;
    if (SAFE_NAME.test(value) || value.includes("{{")) optional[key] = value;
  }
  return { id, name, detailUrl, ...optional };
}

/**
 * Domain-neutral id-list catalog plan: page 1 fetches items + id list;
 * later pages slice cached ids into a follow-up request template.
 */
export function normalizeCatalogPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const first = normalizeRequestSpec(value.first);
  const next = normalizeRequestSpec(value.next);
  if (!first?.idsProperty || !next) return null;
  const origin = safeTemplate(value.origin) || "";
  if (origin && !/^https?:\/\//i.test(origin)) return null;
  const pageSize = Math.min(50, Math.max(1, Number(value.pageSize) || 20));
  return {
    version: 1,
    kind: "idList",
    origin,
    pageSize,
    headers: safeHeaders(value.headers),
    first,
    next,
    item: normalizeItemMap(value.item),
  };
}

export function encodeCatalogPlan(plan) {
  const normalized = normalizeCatalogPlan(plan);
  if (!normalized) throw new TypeError("分类目录计划无效");
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  if (encoded.length > MAX_PLAN_CHARS) throw new TypeError("分类目录计划过大");
  return encoded;
}

export function decodeCatalogPlan(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > MAX_PLAN_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("分类目录计划编码无效");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("分类目录计划不是有效 JSON");
  }
  const normalized = normalizeCatalogPlan(parsed);
  if (!normalized) throw new TypeError("分类目录计划无效");
  return normalized;
}

/** @type {Map<string, { ids: Array<string|number>, expiresAt: number }>} */
const idListCache = new Map();
const ID_CACHE_TTL_MS = 15 * 60 * 1000;

function cacheKey(plan, entityId) {
  return `${plan.origin || ""}::${entityId}::${plan.first.url}`;
}

function rememberIds(plan, entityId, ids) {
  const key = cacheKey(plan, entityId);
  const cleaned = (Array.isArray(ids) ? ids : [])
    .map((value) => (typeof value === "number" ? value : String(value).trim()))
    .filter((value) => value !== "" && value !== "0" && Number(value) !== 0);
  if (!cleaned.length) return;
  idListCache.set(key, { ids: cleaned, expiresAt: Date.now() + ID_CACHE_TTL_MS });
}

function idsFor(plan, entityId) {
  const cached = idListCache.get(cacheKey(plan, entityId));
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    idListCache.delete(cacheKey(plan, entityId));
    return null;
  }
  return cached.ids;
}

function readProperty(item, name) {
  if (!item || typeof item !== "object" || !name) return "";
  if (Object.prototype.hasOwnProperty.call(item, name)) {
    const value = item[name];
    if (Array.isArray(value)) {
      return value.map((entry) => (entry && typeof entry === "object" ? entry.name : entry)).filter(Boolean).join(" ");
    }
    return value == null ? "" : String(value).trim();
  }
  return "";
}

function mapItem(item, plan, vars) {
  const id = readProperty(item, plan.item.id) || readProperty(item, "baseEntityId");
  const name = readProperty(item, plan.item.name);
  if (!id || !name) return null;
  const local = { ...vars, id: String(id) };
  const detailUrl = interpolate(plan.item.detailUrl, local, { encode: true }).trim();
  if (!detailUrl || !/^https?:\/\//i.test(detailUrl)) return null;
  const mapped = {
    name,
    url: detailUrl,
    author: "",
    desc: "",
    cover: "",
    cat: "",
    lastChapterTitle: "",
    status: "",
    wordCount: "",
  };
  if (plan.item.author) mapped.author = readProperty(item, plan.item.author);
  if (plan.item.desc) mapped.desc = readProperty(item, plan.item.desc);
  if (plan.item.cover) mapped.cover = readProperty(item, plan.item.cover);
  if (plan.item.kind) mapped.cat = readProperty(item, plan.item.kind);
  if (plan.item.lastChapterTitle) {
    mapped.lastChapterTitle = readProperty(item, plan.item.lastChapterTitle);
  }
  return mapped;
}

function itemsFromPayload(payload, property) {
  if (!payload || typeof payload !== "object") return [];
  const direct = payload[property];
  if (Array.isArray(direct)) return direct;
  if (payload.data && typeof payload.data === "object" && Array.isArray(payload.data[property])) {
    return payload.data[property];
  }
  return [];
}

/**
 * Execute a declarative id-list catalog plan. Transport is injected; no host
 * branches live here. `entityId` is a plan variable supplied by the request.
 */
export async function executeCatalogPlan(planInput, { entityId, pageIndex = 1, pageSize, download } = {}) {
  const plan = normalizeCatalogPlan(planInput);
  if (!plan || typeof download !== "function") {
    return { data: [], hasMore: false, offset: 0, pageSize: 20 };
  }
  const entity = String(entityId || "").trim();
  if (!entity) return { data: [], hasMore: false, offset: 0, pageSize: plan.pageSize };
  const size = Math.min(50, Math.max(1, Number(pageSize) || plan.pageSize || 20));
  const page = Math.max(1, Number(pageIndex) || 1);
  const vars = {
    origin: plan.origin,
    entityId: entity,
    pageSize: String(size),
    idsJson: "[]",
  };
  const headers = { ...plan.headers };

  if (page === 1) {
    const url = interpolate(plan.first.url, vars, { encode: true }).trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return { data: [], hasMore: false, offset: 0, pageSize: size };
    }
    const payload = JSON.parse(responseText(await download(url, headers)));
    if (Array.isArray(payload?.[plan.first.idsProperty])) {
      rememberIds(plan, entity, payload[plan.first.idsProperty]);
    }
    const data = itemsFromPayload(payload, plan.first.itemsProperty)
      .map((item) => mapItem(item, plan, vars))
      .filter(Boolean);
    const total = idsFor(plan, entity)?.length || payload?.bookCount || data.length;
    return {
      data,
      hasMore: total > data.length,
      offset: 0,
      pageSize: size,
    };
  }

  const ids = idsFor(plan, entity);
  if (!ids?.length) {
    return { data: [], hasMore: false, offset: (page - 1) * size, pageSize: size };
  }
  const start = (page - 1) * size;
  const slice = ids.slice(start, start + size);
  if (!slice.length) {
    return { data: [], hasMore: false, offset: start, pageSize: size };
  }
  vars.idsJson = JSON.stringify(slice);
  const url = interpolate(plan.next.url, vars, { encode: true }).trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { data: [], hasMore: false, offset: start, pageSize: size };
  }
  const payload = JSON.parse(responseText(await download(url, headers)));
  const data = itemsFromPayload(payload, plan.next.itemsProperty)
    .map((item) => mapItem(item, plan, vars))
    .filter(Boolean);
  return {
    data,
    hasMore: start + data.length < ids.length,
    offset: start,
    pageSize: size,
  };
}

/** Clear id-list cache (tests). */
export function clearCatalogPlanCache() {
  idListCache.clear();
}
