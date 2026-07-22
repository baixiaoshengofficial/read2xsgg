#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import {
  createLibraryStore,
  rebaseLibraryArtifact,
  serverConfig,
} from "../src/index.js";

function usage() {
  return `rebase-library - 将库制品中的公开桥接 origin 安全替换为新 origin

用法:
  rebase-library --id <jobId> --from <oldOrigin> --to <newOrigin> [选项]

仅替换属于旧公开桥接 origin 的 URL 出现（含百分号编码形式），保留任务 id、
订阅路径与 source payload。JSON 与 XBS 保持一致。不依赖源名称或上游站点域名。

选项:
  --id <jobId>         已有库任务 ID（订阅路径保持 /library/{id}.xbs）
  --from <origin>      旧公开桥接 origin（如 https://old.example）
  --to <origin>        新公开桥接 origin（如 https://new.example）
  --data-dir <dir>     DATA_DIR（默认环境变量或 ./data）
  --dry-run            只校验并统计替换次数，不写入制品
  -h, --help           显示帮助

示例:
  rebase-library --id 8ffae8f853174022 --from https://old.example --to https://new.example --dry-run
  rebase-library --id abc123 --from https://old.example --to https://new.example --data-dir ./data

输出仅为摘要（id、origins、replacements 等），不会打印完整制品内容。
`;
}

function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--id") {
      options.id = argv[++index];
      if (!options.id || options.id.startsWith("-")) throw new Error("--id 后缺少任务 ID");
    } else if (argument === "--from") {
      options.from = argv[++index];
      if (!options.from || options.from.startsWith("-")) throw new Error("--from 后缺少旧 origin");
    } else if (argument === "--to") {
      options.to = argv[++index];
      if (!options.to || options.to.startsWith("-")) throw new Error("--to 后缺少新 origin");
    } else if (argument === "--data-dir") {
      options.dataDir = argv[++index];
      if (!options.dataDir || options.dataDir.startsWith("-")) throw new Error("--data-dir 后缺少目录");
    } else if (argument.startsWith("-")) throw new Error(`未知选项：${argument}`);
    else throw new Error(`多余参数：${argument}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.id) throw new Error("缺少 --id");
  if (!options.from) throw new Error("缺少 --from");
  if (!options.to) throw new Error("缺少 --to");

  const config = serverConfig(process.env);
  const dataDir = resolve(options.dataDir || config.dataDir || "./data");
  const store = createLibraryStore(dataDir);

  const { summary } = await rebaseLibraryArtifact({
    store,
    jobId: options.id,
    oldOrigin: options.from,
    newOrigin: options.to,
    dryRun: options.dryRun,
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  // Never dump artifact bodies; message/stack only.
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
