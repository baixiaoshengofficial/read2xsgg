/**
 * Content-kind inference shared by the Legado converter.
 *
 * Legado's numeric type is not stable across older source collections.  The
 * converter therefore treats 0 and 3 as ambiguous and infers the portable
 * Xiangse kind from the source's declared capabilities.  This module contains
 * that policy in one place so conversion and future entry-point discovery do
 * not grow source-name or domain branches.
 */

export const SOURCE_KINDS = Object.freeze(["text", "comic", "audio", "video"]);

const EXPLICIT_TYPES = new Map([
  [1, "audio"],
  [2, "comic"],
  [4, "video"],
]);

const KIND_PRIORITY = ["video", "audio", "comic", "text"];

function numericType(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function collectText(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => collectText(item, depth + 1)).join("\n");
  if (typeof value !== "object") return "";
  return Object.entries(value)
    .slice(0, 160)
    .map(([key, item]) => `${key}:${collectText(item, depth + 1)}`)
    .join("\n");
}

function countMatches(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function addSignal(scores, evidence, kind, amount, label) {
  scores[kind] += amount;
  if (label && !evidence[kind].includes(label)) evidence[kind].push(label);
}

function sourceParts(source) {
  const contentRules = source?.ruleContent ?? source?.contentRule ?? {};
  const tocRules = source?.ruleToc ?? source?.tocRule ?? {};
  const searchRules = source?.ruleSearch ?? source?.searchRule ?? {};
  const exploreRules = source?.ruleExplore ?? source?.exploreRule ?? {};
  const metadata = [
    source?.bookSourceName,
    source?.sourceName,
    source?.bookSourceGroup,
    source?.bookSourceComment,
  ].filter(Boolean).join("\n");
  const contentRule = String(contentRules?.content ?? "");
  const chapterUrlRule = String(tocRules?.chapterUrl ?? "");
  const sourceRegex = String(contentRules?.sourceRegex ?? "");
  const executableContent = !/^\s*(?:@js:|<js>)/i.test(contentRule);
  const imagePageRule = executableContent
    && (/(?:^|[\s>])img(?:\s|@|$)/i.test(contentRule)
      || /(?:^|[.$/])(?:images|pages|chapterImages|chapter_images)(?:\[\*?\]|\/|\.)/i.test(contentRule));
  const directMediaRules = [contentRule, chapterUrlRule, sourceRegex]
    .filter((rule, index) => index !== 0 || executableContent)
    .join("\n");
  return {
    type: numericType(source?.bookSourceType),
    metadata,
    // Cover rules commonly mention img/src even for text sources.  Restrict
    // capability signals to chapter/toc rules to avoid classifying a novel by
    // its list thumbnail.
    content: collectText(contentRules),
    toc: collectText(tocRules),
    media: collectText({
      content: contentRules,
      toc: tocRules,
      sourceRegex: contentRules?.sourceRegex,
    }),
    catalogue: collectText({ search: searchRules, explore: exploreRules }),
    contentRule,
    chapterUrlRule,
    sourceRegex,
    directMediaRules,
    imagePageRule,
    imageDecoder: Boolean(String(contentRules?.imageDecode ?? "").trim()),
  };
}

function mediaScore(parts) {
  const scores = { text: 0, comic: 0, audio: 0, video: 0 };
  const evidence = { text: [], comic: [], audio: [], video: [] };
  const metadata = parts.metadata;
  const media = `${parts.directMediaRules}\n${parts.chapterUrlRule}`;

  if (/(?:影视|视频|电影|电视剧|直播|播放器|剧集|vod|video|watch|playback)/i.test(metadata)) {
    addSignal(scores, evidence, "video", 6, "元数据含影视/视频语义");
  }
  if (/(?:有声|音频|音乐|听书|广播剧|播客|audio|podcast|sound|track)/i.test(metadata)) {
    addSignal(scores, evidence, "audio", 6, "元数据含音频语义");
  }
  if (/(?:漫画|动漫|图集|写真|comic|manga|manhua)/i.test(metadata)) {
    addSignal(scores, evidence, "comic", 6, "元数据含图片内容语义");
  }

  const videoUrls = countMatches(media, /\.(?:m3u8|mp4|m4v|webm|flv|mpd)(?:[?#\s'"<>]|$)/gi);
  if (videoUrls) addSignal(scores, evidence, "video", Math.min(12, videoUrls * 4), "章节规则含影视媒体地址");
  if (!videoUrls && /(?:m3u8|mp4|m4v|webm|flv|mpd)/i.test(media)) {
    addSignal(scores, evidence, "video", 4, "媒体规则含影视扩展名提示");
  }
  if (/(?:<video\b|application\/x-mpegurl|dash(?:\.js)?|play_from|vodplayinfo)/i.test(media)) {
    addSignal(scores, evidence, "video", 5, "章节规则含视频播放器/流媒体字段");
  }

  const audioUrls = countMatches(media, /\.(?:mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#\s'"<>]|$)/gi);
  if (audioUrls) addSignal(scores, evidence, "audio", Math.min(12, audioUrls * 4), "章节规则含音频媒体地址");
  if (!audioUrls && /(?:mp3|m4a|aac|ogg|opus|wav|flac)/i.test(media)) {
    addSignal(scores, evidence, "audio", 4, "媒体规则含音频扩展名提示");
  }
  if (/(?:<audio\b|audio\/mpeg|audioUrl|audio_url|playUrl|play_url|streamUrl|stream_url)/i.test(media)) {
    addSignal(scores, evidence, "audio", 5, "章节规则含音频字段");
  }

  if (parts.imageDecoder) {
    addSignal(scores, evidence, "comic", 8, "正文规则声明图片解码器");
  } else if (parts.imagePageRule) {
    addSignal(scores, evidence, "comic", 5, "正文规则直接选择图片页");
  }
  if (/(?:chapterImages|chapter_images|images\s*\[\s*\*?\s*\]|pages\s*\[\s*\*?\s*\]|图片章节)/i.test(
    `${parts.contentRule}\n${parts.chapterUrlRule}`,
  )) {
    addSignal(scores, evidence, "comic", 4, "正文/章节规则声明连续图片集合");
  }

  // A source may use a legacy 0/3 type while exposing only a media extension
  // in a URL template.  Keep this last fallback conservative: a single image
  // cover field in search/catalogue rules must not turn a text source into a
  // comic source.
  if (!scores.comic && parts.imagePageRule && /imageStyle/i.test(parts.media)) {
    addSignal(scores, evidence, "comic", 4, "图片页正文规则声明图片样式");
  }

  return { scores, evidence };
}

/**
 * Infer the Xiangse kind and retain machine-readable evidence for diagnostics.
 * The public converter only needs `.kind`; callers that surface compatibility
 * reports can use the remaining fields without reimplementing the policy.
 */
export function inferSourceKind(source) {
  const parts = sourceParts(source);
  const explicit = EXPLICIT_TYPES.get(parts.type);
  if (explicit) {
    return {
      kind: explicit,
      confidence: 1,
      explicit: true,
      evidence: [`bookSourceType=${parts.type}`],
    };
  }

  const { scores, evidence } = mediaScore(parts);
  let winner = "text";
  for (const kind of KIND_PRIORITY) {
    if (scores[kind] > scores[winner]) winner = kind;
  }
  // Legacy file sources (3) are still text unless their rules actually expose
  // a stronger media capability.  An ambiguous source with no capability
  // evidence remains text, which is the safest Xiangse fallback.
  if (winner !== "text" && scores[winner] < 4) winner = "text";
  const score = scores[winner];
  return {
    kind: winner,
    confidence: winner === "text" ? 0.5 : Math.min(0.98, 0.45 + score * 0.05),
    explicit: false,
    evidence: evidence[winner],
    scores,
  };
}
