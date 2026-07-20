import { hasUnsupportedLegadoRuntime } from "./legadoJs.js";

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
  if (!worlds.length) errors.push("bookWorld 至少需要一个分类");
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
 * Wrap a site-analyze download(buffer) function as fetch()-compatible for runXbsPipeline.
 */
export function downloadAsFetch(download) {
  if (typeof download !== "function") throw new TypeError("downloadAsFetch 需要 download");
  return async (url, init = {}) => {
    try {
      const raw = await download(String(url), init.headers || {});
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
      return {
        ok: true,
        status: 200,
        url: String(url),
        headers: {
          get(name) {
            const key = String(name || "").toLowerCase();
            if (key === "content-type") {
              if (/\.(?:mp3|m4a|aac|ogg|wav|flac)(?:\?|$)/i.test(url)) return "audio/mpeg";
              if (/\.(?:mp4|m3u8|webm)(?:\?|$)/i.test(url)) return "video/mp4";
              if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:\?|$)/i.test(url)) return "image/jpeg";
              return "text/html; charset=utf-8";
            }
            return null;
          },
        },
        async text() { return buffer.toString("utf8"); },
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
