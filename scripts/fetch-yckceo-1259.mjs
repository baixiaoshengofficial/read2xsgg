#!/usr/bin/env node
// 拉取 yckceo 阅读源仓库的最新聚合包（默认 id=1259），作为转换器的持续测试目标。
// 用法：node scripts/fetch-yckceo-1259.mjs [输出路径] [源 id]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2] || "sources/yckceo-1259.json";
const id = process.argv[3] || "1259";
const url = `https://www.yckceo.com/yuedu/shuyuans/json/id/${id}.json`;
// yckceo 的 JSON 接口要求浏览器形态的 UA，否则返回「数据不存在」的 HTML 跳转页。
const headers = {
  Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
  "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
};

const response = await fetch(url, { headers });
if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
const body = await response.text();
if (!/^\s*[\[{]/.test(body)) {
  throw new Error(`响应不是 JSON（可能是 yckceo 的「数据不存在」跳转页），源 id=${id} 可能已删除`);
}
const parsed = JSON.parse(body);
const sources = Array.isArray(parsed) ? parsed : [];
if (!sources.length) throw new Error("源包为空");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(sources, null, 2)}\n`, "utf8");
const byType = {};
for (const source of sources) byType[source.bookSourceType] = (byType[source.bookSourceType] || 0) + 1;
console.log(`已保存 ${sources.length} 个源到 ${output}`);
console.log(`bookSourceType 分布: ${JSON.stringify(byType)}`);
