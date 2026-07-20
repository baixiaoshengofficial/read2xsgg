/**
 * Shared cover heuristics for site discovery (list item + detail page).
 */

const LIST_COVER = ".//img/@data-original||.//img/@data-src||.//img/@src";

const DETAIL_COVER_FALLBACK = [
  "//meta[@property='og:image']/@content",
  "//meta[@name='og:image']/@content",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' imgbox ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-original",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' bookimg ')]//img/@src",
  "//*[@id='fmimg']//img/@src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]/@src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@data-original",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@data-src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@src",
].join("||");

function imgUrl(el) {
  if (!el) return "";
  return String(
    el.getAttribute("data-original")
    || el.getAttribute("data-src")
    || el.getAttribute("src")
    || "",
  ).trim();
}

function listItemContainer(link) {
  if (!link?.closest) return link?.parentElement || null;
  return link.closest("li, article, [class*='item'], [class*='book'], [class*='card']")
    || link.parentElement;
}

function usableCoverUrl(url) {
  const value = String(url || "").trim();
  if (!value || /^data:/i.test(value)) return false;
  return !/nopic|nocover|placeholder|avatar|icon|logo|default\.?(?:gif|png|jpg)/i.test(value);
}

/**
 * When enough list items contain an image, return a relative cover XPath.
 */
export function listCoverSelectorFromLinks(links) {
  const sample = (links || []).filter(Boolean).slice(0, 24);
  if (sample.length < 2) return "";
  let withImg = 0;
  for (const link of sample) {
    const item = listItemContainer(link);
    if (!item) continue;
    const imgs = item.querySelectorAll?.("img") || [];
    for (const img of imgs) {
      if (usableCoverUrl(imgUrl(img))) {
        withImg += 1;
        break;
      }
    }
  }
  const need = Math.max(2, Math.ceil(sample.length * 0.35));
  return withImg >= need ? LIST_COVER : "";
}

/**
 * Prefer og:image / common cover containers on a book detail page.
 */
export function detailCoverSelector(document) {
  if (!document) return "";
  const og = document.querySelector?.('meta[property="og:image"], meta[name="og:image"]');
  if (usableCoverUrl(og?.getAttribute("content"))) return DETAIL_COVER_FALLBACK;

  const cssCandidates = [
    ".imgbox img",
    ".cover img",
    ".bookimg img",
    "#fmimg img",
    "img.cover",
    "img.lazy",
    ".BGsectionOne-top-left img",
    ".book-cover img",
    ".novel-cover img",
  ];
  for (const selector of cssCandidates) {
    try {
      const img = document.querySelector(selector);
      if (img && usableCoverUrl(imgUrl(img))) return DETAIL_COVER_FALLBACK;
    } catch {
      // ignore invalid selectors in odd documents
    }
  }

  const h1 = document.querySelector("h1, h2");
  const root = h1?.parentElement || document.body;
  if (root) {
    for (const img of root.querySelectorAll("img")) {
      if (usableCoverUrl(imgUrl(img))) return DETAIL_COVER_FALLBACK;
    }
  }
  return "";
}

export { LIST_COVER, DETAIL_COVER_FALLBACK };
