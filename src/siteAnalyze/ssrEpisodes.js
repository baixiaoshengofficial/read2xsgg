import { JSDOM } from "jsdom";

const EPISODE_PATH = /\/(?:chapters?|episodes?|programs?|tracks?|play)\/([A-Za-z0-9_-]+)(?=[/?#]|$)/i;
const TITLE_FIELD = /^(?:title|name|episodeName|programName|chapterName|trackName)$/i;
const ID_FIELD = /^(?:id|episodeId|programId|chapterId|trackId|itemId)$/i;
const VERSION_FIELD = /^(?:v|version|revision|rev)$/i;
const TOTAL_FIELD = /^(?:total|count|totalCount|programCount|episodeCount|chapterCount|trackCount)$/i;

function balancedObject(source, start) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

function embeddedPayloads(text) {
  const source = String(text || "");
  const output = [];
  for (const match of source.matchAll(/(?:window\.)?__[A-Za-z_$][\w$]*(?:Stores?|State|Data)\s*=\s*/g)) {
    const start = source.indexOf("{", match.index + match[0].length);
    if (start < 0 || start - (match.index + match[0].length) > 20) continue;
    const literal = balancedObject(source, start);
    if (!literal) continue;
    try { output.push(JSON.parse(literal)); } catch { /* Try another state assignment. */ }
    if (output.length >= 8) break;
  }
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object") output.push(parsed);
  } catch {
    // Ordinary HTML is expected here.
  }
  return output;
}

function objectArrays(value, output = [], depth = 0, parent = null) {
  if (!value || typeof value !== "object" || depth > 10) return output;
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (rows.length >= 2) output.push({ rows, parent });
    for (const item of value.slice(0, 40)) objectArrays(item, output, depth + 1, value);
    return output;
  }
  for (const child of Object.values(value)) objectArrays(child, output, depth + 1, value);
  return output;
}

function rowFields(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const title = keys.find((key) => TITLE_FIELD.test(key)
    && rows.some((row) => String(row[key] || "").trim().length >= 2));
  const id = keys.find((key) => ID_FIELD.test(key)
    && rows.some((row) => /^[A-Za-z0-9_-]+$/.test(String(row[key] || ""))));
  return title && id ? { title, id } : null;
}

