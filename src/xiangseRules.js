const BOOK_ITEM_FIELDS = [
  "bookName",
  "detailUrl",
  "url",
  "author",
  "desc",
  "cat",
  "lastChapterTitle",
  "cover",
  "status",
  "wordCount",
];

const CHAPTER_ITEM_FIELDS = ["title", "url", "updateTime"];

function normalizeSelectorAlternative(value) {
  // Xiangse evaluates list scalar fields against a serialized list item. A
  // leading relative XPath therefore becomes context-dependent in the real
  // client; the documented portable form is an absolute descendant XPath.
  return String(value || "")
    .replace(new RegExp("(^|[^\\w.])\\.\\/+","g"), "$1//")
    .trim();
}

/**
 * Normalize one scalar rule used inside a book/chapter list item.
 *
 * Keep the postprocessor untouched. In particular, the double-pipe JS
 * delimiter must not be confused with XPath's single-pipe union operator.
 */
export function normalizeXiangseItemRule(rule) {
  if (rule && typeof rule === "object" && !Array.isArray(rule)) {
    const output = { ...rule };
    for (const field of ["selector", "fallback"]) {
      if (typeof output[field] === "string") {
        output[field] = normalizeXiangseItemRule(output[field]);
      }
    }
    if (output.templateFields && typeof output.templateFields === "object") {
      output.templateFields = Object.fromEntries(
        Object.entries(output.templateFields).map(([name, value]) => [
          name,
          normalizeXiangseItemRule(value),
        ]),
      );
    }
    return output;
  }
  if (typeof rule !== "string") return rule;
  const source = rule.trim();
  if (!source || /^@js:/i.test(source)) return rule;
  const postIndex = source.search(new RegExp("\\|\\|\\s*@js:", "i"));
  const selector = postIndex >= 0 ? source.slice(0, postIndex) : source;
  const postprocessor = postIndex >= 0 ? source.slice(postIndex) : "";
  const seen = new Set();
  const alternatives = selector
    .split(new RegExp("\\s*\\|\\|\\s*"))
    .map(normalizeSelectorAlternative)
    .filter((item) => item && !seen.has(item) && seen.add(item));
  if (!alternatives.length) return rule;
  return alternatives.join("||") + postprocessor;
}

function normalizeAction(action, fields) {
  if (!action || typeof action !== "object") return action;
  const output = { ...action };
  for (const field of fields) {
    if (typeof output[field] === "string" || (output[field] && typeof output[field] === "object")) {
      output[field] = normalizeXiangseItemRule(output[field]);
    }
  }
  return output;
}

/**
 * Normalize the fields whose XPath context is a Xiangse list item and repair
 * the unusable zero source weight emitted by old heuristic paths.
 */
export function normalizeXiangseSource(source) {
  if (!source || typeof source !== "object") return source;
  const output = structuredClone(source);
  output.bookWorld = Object.fromEntries(
    Object.entries(output.bookWorld || {}).map(([name, action]) => [
      name,
      normalizeAction(action, BOOK_ITEM_FIELDS),
    ]),
  );
  output.searchBook = normalizeAction(output.searchBook, BOOK_ITEM_FIELDS);
  output.chapterList = normalizeAction(output.chapterList, CHAPTER_ITEM_FIELDS);
  if (output.weight !== undefined && Number(output.weight) <= 0) output.weight = "100";
  return output;
}
