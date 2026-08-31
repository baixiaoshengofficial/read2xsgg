/**
 * Shared cover heuristics for site discovery (list item + detail page).
 */

const COVER_ATTRIBUTES = [
  "data-original",
  "data-src",
  "data-lazy-src",
  "data-lazy",
  "data-echo",
  "data-url",
  "data-cover",
  "data-poster",
  "poster",
  "src",
  "srcset",
];

const LIST_COVER = COVER_ATTRIBUTES
  .map((attribute) => `.//img/@${attribute}`)
  .concat(COVER_ATTRIBUTES.map((attribute) => `.//source/@${attribute}`))
  .join("||");

const DETAIL_COVER_META = [
  "//meta[@property='og:image']/@content",
  "//meta[@name='og:image']/@content",
  "//meta[@name='twitter:image']/@content",
  "//meta[@property='twitter:image']/@content",
];

const DETAIL_COVER_IMAGES = [
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' imgbox ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-original",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-lazy-src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@data-url",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' bookimg ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' book-img ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' book-cover ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' novel-cover ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' pic ')]//img/@src",
  "//*[contains(concat(' ', normalize-space(@class), ' '), ' poster ')]//img/@src",
  "//*[@id='fmimg']//img/@src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' cover ')]/@src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@data-original",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@data-src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@data-lazy-src",
  "//img[contains(concat(' ', normalize-space(@class), ' '), ' lazy ')]/@src",
  "//video/@poster",
];

const DETAIL_COVER_IMAGE_FALLBACK = DETAIL_COVER_IMAGES.join("||");
const DETAIL_COVER_FALLBACK = DETAIL_COVER_META.concat(DETAIL_COVER_IMAGES).join("||");

function imgUrl(el) {
  if (!el) return "";
  for (const attribute of COVER_ATTRIBUTES) {
    const value = String(el.getAttribute(attribute) || "").trim();
    if (!value) continue;
    if (attribute === "srcset") return value.split(",")[0]?.trim().split(/\s+/)[0] || "";
    return value;
  }
  return "";
}

function listItemContainer(link) {
  if (!link?.closest) return link?.parentElement || null;
  return link.closest("li, article, [class*='item'], [class*='book'], [class*='card']")
    || link.parentElement;
}

export function usableCoverUrl(url) {
  const value = String(url || "").trim();
  if (!value || /^data:/i.test(value)) return false;
  let pathname = value.split(/[?#]/, 1)[0];
  try {
    pathname = new URL(value, "https://cover.invalid/").pathname;
  } catch {
    // Keep the path-like value for malformed but still extractable URLs.
  }
  const filename = pathname.split("/").pop() || "";
  return !/(?:^|[_-])(?:logo\d*|icon\d*|avatar|default|loading|placeholder|qrcode|qr-code|play(?:er)?|no[_-]?(?:pic|img|cover))(?:[_\-.]|$)/i.test(filename);
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
  const og = document.querySelector?.('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]');
  if (usableCoverUrl(og?.getAttribute("content"))) return DETAIL_COVER_FALLBACK;

  const cssCandidates = [
    ".imgbox img",
    ".cover img",
    ".bookimg img",
    ".book-img img",
    "#fmimg img",
    "img.cover",
    "img.lazy",
    ".BGsectionOne-top-left img",
    ".book-cover img",
    ".novel-cover img",
    ".poster img",
    ".pic img",
    "video[poster]",
  ];
  for (const selector of cssCandidates) {
    try {
      const img = document.querySelector(selector);
      if (img && usableCoverUrl(imgUrl(img))) return DETAIL_COVER_IMAGE_FALLBACK;
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

export { LIST_COVER, DETAIL_COVER_FALLBACK, DETAIL_COVER_IMAGE_FALLBACK };
