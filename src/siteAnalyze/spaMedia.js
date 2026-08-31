import { randomUUID } from "node:crypto";
import { decodeBridgePlan, encodeBridgePlan } from "../bridgePlan.js";
import { encodeMediaExtractionPlan } from "../mediaPlan.js";

const SAFE_FIELD = /^[A-Za-z_$][\w$-]{0,63}$/;
const MEDIA_URL = /\.(?:mp3|m4a|aac|ogg|oga|wav|flac|opus|mp4|m3u8|webm)(?:[?#]|$)/i;

function adapterOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return ""; }
}

function bridgeDetailTemplate(source) {
  const actions = [...Object.values(source?.bookWorld || {}), source?.searchBook].filter(Boolean);
  for (const action of actions) {
    const token = String(action?.requestInfo || "").match(/\/adapter\/books\?plan=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) continue;
    try {
      const field = decodeBridgePlan(token).fields?.url;
      const template = field?.matchTemplate;
      if (template?.prefix && !template?.suffix && /^https?:\/\//i.test(template.prefix)) {
        return { prefix: template.prefix, idField: String(field.selector || "").split("/").at(-1) || "id" };
      }
      if (field?.urlTemplate && /^https?:\/\//i.test(field.urlTemplate)) {
        const idField = field.urlTemplate.match(/\{\{([A-Za-z_$][\w$-]*)\}\}/)?.[1];
        if (idField) return { prefix: field.urlTemplate.split("{{", 1)[0], idField };
      }
    } catch {
      // Try another converted entry action.
    }
  }
  return null;
}

function scriptUrls(html, baseUrl) {
  const urls = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const url = new URL(match[2].replace(/&amp;/gi, "&"), baseUrl);
      if (!/^https?:$/.test(url.protocol) || url.origin !== new URL(baseUrl).origin) continue;
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {
      // Ignore malformed script URLs.
    }
    if (urls.length >= 24) break;
  }
  return urls;
}

function parseLiteral(value) {
  const source = String(value || "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return source;
  const quote = source[0];
  if ((quote === '"' || quote === "'") && source.at(-1) === quote) {
    try {
      return quote === '"' ? JSON.parse(source) : source.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } catch { return ""; }
  }
  return "";
}

function requestDescriptors(script) {
  const descriptors = [];
  for (const match of String(script || "").matchAll(
    /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(([^)]{1,256})\)\s*=>\s*await\s*[\s\S]{0,256}?\.get\(\s*([A-Za-z_$][\w$]*)\s*,\s*(["'])([^"']{3,256})\4\s*,\s*\{([^}]{1,2048})\}\s*\)/g,
  )) {
    const [functionName, rawParams, baseParam, endpoint, requestObject] = [
      match[1], match[2], match[3], match[5], match[6],
    ];
    if (!/(?:api|topic|home|recommend|audio|voice|radio|podcast|episode)/i.test(endpoint)) continue;
    const params = rawParams.split(",").map((item) => item.trim());
    const callPattern = new RegExp(`\\b${functionName}\\s*\\(\\s*([^,]{1,256})\\s*,\\s*(\\{[^{}]{1,1024}\\})\\s*,\\s*([^)]{1,256})\\)`, "g");
    const call = [...String(script || "").matchAll(callPattern)]
      .find((item) => item.index !== match.index);
    if (!call) continue;
    const callArgs = [call[1], call[2], call[3]];
    const query = {};
    for (const pair of requestObject.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$-]*)\s*:\s*([^,]+)(?=,|$)/g)) {
      const name = pair[1];
      const expression = pair[2].trim();
      const jsonParam = expression.match(/^JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)$/)?.[1];
      if (jsonParam) {
        const index = params.indexOf(jsonParam);
        if (index >= 0 && /^\{[^{}]+\}$/.test(callArgs[index] || "")) {
          query[name] = callArgs[index].replace(/([,{]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
        }
        continue;
      }
      const parameterIndex = params.indexOf(expression);
      if (parameterIndex >= 0) {
        const literal = parseLiteral(callArgs[parameterIndex]);
        if (literal !== "") query[name] = literal;
        continue;
      }
      const literal = parseLiteral(expression);
      if (literal !== "") query[name] = literal;
      else if (/device|visitor|fingerprint|uuid/i.test(name)) query[name] = randomUUID();
    }
    if (!Object.keys(query).length) continue;
    descriptors.push({ endpoint, query, baseParam, pageField: "" });
    if (descriptors.length >= 8) break;
  }
  return descriptors;
}

function arraysOfObjects(value, output = [], depth = 0, key = "") {
  if (!value || typeof value !== "object" || depth > 8) return output;
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (rows.length && key) output.push({ key, rows });
    for (const item of value.slice(0, 32)) arraysOfObjects(item, output, depth + 1, key);
    return output;
  }
  for (const [childKey, child] of Object.entries(value)) {
    arraysOfObjects(child, output, depth + 1, childKey);
  }
  return output;
}

function fieldFor(rows, patterns, predicate = () => true) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row || {})).filter((key) => SAFE_FIELD.test(key)));
  for (const pattern of patterns) {
    const key = [...keys].find((candidate) => pattern.test(candidate)
      && rows.some((row) => predicate(String(row?.[candidate] ?? ""))));
    if (key) return key;
  }
  return "";
}

