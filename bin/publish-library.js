#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  createLibraryStore,
  publishLibraryArtifact,
  serverConfig,
} from "../src/index.js";

function usage() {
  return `publish-library - 用显式声明式阅读源 JSON 覆盖已有 /library/{id}.xbs 制品

用法:
  publish-library --id <jobId> --source <legado.json> [选项]

选项:
  --id <jobId>                 已有库任务 ID（订阅路径保持 /library/{id}.xbs）
  --source <file>              声明式 Legado JSON（可含 ruleContent.mediaResolution 或 read2xsgg.mediaResolution）
  --data-dir <dir>             DATA_DIR（默认环境变量或 ./data）
  --image-proxy-base <url>     写入适配器链接的公开基址（默认沿用任务记录）
  --verify                     发布时顺带抽测（默认只转换，便于离线确定性发布）
  -h, --help                   显示帮助

示例:
  publish-library --id 8ffae8f853174022 --source sources/migrations/lian-ting.legado.json
  publish-library --id abc123 --source ./fixture.json --data-dir ./data --image-proxy-base https://convert.example
`;
}

function parseArguments(argv) {
  const options = { verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--verify") options.verify = true;
    else if (argument === "--id") {
      options.id = argv[++index];
      if (!options.id || options.id.startsWith("-")) throw new Error("--id 后缺少任务 ID");
    } else if (argument === "--source") {
      options.source = argv[++index];
      if (!options.source || options.source.startsWith("-")) throw new Error("--source 后缺少文件路径");
    } else if (argument === "--data-dir") {
      options.dataDir = argv[++index];
      if (!options.dataDir || options.dataDir.startsWith("-")) throw new Error("--data-dir 后缺少目录");
    } else if (argument === "--image-proxy-base") {
      options.imageProxyBase = argv[++index];
      if (!options.imageProxyBase || options.imageProxyBase.startsWith("-")) {
        throw new Error("--image-proxy-base 后缺少 URL");
      }
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
  if (!options.source) throw new Error("缺少 --source");

  const config = serverConfig(process.env);
  const dataDir = resolve(options.dataDir || config.dataDir || "./data");
  const store = createLibraryStore(dataDir);
  const sourceText = await readFile(resolve(options.source), "utf8");
  const source = JSON.parse(sourceText.replace(/^\uFEFF/, ""));

  const { job, result } = await publishLibraryArtifact({
    store,
    jobId: options.id,
    source,
    config,
    imageProxyBase: options.imageProxyBase || "",
    verify: options.verify,
  });

  process.stdout.write(`${JSON.stringify({
    id: job.id,
    status: job.status,
    count: job.count,
    subscribePath: job.subscribePath,
    publishedFrom: job.publishedFrom,
    sourcePayloadHash: job.sourcePayloadHash,
    warnings: (result.warnings || []).length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
