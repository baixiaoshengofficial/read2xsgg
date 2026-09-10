import { hasUnsupportedLegadoRuntime } from "./legadoJs.js";
import { decodeTextBuffer } from "./charset.js";

const SOURCE_TYPES = new Set(["text", "comic", "audio", "video"]);
const RESPONSE_TYPES = new Set(["html", "json", ""]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 香色 2.56.1 可执行的后处理是 `selector||@js:`；单竖线会被当成普通选择器。
 */
export function ruleUsesForbiddenSinglePipeJs(rule) {
  const source = String(rule || "");
  if (!source) return false;
  if (/\|\|\s*@js:/i.test(source)) return false;
  return /(?:^|[^|])\|@js:/i.test(source);
}

function validateActionShell(action, path, errors) {
  if (!action || typeof action !== "object") {
    errors.push(`${path}: 缺少动作对象`);
    return false;
  }
  if (!nonEmptyString(action.actionID)) errors.push(`${path}: 缺少 actionID`);
  if (!nonEmptyString(action.host)) errors.push(`${path}: 缺少 host`);
  if (action.responseFormatType != null && !RESPONSE_TYPES.has(String(action.responseFormatType))) {
    errors.push(`${path}: responseFormatType 无效（${action.responseFormatType}）`);
  }
  if (action.parserID != null && action.parserID !== "" && action.parserID !== "DOM") {
    errors.push(`${path}: parserID 应为 DOM`);
  }
  return true;
}

function validateRuleField(action, field, path, errors, { required = true } = {}) {
  const value = action?.[field];
  if (!nonEmptyString(value)) {
    if (required) errors.push(`${path}.${field}: 缺少必填规则`);
    return;
  }
  if (ruleUsesForbiddenSinglePipeJs(value)) {
    errors.push(`${path}.${field}: 使用了香色无法执行的单竖线 |@js:（应为 ||@js:）`);
  }
  if (hasUnsupportedLegadoRuntime(value)) {
    errors.push(`${path}.${field}: 含无法在香色执行的阅读运行时语法`);
  }
}

/**
 * Structural check against the Xiangse source shape this project emits/imports.
 * Does not fetch the network — pair with runXbsPipeline for end-to-end proof.
 */
export function validateXiangseSource(source) {
  const errors = [];
  if (!source || typeof source !== "object") {
    return { ok: false, errors: ["源不是对象"] };
  }
  if (!nonEmptyString(source.sourceName)) errors.push("缺少 sourceName");
  if (!nonEmptyString(source.sourceUrl)) errors.push("缺少 sourceUrl（香色站点根地址）");
  if (!SOURCE_TYPES.has(source.sourceType)) {
    errors.push(`sourceType 无效（应为 text|comic|audio|video，实际 ${source.sourceType}）`);
  }
  if (!nonEmptyString(source.miniAppVersion)) errors.push("缺少 miniAppVersion");

  const worlds = Object.entries(source.bookWorld || {});
  if (!worlds.length && !nonEmptyString(source.searchBook?.requestInfo)) {
    errors.push("bookWorld/searchBook 至少需要一个可用入口");
  }
  for (const [title, action] of worlds) {
    const path = `bookWorld.${title || "(unnamed)"}`;
    if (!validateActionShell(action, path, errors)) continue;
    validateRuleField(action, "requestInfo", path, errors);
    validateRuleField(action, "list", path, errors);
    validateRuleField(action, "bookName", path, errors);
    validateRuleField(action, "detailUrl", path, errors);
  }

  if (validateActionShell(source.searchBook, "searchBook", errors)) {
    validateRuleField(source.searchBook, "requestInfo", "searchBook", errors);
    validateRuleField(source.searchBook, "list", "searchBook", errors);
    validateRuleField(source.searchBook, "bookName", "searchBook", errors);
    validateRuleField(source.searchBook, "detailUrl", "searchBook", errors);
  }

  if (validateActionShell(source.bookDetail, "bookDetail", errors)) {
    validateRuleField(source.bookDetail, "requestInfo", "bookDetail", errors);
  }

  if (validateActionShell(source.chapterList, "chapterList", errors)) {
    validateRuleField(source.chapterList, "requestInfo", "chapterList", errors);
    validateRuleField(source.chapterList, "list", "chapterList", errors);
    validateRuleField(source.chapterList, "title", "chapterList", errors);
    validateRuleField(source.chapterList, "url", "chapterList", errors);
  }

  if (validateActionShell(source.chapterContent, "chapterContent", errors)) {
    validateRuleField(source.chapterContent, "requestInfo", "chapterContent", errors);
    validateRuleField(source.chapterContent, "content", "chapterContent", errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Remove only broken optional entry actions and rebuild search from a valid
 * category when possible. Core detail/chapter/content actions are never
 * hidden here; they must be repaired and verified by the live pipeline.
 */
export function repairXiangseEntrypoints(source) {
  let candidate = source;
  let validation = validateXiangseSource(candidate);
  if (validation.ok) {
    return { source: candidate, validation, removedWorlds: [], replacedSearch: false };
  }

  const removedWorlds = [];
  const nextWorlds = { ...(candidate?.bookWorld || {}) };
  for (const title of Object.keys(nextWorlds)) {
    const prefix = `bookWorld.${title || "(unnamed)"}.`;
    if (!validation.errors.some((error) => error.startsWith(prefix))) continue;
    delete nextWorlds[title];
    removedWorlds.push(title);
  }
  if (removedWorlds.length) {
    candidate = { ...candidate, bookWorld: nextWorlds };
    validation = validateXiangseSource(candidate);
  }

  let replacedSearch = false;
  if (validation.errors.some((error) => error.startsWith("searchBook."))) {
    for (const action of Object.values(candidate?.bookWorld || {})) {
      const repaired = {
        ...candidate,
        searchBook: { ...action, actionID: "searchBook" },
      };
      const repairedValidation = validateXiangseSource(repaired);
      if (repairedValidation.errors.some((error) => error.startsWith("searchBook."))) continue;
      candidate = repaired;
      validation = repairedValidation;
      replacedSearch = true;
      break;
    }
  }

  return { source: candidate, validation, removedWorlds, replacedSearch };
}

export function filterValidXiangseSources(sources, {
  warnings = [],
  skipped = [],
  stage = "structure",
} = {}) {
  const kept = {};
  for (const [name, source] of Object.entries(sources || {})) {
    const repaired = repairXiangseEntrypoints(source);
    const { source: candidate, validation } = repaired;
    if (repaired.removedWorlds.length) {
      warnings.push({
        source: name,
        section: "bookWorld",
        field: stage,
        message: `已跳过 ${repaired.removedWorlds.length} 个香色不可执行分类：${repaired.removedWorlds.join("、")}`,
        rule: "",
      });
    }
    if (repaired.replacedSearch) {
      warnings.push({
        source: name,
        section: "searchBook",
        field: stage,
        message: "搜索动作含香色不可执行规则，已降级为可用分类入口，保留核心阅读链路",
        rule: "",
      });
    }
    if (validation.ok) {
      kept[name] = candidate;
      continue;
    }
    const reason = `香色结构校验失败：${validation.errors.slice(0, 5).join("；")}`;
    skipped.push({ source: name, reason });
    warnings.push({
      source: name,
      section: "source",
      field: stage,
      message: `已过滤无法导入/执行的香色源：${reason}`,
      rule: "",
    });
  }
  return { sources: kept, warnings, skipped };
}

/**
 * Wrap a site-analyze download(buffer) function as fetch()-compatible for runXbsPipeline.
 */
export function downloadAsFetch(download) {
  if (typeof download !== "function") throw new TypeError("downloadAsFetch 需要 download");
  return async (url, init = {}) => {
    try {
      const method = String(init.method || "GET").toUpperCase();
      const raw = await download(String(url), init.headers || {}, {
        method,
        ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(method === "POST" ? { followPostRedirects: true } : {}),
      });
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
      const responseHeaders = buffer.httpHeaders && typeof buffer.httpHeaders === "object"
        ? buffer.httpHeaders
        : {};
      const responseUrl = String(buffer.read2xsggResponseUrl || url);
      return {
        ok: true,
        status: 200,
        url: responseUrl,
        read2xsggDecodedText: Boolean(buffer.read2xsggDecodedText),
        headers: {
          get(name) {
            const key = String(name || "").toLowerCase();
            const actual = Object.entries(responseHeaders)
              .find(([header]) => header.toLowerCase() === key)?.[1];
            if (actual !== undefined && actual !== null) return String(actual);
            if (key === "content-type") {
              if (/\.(?:mp3|m4a|aac|ogg|wav|flac)(?:\?|$)/i.test(responseUrl)) return "audio/mpeg";
              if (/\.(?:mp4|m3u8|webm)(?:\?|$)/i.test(responseUrl)) return "video/mp4";
              if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:\?|$)/i.test(responseUrl)) return "image/jpeg";
              return "text/html; charset=utf-8";
            }
            return null;
          },
        },
        async text() {
          return buffer.read2xsggDecodedText
            ? buffer.toString("utf8")
            : decodeTextBuffer(buffer, { headers: buffer.httpHeaders || {} });
        },
        async arrayBuffer() {
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
      };
    } catch (error) {
      const message = String(error?.message || error || "download failed");
      return {
        ok: false,
        status: 502,
        url: String(url),
        headers: { get: () => null },
        async text() { return message; },
        async arrayBuffer() { return new ArrayBuffer(0); },
      };
    }
  };
}
