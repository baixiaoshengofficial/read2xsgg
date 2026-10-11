/**
 * Normalize the wrapper shapes used by Legado source collections.
 * Keeping this boundary separate prevents the converter and the online
 * preflight stage from disagreeing about which entries are actual sources.
 */

const WRAPPER_KEYS = ["sources", "bookSources", "data", "items", "list", "records"];
const SOURCE_KEYS = [
  "bookSourceUrl",
  "bookSourceName",
  "sourceUrl",
  "sourceName",
  "searchUrl",
  "ruleSearch",
  "searchRule",
  "ruleContent",
  "contentRule",
];

function looksLikeSource(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && SOURCE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key)));
}

function collect(value, { depth = 0, preserveUnknownArray = false } = {}) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (looksLikeSource(item)) return [item];
      if (item && typeof item === "object") {
        return collect(item, { depth: depth + 1, preserveUnknownArray });
      }
      if (preserveUnknownArray) return [item];
      return collect(item, { depth: depth + 1, preserveUnknownArray: false });
    });
  }
  if (typeof value !== "object") return [];
  if (looksLikeSource(value)) return [value];

  const wrapped = [];
  for (const key of WRAPPER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    wrapped.push(...collect(value[key], { depth: depth + 1, preserveUnknownArray: true }));
  }
  if (wrapped.length) return wrapped;

  // Some exports are maps keyed by source name.  Only treat an object as such
  // when every value is an object; arbitrary API payloads must not become
  // dozens of malformed source entries.
  const values = Object.values(value);
  if (values.length && values.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    return values.flatMap((item) => collect(item, { depth: depth + 1, preserveUnknownArray: true }));
  }
  return [];
}

export function isLegadoSource(value) {
  return looksLikeSource(value);
}

export function normalizeLegadoSources(input) {
  const sources = collect(input, { preserveUnknownArray: true });
  // An empty array is a valid result after online preflight filtered every
  // unreachable entry; the caller needs to retain that stage's diagnostics.
  const isKnownWrapper = input && typeof input === "object" && !Array.isArray(input)
    && WRAPPER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (!sources.length && !Array.isArray(input) && !isKnownWrapper) {
    throw new TypeError("没有在输入 JSON 中找到阅读书源");
  }
  return sources;
}
