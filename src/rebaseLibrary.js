import { decodeXbs, encodeXbs } from "./xbs.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a configured public bridge base to a canonical origin
 * (`https://host[:port]`, no path/query/hash/credentials).
 * Independent of any source name or upstream site domain.
 */
export function normalizePublicOrigin(value, label = "公开桥接 origin") {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(`缺少${label}`);
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`无效的${label}：${raw}`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`${label} 仅支持 http/https：${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} 不能包含凭据`);
  }
  return parsed.origin;
}

/**
 * Replace only URL occurrences that belong to `oldOrigin` with `newOrigin`.
 * Handles plain and percent-encoded forms. Boundary-aware so
 * `https://old.example` does not match `https://old.example.evil`.
 *
 * @returns {{ text: string, replacements: number }}
 */
export function rebaseOriginInText(text, oldOrigin, newOrigin) {
  const source = String(text ?? "");
  const from = normalizePublicOrigin(oldOrigin, "旧公开桥接 origin");
  const to = normalizePublicOrigin(newOrigin, "新公开桥接 origin");
  if (from === to) {
    return { text: source, replacements: 0, noopReason: "origins-equal" };
  }

  let replacements = 0;
  let out = source;

  const plain = new RegExp(`${escapeRegExp(from)}(?=[/?#"'\`\\\\\\s]|$)`, "g");
  out = out.replace(plain, () => {
    replacements += 1;
    return to;
  });

  const encodedFrom = encodeURIComponent(from);
  const encodedTo = encodeURIComponent(to);
  if (encodedFrom !== from) {
    // After an encoded origin, a path continues as %2F; query/hash as %3F/%23.
    const encoded = new RegExp(
      `${escapeRegExp(encodedFrom)}(?=%2[Ff]|%3[Ff]|%23|[/?#"'\`\\\\\\s]|$)`,
      "g",
    );
    out = out.replace(encoded, () => {
      replacements += 1;
      return encodedTo;
    });
  }

  return {
    text: out,
    replacements,
    noopReason: replacements === 0 ? "no-matches" : undefined,
  };
}

