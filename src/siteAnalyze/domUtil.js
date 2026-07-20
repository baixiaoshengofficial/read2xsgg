import { JSDOM } from "jsdom";

export function absolute(href, baseUrl) {
  try { return new URL(String(href || "").trim(), baseUrl).toString(); } catch { return ""; }
}

export function visibleText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

export function cssEscapeFallback(value) {
  return String(value).replace(/(["\\])/g, "\\$1");
}

export function classContainsXPath(className) {
  return `//*[contains(concat(' ', normalize-space(@class), ' '), ' ${className} ')]`;
}

export function xpathForElement(el, document) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) {
    const safeId = String(el.id).replace(/'/g, "");
    if (safeId && document.querySelectorAll(`[id="${cssEscapeFallback(safeId)}"]`).length === 1) {
      return `//*[@id='${safeId}']`;
    }
  }
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent || parent === document.documentElement) return `//${tag}`;
  const siblings = [...parent.children].filter((node) => node.tagName === el.tagName);
  if (siblings.length === 1) {
    const parentPath = xpathForElement(parent, document);
    return parentPath ? `${parentPath}/${tag}` : `//${tag}`;
  }
  const index = siblings.indexOf(el) + 1;
  const parentPath = xpathForElement(parent, document);
  return parentPath ? `${parentPath}/${tag}[${index}]` : `//${tag}[${index}]`;
}

export function scoreLinkCluster(links, baseUrl) {
  const samePathPrefix = new Map();
  for (const link of links) {
    let pathname = "";
    try { pathname = new URL(link.href, baseUrl).pathname; } catch { continue; }
    const parts = pathname.split("/").filter(Boolean);
    const key = parts[0] || "/";
    const bucket = samePathPrefix.get(key) || [];
    bucket.push(link);
    samePathPrefix.set(key, bucket);
  }
  let best = [];
  for (const bucket of samePathPrefix.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  return best;
}

export function listSelectorFromLinks(links, document) {
  if (!links.length) return "";

  // Prefer the deepest ancestor that still covers most of the link cluster
  // (e.g. ul.list), not the immediate li parent of a single anchor.
  const coverage = new Map();
  for (const link of links) {
    let node = link.parentElement;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 8) {
      const bucket = coverage.get(node) || { count: 0, depth };
      bucket.count += 1;
      coverage.set(node, bucket);
      node = node.parentElement;
      depth += 1;
    }
  }

  let bestParent = null;
  let bestScore = -1;
  for (const [parent, meta] of coverage) {
    const score = meta.count * 10 + meta.depth;
    if (meta.count >= 2 && score > bestScore) {
      bestParent = parent;
      bestScore = score;
    }
  }
  if (!bestParent) bestParent = links[0].parentElement?.parentElement || links[0].parentElement;
  if (!bestParent) return "//a";

  // Select item containers (li/div), or the anchors themselves when they are
  // direct children of the cluster root (e.g. div.chapter-list > a).
  const linkParent = links[0].parentElement;
  const itemPath = linkParent === bestParent
    ? String(links[0].tagName || "a").toLowerCase()
    : String(linkParent?.tagName || "*").toLowerCase();

  if (bestParent.id) return `//*[@id='${bestParent.id}']/${itemPath}`;
  const className = String(bestParent.className || "").trim().split(/\s+/).find(Boolean);
  if (className) return `${classContainsXPath(className)}/${itemPath}`;
  return `${xpathForElement(bestParent, document)}/${itemPath}`;
}

export function loadDocument(html, url) {
  return new JSDOM(String(html || ""), { url }).window.document;
}

export function pageAnchors(document, baseUrl, origin) {
  return [...document.querySelectorAll("a[href]")].map((a) => ({
    href: absolute(a.getAttribute("href"), baseUrl),
    text: visibleText(a),
    el: a,
  })).filter((item) => {
    if (!item.href || !item.text) return false;
    if (!origin) return true;
    try {
      return new URL(item.href).origin === origin;
    } catch {
      return false;
    }
  });
}
