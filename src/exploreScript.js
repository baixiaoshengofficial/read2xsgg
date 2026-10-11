import { parseLooseJson } from "./requests.js";

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const STRING_LITERAL = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;

function maskNonCode(value) {
  const source = String(value || "");
  // Keep UTF-16 indexing aligned with String#slice and the scanner below.
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

function decodeStringLiteral(literal) {
  const source = String(literal || "");
  const quote = source[0];
  const body = source.slice(1, -1);
  if (quote === '"') {
    try { return JSON.parse(source); } catch { return null; }
  }
  if (quote !== "'") return null;
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = body[++index];
    if (escaped === undefined) return null;
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "v") output += "\v";
    else if (escaped === "0") output += "\0";
    else if (["'", '"', "\\", "/"].includes(escaped)) output += escaped;
    else if (escaped === "x") {
      const hex = body.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (escaped === "u") {
      const hex = body.slice(index + 1, index + 5);
      if (!/^[\da-f]{4}$/i.test(hex)) return null;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else return null;
  }
  return output;
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

function objectInitializer(script, name) {
  const masked = maskNonCode(script);
  const pattern = new RegExp(`\\b(?:var|let|const)\\s+${name}\\s*=`);
  const match = pattern.exec(masked);
  if (!match) return null;
  const equals = masked.indexOf("=", match.index);
  const open = masked.indexOf("{", equals + 1);
  if (open < 0) return null;
  const end = matchingDelimiter(script, open, "{", "}");
  return end < 0 ? null : script.slice(open, end + 1);
}

function staticObject(script, name, splitStrings = false) {
  let source = objectInitializer(script, name);
  if (!source) return null;
  if (splitStrings) {
    const splitPattern = new RegExp(
      `(${STRING_LITERAL})\\s*\\.split\\s*\\(\\s*(${STRING_LITERAL})\\s*\\)`,
      "g",
    );
    source = source.replace(splitPattern, (_match, valueLiteral, separatorLiteral) => {
      const value = decodeStringLiteral(valueLiteral);
      const separator = decodeStringLiteral(separatorLiteral);
      return value === null || separator === null
        ? "null"
        : JSON.stringify(value.split(separator));
    });
  }
  const parsed = parseLooseJson(source, () => {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.keys(parsed).length ? parsed : null;
}

function assignmentExpression(script, name) {
  const masked = maskNonCode(script);
  const pattern = new RegExp(`\\b(?:var|let|const)\\s+${name}\\s*=`);
  const match = pattern.exec(masked);
  if (!match) return "";
  const start = masked.indexOf("=", match.index) + 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === ";" && parentheses === 0 && brackets === 0 && braces === 0) {
      return script.slice(start, index).trim();
    }
  }
  return "";
}

function splitConditional(expression) {
  const masked = maskNonCode(expression);
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let question = -1;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (parentheses === 0 && brackets === 0 && braces === 0 && char === "?" && question < 0) {
      question = index;
    } else if (parentheses === 0 && brackets === 0 && braces === 0 && char === ":" && question >= 0) {
      return {
        condition: expression.slice(0, question).trim(),
        whenTrue: expression.slice(question + 1, index).trim(),
        whenFalse: expression.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function evaluateUrlTemplate(expression, variables, itemName, item) {
  let index = 0;
  let output = "";
  const source = String(expression || "");
  const skipSpace = () => {
    while (/\s/.test(source[index] || "")) index += 1;
  };
  while (index < source.length) {
    skipSpace();
    let value;
    const char = source[index];
    if (char === "'" || char === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        if (escaped) escaped = false;
        else if (source[end] === "\\") escaped = true;
        else if (source[end] === char) break;
      }
      if (end >= source.length) return "";
      value = decodeStringLiteral(source.slice(index, end + 1));
      if (value === null) return "";
      index = end + 1;
    } else {
      const identifier = source.slice(index).match(new RegExp(`^${IDENTIFIER}`))?.[0];
      if (!identifier) return "";
      index += identifier.length;
      skipSpace();
      if (identifier === "encodeURIComponent" && source[index] === "(") {
        index += 1;
        skipSpace();
        const argument = source.slice(index).match(new RegExp(`^${IDENTIFIER}`))?.[0];
        if (argument !== itemName) return "";
        index += argument.length;
        skipSpace();
        if (source[index] !== ")") return "";
        index += 1;
        value = encodeURIComponent(String(item));
      } else if (variables.has(identifier)) {
        const mapped = variables.get(identifier);
        if (!["string", "number", "boolean"].includes(typeof mapped)) return "";
        value = String(mapped);
      } else return "";
    }
    output += value;
    skipSpace();
    if (index >= source.length) break;
    if (source[index] !== "+") return "";
    index += 1;
  }
  return /^(?:https?:\/\/|\/)/i.test(output) ? output : "";
}

/**
 * Read only a pure-data explore UI: a literal nested dictionary, default state,
 * lookup maps, and a URL assembled from string literals plus those lookups.
 * No source function or remote JavaScript is evaluated.
 */
export function extractDataDrivenExploreEntries(scriptValue) {
  const script = String(scriptValue || "");
  if (!script || script.length > 512 * 1024) return [];
  const masked = maskNonCode(script);
  if (!/\breturn\s+JSON\.stringify\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(masked)) return [];

  const itemsMatch = masked.match(new RegExp(
    `\\b(?:var|let|const)\\s+(?<items>${IDENTIFIER})\\s*=\\s*(?<dictionary>${IDENTIFIER})\\s*\\[\\s*(?<state>${IDENTIFIER})\\.(?<channel>${IDENTIFIER})\\s*\\]\\s*\\[\\s*\\k<state>\\.(?<category>${IDENTIFIER})\\s*\\]`,
  ));
  if (!itemsMatch?.groups) return [];
  const { items: itemsName, dictionary: dictionaryName, state: stateName, channel: channelField, category: categoryField } = itemsMatch.groups;
  const state = staticObject(script, stateName);
  const dictionary = staticObject(script, dictionaryName, true);
  if (!state || !dictionary || !Object.hasOwn(state, channelField) || !Object.hasOwn(state, categoryField)) return [];
  const items = dictionary[state[channelField]]?.[state[categoryField]];
  if (!Array.isArray(items) || !items.length || items.length > 2_000) return [];

  const itemName = masked.match(new RegExp(
    `\\b(?:var|let|const)\\s+(?<item>${IDENTIFIER})\\s*=\\s*${itemsName}\\s*\\[`,
  ))?.groups?.item;
  if (!itemName) return [];
  const pushPattern = new RegExp(
    `\\b${IDENTIFIER}\\s*\\.\\s*push\\s*\\(\\s*\\{\\s*title\\s*:\\s*${itemName}\\s*,\\s*url\\s*:\\s*(?<url>${IDENTIFIER})`,
  );
  const urlName = masked.match(pushPattern)?.groups?.url;
  if (!urlName) return [];

  const variables = new Map();
  const mapReads = new RegExp(
    `\\b(?:var|let|const)\\s+(?<target>${IDENTIFIER})\\s*=\\s*(?<map>${IDENTIFIER})\\s*\\[\\s*${stateName}\\.(?<field>${IDENTIFIER})\\s*\\]`,
    "g",
  );
  for (const match of masked.matchAll(mapReads)) {
    // The first lookup of `dict[state.channel][state.category]` selects an
    // array, not a scalar URL parameter. It is consumed above as category data.
    if (match.groups.target === itemsName && match.groups.map === dictionaryName) continue;
    const valueMap = staticObject(script, match.groups.map);
    if (!valueMap || !Object.hasOwn(state, match.groups.field)) return [];
    const value = valueMap[state[match.groups.field]];
    if (!["string", "number", "boolean"].includes(typeof value)) return [];
    variables.set(match.groups.target, value);
  }
  if (!variables.size) return [];

  const urlExpression = assignmentExpression(script, urlName);
  const conditional = splitConditional(urlExpression);
  if (!conditional) return [];
  const condition = conditional.condition.match(new RegExp(
    `^\\s*\\(\\s*${stateName}\\.(?<field>${IDENTIFIER})\\s*={2,3}\\s*(?<value>${STRING_LITERAL})\\s*\\)\\s*$`,
  ));
  if (!condition?.groups || !Object.hasOwn(state, condition.groups.field)) return [];
  const expected = decodeStringLiteral(condition.groups.value);
  if (expected === null) return [];
  const branch = String(state[condition.groups.field]) === expected
    ? conditional.whenTrue
    : conditional.whenFalse;

  const entries = [];
  const seen = new Set();
  for (const rawItem of items) {
    const title = String(rawItem ?? "").trim();
    if (!title || title.length > 160) continue;
    const url = evaluateUrlTemplate(branch, variables, itemName, title);
    if (!url || url.length > 4_096) continue;
    const identity = `${title}\n${url}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push({ title, url, group: "" });
  }
  return entries;
}