function bufferToUtf8(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function parseSourcesJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`制品 JSON 无效：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("制品 JSON 必须是对象或数组");
  }
  return parsed;
}

/**
 * Rebase a JSON/XBS artifact pair in memory. JSON is the source of truth when
 * both are present; XBS is re-encoded from the rebased JSON so the pair stays
 * consistent. Never returns or logs full payloads.
 */
export function rebaseArtifactPair({
  json,
  xbs,
  oldOrigin,
  newOrigin,
} = {}) {
  const from = normalizePublicOrigin(oldOrigin, "旧公开桥接 origin");
  const to = normalizePublicOrigin(newOrigin, "新公开桥接 origin");

  let jsonText = bufferToUtf8(json);
  if (jsonText == null && xbs != null) {
    jsonText = decodeXbs(Buffer.isBuffer(xbs) ? xbs : Buffer.from(xbs)).toString("utf8");
  }
  if (jsonText == null) {
    throw new Error("缺少 JSON 或 XBS 制品");
  }

  if (xbs != null) {
    const decoded = decodeXbs(Buffer.isBuffer(xbs) ? xbs : Buffer.from(xbs)).toString("utf8");
    const fromJson = parseSourcesJson(jsonText);
    const fromXbs = parseSourcesJson(decoded);
    if (JSON.stringify(fromJson) !== JSON.stringify(fromXbs)) {
      throw new Error("JSON 与 XBS 制品内容不一致，拒绝 rebase（请先修复或重新发布）");
    }
  }

  // Validate before mutation.
  parseSourcesJson(jsonText);

  if (from === to) {
    const jsonBuffer = Buffer.from(jsonText.endsWith("\n") ? jsonText : `${jsonText}\n`, "utf8");
    return {
      oldOrigin: from,
      newOrigin: to,
      replacements: 0,
      changed: false,
      noopReason: "origins-equal",
      json: jsonBuffer,
      xbs: encodeXbs(jsonBuffer),
      jsonBytesBefore: Buffer.byteLength(jsonText, "utf8"),
      jsonBytesAfter: jsonBuffer.length,
    };
  }

  const { text, replacements, noopReason } = rebaseOriginInText(jsonText, from, to);
  parseSourcesJson(text);
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  const jsonBuffer = Buffer.from(normalized, "utf8");
  const xbsBuffer = encodeXbs(jsonBuffer);

  return {
    oldOrigin: from,
    newOrigin: to,
    replacements,
    changed: replacements > 0,
    noopReason: replacements > 0 ? undefined : noopReason,
    json: jsonBuffer,
    xbs: xbsBuffer,
    jsonBytesBefore: Buffer.byteLength(jsonText, "utf8"),
    jsonBytesAfter: jsonBuffer.length,
  };
}

function summarizeRebase(result, {
  jobId,
  dryRun,
  imageProxyBaseUpdated = false,
  subscribePath = "",
  written = false,
} = {}) {
  return {
    id: jobId || "",
    oldOrigin: result.oldOrigin,
    newOrigin: result.newOrigin,
    dryRun: Boolean(dryRun),
    written: Boolean(written),
    changed: Boolean(result.changed),
    replacements: Number(result.replacements) || 0,
    noopReason: result.noopReason || "",
    imageProxyBaseUpdated: Boolean(imageProxyBaseUpdated),
    subscribePath: subscribePath || "",
    jsonBytesBefore: result.jsonBytesBefore,
    jsonBytesAfter: result.jsonBytesAfter,
  };
}

/**
 * Rebase an existing library job's JSON/XBS artifacts from one public bridge
 * origin to another. Preserves job id, subscribe path, and source payload.
 *
 * @param {object} options
 * @param {object} options.store - library store
 * @param {string} options.jobId
 * @param {string} options.oldOrigin
 * @param {string} options.newOrigin
 * @param {boolean} [options.dryRun=false] - validate and count only; do not write
 */
export async function rebaseLibraryArtifact({
  store,
  jobId,
  oldOrigin,
  newOrigin,
  dryRun = false,
} = {}) {
  if (!store) throw new Error("rebaseLibraryArtifact requires a library store");
  const id = String(jobId || "").trim();
  if (!id) throw new Error("缺少任务 id");

  const job = await store.getJob(id);
  if (!job) throw new Error(`任务不存在：${id}`);

  const json = await store.readArtifact(id, "json");
  const xbs = await store.readArtifact(id, "xbs");
  if (!json && !xbs) throw new Error(`制品不存在：${id}`);

  const result = rebaseArtifactPair({
    json,
    xbs,
    oldOrigin,
    newOrigin,
  });

  const currentProxy = String(job.imageProxyBase || "").trim();
  let wouldUpdateProxy = false;
  let nextProxy = currentProxy;
  if (currentProxy) {
    try {
      if (normalizePublicOrigin(currentProxy) === result.oldOrigin
        && result.oldOrigin !== result.newOrigin) {
        nextProxy = result.newOrigin;
        wouldUpdateProxy = true;
      }
    } catch {
      // Leave opaque/invalid stored proxy values untouched.
    }
  } else if (result.changed) {
    nextProxy = result.newOrigin;
    wouldUpdateProxy = true;
  }

  // Dry-run and no-op validation never rewrite artifacts or job metadata.
  if (dryRun || !result.changed) {
    return {
      job,
      summary: summarizeRebase(result, {
        jobId: id,
        dryRun,
        imageProxyBaseUpdated: dryRun ? wouldUpdateProxy && result.oldOrigin !== result.newOrigin : false,
        subscribePath: job.subscribePath || `/library/${id}.xbs`,
        written: false,
      }),
    };
  }

  await store.saveArtifacts(id, { xbs: result.xbs, json: result.json });
  // Terminal jobs ignore patches unless status is present; echo current status.
  const saved = await store.updateJob(id, {
    status: job.status,
    imageProxyBase: nextProxy || result.newOrigin,
    rebasedAt: new Date().toISOString(),
    rebasedFrom: result.oldOrigin,
    rebasedTo: result.newOrigin,
    rebaseReplacements: result.replacements,
  });

  return {
    job: saved || job,
    summary: summarizeRebase(result, {
      jobId: id,
      dryRun: false,
      imageProxyBaseUpdated: wouldUpdateProxy,
      subscribePath: (saved || job).subscribePath || `/library/${id}.xbs`,
      written: true,
    }),
  };
}
