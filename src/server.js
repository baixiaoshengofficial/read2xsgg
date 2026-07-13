import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { convertLegado } from "./converter.js";
import { encodeXbs } from "./xbs.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function integer(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value));
}

export function serverConfig(environment = process.env) {
  return {
    host: environment.HOST || "0.0.0.0",
    port: integer(environment.PORT, 3000, 0),
    fetchTimeoutMs: integer(environment.FETCH_TIMEOUT_MS, 15_000),
    maxSourceBytes: integer(environment.MAX_SOURCE_BYTES, 10 * 1024 * 1024),
    maxRedirects: integer(environment.MAX_REDIRECTS, 5, 0),
    maxConcurrent: integer(environment.MAX_CONCURRENT, 8),
    cacheTtlMs: integer(environment.CACHE_TTL_SECONDS, 300, 0) * 1000,
    maxCacheEntries: integer(environment.MAX_CACHE_ENTRIES, 100),
    allowPrivateNetworks: boolean(environment.ALLOW_PRIVATE_NETWORKS),
    allowDnsProxyNetworks: boolean(environment.ALLOW_DNS_PROXY_NETWORKS),
    corsOrigin: environment.CORS_ORIGIN || "*",
  };
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(octets[2])) || (b === 88 && octets[2] === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100)))
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224;
}

function isPrivateIp(address) {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function isDnsProxyIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

async function resolveTarget(url, config) {
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, "阅读源地址只支持 http:// 或 https://");
  if (!url.hostname) throw new HttpError(400, "阅读源地址缺少主机名");
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpError(502, `无法解析阅读源域名：${error.message}`);
  }
  if (!addresses.length) throw new HttpError(502, "阅读源域名没有可用地址");
  const hostnameIsIp = isIP(url.hostname) !== 0;
  const blockedAddresses = addresses.filter(({ address }) => isPrivateIp(address));
  const dnsProxyException = config.allowDnsProxyNetworks
    && !hostnameIsIp
    && blockedAddresses.length > 0
    && blockedAddresses.every(({ address }) => isDnsProxyIpv4(address));
  if (!config.allowPrivateNetworks && blockedAddresses.length && !dnsProxyException) {
    throw new HttpError(403, "出于安全考虑，默认禁止访问本机或内网地址；可信环境可设置 ALLOW_PRIVATE_NETWORKS=true");
  }
  return addresses[0];
}

