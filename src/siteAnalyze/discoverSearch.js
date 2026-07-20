import { absolute } from "./domUtil.js";
import { sniffCharsetFromHtml, xiangseEncodeFields } from "../charset.js";

const SEARCH_INPUT_SELECTOR = [
  'input[type="search"]',
  'input[name="searchkey"]',
  'input[name="searchKey"]',
  'input[name="keyword"]',
  'input[name="keyWord"]',
  'input[name="key"]',
  'input[name="q"]',
  'input[name="wd"]',
  'input[name="search"]',
  'input[name="s"]',
  "#searchkey",
  "#keyword",
  "#keyWord",
  ".search-key",
  ".searchkey",
].join(", ");

const SEARCH_HINT = /search|搜索|找书|搜书|关键字|关键词/i;

function findSearchInput(form) {
  const direct = form.querySelector(SEARCH_INPUT_SELECTOR);
  if (direct) return direct;
  for (const el of form.querySelectorAll("input[type='text'], input:not([type]), input[type='search']")) {
    const blob = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.className || ""} ${el.getAttribute("placeholder") || ""}`;
    if (SEARCH_HINT.test(blob)) return el;
  }
  return null;
}

function inputName(input) {
  const name = String(input?.getAttribute?.("name") || "").trim();
  if (name) return name;
  const id = String(input?.id || "").trim();
  if (/searchkey|keyword|key|q|wd/i.test(id)) return id;
  return "searchkey";
}

function formScore(form, input) {
  let score = 0;
  const action = String(form.getAttribute("action") || "");
  const blob = `${action} ${form.className || ""} ${form.id || ""} ${inputName(input)} ${input?.getAttribute?.("placeholder") || ""}`;
  if (SEARCH_HINT.test(blob)) score += 50;
  if (/search\.php|search\.html|\/search/i.test(action)) score += 40;
  if (/searchkey|keyword/i.test(inputName(input))) score += 30;
  if (String(form.getAttribute("method") || "get").toLowerCase() === "post") score += 5;
  return score;
}

function hiddenParams(form, keywordName) {
  const params = {};
  for (const el of form.querySelectorAll("input[type='hidden'][name], select[name]")) {
    const name = String(el.getAttribute("name") || "").trim();
    if (!name || name === keywordName) continue;
    const value = el.tagName === "SELECT"
      ? String(el.value || el.querySelector("option[selected]")?.value || el.querySelector("option")?.value || "")
      : String(el.getAttribute("value") || "");
    if (value) params[name] = value;
  }
  return params;
}

function toXiangsePostRequest(actionUrl, keywordName, extras = {}) {
  const entries = {
    [keywordName]: "params.keyWord",
    ...Object.fromEntries(
      Object.entries(extras).map(([key, value]) => [key, JSON.stringify(value)]),
    ),
  };
  const hp = `{${Object.entries(entries).map(([key, expr]) => (
    expr === "params.keyWord"
      ? `${JSON.stringify(key)}: params.keyWord`
      : `${JSON.stringify(key)}: ${expr}`
  )).join(", ")}}`;
  return [
    "@js:",
    `let url = ${JSON.stringify(actionUrl)};`,
    `let hp = ${hp};`,
    "return {url:url, POST:true, httpParams:hp};",
  ].join("\n");
}

function toXiangseGetRequest(actionUrl, keywordName, extras = {}) {
  let url;
  try {
    url = new URL(actionUrl);
  } catch {
    return "";
  }
  url.searchParams.set(keywordName, "%@keyWord");
  for (const [key, value] of Object.entries(extras)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  // Keep %@keyWord unescaped for 香色 substitution.
  return url.toString().replace(/%25%40keyWord/gi, "%@keyWord").replace(/%40keyWord/gi, "%@keyWord");
}

function homeHasSearchHint(document) {
  const homeText = String(document.body?.textContent || "").slice(0, 4000);
  if (SEARCH_HINT.test(homeText)) return true;
  return [...document.querySelectorAll("a[href]")].some((a) => /search/i.test(a.getAttribute("href") || ""));
}

/**
 * Discover a usable search request from homepage forms / search widgets.
 * Returns Xiangse requestInfo (+ optional GBK encode fields).
 */
export function discoverSearchRequest(document, homeUrl, { html = "", headers = {} } = {}) {
  if (!document) return null;
  let origin;
  try {
    origin = new URL(homeUrl);
  } catch {
    return null;
  }

  const candidates = [];
  for (const form of document.querySelectorAll("form")) {
    const input = findSearchInput(form);
    if (!input) continue;
    const keywordName = inputName(input);
    const actionRaw = String(form.getAttribute("action") || "").trim() || homeUrl;
    const actionUrl = absolute(actionRaw, homeUrl) || `${origin.protocol}//${origin.host}/`;
    const method = String(form.getAttribute("method") || "get").trim().toLowerCase() === "post"
      ? "post"
      : "get";
    const extras = hiddenParams(form, keywordName);
    const score = formScore(form, input);
    let relativeAction = actionUrl;
    try {
      const parsed = new URL(actionUrl);
      if (parsed.origin === origin.origin) {
        relativeAction = `${parsed.pathname}${parsed.search}` || "/";
      }
    } catch {
      // keep absolute
    }
    candidates.push({
      score,
      method,
      keywordName,
      actionUrl,
      relativeAction,
      extras,
      requestInfo: method === "post"
        ? toXiangsePostRequest(relativeAction, keywordName, extras)
        : toXiangseGetRequest(actionUrl, keywordName, extras),
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates.find((item) => item.requestInfo);
  const encode = xiangseEncodeFields(sniffCharsetFromHtml(html || document.documentElement?.outerHTML || "", headers));
  if (!best) {
    if (!homeHasSearchHint(document)) return null;
    return {
      requestInfo: "/modules/article/search.php?searchkey=%@keyWord",
      method: "get",
      keywordName: "searchkey",
      ...encode,
    };
  }

  return {
    requestInfo: best.requestInfo,
    method: best.method,
    keywordName: best.keywordName,
    actionUrl: best.actionUrl,
    ...encode,
  };
}
