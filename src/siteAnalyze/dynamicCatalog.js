import { responseText } from "../httpTransport.js";
import { parseHeaders } from "../requests.js";

const SAFE_FIELD = /^[A-Za-z_$][\w$-]{0,63}$/;

function decodeStringLiteral(quote, body) {
  try {
    if (quote === '"') return JSON.parse(`${quote}${body}${quote}`);
    return body
      .replace(/\\'/g, "'")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  } catch {
    return "";
  }
}

function absoluteTemplate(value, origin) {
  const template = String(value || "").trim();
  if (!template) return "";
  if (/^https?:\/\//i.test(template)) {
    return template.startsWith(origin) ? `{{origin}}${template.slice(origin.length)}` : template;
  }
  if (!template.startsWith("/")) return "";
  return `{{origin}}${template}`;
}

function simpleField(rule, preferred = []) {
  const source = String(rule || "");
  const fields = [...source.matchAll(/\$\.?\.?(?:\.)?([A-Za-z_$][\w$-]*)/g)]
    .map((match) => match[1]);
  for (const expected of preferred) {
    const found = fields.find((field) => expected.test(field));
    if (found) return found;
  }
  return fields.find((field) => SAFE_FIELD.test(field)) || "";
}

function selectorArrayFields(rule) {
  const selector = String(rule || "").replace(/<js>[\s\S]*?<\/js>/gi, "");
  return [...selector.matchAll(/(?:\$\.\.|\$\.)([A-Za-z_$][\w$-]*)\s*(?:\[\*\])?/g)]
    .map((match) => match[1])
    .filter((field) => SAFE_FIELD.test(field) && !["js", "result"].includes(field));
}

function valueAtPath(payload, path) {
  let value = payload;
  for (const field of path) value = value?.[field];
  return value;
}

function payloadArray(payload, field) {
  if (Array.isArray(payload?.[field])) return payload[field];
  if (Array.isArray(payload?.data?.[field])) return payload.data[field];
  return [];
}

function inferPayloadField(payload, candidates, predicate) {
  for (const field of candidates) {
    const values = payloadArray(payload, field);
    if (values.length && predicate(values)) return field;
  }
  for (const scope of [payload, payload?.data]) {
    if (!scope || typeof scope !== "object") continue;
    for (const [field, values] of Object.entries(scope)) {
      if (SAFE_FIELD.test(field) && Array.isArray(values) && values.length && predicate(values)) return field;
    }
  }
  return "";
}

function interpolateProbe(template, vars) {
  return String(template || "").replace(/\{\{\s*([A-Za-z_$][\w$-]*)\s*\}\}/g, (_, name) => {
    const value = vars[name] ?? "";
    return name === "origin" ? String(value) : encodeURIComponent(String(value));
  });
}

function rowIdentity(row, plan) {
  if (!row || typeof row !== "object") return "";
  return String(row[plan.item.id] ?? row[plan.item.name] ?? "").trim();
}

function catalogHeaders(source) {
  const headers = parseHeaders(source?.header, () => {});
  if (source?.httpUserAgent) headers["User-Agent"] = String(source.httpUserAgent);
  return headers;
}

/**
 * Infer a declarative dynamic-catalog description from Legado script shape.
 * Every URL, path and field comes from the source itself; no site identity is
 * consulted here.
 */
export function inferDynamicCatalog(source) {
  const script = String(source?.exploreUrl || "").trim();
  if (!/^(?:@js:|<js>)/i.test(script) || !/\bjava\.ajax\s*\(/i.test(script)) return null;

  const ajax = script.match(/\bjava\.ajax\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
  let categoryUrl = "";
  if (ajax) {
    const variable = ajax[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = script.match(new RegExp(`(?:\\b(?:var|let|const)\\s+)?${variable}\\s*=\\s*([\"'])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`, "i"));
    if (assignment) categoryUrl = decodeStringLiteral(assignment[1], assignment[2]);
  } else {
    const direct = script.match(/\bjava\.ajax\s*\(\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1\s*\)/i);
    if (direct) categoryUrl = decodeStringLiteral(direct[1], direct[2]);
  }
  if (!/^https?:\/\//i.test(categoryUrl)) return null;

  const pathMatch = script.match(/JSON\.parse\s*\(\s*java\.ajax\s*\([\s\S]*?\)\s*\)((?:\.[A-Za-z_$][\w$-]*){1,6})/i);
  const categoryPath = pathMatch?.[1]?.split(".").filter(Boolean) || [];
  const childMatch = script.match(/(?:\b(?:var|let|const)\s+)?[A-Za-z_$][\w$]*\s*=\s*\$\.([A-Za-z_$][\w$-]*)\s*;[\s\S]{0,300}?\.map\s*\(/i);
  const childField = childMatch?.[1] || "";
  const parentName = script.match(/\bpush\s*\(\s*\$\.([A-Za-z_$][\w$-]*)\s*,\s*(?:null|["']{2})/i)?.[1] || "";
  const childName = script.match(/\btitle\s*=\s*\$\.([A-Za-z_$][\w$-]*)/i)?.[1] || parentName;
  if (!categoryPath.length || !childField || !parentName || !childName) return null;

  const firstMatch = script.match(/\bif\s*\(\s*page\s*={2,3}\s*1\s*\)[\s\S]{0,1200}?\burl\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/i);
  if (!firstMatch) return null;
  let firstUrl = decodeStringLiteral(firstMatch[1], firstMatch[2]);
  const entityField = firstUrl.match(/\$\{\s*\$\.([A-Za-z_$][\w$-]*)\s*\}/)?.[1] || "";
  if (!entityField) return null;
  firstUrl = firstUrl.replace(/\$\{\s*\$\.[A-Za-z_$][\w$-]*\s*\}/g, "{{entityId}}");

  const nextMatch = script.match(/\burl\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*?[?&][A-Za-z_$][\w$-]*Ids=)\1\s*\+\s*JSON\.stringify\s*\(/i);
  if (!nextMatch) return null;
  let nextUrl = `${decodeStringLiteral(nextMatch[1], nextMatch[2])}{{idsJson}}`;
  const pageSizeMatch = firstUrl.match(/[?&](?:dsize|pageSize|size|limit)=(\d{1,3})\b/i)
    || script.match(/\.slice\s*\([^,]+,\s*[^+]+\+\s*(\d{1,3})\s*\)/i);
  const pageSize = Math.min(50, Math.max(1, Number(pageSizeMatch?.[1]) || 20));
  firstUrl = firstUrl.replace(/([?&](?:dsize|pageSize|size|limit)=)\d{1,3}\b/i, "$1{{pageSize}}");
  nextUrl = nextUrl.replace(/([?&](?:dsize|pageSize|size|limit)=)\d{1,3}\b/i, "$1{{pageSize}}");

  const origin = new URL(categoryUrl).origin;
  firstUrl = absoluteTemplate(firstUrl, origin);
  nextUrl = absoluteTemplate(nextUrl, origin);
  if (!firstUrl || !nextUrl) return null;

  const rules = source?.ruleExplore && Object.keys(source.ruleExplore).length
    ? { ...source.ruleSearch, ...source.ruleExplore }
    : (source?.ruleSearch || {});
  const idField = entityField;
  const detailRule = String(rules.bookUrl || "");
  let detailUrl = detailRule.replace(/\{\{\s*\$\.([A-Za-z_$][\w$-]*)\s*\}\}/g, (_match, field) => `{{${field}}}`);
  if (/^https?:\/\//i.test(detailUrl) && detailUrl.startsWith(origin)) {
    detailUrl = `{{origin}}${detailUrl.slice(origin.length)}`;
  }
  const detailId = [...detailUrl.matchAll(/\{\{([A-Za-z_$][\w$-]*)\}\}/g)]
    .map((match) => match[1])
    .find((field) => field !== "origin") || idField;
  if (!detailUrl || !detailId) return null;

  const idsProperty = String(rules.bookList || "")
    .match(/JSON\.parse\s*\(\s*result\s*\)\.([A-Za-z_$][\w$-]*)/i)?.[1] || "";
  const itemCandidates = selectorArrayFields(rules.bookList);
  const item = {
    id: detailId,
    name: simpleField(rules.name, [/name/i, /title/i]) || "name",
    detailUrl,
  };
  const optionalRules = {
    author: rules.author,
    desc: rules.intro || rules.desc,
    cover: rules.coverUrl || rules.cover,
    kind: rules.kind,
    lastChapterTitle: rules.lastChapter,
  };
  for (const [key, rule] of Object.entries(optionalRules)) {
    const field = simpleField(rule, [new RegExp(key === "cover" ? "cover|pic|img" : key, "i")]);
    if (field) item[key] = field;
  }

  return {
    categoryUrl,
    categoryPath,
    childField,
    parentName,
    childName,
    entityField,
    itemCandidates,
    plan: {
      version: 1,
      kind: "idList",
      origin,
      pageSize,
      headers: catalogHeaders(source),
      first: { url: firstUrl, idsProperty: idsProperty || "ids", itemsProperty: itemCandidates.at(-1) || "items" },
      next: { url: nextUrl, itemsProperty: itemCandidates.at(-1) || "items" },
      item,
    },
  };
}

async function validatePlan(inferred, entries, download) {
  const plan = structuredClone(inferred.plan);
  const entityId = String(entries[0]?.entityId || "");
  const vars = { origin: plan.origin, entityId, pageSize: plan.pageSize, idsJson: "[]" };
  const firstUrl = interpolateProbe(plan.first.url, vars);
  const firstPayload = JSON.parse(responseText(await download(firstUrl, plan.headers)));
  const idsProperty = inferPayloadField(firstPayload, [plan.first.idsProperty], (values) => (
    values.some((value) => typeof value !== "object")
  ));
  const itemsProperty = inferPayloadField(firstPayload, inferred.itemCandidates, (values) => (
    values.some((value) => value && typeof value === "object" && !Array.isArray(value))
  ));
  if (!idsProperty || !itemsProperty) throw new Error("分类首屏没有可识别的 ID 列表或书籍数组");
  plan.first.idsProperty = idsProperty;
  plan.first.itemsProperty = itemsProperty;
  plan.next.itemsProperty = itemsProperty;

  const firstRows = payloadArray(firstPayload, itemsProperty);
  const firstValid = firstRows.filter((row) => rowIdentity(row, plan) && row?.[plan.item.name]);
  if (!firstValid.length) throw new Error("分类首屏未解析出书名和详情标识");
  if (plan.item.cover && !firstValid.some((row) => String(row?.[plan.item.cover] || "").trim())) {
    throw new Error("源声明了封面规则，但分类首屏没有解析出封面");
  }

  const ids = payloadArray(firstPayload, idsProperty);
  let page2Count = 0;
  if (ids.length > plan.pageSize) {
    const slice = ids.slice(plan.pageSize, plan.pageSize * 2);
    vars.idsJson = JSON.stringify(slice);
    const secondUrl = interpolateProbe(plan.next.url, vars);
    const secondPayload = JSON.parse(responseText(await download(secondUrl, plan.headers)));
    const secondRows = payloadArray(secondPayload, itemsProperty);
    const secondValid = secondRows.filter((row) => rowIdentity(row, plan) && row?.[plan.item.name]);
    if (!secondValid.length) throw new Error("分类第 2 页未解析出书名和详情标识");
    const firstIds = new Set(firstValid.map((row) => rowIdentity(row, plan)));
    if (secondValid.every((row) => firstIds.has(rowIdentity(row, plan)))) {
      throw new Error("分类第 2 页与第 1 页重复");
    }
    page2Count = secondValid.length;
  }
  return { plan, page1Count: firstValid.length, page2Count };
}

export async function materializeDynamicCatalogSource(source, { download } = {}) {
  const inferred = inferDynamicCatalog(source);
  if (!inferred || typeof download !== "function") return { source, materialized: false };
  const categoryPayload = JSON.parse(responseText(await download(inferred.categoryUrl, inferred.plan.headers)));
  const parents = valueAtPath(categoryPayload, inferred.categoryPath);
  if (!Array.isArray(parents) || !parents.length) throw new Error("动态分类接口没有返回分类数组");
  const entries = [];
  for (const parent of parents) {
    const children = parent?.[inferred.childField];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const title = String(child?.[inferred.childName] || "").trim();
      const entityId = String(child?.[inferred.entityField] ?? "").trim();
      if (!title || !entityId) continue;
      entries.push({
        title,
        group: String(parent?.[inferred.parentName] || "").trim(),
        entityId,
        pageSize: inferred.plan.pageSize,
      });
    }
  }
  if (!entries.length) throw new Error("动态分类没有可用的标题和实体 ID");
  const validated = await validatePlan(inferred, entries, download);
  return {
    source: {
      ...source,
      exploreUrl: entries.map((entry) => ({
        ...entry,
        // Keep the adapter's upstream slice size independent from Xiangse's
        // short-page threshold. Some APIs reserve one slot on page 1.
        pageSize: Math.max(1, Math.min(validated.plan.pageSize, validated.page1Count)),
        requestPageSize: validated.plan.pageSize,
      })),
      ruleExplore: {
        bookList: "$.data[*]",
        name: "$.name",
        bookUrl: "$.url",
        author: "$.author",
        intro: "$.desc",
        coverUrl: "$.cover",
        kind: "$.cat",
        lastChapter: "$.lastChapterTitle",
      },
      read2xsgg: { ...(source.read2xsgg || {}), catalogPlan: validated.plan },
    },
    materialized: true,
    categoryCount: entries.length,
    page1Count: validated.page1Count,
    page2Count: validated.page2Count,
  };
}

export async function materializeDynamicCatalogs(input, { download } = {}) {
  const isSource = (value) => value && typeof value === "object" && !Array.isArray(value)
    && (value.bookSourceUrl || value.bookSourceName || value.searchUrl || value.exploreUrl);
  const entries = Array.isArray(input)
    ? input.map((value, index) => [index, value])
    : isSource(input) ? [[null, input]] : Object.entries(input || {});
  const output = Array.isArray(input) ? [...input] : (isSource(input) ? input : { ...(input || {}) });
  const warnings = [];
  const candidates = entries.filter(([, source]) => inferDynamicCatalog(source));
  await Promise.all(candidates.map(async ([key, source]) => {
    const name = String(source?.bookSourceName || source?.name || key || "未命名书源");
    try {
      const result = await materializeDynamicCatalogSource(source, { download });
      if (Array.isArray(output)) output[key] = result.source;
      else if (key === null) Object.assign(output, result.source);
      else output[key] = result.source;
      warnings.push({
        source: name,
        section: "bookWorld",
        field: "exploreUrl",
        message: `动态分类已通用物化 ${result.categoryCount} 项；首屏 ${result.page1Count} 条，第 2 页 ${result.page2Count} 条，分页未重复`,
        rule: "",
      });
    } catch (error) {
      warnings.push({
        source: name,
        section: "bookWorld",
        field: "exploreUrl",
        message: `动态分类通用物化失败，保留原规则：${error.message}`,
        rule: "",
      });
    }
  }));
  return { input: output, warnings };
}
