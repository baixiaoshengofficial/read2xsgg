import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return randomBytes(8).toString("hex");
}

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    // Explicit mode so root-run ops CLIs do not leave 0600 files unreadable to the service user.
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function createLockMap() {
  const tails = new Map();
  return function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    tails.set(key, next);
    return next.finally(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
  };
}

/**
 * Filesystem-backed library of async conversion jobs and XBS artifacts.
 */
export function createLibraryStore(dataDir) {
  const root = path.resolve(dataDir || "./data");
  const jobsDir = path.join(root, "jobs");
  const artifactsDir = path.join(root, "artifacts");
  const conversionsDir = path.join(root, "conversions");
  const indexPath = path.join(root, "index.json");
  const withLock = createLockMap();

  async function ensure() {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(conversionsDir, { recursive: true });
    await withLock("index", async () => {
      const index = await readJson(indexPath, null);
      if (!index) await writeJsonAtomic(indexPath, { version: 1, jobs: [] });
    });
  }

  function jobPath(id) {
    return path.join(jobsDir, `${id}.json`);
  }

  function artifactPath(id, ext) {
    return path.join(artifactsDir, `${id}.${ext}`);
  }

  function conversionId(key) {
    return createHash("sha256").update(String(key || "")).digest("hex");
  }

  function conversionPath(key, ext) {
    return path.join(conversionsDir, `${conversionId(key)}.${ext}`);
  }

  async function readIndexUnlocked() {
    const index = await readJson(indexPath, { version: 1, jobs: [] });
    if (!Array.isArray(index.jobs)) index.jobs = [];
    return index;
  }

  async function upsertIndexEntry(entry) {
    return withLock("index", async () => {
      const index = await readIndexUnlocked();
      const next = {
        id: entry.id,
        title: entry.title || "",
        sourceUrl: entry.sourceUrl || "",
        mode: entry.mode || "source",
        status: entry.status,
        updatedAt: entry.updatedAt || nowIso(),
        count: entry.count ?? null,
        error: entry.error || "",
        progress: entry.progress || null,
        phase: entry.phase || "",
      };
      const pos = index.jobs.findIndex((item) => item.id === next.id);
      if (pos >= 0) index.jobs[pos] = next;
      else index.jobs.unshift(next);
      await writeJsonAtomic(indexPath, index);
      return next;
    });
  }

  async function removeIndexEntry(id) {
    return withLock("index", async () => {
      const index = await readIndexUnlocked();
      index.jobs = index.jobs.filter((item) => item.id !== id);
      await writeJsonAtomic(indexPath, index);
    });
  }

  async function getJob(id) {
    await ensure();
    return withLock(`job:${id}`, () => readJson(jobPath(id), null));
  }

  async function listJobs() {
    await ensure();
    const index = await withLock("index", () => readIndexUnlocked());
    const full = [];
    for (const entry of index.jobs) {
      const job = await getJob(entry.id);
      full.push(job || entry);
    }
    return full;
  }

  async function createJob({ url, mode = "source", name = "", imageProxyBase = "" } = {}) {
    await ensure();
    const id = newJobId();
    const createdAt = nowIso();
    const job = {
      id,
      title: String(name || "").trim() || String(url || "").trim(),
      sourceUrl: String(url || "").trim(),
      mode: mode === "site" ? "site" : "source",
      status: "queued",
      phase: "queued",
      imageProxyBase: String(imageProxyBase || ""),
      progress: { done: 0, total: 0, kept: 0, skipped: 0, unverified: 0, fallback: 0, failed: 0 },
      count: null,
      fallbackCount: 0,
      skippedBuckets: {},
      error: "",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      subscribePath: `/library/${id}.xbs`,
    };
    await withLock(`job:${id}`, async () => {
      await writeJsonAtomic(jobPath(id), job);
    });
    await upsertIndexEntry(job);
    return job;
  }

  async function updateJob(id, patch = {}) {
    return withLock(`job:${id}`, async () => {
      const current = await readJson(jobPath(id), null);
      if (!current) return null;
      const terminal = current.status === "done" || current.status === "failed";
      if (terminal && patch.status === undefined) {
        return current;
      }
      const next = {
        ...current,
        ...patch,
        id: current.id,
        updatedAt: nowIso(),
        progress: patch.progress ? { ...current.progress, ...patch.progress } : current.progress,
      };
      await writeJsonAtomic(jobPath(id), next);
      return next;
    }).then(async (next) => {
      if (next) await upsertIndexEntry(next);
      return next;
    });
  }

  async function saveArtifacts(id, { xbs, json } = {}) {
    await ensure();
    if (xbs) await writeFile(artifactPath(id, "xbs"), xbs, { mode: 0o644 });
    if (json) await writeFile(artifactPath(id, "json"), json, { mode: 0o644 });
  }

  async function readArtifact(id, ext) {
    try {
      return await readFile(artifactPath(id, ext));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Persist an explicitly supplied Legado JSON payload for a library job.
   * Used when remote legacy sources lack declarative fields (e.g. mediaResolution)
   * and an operator republishes from a migration fixture / admin body.
   */
  async function saveSourcePayload(id, source) {
    await ensure();
    await writeJsonAtomic(artifactPath(id, "source.json"), source);
  }

  async function readSourcePayload(id) {
    return readJson(artifactPath(id, "source.json"), null);
  }

  /**
   * Persist the synchronous conversion cache separately from user-managed
   * library jobs. The metadata is written last, so readers never accept a
   * partially-written pair of JSON/XBS artifacts after an interrupted write.
   */
  async function saveConversion(key, result, { expiresAt = 0 } = {}) {
    if (!key || !result?.xbs || !result?.json) return;
    await ensure();
    const id = conversionId(key);
    await withLock(`conversion:${id}`, async () => {
      await writeFile(conversionPath(key, "xbs"), result.xbs);
      await writeFile(conversionPath(key, "json"), result.json);
      await writeJsonAtomic(conversionPath(key, "meta.json"), {
        version: 1,
        savedAt: nowIso(),
        expiresAt: Number(expiresAt) || 0,
        xbsHash: contentHash(result.xbs),
        jsonHash: contentHash(result.json),
        etag: String(result.etag || ""),
        count: Number(result.count) || 0,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        skipped: Array.isArray(result.skipped) ? result.skipped : [],
        skippedBuckets: result.skippedBuckets && typeof result.skippedBuckets === "object" ? result.skippedBuckets : {},
        fallbackCount: Number(result.fallbackCount) || 0,
        unverifiedCount: Number(result.unverifiedCount) || 0,
      });
    });
  }

  async function readConversion(key) {
    if (!key) return null;
    const id = conversionId(key);
    return withLock(`conversion:${id}`, async () => {
      const meta = await readJson(conversionPath(key, "meta.json"), null);
      if (!meta || meta.version !== 1) return null;
      try {
        const [xbs, json] = await Promise.all([
          readFile(conversionPath(key, "xbs")),
          readFile(conversionPath(key, "json")),
        ]);
        if (!meta.xbsHash || !meta.jsonHash || meta.xbsHash !== contentHash(xbs) || meta.jsonHash !== contentHash(json)) return null;
        const sources = JSON.parse(json.toString("utf8"));
        if (!sources || typeof sources !== "object" || Array.isArray(sources)) return null;
        return { ...meta, xbs, json, sources };
      } catch (error) {
        if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    });
  }

  async function deleteJob(id) {
    await ensure();
    await withLock(`job:${id}`, async () => {
      await rm(jobPath(id), { force: true });
    });
    await rm(artifactPath(id, "xbs"), { force: true });
    await rm(artifactPath(id, "json"), { force: true });
    await rm(artifactPath(id, "source.json"), { force: true });
    await removeIndexEntry(id);
    return true;
  }

  async function listRecoverableJobs() {
    const jobs = await listJobs();
    return jobs.filter((job) => job && (job.status === "queued" || job.status === "running"));
  }

  return {
    root,
    ensure,
    createJob,
    getJob,
    listJobs,
    updateJob,
    saveArtifacts,
    readArtifact,
    saveSourcePayload,
    readSourcePayload,
    saveConversion,
    readConversion,
    deleteJob,
    listRecoverableJobs,
  };
}
