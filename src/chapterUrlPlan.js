import {
  hasUnsupportedLegadoRuntime,
  maskLegadoJavaScript,
  rewriteLegadoJavaScript,
} from "./legadoJs.js";

export const CONTEXTUAL_CHAPTER_URL_MARKER = "read2xsgg:contextual-chapter-url";

const PORTABLE_JSLIB_FORBIDDEN = /\b(?:eval|Function|require|process|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|while|do|import|export|prototype|__proto__|constructor|Packages|android|cookie)\b|\b(?:java|source)\s*\./;

function unwrapScript(rule) {
  const source = String(rule || "").trim();
  if (/^@js:/i.test(source)) return source.replace(/^@js:\s*/i, "");
  if (/^<js>/i.test(source)) return source.replace(/^<js>\s*/i, "").replace(/<\/js>\s*$/i, "");
  return "";
}

function topLevelDeclarations(source) {
  const masked = maskLegadoJavaScript(source);
  const statements = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  const push = (end) => {
    const statement = String(source).slice(start, end).trim().replace(/^;+|;+$/g, "").trim();
    if (statement) statements.push(statement);
    start = end;
  };
  for (let index = 0; index < masked.length; index += 1) {
    const token = masked[index];
    if (token === "(") round += 1;
    else if (token === ")") round -= 1;
    else if (token === "[") square += 1;
    else if (token === "]") square -= 1;
    else if (token === "{") curly += 1;
    else if (token === "}") {
      curly -= 1;
      if (round === 0 && square === 0 && curly === 0
        && /^\s*function\s+[A-Za-z_$][\w$]*\s*\(/.test(masked.slice(start, index + 1))) {
        push(index + 1);
      }
    } else if (token === ";" && round === 0 && square === 0 && curly === 0) {
      push(index + 1);
    }
  }
  push(source.length);
  return statements;
}

function portableLibrary(jsLib) {
  const source = String(jsLib || "").trim();
  if (!source) return "";
  if (source.length > 12_000 || PORTABLE_JSLIB_FORBIDDEN.test(maskLegadoJavaScript(source))) return null;
  const statements = topLevelDeclarations(source);
  if (!statements.length || statements.length > 64) return null;
  if (statements.some((statement) => !/^(?:(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=|function\s+[A-Za-z_$][\w$]*\s*\()/.test(statement))) {
    return null;
  }
  const masked = maskLegadoJavaScript(source);
  for (const match of masked.matchAll(/\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/g)) {
    const loop = [match[1], match[2], match[3]].map((part) => part.trim());
    const name = loop[0].match(/^(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*0$/)?.[1] || "";
    if (!name
      || !new RegExp(`^${name}\\s*<\\s*[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.length$`).test(loop[1])
      || !new RegExp(`^(?:\\+\\+${name}|${name}\\+\\+)$`).test(loop[2])) return null;
  }
  // rewriteLegadoJavaScript currently renames these runtime bindings across
  // nested function scopes; reject declarations anywhere in jsLib until that
  // shared rewriter can preserve lexical shadowing.
  if (/\b(?:var|let|const)\s+(?:config|params|result)\b/.test(masked)) return null;
  try {
    new Function("config", "params", "result", source);
  } catch {
    return null;
  }
  return source;
}

function rewriteCodeCallNames(source, replacements) {
  let output = String(source || "");
  const edits = [];
  const masked = maskLegadoJavaScript(output);
  for (const [pattern, replacement] of replacements) {
    for (const match of masked.matchAll(pattern)) {
      edits.push({ index: match.index, length: match[0].length, replacement });
    }
  }
  for (const edit of edits.sort((left, right) => right.index - left.index)) {
    output = `${output.slice(0, edit.index)}${edit.replacement}${output.slice(edit.index + edit.length)}`;
  }
  return output;
}

function normalizedPath(value) {
  const source = String(value || "").trim().replace(/^\$\.?/, "");
  if (!source || source.length > 256) return "";
  const parts = source.match(/[A-Za-z_$][\w$]*|\[\d{1,5}\]/g) || [];
  const rebuilt = source.replace(/\[(\d{1,5})\]/g, ".$1").replace(/^\./, "");
  if (!parts.length || rebuilt.split(".").some((part) => !/^(?:[A-Za-z_$][\w$]*|\d{1,5})$/.test(part))) return "";
  return rebuilt.replace(/\./g, "/");
}

function jsonSelectorPaths(script) {
  const paths = new Set();
  for (const match of String(script).matchAll(/\bjava\.getString\s*\(\s*(["'])(\$\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d{1,5}\])*)\1\s*\)/gi)) {
    const path = normalizedPath(match[2]);
    if (path) paths.add(path);
  }
  return [...paths].slice(0, 16);
}

function contextualResponsePaths(script) {
  const source = String(script || "");
  const ajaxVariables = new Set([...source.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*java\.ajax\s*\(/gi,
  )].map((match) => match[1]));
  const jsonVariables = [];
  for (const match of source.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\.parse\s*\(\s*String\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/gi,
  )) {
    if (ajaxVariables.has(match[2])) jsonVariables.push(match[1]);
  }
  const paths = new Set();
  const masked = maskLegadoJavaScript(source);
  for (const name of jsonVariables) {
    const pattern = new RegExp(`\\b${name}\\s*\\.\\s*((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*[A-Za-z_$][\\w$]*)`, "g");
    for (const match of masked.matchAll(pattern)) {
      let path = match[1].replace(/\s+/g, "").replace(/\./g, "/");
      const tail = masked.slice(match.index + match[0].length).match(/^\s*(.)/)?.[1] || "";
      if (tail === "(") path = path.split("/").slice(0, -1).join("/");
      if (path && path.split("/").every((part) => /^[A-Za-z_$][\w$]*$/.test(part))) paths.add(path);
    }
  }
  const all = [...paths];
  const leaves = all.filter((path) => !all.some((other) => other.startsWith(`${path}/`)));
  return leaves.slice(0, 24);
}

function itemPropertyPaths(script) {
  const paths = new Set(jsonSelectorPaths(script));
  const masked = maskLegadoJavaScript(script);
  for (const match of masked.matchAll(/\bresult\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const tail = masked.slice(match.index + match[0].length).match(/^\s*(.)/)?.[1] || "";
    if (tail !== "(") paths.add(match[1]);
  }
  return [...paths].slice(0, 16);
}

/**
 * Compile a narrow, data-backed chapter URL rule for the Xiangse JS runtime.
 * Source code is never run here: only a pure declaration-only jsLib plus
 * whitelisted Legado calls (JSON selectors, MD5, source variable cache, and
 * reads of the current catalogue response) are translated.
 */
export function compileContextualChapterUrl(rule, jsLib = "") {
  const source = unwrapScript(rule);
  if (!source || source.length > 12_000 || /`/.test(source)) return null;
  const javaCalls = [...source.matchAll(/\bjava\.([A-Za-z_$][\w$]*)\s*\(/gi)].map((match) => match[1].toLowerCase());
  if (!javaCalls.includes("ajax") || !javaCalls.includes("getstring")
    || javaCalls.some((name) => !["ajax", "getstring", "md5encode"].includes(name))) return null;
  const sourceCalls = [...source.matchAll(/\bsource\.([A-Za-z_$][\w$]*)\s*\(/gi)].map((match) => match[1].toLowerCase());
  if (sourceCalls.some((name) => !["getvariable", "setvariable"].includes(name))) return null;

  const itemPaths = itemPropertyPaths(source);
  const contextPaths = contextualResponsePaths(source);
  if (!itemPaths.length || !contextPaths.length) return null;
  const library = portableLibrary(jsLib);
  if (jsLib && library === null) return null;

  let body = rewriteCodeCallNames(source, [
    [/\bjava\.ajax(?=\s*\()/gi, "__xsContextAjax"],
    [/\bsource\.getVariable(?=\s*\(\s*\))/gi, "__xsReadContextState"],
    [/\bsource\.setVariable(?=\s*\()/gi, "__xsWriteContextState"],
  ]);

  const program = [
    "@js:",
    `/* ${CONTEXTUAL_CHAPTER_URL_MARKER} */`,
    library || "",
    "var __xsContext = result && result.__read2xsggContext || {};",
    "result = result && result.__read2xsggItem || result;",
    'var baseUrl = String((params && params.responseUrl) || (params && params.queryInfo && (params.queryInfo.chapterUrl || params.queryInfo.detailUrl || params.queryInfo.url)) || config.host || "");',
    "function __xsContextAjax(url) {",
    '  var expected = String(__xsContext.requestUrl || "").split("#")[0].split("?")[0];',
    '  var requested = String(url || "").trim().split(",{")[0].split("#")[0].split("?")[0];',
    '  if (!expected || requested !== expected) return "";',
    '  return JSON.stringify(__xsContext.payload || {});',
    "}",
    'function __xsReadContextState() { var state = __xsContext.state; return state == null ? "" : (typeof state === "string" ? state : JSON.stringify(state)); }',
    'function __xsWriteContextState(value) { __xsContext.state = value == null ? "" : String(value); return value; }',
    body,
  ].filter(Boolean).join("\n");
  const portable = rewriteLegadoJavaScript(program);
  if (hasUnsupportedLegadoRuntime(portable)) return null;
  try {
    new Function("config", "params", "result", portable.replace(/^@js:\s*/i, ""));
  } catch {
    return null;
  }
  return { rule: portable, itemPaths, contextPaths };
}