function fieldsFor(rows, patterns, predicate = () => true) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row || {})).filter((key) => SAFE_FIELD.test(key)));
  const output = [];
  for (const pattern of patterns) {
    for (const candidate of keys) {
      if (output.includes(candidate) || !pattern.test(candidate)) continue;
      if (rows.some((row) => predicate(String(row?.[candidate] ?? "")))) output.push(candidate);
    }
  }
  return output;
}

function inferLists(payload, preferredId = "") {
  const grouped = new Map();
  for (const candidate of arraysOfObjects(payload)) {
    const { key, rows } = candidate;
    const names = fieldsFor(rows, [/^title$/i, /^name$/i, /name|title/i], (value) => value.length >= 2 && value.length <= 200);
    const ids = fieldsFor(rows, [
      ...(preferredId ? [new RegExp(`^${preferredId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")] : []),
      /^(?:voice|audio|episode|track|radio|item|target)?id$/i,
      /id$/i,
    ], (value) => /^[A-Za-z0-9_-]{1,100}$/.test(value));
    for (const name of names.slice(0, 3)) {
      for (const id of ids.slice(0, 6)) {
        const valid = rows.filter((row) => String(row?.[name] ?? "").trim() && String(row?.[id] ?? "").trim());
        if (!valid.length) continue;
        const groupKey = `${key}\n${name}\n${id}`;
        const existing = grouped.get(groupKey);
        if (existing) {
          existing.rows.push(...valid);
          continue;
        }
        grouped.set(groupKey, {
          listKey: key,
          rows: [...valid],
          name,
          id,
          cover: fieldFor(rows, [/imageUrl|cover|image|pic|thumb/i], (value) => /^(?:https?:)?\/\//i.test(value)),
          author: fieldFor(rows, [/author|creator|anchor|userName|imageRBText/i], (value) => value.length > 0 && value.length <= 100),
        });
      }
    }
  }
  return [...grouped.values()]
    .map((candidate) => ({
      ...candidate,
      rows: candidate.rows.filter((row, index, all) => (
        all.findIndex((item) => String(item[candidate.id]) === String(row[candidate.id])) === index
      )),
      score: candidate.rows.length * 20
        + (preferredId && candidate.id.toLowerCase() === preferredId.toLowerCase() ? 10_000 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

function representativeRows(rows, limit = 6) {
  if (rows.length <= limit) return rows;
  const indexes = [0, 1, 2, Math.floor(rows.length / 2), rows.length - 2, rows.length - 1];
  return [...new Set(indexes)].slice(0, limit).map((index) => rows[index]);
}

function leaves(value, path = "", output = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return output;
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_FIELD.test(key)) continue;
    const next = path ? `${path}/${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) leaves(child, next, output, depth + 1);
    else if (["string", "number"].includes(typeof child)) output.push({ path: next, key, value: String(child) });
  }
  return output;
}

function inferDetail(payload, preferredId = "") {
  let best = null;
  const visit = (value, property = "", depth = 0) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 7) return;
    const values = leaves(value);
    const media = values.find((item) => MEDIA_URL.test(item.value));
    const id = values.find((item) => item.key === preferredId)
      || values.find((item) => /^(?:voice|audio|episode|track|radio|item)?id$/i.test(item.key));
    const name = values
      .filter((item) => !/(?:btn|button)/i.test(item.key)
        && (/^(?:name|title)$/i.test(item.key) || /name|title/i.test(item.key))
        && item.value.length >= 2)
      .sort((left, right) => {
        const idParent = String(id?.path || "").split("/").slice(0, -1).join("/");
        const score = (item) => {
          const parent = item.path.split("/").slice(0, -1).join("/");
          return (parent && parent === idParent ? 100 : 0)
            + (/^(?:name|title)$/i.test(item.key) ? 20 : 0)
            + (/(?:voice|audio|episode|track|radio)/i.test(item.path) ? 5 : 0);
        };
        return score(right) - score(left);
      })[0];
    if (property && media && name && id) {
      // Prefer the smallest nested object that still contains identity,
      // metadata and playable media. Parent response envelopes also contain
      // those leaves, but make unstable chapter containers.
      const score = depth;
      if (!best || score > best.score) {
        best = {
          score,
          container: property,
          name: name.path,
          id: id.path,
          media: media.path,
          mediaProperty: media.key,
          cover: values.find((item) => /imageUrl|cover|image|pic|thumb/i.test(item.key) && /^https?:\/\//i.test(item.value))?.path || "",
          author: values.find((item) => /author|creator|anchor|user.*name/i.test(item.path) && item.value.length <= 100)?.path || "",
          cat: values.find((item) => /^(?:label|lable|category|class|genre|kind)name$/i.test(item.key)
            && item.value.length <= 100)?.path
            || values.find((item) => !/id$/i.test(item.key)
              && /label|lable|category|class|genre|kind/i.test(item.key)
              && item.value.length <= 100)?.path || "",
        };
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, key, depth + 1);
  };
  visit(payload);
  return best;
}

function requestUrl(origin, descriptor, pageIndex = 1) {
  const query = new URLSearchParams();
  for (const [name, raw] of Object.entries(descriptor.query)) {
    let value = String(raw);
    if (/^\{/.test(value) && /"page(?:No|Index)?"\s*:\s*\d+/i.test(value)) {
      value = value.replace(/("page(?:No|Index)?"\s*:\s*)\d+/i, `$1${pageIndex}`);
      descriptor.pageField = name;
    }
    query.set(name, value);
  }
  return new URL(`${descriptor.endpoint}?${query}`, origin).toString();
}

function actionRequest(adapterBase, endpoint, plan, extra = "") {
  const prefix = `${adapterBase}${endpoint}?plan=${encodeBridgePlan(plan)}${extra}&url=`;
  return [
    "@js:",
    'var p = String((params && params.pageIndex) || 1);',
    `var u = ${JSON.stringify(plan.upstreamTemplate)};`,
    'u = u.replace("__PAGE__", p);',
    `return ${JSON.stringify(prefix)}.replace(/%@pageIndex/g, p) + encodeURIComponent(u);`,
  ].join("\n");
}

function itemRequest(adapterBase, endpoint, plan) {
  const prefix = `${adapterBase}${endpoint}?plan=${encodeBridgePlan(plan)}&url=`;
  return [
    "@js:",
    'var q = (params && params.queryInfo) || {};',
    'var u = String(result || q.chapterUrl || q.detailUrl || q.url || "").trim();',
    `return ${JSON.stringify(prefix)} + encodeURIComponent(u);`,
  ].join("\n");
}

function shell(actionID, host, responseFormatType = "json") {
  return { actionID, validConfig: "", host, responseFormatType, parserID: "DOM" };
}

export async function discoverSpaMedia(originUrl, kind, {
  download,
  homeHtml,
  homeResponseUrl = "",
  adapterBase = "",
  repairSource = null,
  diagnostics = [],
} = {}) {
  if (!["audio", "video"].includes(kind) || typeof download !== "function") return null;
  const adapter = adapterOrigin(adapterBase);
  const detailTemplate = bridgeDetailTemplate(repairSource);
  if (!adapter || !detailTemplate) return null;
  const originalOrigin = new URL(originUrl).origin;
  const pageUrl = homeResponseUrl || originUrl;
  const scriptResults = await Promise.allSettled(
    scriptUrls(homeHtml, pageUrl).map((url) => download(url)),
  );
  const scripts = scriptResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.toString("utf8"));
  const descriptors = scripts.flatMap(requestDescriptors);
  if (!descriptors.length) {
    diagnostics.push(`spa-api: ${scripts.length} 个脚本中未发现静态 JSON 目录请求`);
    return null;
  }
  const candidateOrigins = [...new Set([originalOrigin, new URL(pageUrl).origin])];
  const headers = { "X-Fingerprint": randomUUID() };
  let payloadCount = 0;
  let listCount = 0;
  let detailCount = 0;
  let mediaDetailCount = 0;
  const attemptedIdFields = new Set();
  for (const descriptor of descriptors) {
    for (const apiOrigin of candidateOrigins) {
      let listPayload;
      let page1Url;
      try {
        page1Url = requestUrl(apiOrigin, descriptor, 1);
        listPayload = JSON.parse((await download(page1Url, headers)).toString("utf8"));
        payloadCount += 1;
      } catch {
        continue;
      }
      const lists = inferLists(listPayload, detailTemplate.idField);
      if (!lists.length) continue;
      listCount += lists.length;
      for (const list of lists) {
        attemptedIdFields.add(list.id);
        const rows = list.rows;
        for (const sample of representativeRows(rows)) {
          const detailUrl = `${detailTemplate.prefix}${sample[list.id]}`;
          let detailPayload;
          try {
            detailPayload = JSON.parse((await download(detailUrl, headers)).toString("utf8"));
            detailCount += 1;
            if (leaves(detailPayload).some((item) => MEDIA_URL.test(item.value))) mediaDetailCount += 1;
          } catch {
            continue;
          }
          const detail = inferDetail(detailPayload, list.id);
          if (!detail?.container) continue;

      const page2Url = requestUrl(apiOrigin, descriptor, 2);
      let page2Count = 0;
      try {
        const page2 = JSON.parse((await download(page2Url, headers)).toString("utf8"));
        const second = arraysOfObjects(page2)
          .filter((candidate) => candidate.key === list.listKey)
          .flatMap((candidate) => candidate.rows)
          .filter((row) => row?.[list.name] && row?.[list.id]);
        const firstIds = new Set(rows.map((row) => String(row[list.id])));
        if (second.some((row) => !firstIds.has(String(row[list.id])))) page2Count = second.length;
      } catch {
        // A valid first page still provides a usable category.
      }

      const listPlan = {
        version: 1,
        kind: "books",
        host: apiOrigin,
        responseType: "json",
        list: `@json-recursive:${encodeURIComponent(list.listKey)}`,
        fields: {
          name: { selector: list.name },
          url: {
            selector: list.id,
            matchTemplate: { pattern: "^([\\s\\S]+)$", prefix: detailTemplate.prefix, suffix: "", hostPrefix: false },
          },
          ...(list.cover ? { cover: { selector: list.cover } } : {}),
          ...(list.author ? { author: { selector: list.author } } : {}),
        },
        headers,
      };
      const templateUrl = requestUrl(apiOrigin, descriptor, 1).replace(
        /(%22page(?:No|Index)?%22%3A)1/i,
        "$1__PAGE__",
      ).replace(/("page(?:No|Index)?"%3A)1/i, "$1__PAGE__");
      listPlan.upstreamTemplate = templateUrl;

      const detailPlan = {
        version: 1,
        kind: "detail",
        host: new URL(detailTemplate.prefix).origin,
        responseType: "json",
        fields: {
          name: { selector: `@json-recursive:${encodeURIComponent(detail.name)}` },
          ...(detail.cover ? { cover: { selector: `@json-recursive:${encodeURIComponent(detail.cover)}` } } : {}),
          ...(detail.author ? { author: { selector: `@json-recursive:${encodeURIComponent(detail.author)}` } } : {}),
          ...(detail.cat ? { cat: { selector: `@json-recursive:${encodeURIComponent(detail.cat)}` } } : {}),
        },
        headers,
      };
      const chapterPlan = {
        version: 1,
        kind: "chapters",
        host: new URL(detailTemplate.prefix).origin,
        responseType: "json",
        list: `@json-recursive:${encodeURIComponent(detail.container)}`,
        fields: {
          title: { selector: detail.name },
          url: {
            selector: detail.id,
            matchTemplate: { pattern: "^([\\s\\S]+)$", prefix: detailTemplate.prefix, suffix: "", hostPrefix: false },
          },
        },
        headers,
      };
      const mediaPlan = encodeMediaExtractionPlan({
        kind,
        properties: [detail.mediaProperty],
        attributes: ["src"],
        urlHints: [],
        headers,
      });
      const category = {
        ...shell("bookWorld", apiOrigin),
        requestInfo: actionRequest(adapter, "/adapter/books", listPlan, "&page=%@pageIndex&pageSize=20"),
        list: "$.data",
        bookName: "name",
        detailUrl: "url",
        author: "author",
        cover: "cover",
        moreKeys: { pageSize: 20, ...(page2Count ? { maxPage: 200 } : { maxPage: 1 }) },
        _sIndex: 0,
      };
      const source = {
        sourceName: repairSource?.sourceName || new URL(originUrl).hostname,
        sourceUrl: originalOrigin,
        weight: 0,
        enable: 1,
        miniAppVersion: "2.56.1",
        authorId: "",
        sourceType: kind,
        httpHeaders: headers,
        bookWorld: { 站点推荐: category },
        searchBook: { ...category, actionID: "searchBook" },
        bookDetail: {
          ...shell("bookDetail", new URL(detailTemplate.prefix).origin),
          requestInfo: itemRequest(adapter, "/adapter/detail", detailPlan),
          bookName: "$.name",
          author: "$.author",
          cat: "$.cat",
          cover: "$.cover",
        },
        chapterList: {
          ...shell("chapterList", new URL(detailTemplate.prefix).origin),
          requestInfo: itemRequest(adapter, "/adapter/chapters", chapterPlan),
          list: "$.data",
          title: "title",
          url: "url",
        },
        chapterContent: {
          ...shell("chapterContent", new URL(detailTemplate.prefix).origin),
          requestInfo: [
            "@js:",
            'var q = (params && params.queryInfo) || {};',
            'var u = String(result || q.chapterUrl || "").trim();',
            'var ref = String(q.detailUrl || q.url || "").trim();',
            `return ${JSON.stringify(`${adapter}/adapter/media?kind=${kind}&plan=${mediaPlan}&url=`)} + encodeURIComponent(u) + (ref ? "&referer=" + encodeURIComponent(ref) : "");`,
          ].join("\n"),
          content: [
            "@js:",
            'var item = result || {};',
            'if (typeof item === "string") { try { item = JSON.parse(item); } catch (e) { item = { url: item }; } }',
            'var url = String(item.url || "").trim();',
            'if (!url) return "";',
            'var headers = {}; var baseHeaders = (config && config.httpHeaders) || {}; var mediaHeaders = item.httpHeaders || item.headers || {};',
            'for (var key in baseHeaders) headers[key] = baseHeaders[key];',
            'for (var name in mediaHeaders) headers[name] = mediaHeaders[name];',
            'return JSON.stringify({url: (function () { try { return encodeURI(decodeURI(url)); } catch (e) { return encodeURI(url); } })(), httpHeaders: headers, forbidCache: true});',
          ].join("\n"),
        },
      };
      return {
        kind,
        host: originalOrigin,
        title: source.sourceName,
        source,
        bookCount: rows.length,
        chapterCount: 1,
        mediaSampleUrl: leaves(detailPayload).find((item) => MEDIA_URL.test(item.value))?.value || "",
      };
        }
      }
    }
  }
  diagnostics.push(`spa-api: 未发现可执行的 JSON 媒体目录（请求 ${descriptors.length}，响应 ${payloadCount}，列表 ${listCount}，详情 ${detailCount}，含媒体 ${mediaDetailCount}，ID ${[...attemptedIdFields].join("/") || "无"}）`);
  return null;
}
