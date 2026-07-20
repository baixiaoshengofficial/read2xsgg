/**
 * Guess whether a site offers text / comic / audio / video from HTML signals.
 * Returns every kind that clears its threshold (mixed sites may have several).
 */

function scoreKinds(html, baseUrl = "") {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const imgCount = (lower.match(/<img\b/g) || []).length;
  const linkCount = (lower.match(/<a\b/g) || []).length;
  const audioHits = (lower.match(/<audio\b|\.mp3\b|\.m4a\b|audio\/mpeg|听书|有声|电台/g) || []).length;
  const videoHits = (lower.match(/<video\b|\.m3u8\b|\.mp4\b|application\/x-mpegurl|影视|播放器|电影|剧集/g) || []).length;
  const comicHits = (lower.match(/漫画|comic|manga|manhua|章节图片|阅读漫画/g) || []).length;
  const novelHits = (lower.match(/小说|章节|目录|作者|最新章节|全文|正文|book|novel|chapter/g) || []).length;
  const imgRatio = linkCount > 0 ? imgCount / linkCount : imgCount;

  const kinds = [];
  if (videoHits >= 2) {
    kinds.push({ kind: "video", confidence: Math.min(0.9, 0.35 + videoHits * 0.05), score: videoHits });
  }
  if (audioHits >= 2) {
    kinds.push({ kind: "audio", confidence: Math.min(0.9, 0.35 + audioHits * 0.05), score: audioHits });
  }
  if (comicHits >= 2 || (imgRatio > 1.2 && imgCount >= 20 && novelHits < comicHits + 5)) {
    kinds.push({
      kind: "comic",
      confidence: Math.min(0.85, 0.35 + comicHits * 0.08 + Math.min(imgRatio, 3) * 0.05),
      score: comicHits + imgCount * 0.01,
    });
  }
  if (novelHits >= 2 || /\/(?:book|novel|info|chapter|read)\b/i.test(baseUrl) || linkCount >= 10) {
    const confidence = novelHits >= 2
      ? Math.min(0.9, 0.4 + novelHits * 0.04)
      : /\/(?:book|novel|info|chapter|read)\b/i.test(baseUrl)
        ? 0.45
        : 0.35;
    kinds.push({ kind: "text", confidence, score: novelHits + (linkCount >= 10 ? 1 : 0) });
  }

  kinds.sort((a, b) => b.confidence - a.confidence || b.score - a.score);
  return { kinds, linkCount, imgCount };
}

/**
 * All kinds that look present on the page (may be empty → unknown).
 */
export function detectKinds(html, baseUrl = "") {
  const { kinds } = scoreKinds(html, baseUrl);
  if (kinds.length) return kinds.map(({ kind, confidence }) => ({ kind, confidence }));
  return [{ kind: "unknown", confidence: 0.1 }];
}

/**
 * Primary kind (highest confidence). Kept for callers that expect a single winner.
 */
export function detectKind(html, baseUrl = "") {
  const kinds = detectKinds(html, baseUrl);
  return kinds[0] || { kind: "unknown", confidence: 0.1 };
}
