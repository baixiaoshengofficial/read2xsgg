#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { convertLegado, encodeXbs } from "../src/index.js";

function usage() {
  return `read2xsgg - 将阅读（Legado）书源转换为香色闺阁源

用法:
  read2xsgg <input.json|url|-> [选项]

选项:
  -o, --output <file>   输出 XBS 文件（默认：<输入名>.xbs）
  --json <file>         同时输出可审阅的香色 JSON
  --json-only           只输出 JSON，不生成 XBS
  --report <file>       写入兼容性告警报告
  --compact             JSON 不进行格式化
  -h, --help            显示帮助

示例:
  read2xsgg legado.json -o sources.xbs --json sources.converted.json --report report.json
  curl -s https://example.com/sources.json | read2xsgg - --json-only > sources.json
`;
}

function parseArguments(argv) {
  const options = { compact: false, jsonOnly: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--json-only") options.jsonOnly = true;
    else if (argument === "-o" || argument === "--output") {
      options.output = argv[++index];
      if (!options.output || options.output.startsWith("-")) throw new Error(`${argument} 后缺少文件路径`);
    } else if (argument === "--json") {
      options.json = argv[++index];
      if (!options.json || options.json.startsWith("-")) throw new Error("--json 后缺少文件路径");
    } else if (argument === "--report") {
      options.report = argv[++index];
      if (!options.report || options.report.startsWith("-")) throw new Error("--report 后缺少文件路径");
    }
    else if (argument === "-") positional.push(argument);
    else if (argument.startsWith("-")) throw new Error(`未知选项：${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new Error(`只能指定一个输入，额外参数：${positional.slice(1).join(" ")}`);
  options.input = positional[0];
  return options;
}

async function readInput(input) {
  if (input === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);
    if (!response.ok) throw new Error(`下载阅读源失败：HTTP ${response.status}`);
    return response.text();
  }
  return readFile(resolve(input), "utf8");
}

function defaultOutput(input) {
  if (input === "-" || /^https?:\/\//i.test(input)) return resolve("sources.xbs");
  const extension = extname(input);
  const stem = extension ? input.slice(0, -extension.length) : input;
  return resolve(`${stem}.xbs`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.input) throw new Error(`缺少输入文件\n\n${usage()}`);
  const raw = await readInput(options.input);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`输入不是有效 JSON：${error.message}`);
  }
  const { sources, warnings } = convertLegado(parsed);
  const count = Object.keys(sources).length;
  if (!count) throw new Error("输入中没有可转换的阅读源");
  const spacing = options.compact ? 0 : 2;
  const json = `${JSON.stringify(sources, null, spacing)}\n`;

  if (options.jsonOnly && !options.json) {
    process.stdout.write(json);
  } else {
    if (!options.jsonOnly) {
      const xbsPath = resolve(options.output ?? defaultOutput(options.input));
      await writeFile(xbsPath, encodeXbs(json));
      process.stderr.write(`✓ 已生成 ${count} 个香色闺阁源：${xbsPath}\n`);
    }
    if (options.json) {
      const jsonPath = resolve(options.json);
      await writeFile(jsonPath, json, "utf8");
      process.stderr.write(`✓ 已生成可审阅 JSON：${jsonPath}\n`);
    }
  }

  if (options.report) {
    const reportPath = resolve(options.report);
    await writeFile(reportPath, `${JSON.stringify({ converted: count, warningCount: warnings.length, warnings }, null, 2)}\n`, "utf8");
    process.stderr.write(`✓ 已生成兼容性报告：${reportPath}\n`);
  }
  if (warnings.length) {
    process.stderr.write(`⚠ 转换完成，但有 ${warnings.length} 项需要人工复核${options.report ? "（详见报告）" : "（使用 --report 导出详情）"}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
