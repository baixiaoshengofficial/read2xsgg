/**
 * Content-kind inference shared by the Legado converter.
 *
 * Legado type values are combined with declared capabilities because older
 * collections often reuse ambiguous numeric values. Keep this policy here so
 * conversion and discovery share it.
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

function hasMeaningfulRuleField(text, field) {
  const pattern = new RegExp(`(?:^|\\n)${field}[ \\t]*:[ \\t]*([^\\n]*)`, "gi");
  return [...String(text).matchAll(pattern)].some((match) => {
    const value = String(match[1] || "").trim();
    return value && !/^(?:0|false|null|undefined|["']{2}|\\{\\})$/i.test(value);
  });
}

function hasMixedMediaAndTextOutput(content) {
  const rule = String(content || "");
  const hasMediaOutput = /\b(?:audioUrl|audio_url|playUrl|play_url|streamUrl|stream_url|m4aUrl|mp3Url|videoUrl|video_url)\b/i.test(rule);
  const hasTextOutput = /\b(?:chapterBody|content|text|body|htmlContent)\b/i.test(rule);
  const hasConditionalOutput = /\|\||\bif\s*\(|\?[^:]{1,256}:/i.test(rule);
  return hasMediaOutput && hasTextOutput && hasConditionalOutput;
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
  return {
    type: numericType(source?.bookSourceType),
    declaredKind: String(source?.sourceType || "").trim().toLowerCase(),
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
  };
}

function mediaScore(parts) {
  const scores = { text: 0, comic: 0, audio: 0, video: 0 };
  const evidence = { text: [], comic: [], audio: [], video: [] };
  const metadata = parts.metadata;
  const media = `${parts.media}\n${parts.toc}`;

  if (/(?:影视|视频|电影|电视剧|直播|播放器|剧集|vod|video|watch|playback)/i.test(metadata)) {
    addSignal(scores, evidence, "video", 6, "元数据含影视/视频语义");
  }
  if (/(?:有声|音频|音乐|听书|广播剧|播客|audio|podcast|sound|track)/i.test(metadata)) {
    addSignal(scores, evidence, "audio", 6, "元数据含音频语义");
  }
  if (/(?:漫画|动漫|图集|写真|comic|manga|manhua)/i.test(metadata)) {
    addSignal(scores, evidence, "comic", 6, "元数据含图片内容语义");
  }

  const videoUrls = countMatches(media, /\.(?:m3u8|mp4|m4v|webm|flv|mpd)(?:[?#\s]|$)/gi);
  if (videoUrls) addSignal(scores, evidence, "video", Math.min(12, videoUrls * 4), "章节规则含影视媒体地址");
  if (!videoUrls && /(?:m3u8|mp4|m4v|webm|flv|mpd)/i.test(media)) {
    addSignal(scores, evidence, "video", 4, "媒体规则含影视扩展名提示");
  }
  if (/(?:<video\b|application\/x-mpegurl|dash(?:\.js)?|play_from|vodplayinfo)/i.test(media)) {
    addSignal(scores, evidence, "video", 5, "章节规则含视频播放器/流媒体字段");
  }

  const audioUrls = countMatches(media, /\.(?:mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#\s]|$)/gi);
  if (audioUrls) addSignal(scores, evidence, "audio", Math.min(12, audioUrls * 4), "章节规则含音频媒体地址");
  if (!audioUrls && /(?:mp3|m4a|aac|ogg|opus|wav|flac)/i.test(media)) {
    addSignal(scores, evidence, "audio", 4, "媒体规则含音频扩展名提示");
  }
  if (/(?:<audio\b|audio\/mpeg|audioUrl|audio_url|playUrl|play_url|streamUrl|stream_url)/i.test(media)) {
    addSignal(scores, evidence, "audio", 5, "章节规则含音频字段");
  }

  // `imageStyle` is a presentation hint used by ordinary novels with inline
  // illustrations, and `<img>` often appears in JS that inserts such an
  // illustration into a text chapter. Neither proves that chapters are image
  // pages. Require an image-specific extraction rule, decoder, or page-list
  // capability before classifying an ambiguous legacy source as a comic.
  const hasImageCapability = hasMeaningfulRuleField(parts.content, "imageDecode")
    || /(?:^|[.\s@])img(?:@|\s|$)|page[-_]?chapter|imageUrl|image_url|pictureUrl|picture_url/i.test(parts.content);
  if (hasImageCapability) {
    addSignal(scores, evidence, "comic", 5, "正文规则含图片提取能力");
  }
  const inlineIllustrationBody = /(?:\.\s*(?:Content|content)|\[\s*["'](?:Content|content)["']\s*\])\s*\.split\s*\(/i.test(parts.content)
    && /\bBlocks\b/i.test(parts.content)
    && /\bType\s*={2,3}\s*["']image["']/i.test(parts.content)
    && /<img\b/i.test(parts.content);
  if (inlineIllustrationBody) {
    addSignal(scores, evidence, "text", 8, "正文由文本段落组成并将图片块插入段落流");
  }
  if (/(?:chapterImages|chapter_images|images\s*\[|pages\s*\[|图片章节)/i.test(parts.content)) {
    addSignal(scores, evidence, "comic", 4, "正文规则含连续图片集合");
  }

  // A file source may expose only a media extension
  // in a URL template.  Keep this last fallback conservative: a single image
  // cover field in search/catalogue rules must not turn a text source into a
  // comic source.
  if (!scores.comic && (
    hasMeaningfulRuleField(parts.catalogue, "imageDecode")
    || hasMeaningfulRuleField(parts.catalogue, "imageStyle")
  )) {
    addSignal(scores, evidence, "comic", 4, "源规则声明图片解码/样式");
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
  const explicit = EXPLICIT_TYPES.get(parts.type)
    || (parts.type === null && SOURCE_KINDS.includes(parts.declaredKind) ? parts.declaredKind : "");
  if (explicit) {
    return {
      kind: explicit,
      confidence: 1,
      explicit: true,
      evidence: [parts.type === null ? `sourceType=${parts.declaredKind}` : `bookSourceType=${parts.type}`],
    };
  }

  const { scores, evidence } = mediaScore(parts);
  // Legacy type 0/3 sources sometimes expose a hybrid rule: prefer a playable
  // URL when one is present, otherwise return the chapter's readable text.
  // There is no mixed source type in Xiangse. When the rule only weakly hints
  // at media fields, keep the declared legacy text meaning instead of turning
  // a usable text source into an audio player that can never resolve a URL.
  if ((parts.type === 0 || parts.type === 3) && hasMixedMediaAndTextOutput(parts.content)) {
    addSignal(
      scores,
      evidence,
      "text",
      10,
      "正文规则同时提供媒体与文本回退，按阅读默认文本类型处理",
    );
  }
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
