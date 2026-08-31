import { JSDOM } from "jsdom";

export function absolute(href, baseUrl) {
  try { return new URL(String(href || "").trim(), baseUrl).toString(); } catch { return ""; }
}

export function visibleText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

export function bookNameSelector() {
  return [
    "normalize-space((.//*[self::h1 or self::h2 or self::h3 or self::h4",
    " or contains(concat(' ', normalize-space(@class), ' '), ' title ')",
    " or contains(concat(' ', normalize-space(@class), ' '), ' book-title ')",
    " or contains(concat(' ', normalize-space(@class), ' '), ' cardtitle ')])[1])",
    "||normalize-space(self::a/@title)",
    "||normalize-space((.//a[@title])[1]/@title)",
    "||normalize-space((self::a/text()[normalize-space()])[last()])",
    "||normalize-space(((.//a)[1]/text()[normalize-space()])[last()])",
    "||normalize-space((.//a)[1])",
    "||normalize-space(.)",
    "||normalize-space(/html/body/*)",
  ].join("");
}

export function linkHasNearbyCover(link) {
  let node = link?.el?.parentElement;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    for (const image of node.querySelectorAll?.("img[src],img[data-src],img[data-original],source[srcset]") || []) {
      const anchor = image.closest?.("a[href]");
      if (!anchor) continue;
      try {
        const coverTarget = new URL(anchor.getAttribute("href"), link.href);
        const textTarget = new URL(link.href);
        if (coverTarget.origin === textTarget.origin
          && coverTarget.pathname.replace(/\/$/, "") === textTarget.pathname.replace(/\/$/, "")) return true;
      } catch {
        // Continue with other nearby cover anchors.
      }
    }
  }
  return false;
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
    const first = parts[0] || "";
    const extension = first.match(/(\.[A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() || "";
    const dynamicFirst = /^\d+$|\d{3,}|^[a-f0-9]{8,}(?:\.[A-Za-z0-9]+)?$/i.test(first);
    const key = parts.length <= 1 && extension
      ? `/:file${extension}`
      : (dynamicFirst ? "/:id" : (first || "/"));
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
    // Coverage is primary; for equal coverage prefer the closest common
    // ancestor. A positive depth weight selected broad page containers and
    // produced paths such as `main/li` even when the links lived in a nested ul.
    const score = meta.count * 100 - meta.depth;
    if (meta.count >= 2 && score > bestScore) {
      bestParent = parent;
      bestScore = score;
    }
  }
  if (!bestParent) bestParent = links[0].parentElement?.parentElement || links[0].parentElement;
  if (!bestParent) return "//a";

  // Select item containers (li/div), or the anchors themselves when they are
  // direct children of the cluster root (e.g. div.chapter-list > a).
  const parentCounts = new Map();
  for (const link of links) {
    const tag = String(link.parentElement?.tagName || "").toLowerCase();
    if (tag) parentCounts.set(tag, (parentCounts.get(tag) || 0) + 1);
  }
  const modalParentTag = [...parentCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const representative = links.find((link) => (
    String(link.parentElement?.tagName || "").toLowerCase() === modalParentTag
  )) || links[0];
  const linkParent = representative.parentElement;
  const itemPath = linkParent === bestParent
    ? String(representative.tagName || "a").toLowerCase()
    : String(linkParent?.tagName || "*").toLowerCase();
  const axis = linkParent === bestParent || linkParent?.parentElement === bestParent ? "/" : "//";

  if (bestParent.id) return `//*[@id='${bestParent.id}']${axis}${itemPath}`;
  const className = String(bestParent.className || "").trim().split(/\s+/).find(Boolean);
  if (className) return `${classContainsXPath(className)}${axis}${itemPath}`;
  return `${xpathForElement(bestParent, document)}${axis}${itemPath}`;
}

function xpathString(value) {
  const source = String(value || "");
  if (!source.includes("'")) return `'${source}'`;
  if (!source.includes('"')) return `"${source}"`;
  return `concat(${source.split("'").map((part, index) => (
    `${index ? `"'",` : ""}'${part}'`
  )).join(",")})`;
}

/**
 * Build an anchor selector from the common URL path of an observed link group.
 * Path identities survive rotating CSS classes and mobile/desktop templates.
 */
export function stableAnchorSelectorFromLinks(links, document, baseUrl) {
  const rawHrefs = [];
  const paths = (links || []).flatMap((link) => {
    const raw = String(link?.getAttribute?.("href") || "").trim();
    if (!raw || /^(?:javascript:|#)/i.test(raw)) return [];
    try {
      rawHrefs.push(raw);
      return [new URL(raw, baseUrl).pathname.split("/").filter(Boolean)];
    } catch {
      return [];
    }
  });
  const uniquePaths = new Set(paths.map((parts) => `/${parts.join("/")}`));
  if (uniquePaths.size < 2) return "";
  const common = [];
  const shortest = Math.min(...paths.map((parts) => parts.length));
  for (let index = 0; index < shortest; index += 1) {
    const value = paths[0][index];
    if (!value || !paths.every((parts) => parts[index] === value)) break;
    common.push(value);
  }
  if (!common.length) {
    const dynamicRootTail = paths.length >= 2
      && paths[0].length >= 2
      && paths.every((parts) => (
        parts.length === paths[0].length
        && /^\d+$/.test(parts[0])
        && parts.slice(1).join("/") === paths[0].slice(1).join("/")
      ));
    if (dynamicRootTail) {
      const suffix = `/${paths[0].slice(1).join("/")}`;
      let originPrefix = "";
      try { originPrefix = `${new URL(baseUrl).origin}/`; } catch { /* Relative links remain usable. */ }
      const relativeId = "substring-before(substring-after(@href, '/'), '/')";
      const absoluteId = originPrefix
        ? `substring-before(substring-after(@href, ${xpathString(originPrefix)}), '/')`
        : "''";
      const selector = [
        "//a[@href and normalize-space(.) != ''",
        ` and contains(substring-before(concat(@href, '?'), '?'), ${xpathString(suffix)})`,
        " and ((starts-with(@href, '/')",
        ` and ${relativeId} != '' and translate(${relativeId}, '0123456789', '') = '')`,
        originPrefix
          ? ` or (starts-with(@href, ${xpathString(originPrefix)}) and ${absoluteId} != '' and translate(${absoluteId}, '0123456789', '') = '')`
          : "",
        ")]",
      ].join("");
      try {
        const view = document.defaultView;
        const result = document.evaluate(
          selector,
          document,
          null,
          view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        if (result.snapshotLength >= Math.min(2, paths.length)) return selector;
      } catch {
        // Continue with other dynamic-root shapes.
      }
    }
    const numericRoot = paths.length >= 2 && paths.every((parts) => (
      parts.length === 1 && /^\d+$/.test(parts[0])
    ));
    if (!numericRoot) return "";
    const selector = [
      "//a[normalize-space(.) != ''",
      " and translate(@href, '/0123456789', '') = ''",
      " and not(contains(normalize-space(.), '作者'))",
      " and not(contains(normalize-space(.), '更新'))",
      " and not(contains(normalize-space(.), '字数'))",
      "]",
    ].join("");
    try {
      const view = document.defaultView;
      const result = document.evaluate(
        selector,
        document,
        null,
        view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return result.snapshotLength >= Math.min(2, paths.length) ? selector : "";
    } catch {
      return "";
    }
  }
  if (/^\d+$|\d{4,}|^[a-f0-9]{8,}$/i.test(common[0])) return "";
  // IDs/slugs after the first segment belong to the sampled book. Baking them
  // into chapterList would make every other book's catalogue parse as empty.
  const prefixSegments = [common[0]];
  if (/\.(?:php|aspx?)$/i.test(common[0])
    && common[1]
    && /^[A-Za-z][\w-]{1,40}$/.test(common[1])) {
    prefixSegments.push(common[1]);
  }
  const prefix = `/${prefixSegments.join("/")}/`;
  const extensions = paths.map((parts) => parts.at(-1)?.match(/(\.(?:html?|php|aspx?))$/i)?.[1]?.toLowerCase() || "");
  const extension = extensions[0] && extensions.every((value) => value === extensions[0])
    ? extensions[0]
    : "";
  const trailingSlash = rawHrefs.length === paths.length
    && rawHrefs.every((value) => value.split(/[?#]/, 1)[0].endsWith("/"));
  const slashCounts = rawHrefs.map((value) => (
    (value.split(/[?#]/, 1)[0].match(/\//g) || []).length
  ));
  const slashCount = slashCounts.length && slashCounts.every((value) => value === slashCounts[0])
    ? slashCounts[0]
    : null;
  const selector = [
    `//a[contains(@href, ${xpathString(prefix)})`,
    extension ? ` and contains(@href, ${xpathString(extension)})` : "",
    trailingSlash ? " and substring(@href, string-length(@href), 1) = '/'" : "",
    Number.isFinite(slashCount)
      ? ` and ((string-length(@href) - string-length(translate(@href, '/', '')) = ${slashCount})`
        + ` or ((starts-with(@href, 'http://') or starts-with(@href, 'https://') or starts-with(@href, '//'))`
        + ` and string-length(@href) - string-length(translate(@href, '/', '')) = ${slashCount + 2}))`
      : "",
    " and normalize-space(.) != ''",
    "]",
  ].join("");
  try {
    const view = document.defaultView;
    const result = document.evaluate(
      selector,
      document,
      null,
      view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return result.snapshotLength >= Math.min(2, paths.length) ? selector : "";
  } catch {
    return "";
  }
}

/** Cross-book chapter selector used when URL prefixes contain a sampled book id. */
export function chapterAnchorSelectorFromLinks(links, document, baseUrl) {
  const stable = stableAnchorSelectorFromLinks(links, document, baseUrl);
  if (stable) {
    try {
      const view = document.defaultView;
      const result = document.evaluate(
        stable,
        document,
        null,
        view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      let semantic = 0;
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const anchor = result.snapshotItem(index);
        const text = visibleText(anchor);
        const href = String(anchor?.getAttribute?.("href") || "");
        if (/(?:第.{0,24}[章節节回話话集卷]|序章|楔子)/i.test(text)
          || /\/(?:chapter|chapters|read|episode|episodes)\//i.test(href)) semantic += 1;
      }
      if (result.snapshotLength && semantic >= Math.ceil(result.snapshotLength * 0.8)) {
        return stable.replace(/\]$/, [
          " and ((contains(normalize-space(.), '第') and (contains(normalize-space(.), '章')",
          " or contains(normalize-space(.), '節') or contains(normalize-space(.), '节')",
          " or contains(normalize-space(.), '回') or contains(normalize-space(.), '話')",
          " or contains(normalize-space(.), '话') or contains(normalize-space(.), '集')",
          " or contains(normalize-space(.), '卷'))) or starts-with(normalize-space(.), '序章')",
          " or starts-with(normalize-space(.), '楔子')",
          " or contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/chapter')",
          " or contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/read/'))",
          " and not(normalize-space(.) = '開始閱讀') and not(normalize-space(.) = '开始阅读')",
          " and not(normalize-space(.) = '立即閱讀') and not(normalize-space(.) = '立即阅读')",
          " and not(normalize-space(.) = '點擊閱讀') and not(normalize-space(.) = '点击阅读')]",
        ].join(""));
      }
    } catch {
      // Fall through to the chapter-semantic selector.
    }
  }
  const selector = [
    "//a[@href and normalize-space(@href) != ''",
    " and not(starts-with(normalize-space(@href), '#'))",
    " and not(starts-with(translate(normalize-space(@href), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'javascript:'))",
    " and normalize-space(.) != '' and (",
    "(contains(normalize-space(.), '第') and (contains(normalize-space(.), '章')",
    " or contains(normalize-space(.), '節') or contains(normalize-space(.), '节')",
    " or contains(normalize-space(.), '回') or contains(normalize-space(.), '話')",
    " or contains(normalize-space(.), '话') or contains(normalize-space(.), '集')",
    " or contains(normalize-space(.), '卷'))) or starts-with(normalize-space(.), '序章')",
    " or starts-with(normalize-space(.), '楔子')",
    " or contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/chapter')",
    " or contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '/read/')",
    ") and not(starts-with(normalize-space(.), '返回'))",
    " and not(starts-with(normalize-space(.), '回到'))",
    " and not(starts-with(normalize-space(.), '回顶部'))",
    " and not(normalize-space(.) = '開始閱讀') and not(normalize-space(.) = '开始阅读')",
    " and not(normalize-space(.) = '立即閱讀') and not(normalize-space(.) = '立即阅读')",
    " and not(normalize-space(.) = '點擊閱讀') and not(normalize-space(.) = '点击阅读')]",
  ].join("");
  try {
    const view = document.defaultView;
    const result = document.evaluate(
      selector,
      document,
      null,
      view.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return result.snapshotLength >= 2 ? selector : "";
  } catch {
    return "";
  }
}

export function loadDocument(html, url) {
  // Raw HTML remains available to type/media detectors. Selector inference
  // only needs rendered markup, so omit large inline bundles before JSDOM.
  const source = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, (tag) => (
      /\btype\s*=\s*["']application\/(?:ld\+)?json(?:\s*;[^"']*)?["']/i.test(tag) ? tag : ""
    ))
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, "");
  return new JSDOM(source, { url }).window.document;
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