function anchorCatalog(html, pageUrl) {
  const document = new JSDOM(String(html || ""), { url: pageUrl }).window.document;
  const rows = [];
  const byId = new Map();
  let template = null;
  for (const anchor of document.querySelectorAll("a[href]")) {
    let href;
    try { href = new URL(anchor.getAttribute("href"), pageUrl).toString(); } catch { continue; }
    const match = href.match(EPISODE_PATH);
    const title = String(anchor.textContent || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    if (!match || !title || byId.has(match[1])) continue;
    const row = { id: match[1], title, url: href };
    rows.push(row);
    byId.set(row.id, row);
    if (!template) {
      template = {
        prefix: href.slice(0, match.index + match[0].lastIndexOf(match[1])),
        suffix: href.slice(match.index + match[0].lastIndexOf(match[1]) + match[1].length),
      };
    }
  }
  return { rows, byId, template };
}

function metadataFromPayload(value, pageUrl) {
  const ids = new Set(String(new URL(pageUrl).pathname).split("/").filter(Boolean));
  let best = null;
  let total = 0;
  const visit = (item, depth = 0) => {
    if (!item || typeof item !== "object" || depth > 10) return;
    if (!Array.isArray(item)) {
      const entries = Object.entries(item);
      const versionEntry = entries.find(([key, value]) => VERSION_FIELD.test(key)
        && /^[A-Za-z0-9._-]{4,200}$/.test(String(value || "")));
      const idEntry = entries.find(([key, value]) => /^(?:id|channelId|albumId|showId|bookId)$/i.test(key)
        && /^[A-Za-z0-9_-]+$/.test(String(value || "")));
      if (versionEntry && idEntry) {
        const score = (ids.has(String(idEntry[1])) ? 100 : 0) + depth;
        if (!best || score > best.score) {
          best = { entityId: String(idEntry[1]), version: String(versionEntry[1]), score };
        }
      }
      for (const [key, value] of entries) {
        if (TOTAL_FIELD.test(key) && Number(value) > total) total = Number(value);
      }
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value);
  return { ...(best || {}), total };
}

function applyUrlTemplate(template, id) {
  if (!template || !id) return "";
  return `${template.prefix}${id}${template.suffix}`;
}

export function extractSsrEpisodeCatalog(text, pageUrl, templateHint = null) {
  const anchors = anchorCatalog(text, pageUrl);
  const payloads = embeddedPayloads(text);
  const candidates = [];
  for (const payload of payloads) {
    for (const array of objectArrays(payload)) {
      const { rows, parent } = array;
      const fields = rowFields(rows);
      if (!fields) continue;
      const valid = rows.filter((row) => String(row[fields.title] || "").trim()
        && String(row[fields.id] || "").trim());
      const anchorMatches = valid.filter((row) => anchors.byId.has(String(row[fields.id]))).length;
      const totalHint = Object.entries(parent || {}).find(([key, value]) => (
        TOTAL_FIELD.test(key) && Number(value) >= valid.length
      ))?.[1];
      candidates.push({
        payload,
        rows: valid,
        fields,
        totalHint: Number(totalHint) || 0,
        score: valid.length + anchorMatches * 100,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  const template = templateHint || anchors.template;
  const rows = selected ? selected.rows.map((row) => {
    const id = String(row[selected.fields.id]);
    return {
      id,
      title: String(row[selected.fields.title]).replace(/\s+/g, " ").trim(),
      url: anchors.byId.get(id)?.url || applyUrlTemplate(template, id),
    };
  }).filter((row) => row.url) : anchors.rows;
  const metadata = selected ? metadataFromPayload(selected.payload, pageUrl) : {};
  return {
    rows: rows.filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index),
    total: Math.max(Number(selected?.totalHint) || 0, rows.length),
    entityId: metadata.entityId || "",
    version: metadata.version || "",
    urlTemplate: template,
  };
}

function siteDomain(hostname) {
  const parts = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const country = parts.at(-1)?.length === 2 && /^(?:ac|co|com|edu|gov|net|org)$/.test(parts.at(-2));
  return parts.slice(country ? -3 : -2).join(".");
}

function scriptUrls(html, pageUrl) {
  const output = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const url = new URL(match[2], pageUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      if (!output.includes(url.toString())) output.push(url.toString());
    } catch {
      // Ignore malformed script references.
    }
  }
  return output.slice(-8);
}

function apiBases(script, pageUrl) {
  const output = new Set([new URL(pageUrl).origin]);
  for (const match of String(script || "").matchAll(/https:\/\/[A-Za-z0-9.-]*api[A-Za-z0-9.-]*/gi)) {
    try { output.add(new URL(match[0]).origin); } catch { /* Ignore partial URLs. */ }
  }
  const domain = siteDomain(new URL(pageUrl).hostname);
  for (const match of String(script || "").matchAll(/["'](https:\/\/[A-Za-z0-9.-]*api[A-Za-z0-9.-]*\.)["']\.concat\(/gi)) {
    try { output.add(new URL(`${match[1]}${domain}`).origin); } catch { /* Ignore invalid bases. */ }
  }
  return [...output];
}

function apiPathTemplates(script) {
  const output = [];
  const pattern = /(["'])(\/api\/[^"']*?\/(?:channels?|albums?|shows?)\/)\1\)\.concat\([^,]+,\s*(["'])(\/(?:programs?|episodes?|tracks?)\?(?:version|v)=)\3\)\.concat\([^,]+,\s*(["'])(&[^"']*?(?:page_index|pageIndex|page)=)\5/gi;
  for (const match of String(script || "").matchAll(pattern)) {
    output.push(`${match[2]}{{entityId}}${match[4]}{{version}}${match[6]}{{page}}`);
  }
  return [...new Set(output)];
}

function fillPlan(template, catalog, page) {
  return String(template)
    .replaceAll("{{entityId}}", encodeURIComponent(catalog.entityId))
    .replaceAll("{{version}}", encodeURIComponent(catalog.version))
    .replaceAll("{{page}}", encodeURIComponent(String(page)));
}

export async function discoverSsrEpisodePlan(html, pageUrl, { download } = {}) {
  if (typeof download !== "function") return null;
  const catalog = extractSsrEpisodeCatalog(html, pageUrl);
  if (catalog.rows.length < 2 || !catalog.entityId || !catalog.version
    || catalog.total <= catalog.rows.length || !catalog.urlTemplate) return null;
  const results = await Promise.allSettled(scriptUrls(html, pageUrl).map((url) => download(url)));
  const scripts = results.filter((item) => item.status === "fulfilled")
    .map((item) => item.value.toString("utf8"));
  for (const script of scripts) {
    for (const base of apiBases(script, pageUrl)) {
      for (const path of apiPathTemplates(script)) {
        const apiTemplate = `${base}${path}`;
        try {
          const firstText = (await download(fillPlan(apiTemplate, catalog, 1))).toString("utf8");
          const secondText = (await download(fillPlan(apiTemplate, catalog, 2))).toString("utf8");
          const first = extractSsrEpisodeCatalog(firstText, pageUrl, catalog.urlTemplate);
          const second = extractSsrEpisodeCatalog(secondText, pageUrl, catalog.urlTemplate);
          const firstIds = new Set(first.rows.map((row) => row.id));
          if (first.rows.length >= 2 && second.rows.some((row) => !firstIds.has(row.id))) {
            return {
              version: 1,
              apiTemplate,
              pageSize: first.rows.length,
              total: Math.max(catalog.total, first.total, second.total),
              sampleRows: first.rows,
            };
          }
        } catch {
          // Only a real, distinct second page can enable pagination.
        }
      }
    }
  }
  return null;
}

export function encodeSsrEpisodePlan(plan) {
  const persisted = {
    version: 1,
    apiTemplate: String(plan?.apiTemplate || ""),
    pageSize: Math.max(1, Number(plan?.pageSize) || 1),
    total: Math.max(0, Number(plan?.total) || 0),
  };
  return Buffer.from(JSON.stringify(persisted), "utf8").toString("base64url");
}

export function decodeSsrEpisodePlan(value) {
  const plan = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  if (plan?.version !== 1 || typeof plan.apiTemplate !== "string"
    || !/^https?:\/\//i.test(plan.apiTemplate)
    || !plan.apiTemplate.includes("{{entityId}}")
    || !plan.apiTemplate.includes("{{version}}")
    || !plan.apiTemplate.includes("{{page}}")) throw new Error("SSR 节目目录计划无效");
  return {
    version: 1,
    apiTemplate: plan.apiTemplate,
    pageSize: Math.max(1, Number(plan.pageSize) || 1),
    total: Math.max(0, Number(plan.total) || 0),
  };
}

export function ssrEpisodePageUrl(plan, catalog, page) {
  return fillPlan(plan.apiTemplate, catalog, page);
}
