import { responseText } from "../httpTransport.js";
import { parseHeaders } from "../requests.js";

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const SAFE_PROPERTY = /^[A-Za-z_$][\w$-]{0,63}$/;
const MAX_SCRIPT_CHARS = 256 * 1024;
const MAX_CATEGORY_ROWS = 300;

function maskNonCode(value) {
  const source = String(value || "");
  const output = source.split("");
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (char !== "\n" && char !== "\r") output[index] = " ";
      continue;
    }
    if (quote) {
      if (char !== "\n" && char !== "\r") output[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      blockComment = true;
    } else if (char === "'" || char === '"' || char === "`") {
      output[index] = " ";
      quote = char;
    }
  }
  return output.join("");
}

function readString(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    if (escaped) escaped = false;
    else if (source[index] === "\\") escaped = true;
    else if (source[index] === quote) {
      const body = source.slice(start + 1, index);
      try {
        return {
          end: index + 1,
          value: quote === '"'
            ? JSON.parse(`"${body}"`)
            : body.replace(/\\(['"\\/])/g, "$1")
              .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t"),
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function matchingDelimiter(source, start, open, close) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) return -1;
      index = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source, delimiter = ",") {
  const parts = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === delimiter && parentheses === 0 && brackets === 0 && braces === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function tokenizeExpression(value) {
  const source = String(value || "");
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    const string = readString(source, index);
    if (string) {
      tokens.push({ type: "literal", value: string.value });
      index = string.end;
      continue;
    }
    const number = source.slice(index).match(/^\d+(?:\.\d+)?/);
    if (number) {
      tokens.push({ type: "literal", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = source.slice(index).match(new RegExp(`^${IDENTIFIER}`))?.[0];
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier });
      index += identifier.length;
      continue;
    }
    if ("()+.,[]".includes(source[index])) {
      tokens.push({ type: source[index], value: source[index] });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function primitive(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? String(value) : null;
}

function propertyPathValue(value, path) {
  let current = value;
  for (const field of path) {
    if (field === "__proto__" || field === "prototype" || field === "constructor") return undefined;
    if (current == null || !Object.hasOwn(Object(current), field)) return undefined;
    current = current[field];
  }
  return current;
}

function evaluateExpression(expression, context, depth = 0) {
  if (depth > 8) return undefined;
  const tokens = tokenizeExpression(expression);
  if (!tokens?.length) return undefined;
  let cursor = 0;

  const readPrimary = () => {
    const token = tokens[cursor++];
    if (!token) return undefined;
    if (token.type === "literal") return token.value;
    if (token.type === "(") {
      const value = readConcat();
      if (tokens[cursor++]?.type !== ")") return undefined;
      return value;
    }
    if (token.type !== "identifier") return undefined;

    let value;
    let rowValue = false;
    if (["encodeURIComponent", "encodeURI", "String"].includes(token.value)
      && tokens[cursor]?.type === "(") {
      cursor += 1;
      const argument = readConcat();
      if (tokens[cursor++]?.type !== ")") return undefined;
      const text = primitive(argument);
      if (text === null) return undefined;
      if (token.value === "encodeURIComponent") return encodeURIComponent(text);
      if (token.value === "encodeURI") return encodeURI(text);
      return text;
    }

    if (Object.hasOwn(context.locals || {}, token.value)) {
      value = evaluateExpression(context.locals[token.value], context, depth + 1);
    } else if (Object.hasOwn(context.constants || {}, token.value)) {
      value = context.constants[token.value];
    } else if (token.value === context.rowName) {
      value = context.row;
      rowValue = true;
    } else if (token.value === context.collectionName && tokens[cursor]?.type === "[") {
      cursor += 1;
      if (tokens[cursor++]?.value !== context.indexName || tokens[cursor++]?.type !== "]") return undefined;
      value = context.row;
      rowValue = true;
    } else if (token.value === "source" && tokens[cursor]?.type === ".") {
      cursor += 1;
      if (tokens[cursor++]?.value !== "bookSourceUrl") return undefined;
      value = context.sourceUrl;
    } else {
      return undefined;
    }

    while (cursor < tokens.length) {
      if (tokens[cursor]?.type === ".") {
        cursor += 1;
        const field = tokens[cursor++];
        if (field?.type !== "identifier" || !SAFE_PROPERTY.test(field.value)) return undefined;
        value = propertyPathValue(value, [field.value]);
      } else if (tokens[cursor]?.type === "[") {
        cursor += 1;
        const field = tokens[cursor++];
        if (field?.type !== "literal" || !["string", "number"].includes(typeof field.value)
          || tokens[cursor++]?.type !== "]") return undefined;
        value = propertyPathValue(value, [field.value]);
      } else break;
      if (value === undefined) return undefined;
      rowValue ||= Boolean(context.row && value !== context.row);
    }
    if (rowValue && context.rowReference) context.rowReference.value = true;
    return value;
  };

  const readConcat = () => {
    let value = readPrimary();
    if (value === undefined) return undefined;
    while (tokens[cursor]?.type === "+") {
      cursor += 1;
      const right = readPrimary();
      const leftText = primitive(value);
      const rightText = primitive(right);
      if (leftText === null || rightText === null) return undefined;
      value = leftText + rightText;
    }
    return value;
  };

  const result = readConcat();
  return cursor === tokens.length ? result : undefined;
}

function propertyPathFromExpression(expression, baseName) {
  const source = String(expression || "").trim().replace(/\s*\|\|\s*\[\s*\]\s*$/, "");
  const match = source.match(new RegExp(`^${baseName}((?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\])*)$`));
  if (!match) return null;
  const path = [];
  const suffix = match[1];
  for (const part of suffix.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    path.push(part[1] ?? Number(part[2]));
  }
  return path;
}

function declarationExpression(script, masked, name, beforeIndex) {
  const pattern = new RegExp(`\\b(?:(?:var|let|const)\\s+)?${name}\\s*=` , "g");
  let selected = null;
  for (const match of masked.matchAll(pattern)) {
    if (match.index >= beforeIndex) break;
    const equals = masked.indexOf("=", match.index);
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    for (let index = equals + 1; index < masked.length; index += 1) {
      const char = masked[index];
      if (char === "(") parentheses += 1;
      else if (char === ")") parentheses -= 1;
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets -= 1;
      else if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      else if (char === ";" && parentheses === 0 && brackets === 0 && braces === 0) {
        selected = script.slice(equals + 1, index).trim();
        break;
      }
    }
  }
  return selected;
}

function staticStringConstants(script, masked, sourceUrl) {
  const constants = {};
  const pattern = new RegExp(`\\b(?:var|let|const)\\s+(${IDENTIFIER})\\s*=`, "g");
  for (const match of masked.matchAll(pattern)) {
    const expression = declarationExpression(script, masked, match[1], script.length);
    if (!expression) continue;
    const value = evaluateExpression(expression, { constants, sourceUrl });
    if (typeof value === "string" && value.length <= 4_096) constants[match[1]] = value;
  }
  return constants;
}

function parseJsonAjaxAssignments(script, masked) {
  const assignments = [];
  const pattern = new RegExp(`\\b(?:(?:var|let|const)\\s+)?(${IDENTIFIER})\\s*=\\s*JSON\\.parse\\s*\\(`, "gi");
  for (const match of masked.matchAll(pattern)) {
    const parseOpen = masked.indexOf("(", match.index + match[0].lastIndexOf("JSON.parse"));
    const parseEnd = matchingDelimiter(script, parseOpen, "(", ")");
    if (parseEnd < 0) continue;
    const argument = script.slice(parseOpen + 1, parseEnd).trim();
    const argumentMasked = maskNonCode(argument);
    const ajaxMatch = argumentMasked.match(/\bjava\.ajax\s*\(/i);
    if (!ajaxMatch) continue;
    const ajaxOpen = argumentMasked.indexOf("(", ajaxMatch.index);
    const ajaxEnd = matchingDelimiter(argument, ajaxOpen, "(", ")");
    if (ajaxEnd < 0) continue;
    const ajaxArgs = splitTopLevel(argument.slice(ajaxOpen + 1, ajaxEnd));
    if (!ajaxArgs[0] || ajaxArgs.length > 2) continue;
    const suffix = script.slice(parseEnd + 1).match(/^\s*((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)/)?.[1] || "";
    const path = [];
    for (const item of suffix.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
      path.push(item[1] ?? Number(item[2]));
    }
    assignments.push({
      variable: match[1],
      path,
      endpointExpression: ajaxArgs[0],
      index: match.index,
    });
  }
  return assignments;
}

function loopCandidates(script, masked) {
  const loops = [];
  const pattern = new RegExp(
    `\\bfor\\s*\\(\\s*(?:(?:var|let|const)\\s+)?(${IDENTIFIER})\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*(${IDENTIFIER})\\s*\\.\\s*length\\s*;\\s*(?:\\1\\s*\\+\\+|\\+\\+\\1)\\s*\\)`,
    "g",
  );
  for (const match of masked.matchAll(pattern)) {
    let bodyStart = match.index + match[0].length;
    while (/\s/.test(masked[bodyStart] || "")) bodyStart += 1;
    if (masked[bodyStart] !== "{") continue;
    const bodyEnd = matchingDelimiter(script, bodyStart, "{", "}");
    if (bodyEnd < 0) continue;
    loops.push({
      indexName: match[1],
      collectionName: match[2],
      start: match.index,
      bodyStart,
      bodyEnd,
      body: script.slice(bodyStart + 1, bodyEnd),
    });
  }
  return loops;
}

function callbackCandidates(script, masked) {
  const candidates = [];
  const pattern = new RegExp(
    `\\b(${IDENTIFIER})\\s*\\.\\s*(?:forEach|map)\\s*\\(\\s*(?:function\\s*\\(\\s*(${IDENTIFIER})\\s*\\)|\\(?\\s*(${IDENTIFIER})\\s*\\)?\\s*=>)\\s*\\{`,
    "g",
  );
  for (const match of masked.matchAll(pattern)) {
    const bodyStart = masked.indexOf("{", match.index + match[0].length - 1);
    const bodyEnd = matchingDelimiter(script, bodyStart, "{", "}");
    if (bodyEnd < 0) continue;
    candidates.push({
      indexName: "",
      collectionName: match[1],
      rowName: match[2] || match[3],
      start: match.index,
      bodyStart,
      bodyEnd,
      body: script.slice(bodyStart + 1, bodyEnd),
    });
  }
  return candidates;
}

function pushExpressions(body) {
  const masked = maskNonCode(body);
  const pushes = [];
  for (const match of masked.matchAll(/\bpush\s*\(/g)) {
    const before = masked.slice(0, match.index).trimEnd();
    if (before.endsWith(".")) continue;
    const open = masked.indexOf("(", match.index);
    const end = matchingDelimiter(body, open, "(", ")");
    if (end < 0) continue;
    const args = splitTopLevel(body.slice(open + 1, end));
    if (args.length < 2 || !args[0] || !args[1]) continue;
    pushes.push({ title: args[0], url: args[1], index: match.index });
  }
  return pushes;
}

function rowAliasForLoop(loop) {
  if (loop.rowName) return loop.rowName;
  const masked = maskNonCode(loop.body);
  const match = masked.match(new RegExp(
    `\\b(?:(?:var|let|const)\\s+)?(${IDENTIFIER})\\s*=\\s*${loop.collectionName}\\s*\\[\\s*${loop.indexName}\\s*\\]`,
  ));
  return match?.[1] || "";
}

function referencesLoopRow(expression, loop, rowNames) {
  const masked = maskNonCode(expression);
  return [...rowNames].some((name) => new RegExp(`\\b${name}\\b`).test(masked))
    || (loop.indexName && new RegExp(
      `\\b${loop.collectionName}\\s*\\[\\s*${loop.indexName}\\s*\\]\\s*(?:\\.|\\[)`,
    ).test(masked));
}

function loopRowNames(loop, rowName) {
  const names = new Set(rowName ? [rowName] : []);
  const masked = maskNonCode(loop.body);
  const assignments = new RegExp(`\\b(?:(?:var|let|const)\\s+)?(${IDENTIFIER})\\s*=`, "g");
  for (let pass = 0; pass < 3; pass += 1) {
    for (const match of masked.matchAll(assignments)) {
      if (names.has(match[1])) continue;
      const expression = declarationExpression(loop.body, masked, match[1], loop.body.length);
      if (expression && referencesLoopRow(expression, loop, names)) names.add(match[1]);
    }
  }
  return names;
}

function resolveArrayPath(loop, assignment, script, masked) {
  if (loop.collectionName === assignment.variable) return assignment.path;
  const expression = declarationExpression(script, masked, loop.collectionName, loop.start);
  if (!expression) return null;
  const path = propertyPathFromExpression(expression, assignment.variable);
  return path ? [...assignment.path, ...path] : null;
}

function requestHeaders(source) {
  const headers = parseHeaders(source?.header, () => {});
  if (source?.httpUserAgent) headers["User-Agent"] = String(source.httpUserAgent);
  return headers;
}

function normalizeEndpoint(value, sourceUrl) {
  let endpoint = String(value || "").trim()
    .replace(/\{\{\s*(?:Get|get)\(\s*["']url["']\s*\)\s*\}\}/gi, sourceUrl);
  if (!endpoint || endpoint.length > 4_096 || /[<>\r\n]/.test(endpoint)) return "";
  try {
    const parsed = new URL(endpoint, sourceUrl);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * Recognize a deliberately small, side-effect-free Legado explore subset:
 * one JSON array fetched with java.ajax(), a numeric for-loop, and push(title,
 * url) values assembled only from literals, static variables, row properties,
 * and URL encoding. The source script is inspected but never executed.
 */
export function inferAjaxArrayExplore(source) {
  const script = String(source?.exploreUrl || "").trim();
  if (!/^(?:@js:|<js>)/i.test(script) || script.length > MAX_SCRIPT_CHARS) return null;
  if (!/JSON\.stringify\s*\(/i.test(script)) return null;
  const masked = maskNonCode(script);
  const constants = staticStringConstants(script, masked, String(source?.bookSourceUrl || ""));
  const assignments = parseJsonAjaxAssignments(script, masked);
  const loops = [...loopCandidates(script, masked), ...callbackCandidates(script, masked)];
  for (const assignment of assignments) {
    const endpointValue = evaluateExpression(assignment.endpointExpression, { constants, sourceUrl: source?.bookSourceUrl || "" });
    const endpoint = normalizeEndpoint(endpointValue, String(source?.bookSourceUrl || ""));
    if (!endpoint) continue;
    for (const loop of loops) {
      const arrayPath = resolveArrayPath(loop, assignment, script, masked);
      if (!arrayPath) continue;
      const rowName = rowAliasForLoop(loop);
      const rowNames = loopRowNames(loop, rowName);
      const pushes = pushExpressions(loop.body).filter((push) => (
        referencesLoopRow(push.title, loop, rowNames) || referencesLoopRow(push.url, loop, rowNames)
      ));
      if (!pushes.length) continue;
      return {
        endpoint,
        arrayPath,
        constants,
        loop: {
          indexName: loop.indexName,
          collectionName: loop.collectionName,
          rowName,
          body: loop.body,
          pushes,
        },
        headers: requestHeaders(source),
      };
    }
  }
  return null;
}

function evaluateLoopLocals(body, context) {
  const masked = maskNonCode(body);
  const locals = Object.create(null);
  const pattern = new RegExp(`\\b(?:(?:var|let|const)\\s+)?(${IDENTIFIER})\\s*=`, "g");
  for (const match of masked.matchAll(pattern)) {
    const expression = declarationExpression(body, masked, match[1], body.length);
    if (!expression || match[1] === context.rowName) continue;
    const value = evaluateExpression(expression, { ...context, locals });
    if (value !== undefined) locals[match[1]] = expression;
  }
  return locals;
}

function evaluatePush(push, context) {
  const rowReference = { value: false };
  const valueContext = { ...context, rowReference };
  const title = evaluateExpression(push.title, valueContext);
  if (!rowReference.value) return null;
  const url = evaluateExpression(push.url, valueContext);
  if (title === undefined || url === undefined) return null;
  const titleText = String(title).replace(/\s+/g, " ").trim();
  const rawUrl = String(url).trim();
  if (!titleText || titleText.length > 160 || !rawUrl || rawUrl.length > 4_096) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl, context.sourceUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
  return { title: titleText, url: parsed.toString(), group: "" };
}

export async function materializeAjaxArrayExplore(source, { download } = {}) {
  const inferred = inferAjaxArrayExplore(source);
  if (!inferred || typeof download !== "function") return { materialized: false, entries: [] };
  const payload = JSON.parse(responseText(await download(inferred.endpoint, inferred.headers)));
  let rows = propertyPathValue(payload, inferred.arrayPath);
  if (!Array.isArray(rows) && inferred.arrayPath.length === 0 && Array.isArray(payload)) rows = payload;
  if (!Array.isArray(rows) || !rows.length) throw new Error("动态分类接口没有返回数组");
  const entries = [];
  const seen = new Set();
    const { loop } = inferred;
  const count = Math.min(rows.length, MAX_CATEGORY_ROWS);
  for (let index = 0; index < count; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const context = {
      constants: inferred.constants,
      sourceUrl: String(source?.bookSourceUrl || ""),
      row,
      rowName: loop.rowName,
      collectionName: loop.collectionName,
      indexName: loop.indexName,
      locals: {},
    };
    context.locals = evaluateLoopLocals(loop.body, context);
    for (const push of loop.pushes) {
      const entry = evaluatePush(push, context);
      if (!entry) continue;
      const identity = `${entry.title}\n${entry.url}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
      if (entries.length >= MAX_CATEGORY_ROWS) break;
    }
    if (entries.length >= MAX_CATEGORY_ROWS) break;
  }
  if (!entries.length) throw new Error("动态分类数组没有可安全映射的标题和 URL");
  return { materialized: true, entries, endpoint: inferred.endpoint, rowCount: rows.length };
}
