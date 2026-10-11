import { createHash } from "node:crypto";

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalValue(item, seen));
  } else if (typeof value.entries === "function" && value.constructor?.name === "Headers") {
    result = canonicalHeaders(value);
  } else {
    result = Object.fromEntries(Object.keys(value)
      .filter((key) => key !== "signal")
      .sort()
      .map((key) => [key, canonicalValue(value[key], seen)]));
  }
  seen.delete(value);
  return result;
}

function canonicalHeaders(input) {
  const entries = typeof input?.entries === "function"
    ? [...input.entries()]
    : Object.entries(input || {});
  const normalized = new Map();
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!name) continue;
    normalized.set(name, String(rawValue ?? "").trim());
  }
  return [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Stable identity for a concrete source request. Header names are
 * case-insensitive; requestInfo is included when the request is a seed because
 * two rules can resolve to the same sample URL but produce different pages as
 * their parameters change.
 */
export function requestIdentity(request, { includeRequestInfo = false } = {}) {
  const options = request?.options && typeof request.options === "object"
    ? request.options
    : {};
  const headers = { ...(options.headers || {}), ...(request?.headers || {}) };
  const payload = {
    url: String(request?.url || ""),
    method: String(options.method || request?.method || "GET").toUpperCase(),
    body: canonicalValue(options.body ?? request?.body ?? ""),
    headers: canonicalHeaders(headers),
    options: canonicalValue(Object.fromEntries(Object.entries(options)
      .filter(([key]) => key !== "headers" && key !== "signal"))),
    ...(includeRequestInfo ? { requestInfo: String(request?.requestInfo || "") } : {}),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
}
