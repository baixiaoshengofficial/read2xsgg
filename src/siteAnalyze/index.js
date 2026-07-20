import { detectKind } from "./detectKind.js";
import { discoverNovel } from "./discoverNovel.js";
import { novelDiscoveryToXiangse } from "./toXiangse.js";

/**
 * Analyze a live website and produce a Xiangse source when possible.
 * MVP: only HTML novel templates are fully supported.
 */
export async function analyzeSite(siteUrl, {
  download,
  sourceName = "",
  timeoutMs = 8_000,
} = {}) {
  if (typeof download !== "function") {
    return { ok: false, reason: "analyze-failed: 缺少下载器" };
  }
  let origin;
  try {
    origin = new URL(siteUrl);
  } catch {
    return { ok: false, reason: "analyze-failed: 网站 URL 无效" };
  }
  if (!/^https?:$/i.test(origin.protocol)) {
    return { ok: false, reason: "analyze-failed: 仅支持 http/https" };
  }

  const timedDownload = async (url, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await download(url, headers, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let homeHtml = "";
  try {
    homeHtml = (await timedDownload(`${origin.protocol}//${origin.host}/`)).toString("utf8");
  } catch (error) {
    return { ok: false, reason: `analyze-failed: 首页不可访问（${error.message || error}）` };
  }

  const kindInfo = detectKind(homeHtml, origin.toString());
  if (kindInfo.kind !== "text") {
    return {
      ok: false,
      reason: `analyze-failed: 当前仅支持自动识别小说站（检测到 ${kindInfo.kind}）`,
      kind: kindInfo.kind,
      confidence: kindInfo.confidence,
    };
  }

  let discovery;
  try {
    discovery = await discoverNovel(`${origin.protocol}//${origin.host}/`, { download: timedDownload });
  } catch (error) {
    return { ok: false, reason: `analyze-failed: ${error.message || error}`, kind: "text" };
  }
  if (!discovery) {
    return { ok: false, reason: "analyze-failed: 未能从首页发现可用的书籍/章节结构", kind: "text" };
  }

  const source = novelDiscoveryToXiangse(discovery, { sourceName });
  if (!source) {
    return { ok: false, reason: "analyze-failed: 无法生成香色源", kind: "text" };
  }
  return {
    ok: true,
    kind: "text",
    confidence: kindInfo.confidence,
    discovery,
    source,
    warning: {
      source: source.sourceName,
      section: "source",
      field: "fallback",
      message: "fallback:site-analyze：阅读规则抽测失败或直接识站，已用启发式页面结构生成香色源",
      rule: origin.host,
    },
  };
}

export { detectKind } from "./detectKind.js";
export { discoverNovel } from "./discoverNovel.js";
export { novelDiscoveryToXiangse } from "./toXiangse.js";
