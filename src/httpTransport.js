/**
 * Explicit request-transport helpers for security-checked server downloaders.
 *
 * Callers receive a bound `download(url, …)` with no source/domain identity.
 * Accepted call styles:
 *
 *   download(url)
 *   download(url, headers)
 *   download(url, headers, { method, body })
 *   download(url, { headers, method, body })
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function looksLikeTransportInit(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  // A headers map uses header names as keys; a transport init uses these.
  return keys.every((key) => /^(?:headers|method|body|signal|label|maxBytes)$/i.test(key));
}

/**
 * Normalize download() positional args into a single request descriptor.
 * @returns {{ headers: Record<string, string>, method: string, body: string|Buffer|null }}
 */
export function normalizeDownloadArgs(headersOrInit = {}, maybeOptions = undefined) {
  if (maybeOptions !== undefined) {
    const headers = isPlainObject(headersOrInit) ? { ...headersOrInit } : {};
    const options = isPlainObject(maybeOptions) ? maybeOptions : {};
    return {
      headers: isPlainObject(options.headers) ? { ...headers, ...options.headers } : headers,
      method: String(options.method || "GET").toUpperCase(),
      body: options.body ?? null,
    };
  }

  if (looksLikeTransportInit(headersOrInit)) {
    const headers = isPlainObject(headersOrInit.headers) ? { ...headersOrInit.headers } : {};
    return {
      headers,
      method: String(headersOrInit.method || "GET").toUpperCase(),
      body: headersOrInit.body ?? null,
    };
  }

  return {
    headers: isPlainObject(headersOrInit) ? { ...headersOrInit } : {},
    method: "GET",
    body: null,
  };
}

/**
 * Redirect following is only safe for idempotent methods. POST/PUT/etc. must
 * not replay bodies across Location hops.
 */
export function redirectLimitForMethod(method, maxRedirects) {
  const verb = String(method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return Math.max(0, Number(maxRedirects) || 0);
  return 0;
}

/**
 * Decode a download() response that may be a Buffer or string.
 */
export function responseText(response) {
  if (Buffer.isBuffer(response)) return response.toString("utf8");
  return String(response ?? "");
}

/**
 * Bind a config-aware downloader to the adapter transport contract.
 * `fetchBuffer(url, config, headers, { method, body })` is typically server.downloadSource.
 */
export function createDownloader(fetchBuffer, config) {
  if (typeof fetchBuffer !== "function") {
    throw new TypeError("createDownloader requires fetchBuffer(url, config, headers, options)");
  }
  return async function download(url, headersOrInit = {}, maybeOptions) {
    const { headers, method, body } = normalizeDownloadArgs(headersOrInit, maybeOptions);
    return fetchBuffer(String(url), config, headers, { method, body });
  };
}
