const CONTENT_ENDPOINT = /(?:chapter|catalog|directory|menu|list|episode|comic|manga|book|read|get)/i;

function datasetVariables(html) {
  const source = String(html || "");
  const elementIds = new Map();
  const variables = new Map();
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    elementIds.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\??\.dataset\??\.([A-Za-z_$][\w$]*)/g)) {
    const id = elementIds.get(match[2]);
    if (!id) continue;
    const tag = source.match(new RegExp(`<[^>]+\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i"))?.[0] || "";
    const kebab = match[3].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const value = tag.match(new RegExp(`\\bdata-${kebab}=["']([^"']*)["']`, "i"))?.[1];
    if (value !== undefined) variables.set(match[1], value);
  }
  return variables;
}

function templateUrl(token, variables, pageUrl) {
  const source = String(token || "").trim();
  let value = "";
  if (source.startsWith("`") && source.endsWith("`")) {
    value = source.slice(1, -1).replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (match, name) => (
      variables.has(name) ? variables.get(name) : match
    ));
    if (/\$\{/.test(value)) return "";
  } else if ((source.startsWith('"') && source.endsWith('"'))
    || (source.startsWith("'") && source.endsWith("'"))) {
    try {
      value = source[0] === '"' ? JSON.parse(source) : source.slice(1, -1).replace(/\\'/g, "'");
    } catch {
      return "";
    }
  } else {
    return "";
  }
  try {
    const url = new URL(value, pageUrl);
    if (url.origin !== new URL(pageUrl).origin || !CONTENT_ENDPOINT.test(`${url.pathname}${url.search}`)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Resolve a same-origin HTML fragment endpoint declared by a page's fetch(). */
export function dynamicHtmlRequestUrl(html, pageUrl) {
  const variables = datasetVariables(html);
  const assignedUrls = new Map();
  const literalPattern = "`(?:\\\\.|[^`])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
  for (const match of String(html || "").matchAll(new RegExp(
    `\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${literalPattern})`,
    "g",
  ))) {
    const url = templateUrl(match[2], variables, pageUrl);
    if (url) assignedUrls.set(match[1], url);
  }
  const candidates = [];
  let order = 0;
  const fetchPattern = new RegExp(
    `\\bfetch\\(\\s*(${literalPattern}|[A-Za-z_$][\\w$]*)`,
    "g",
  );
  for (const match of String(html || "").matchAll(fetchPattern)) {
    const url = assignedUrls.get(match[1]) || templateUrl(match[1], variables, pageUrl);
    if (!url) continue;
    const parsed = new URL(url);
    const score = (/(?:chapter|catalog|directory|menu|list|episode)/i.test(`${parsed.pathname}${parsed.search}`) ? 500 : 0)
      + ((match[1].includes("${") || assignedUrls.has(match[1])) ? 100 : 0)
      - order;
    candidates.push({ url, score });
    order += 1;
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.url || "";
}
