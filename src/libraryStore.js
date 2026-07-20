import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return randomBytes(8).toString("hex");
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
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

/**
 * Filesystem-backed library of async conversion jobs and XBS artifacts.
 */
export function createLibraryStore(dataDir) {
  const root = path.resolve(dataDir || "./data");
  const jobsDir = path.join(root, "jobs");
  const artifactsDir = path.join(root, "artifacts");
  const indexPath = path.join(root, "index.json");

  async function ensure() {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    const index = await readJson(indexPath, null);
    if (!index) await writeJsonAtomic(indexPath, { version: 1, jobs: [] });
  }

  function jobPath(id) {
    return path.join(jobsDir, `${id}.json`);
  }

  function artifactPath(id, ext) {
    return path.join(artifactsDir, `${id}.${ext}`);
  }

  async function readIndex() {
    await ensure();
    const index = await readJson(indexPath, { version: 1, jobs: [] });
    if (!Array.isArray(index.jobs)) index.jobs = [];
    return index;
  }

  async function writeIndex(index) {
    await writeJsonAtomic(indexPath, index);
  }

  async function upsertIndexEntry(entry) {
    const index = await readIndex();
    const next = {
      id: entry.id,
      title: entry.title || "",
      sourceUrl: entry.sourceUrl || "",
      mode: entry.mode || "source",
      status: entry.status,
      updatedAt: entry.updatedAt || nowIso(),
      count: entry.count ?? null,
      error: entry.error || "",
    };
    const pos = index.jobs.findIndex((item) => item.id === next.id);
    if (pos >= 0) index.jobs[pos] = next;
    else index.jobs.unshift(next);
    await writeIndex(index);
    return next;
  }

  async function removeIndexEntry(id) {
    const index = await readIndex();
    index.jobs = index.jobs.filter((item) => item.id !== id);
    await writeIndex(index);
  }

  async function getJob(id) {
    await ensure();
    return readJson(jobPath(id), null);
  }

  async function listJobs() {
    const index = await readIndex();
    return index.jobs;
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
    await writeJsonAtomic(jobPath(id), job);
    await upsertIndexEntry(job);
    return job;
  }

  async function updateJob(id, patch = {}) {
    const current = await getJob(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: nowIso(),
      progress: patch.progress ? { ...current.progress, ...patch.progress } : current.progress,
    };
    await writeJsonAtomic(jobPath(id), next);
    await upsertIndexEntry(next);
    return next;
  }

  async function saveArtifacts(id, { xbs, json } = {}) {
    await ensure();
    if (xbs) await writeFile(artifactPath(id, "xbs"), xbs);
    if (json) await writeFile(artifactPath(id, "json"), json);
  }

  async function readArtifact(id, ext) {
    try {
      return await readFile(artifactPath(id, ext));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function deleteJob(id) {
    await ensure();
    await rm(jobPath(id), { force: true });
    await rm(artifactPath(id, "xbs"), { force: true });
    await rm(artifactPath(id, "json"), { force: true });
    await removeIndexEntry(id);
    return true;
  }

  async function listRecoverableJobs() {
    const jobs = await listJobs();
    const out = [];
    for (const entry of jobs) {
      if (entry.status !== "queued" && entry.status !== "running") continue;
      const full = await getJob(entry.id);
      if (full) out.push(full);
    }
    return out;
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
    deleteJob,
    listRecoverableJobs,
  };
}
