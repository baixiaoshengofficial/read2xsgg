import { absolute, loadDocument, visibleText } from "./domUtil.js";

const PAGE_PARAM_KEYS = [
  "page",
  "pageNum",
  "pageIndex",
  "p",
  "pn",
];

function nodeSignature(node) {
  if (!node) return "";
  const text = visibleText(node).slice(0, 120);
  const href = node.matches?.("a[href]")
    ? node.getAttribute("href")
    : node.querySelector?.("a[href]")?.getAttribute("href");
  return `${text}|${String(href || "").trim()}`;
}

function xpathElementSignatures(document, expression) {
  if (!document || !expression) return [];
  const view = document.defaultView;
  let best = [];
  for (const alternative of String(expression).split(/\s*\|\|\s*/).filter(Boolean)) {
    try {
      const result = document.evaluate(
        alternative,
        document,
        null,
        view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const values = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const signature = nodeSignature(result.snapshotItem(index));
        if (signature) values.push(signature);
      }
      if (values.length > best.length) best = values;
    } catch {
      // Try the next selector alternative.
    }
  }
  return best;
}

function signaturesDiffer(left, right) {
  if (!left.length || !right.length) return false;
  const leftSet = new Set(left.slice(0, 10));
  const rightSet = new Set(right.slice(0, 10));
  let overlap = 0;
  for (const value of rightSet) {
    if (leftSet.has(value)) overlap += 1;
  }
  return overlap < Math.min(leftSet.size, rightSet.size);
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function nextPageAnchors(document, baseUrl, origin) {
  return [...document.querySelectorAll("a[href]")].map((anchor, index) => {
    const href = absolute(anchor.getAttribute("href"), baseUrl);
    const text = visibleText(anchor);
    const rel = String(anchor.getAttribute("rel") || "");
    const className = String(anchor.getAttribute("class") || "");
    const aria = String(anchor.getAttribute("aria-label") || "");
    const label = `${text} ${rel} ${className} ${aria}`;
    return { href, text, label, index };
  }).filter((item) => item.href && sameOrigin(item.href, origin));
}

function scoreNextAnchor(item) {
  const label = String(item.label || "").trim();
  let score = 0;
  if (/\bnext\b/i.test(label)) score += 100;
  if (/(?:下一页|下一頁|下页|下頁|后一页|后一頁|后页|后頁|下1页|下1頁)/.test(label)) score += 100;
  if (/^(?:>|›|»|→)$/.test(String(item.text || "").trim())) score += 80;
  if (/\bprev(?:ious)?\b|上一页|上一頁|上页|上頁|前页|前頁/.test(label)) score -= 200;
  if (/末页|尾页|last/i.test(label)) score -= 80;
  return score;
}

function pageTemplateFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return "";
  }

  for (const key of PAGE_PARAM_KEYS) {
    const value = url.searchParams.get(key);
    if (/^\d+$/.test(String(value || "")) && Number(value) >= 2) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return url.toString().replace(new RegExp(`([?&]${escaped}=)\\d+`, "i"), "$1%@pageIndex");
    }
  }

  const path = url.pathname;
  const replacements = [
    [/\/page\/\d+(?=\/|$)/i, (match) => match.replace(/\d+$/, "%@pageIndex")],
    [/(\/list\/)\d+(?=\/|$)/i, "$1%@pageIndex"],
    [/([/_-])\d+(\.html?)$/i, "$1%@pageIndex$2"],
    [/\/\d+\/?$/i, "/%@pageIndex/"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(path)) continue;
    url.pathname = path.replace(pattern, replacement);
    return url.toString();
  }
  return "";
}

function pageTwoUrl(template) {
  return String(template || "").replace(/%@pageIndex/g, "2");
}

/**
 * Discover a generic page-number template from a "next page" link and verify
 * that page 2 still contains rows matching the same list selector.
 */
export async function discoverPagedListUrl(document, currentUrl, {
  origin = "",
  listSelector = "",
  download,
} = {}) {
  if (!document || !currentUrl || !origin || !listSelector || typeof download !== "function") return "";
  const page1Signatures = xpathElementSignatures(document, listSelector);
  const candidates = nextPageAnchors(document, currentUrl, origin)
    .map((item) => ({ ...item, score: scoreNextAnchor(item) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  for (const candidate of candidates) {
    const template = pageTemplateFromUrl(candidate.href);
    if (!template || !/%@pageIndex/.test(template)) continue;
    try {
      const html = (await download(pageTwoUrl(template))).toString("utf8");
      const page2 = loadDocument(html, pageTwoUrl(template));
      const page2Signatures = xpathElementSignatures(page2, listSelector);
      if (signaturesDiffer(page1Signatures, page2Signatures)) return template;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}
