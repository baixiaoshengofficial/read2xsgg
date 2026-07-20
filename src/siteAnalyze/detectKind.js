/**
 * Guess whether a site is primarily text / comic / audio / video from HTML signals.
 * MVP: only `text` is considered analyzable for full rule discovery.
 */
export function detectKind(html, baseUrl = "") {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const text = source.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const imgCount = (lower.match(/<img\b/g) || []).length;
  const linkCount = (lower.match(/<a\b/g) || []).length;
  const audioHits = (lower.match(/<audio\b|\.mp3\b|\.m4a\b|audio\/mpeg|听书|有声/g) || []).length;
  const videoHits = (lower.match(/<video\b|\.m3u8\b|\.mp4\b|application\/x-mpegurl|影视|播放器/g) || []).length;
  const comicHits = (lower.match(/漫画|comic|manga|章节图片|阅读漫画/g) || []).length;
  const novelHits = (lower.match(/小说|章节|目录|作者|最新章节|全文|正文|book|novel|chapter/g) || []).length;

  const imgRatio = linkCount > 0 ? imgCount / linkCount : imgCount;
  if (videoHits >= 3 && videoHits >= audioHits && videoHits >= comicHits) {
    return { kind: "video", confidence: Math.min(0.9, 0.4 + videoHits * 0.05) };
  }
  if (audioHits >= 3 && audioHits >= comicHits) {
    return { kind: "audio", confidence: Math.min(0.9, 0.4 + audioHits * 0.05) };
  }
  if (comicHits >= 2 || (imgRatio > 1.2 && imgCount >= 20 && novelHits < comicHits + 5)) {
    return { kind: "comic", confidence: Math.min(0.85, 0.35 + comicHits * 0.08 + Math.min(imgRatio, 3) * 0.05) };
  }
  if (novelHits >= 2 || /\/(?:book|novel|info|chapter|read)\b/i.test(baseUrl)) {
    return { kind: "text", confidence: Math.min(0.9, 0.4 + novelHits * 0.04) };
  }
  // Default to text for generic catalog-looking pages so novel discovery can try.
  if (linkCount >= 10) return { kind: "text", confidence: 0.35 };
  return { kind: "unknown", confidence: 0.1 };
}