function requestBuffer(url, resolved, config) {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requester(url, {
      headers: {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "read2xsgg/0.2",
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      servername: url.hostname,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new HttpError(502, `下载阅读源失败：上游返回 HTTP ${status}`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > config.maxSourceBytes) {
        response.destroy();
        reject(new HttpError(413, `阅读源超过大小限制 ${config.maxSourceBytes} 字节`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > config.maxSourceBytes) {
          response.destroy(new HttpError(413, `阅读源超过大小限制 ${config.maxSourceBytes} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks, length) }));
      response.on("error", reject);
    });
    request.setTimeout(config.fetchTimeoutMs, () => request.destroy(new HttpError(504, `下载阅读源超时（${config.fetchTimeoutMs}ms）`)));
    request.on("error", (error) => reject(error instanceof HttpError ? error : new HttpError(502, `下载阅读源失败：${error.message}`)));
    request.end();
  });
}

export async function downloadSource(sourceUrl, config = serverConfig()) {
  let current;
  try {
    current = new URL(sourceUrl);
  } catch {
    throw new HttpError(400, "阅读源地址不是有效 URL");
  }
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config);
    if (result.buffer) return result.buffer;
    if (redirects === config.maxRedirects) throw new HttpError(502, `阅读源重定向次数超过 ${config.maxRedirects}`);
    current = result.redirect;
  }
  throw new HttpError(502, "下载阅读源失败");
}

function sourceUrlFromRequest(request) {
  const rawUrl = request.url || "/";
  if (rawUrl.startsWith("/url/")) {
    const value = rawUrl.slice("/url/".length);
    try {
      return { sourceUrl: decodeURIComponent(value), format: "xbs" };
    } catch {
      throw new HttpError(400, "路径中的阅读源 URL 编码无效");
    }
  }
  if (rawUrl.startsWith("/json/")) {
    const value = rawUrl.slice("/json/".length);
    try {
      return { sourceUrl: decodeURIComponent(value), format: "json" };
    } catch {
      throw new HttpError(400, "路径中的阅读源 URL 编码无效");
    }
  }
  const parsed = new URL(rawUrl, "http://read2xsgg.local");
  if (parsed.pathname === "/convert" || parsed.pathname === "/convert/json") {
    return {
      sourceUrl: parsed.searchParams.get("url") || "",
      format: parsed.pathname.endsWith("/json") || parsed.searchParams.get("format") === "json" ? "json" : "xbs",
    };
  }
  return null;
}

function help(config) {
  return {
    name: "read2xsgg",
    status: "ok",
    usage: {
      path: "/url/https://example.com/legado.json",
      query: "/convert?url=https%3A%2F%2Fexample.com%2Flegado.json",
      json: "/convert/json?url=https%3A%2F%2Fexample.com%2Flegado.json",
      health: "/healthz",
    },
    limits: {
      maxSourceBytes: config.maxSourceBytes,
      fetchTimeoutMs: config.fetchTimeoutMs,
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowDnsProxyNetworks: config.allowDnsProxyNetworks,
    },
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, ...headers });
  response.end(body);
}

function cacheSet(cache, key, value, config) {
  if (config.cacheTtlMs <= 0) return;
  if (cache.size >= config.maxCacheEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { expiresAt: Date.now() + config.cacheTtlMs, value });
}

async function convertOnlineSource(sourceUrl, config) {
  const raw = await downloadSource(sourceUrl, config);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new HttpError(422, `在线阅读源不是有效 JSON：${error.message}`);
  }
  let converted;
  try {
    converted = convertLegado(parsed);
  } catch (error) {
    throw new HttpError(422, `无法转换在线阅读源：${error.message}`);
  }
  const count = Object.keys(converted.sources).length;
  if (!count) throw new HttpError(422, "在线地址中没有可转换的阅读源");
  const json = Buffer.from(`${JSON.stringify(converted.sources, null, 2)}\n`, "utf8");
  const xbs = encodeXbs(json);
  return { ...converted, count, json, xbs, etag: `"${createHash("sha256").update(xbs).digest("hex")}"` };
}

export function createAppServer(options = {}) {
  const config = { ...serverConfig(), ...(options.config ?? {}) };
  const cache = new Map();
  let active = 0;

  return createServer(async (request, response) => {
    const commonHeaders = {
      "Access-Control-Allow-Origin": config.corsOrigin,
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,If-None-Match",
      "X-Content-Type-Options": "nosniff",
    };
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, commonHeaders);
        response.end();
        return;
      }
      if (!new Set(["GET", "HEAD"]).has(request.method)) throw new HttpError(405, "仅支持 GET、HEAD 和 OPTIONS");
      const pathname = new URL(request.url || "/", "http://read2xsgg.local").pathname;
      if (pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" }, commonHeaders);
        return;
      }
      const target = sourceUrlFromRequest(request);
      if (!target) {
        sendJson(response, pathname === "/" ? 200 : 404, help(config), commonHeaders);
        return;
      }
      if (!target.sourceUrl) throw new HttpError(400, "缺少在线阅读源 URL");
      if (active >= config.maxConcurrent) throw new HttpError(429, "当前转换任务过多，请稍后重试");

      const cacheKey = target.sourceUrl;
      let converted = cache.get(cacheKey);
      if (converted && converted.expiresAt <= Date.now()) {
        cache.delete(cacheKey);
        converted = undefined;
      }
      if (converted) converted = converted.value;
      else {
        active += 1;
        try {
          converted = await convertOnlineSource(target.sourceUrl, config);
          cacheSet(cache, cacheKey, converted, config);
        } finally {
          active -= 1;
        }
      }

      const headers = {
        ...commonHeaders,
        ETag: converted.etag,
        "Cache-Control": `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
        "X-Converted-Count": String(converted.count),
        "X-Warning-Count": String(converted.warnings.length),
      };
      if (request.headers["if-none-match"] === converted.etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      if (target.format === "json") {
        sendJson(response, 200, { sources: converted.sources, warnings: converted.warnings }, headers);
        return;
      }
      const filename = `read2xsgg-${createHash("sha256").update(target.sourceUrl).digest("hex").slice(0, 12)}.xbs`;
      response.writeHead(200, {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": converted.xbs.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(converted.xbs);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error.message || "服务器内部错误" }, commonHeaders);
    }
  });
}

export function startServer(config = serverConfig()) {
  const server = createAppServer({ config });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`read2xsgg listening on http://${config.host}:${config.port}\n`);
  });
  return server;
}
