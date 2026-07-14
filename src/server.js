import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { convertLegado } from "./converter.js";
import { ImageDecodeError, decodeImage, supportedImageDecoders } from "./imageDecoder.js";
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
    maxImageBytes: integer(environment.MAX_IMAGE_BYTES, 25 * 1024 * 1024),
    maxRedirects: integer(environment.MAX_REDIRECTS, 5, 0),
    maxConcurrent: integer(environment.MAX_CONCURRENT, 8),
    cacheTtlMs: integer(environment.CACHE_TTL_SECONDS, 300, 0) * 1000,
    maxCacheEntries: integer(environment.MAX_CACHE_ENTRIES, 100),
    allowPrivateNetworks: boolean(environment.ALLOW_PRIVATE_NETWORKS),
    allowDnsProxyNetworks: boolean(environment.ALLOW_DNS_PROXY_NETWORKS),
    corsOrigin: environment.CORS_ORIGIN || "*",
    publicBaseUrl: String(environment.PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),
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

function requestBuffer(url, resolved, config, { maxBytes = config.maxSourceBytes, accept, headers = {}, label = "下载资源" } = {}) {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requester(url, {
      headers: {
        Accept: accept || "application/json,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "read2xsgg/0.2",
        ...headers,
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
        reject(new HttpError(502, `${label}失败：上游返回 HTTP ${status}`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maxBytes) {
        response.destroy();
        reject(new HttpError(413, `${label}超过大小限制 ${maxBytes} 字节`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy(new HttpError(413, `${label}超过大小限制 ${maxBytes} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks, length), headers: response.headers }));
      response.on("error", reject);
    });
    request.setTimeout(config.fetchTimeoutMs, () => request.destroy(new HttpError(504, `${label}超时（${config.fetchTimeoutMs}ms）`)));
    request.on("error", (error) => reject(error instanceof HttpError ? error : new HttpError(502, `${label}失败：${error.message}`)));
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
    const result = await requestBuffer(current, resolved, config, { label: "下载阅读源" });
    if (result.buffer) return result.buffer;
    if (redirects === config.maxRedirects) throw new HttpError(502, `阅读源重定向次数超过 ${config.maxRedirects}`);
    current = result.redirect;
  }
  throw new HttpError(502, "下载阅读源失败");
}

function normalizeRemoteUrl(value) {
  let source = String(value ?? "").trim();
  if (!source) throw new HttpError(400, "缺少图片 URL");
  try {
    source = decodeURIComponent(source);
  } catch {
    throw new HttpError(400, "图片 URL 编码无效");
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new HttpError(400, "图片 URL 不是有效 URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, "图片 URL 只支持 http:// 或 https://");
  if (url.username || url.password) throw new HttpError(400, "图片 URL 不能包含用户名或密码");
  return url.toString();
}

export async function downloadImage(imageUrl, decoder = "auto", config = serverConfig()) {
  let current;
  try {
    current = new URL(normalizeRemoteUrl(imageUrl));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "图片 URL 不是有效 URL");
  }
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const resolved = await resolveTarget(current, config);
    const result = await requestBuffer(current, resolved, config, {
      maxBytes: config.maxImageBytes,
      label: "下载图片",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      // A same-origin Referer works for sources which reject empty Referer, while
      // keeping the endpoint free of caller-controlled request headers.
      headers: { Referer: `${current.protocol}//${current.host}/` },
    });
    if (!result.buffer) {
      if (redirects === config.maxRedirects) throw new HttpError(502, `图片重定向次数超过 ${config.maxRedirects}`);
      current = result.redirect;
      continue;
    }
    try {
      return { ...decodeImage(result.buffer, decoder), upstreamUrl: current.toString() };
    } catch (error) {
      if (error instanceof ImageDecodeError) throw new HttpError(422, `图片无法解码：${error.message}`);
      throw error;
    }
  }
  throw new HttpError(502, "下载图片失败");
}

/**
 * 把路径里嵌套的阅读源地址还原成可抓取 URL。
 * 支持：
 * - 完整 URL（可编码或原样）: https://host/path.json
 * - 去协议手拼接: host/path.json
 * - 代理友好: https/host/path.json
 */
export function normalizeEmbeddedSourceUrl(value) {
  let source = String(value ?? "").trim();
  if (!source) throw new HttpError(400, "缺少在线阅读源 URL");
  if (source.endsWith(".xbs")) source = source.slice(0, -".xbs".length);
  if (/%[0-9A-Fa-f]{2}/.test(source)) {
    try {
      source = decodeURIComponent(source);
    } catch {
      throw new HttpError(400, "路径中的阅读源 URL 编码无效");
    }
  }
  source = source.trim().replace(/^\/+/, "");
  if (!source) throw new HttpError(400, "缺少在线阅读源 URL");

  if (/^https?:\/\//i.test(source)) return source;
  // /xbs/https/www.example.com/a.json.xbs 或误写成 https:/www...
  const schemeSlash = source.match(/^(https?)\/+(.*)$/i);
  if (schemeSlash?.[2]) return `${schemeSlash[1].toLowerCase()}://${schemeSlash[2]}`;

  // 手拼最简形式：去掉协议后直接接在 /xbs/ 后面
  // 域名默认 https；字面量 IP（含端口）默认 http，便于本地/内网源。
  if (/^[a-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(source) || /^\[[0-9a-f:]+\](?::\d+)?(?:\/|$)/i.test(source)) {
    const host = source.startsWith("[") ? (source.match(/^\[[0-9a-f:]+\]/i)?.[0] ?? "") : source.split("/")[0].replace(/:\d+$/, "");
    const scheme = host && isIP(host.replace(/^\[|\]$/g, "")) ? "http" : "https";
    return `${scheme}://${source}`;
  }

  throw new HttpError(400, "无法解析阅读源地址，请使用 https://host/path 或 host/path");
}

function sourceUrlFromRequest(request) {
  const rawUrl = request.url || "/";
  const pathOnly = rawUrl.split(/[?#]/, 1)[0];

  // 推荐手拼：/xbs/www.example.com/legado.json.xbs
  for (const prefix of ["/xbs/", "/x/", "/url/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "xbs" };
    }
  }
  for (const prefix of ["/json/", "/j/"]) {
    if (pathOnly.startsWith(prefix)) {
      return { sourceUrl: normalizeEmbeddedSourceUrl(pathOnly.slice(prefix.length)), format: "json" };
    }
  }

  const parsed = new URL(rawUrl, "http://read2xsgg.local");
  if (["/convert", "/convert.xbs", "/x.xbs", "/convert/json"].includes(parsed.pathname)) {
    let sourceUrl = "";
    // /x.xbs?u=... 把 u= 后面整段都当阅读源（支持源地址自带 ?query，免编码）
    if (parsed.pathname === "/x.xbs") {
      const marker = rawUrl.includes("?u=") ? "?u=" : rawUrl.includes("&u=") ? "&u=" : "";
      sourceUrl = marker ? rawUrl.slice(rawUrl.indexOf(marker) + marker.length) : (parsed.searchParams.get("url") || "");
    } else {
      sourceUrl = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
    }
    return {
      sourceUrl: sourceUrl ? normalizeEmbeddedSourceUrl(sourceUrl) : "",
      format: parsed.pathname.endsWith("/json") || parsed.searchParams.get("format") === "json" ? "json" : "xbs",
    };
  }
  return null;
}

function imageRequestFromRequest(request) {
  const parsed = new URL(request.url || "/", "http://read2xsgg.local");
  let decoder;
  if (parsed.pathname === "/image") decoder = parsed.searchParams.get("decoder") || "auto";
  else if (parsed.pathname.startsWith("/image/")) decoder = parsed.pathname.slice("/image/".length);
  else return null;
  if (!/^(?:auto|passthrough|[a-z0-9-]+)$/i.test(decoder)) throw new HttpError(400, "图片解码器名称无效");
  return { imageUrl: parsed.searchParams.get("url") || parsed.searchParams.get("u") || "", decoder: decoder.toLowerCase() };
}

function publicBaseUrl(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = String(request.headers.host || "").trim();
  if (!/^[a-z0-9.[\]-]+(?::\d+)?$/i.test(host)) return "";
  return `${request.socket.encrypted ? "https" : "http"}://${host}`;
}

function help(config) {
  return {
    name: "read2xsgg",
    status: "ok",
    usage: {
      easy: "/xbs/www.example.com/legado.json.xbs",
      easyRule: "订阅地址 = {本站}/xbs/ + 去掉 https:// 后的阅读源地址 + .xbs",
      easyQuery: "/x.xbs?u=https://www.example.com/legado.json",
      xbs: "/convert.xbs?url=https://www.example.com/legado.json",
      path: "/url/https://www.example.com/legado.json.xbs",
      json: "/j/www.example.com/legado.json",
      image: "/image/mwwz-aes?url=https://cdn.example.com/encrypted-image",
      health: "/healthz",
    },
    limits: {
      maxSourceBytes: config.maxSourceBytes,
      maxImageBytes: config.maxImageBytes,
      fetchTimeoutMs: config.fetchTimeoutMs,
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowDnsProxyNetworks: config.allowDnsProxyNetworks,
      imageDecoders: supportedImageDecoders(),
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

async function convertOnlineSource(sourceUrl, config, imageProxyBase = "") {
  const raw = await downloadSource(sourceUrl, config);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new HttpError(422, `在线阅读源不是有效 JSON：${error.message}`);
  }
  let converted;
  try {
    converted = convertLegado(parsed, { imageProxyBase });
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
      const imageTarget = imageRequestFromRequest(request);
      if (imageTarget) {
        if (!imageTarget.imageUrl) throw new HttpError(400, "缺少图片 URL");
        if (active >= config.maxConcurrent) throw new HttpError(429, "当前图片处理任务过多，请稍后重试");
        active += 1;
        let image;
        try {
          image = await downloadImage(imageTarget.imageUrl, imageTarget.decoder, config);
        } finally {
          active -= 1;
        }
        response.writeHead(200, {
          ...commonHeaders,
          "Content-Type": image.mimeType,
          "Content-Length": image.buffer.length,
          "Cache-Control": "public, max-age=3600",
          "X-Image-Decoder": image.decoder,
        });
        if (request.method === "HEAD") response.end();
        else response.end(image.buffer);
        return;
      }
      const target = sourceUrlFromRequest(request);
      if (!target) {
        sendJson(response, pathname === "/" ? 200 : 404, help(config), commonHeaders);
        return;
      }
      if (!target.sourceUrl) throw new HttpError(400, "缺少在线阅读源 URL");
      if (active >= config.maxConcurrent) throw new HttpError(429, "当前转换任务过多，请稍后重试");

      // The conversion may embed this server's public image-proxy URL in a
      // recognised comic rule, so do not share it across distinct public hosts.
      const cacheKey = `${target.sourceUrl}\n${publicBaseUrl(request, config)}`;
      let converted = cache.get(cacheKey);
      if (converted && converted.expiresAt <= Date.now()) {
        cache.delete(cacheKey);
        converted = undefined;
      }
      if (converted) converted = converted.value;
      else {
        active += 1;
        try {
          converted = await convertOnlineSource(target.sourceUrl, config, publicBaseUrl(request, config));
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
