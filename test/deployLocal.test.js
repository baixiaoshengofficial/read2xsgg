import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/deploy-local.sh", import.meta.url));

test("本地部署脚本把资源覆盖值限制在宿主机的 90% 以内", () => {
  const output = execFileSync(script, ["--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RESOURCE_LIMIT_PERCENT: "90",
      CONTAINER_CPUS: "999",
      CONTAINER_MEMORY_LIMIT: "999g",
      CONTAINER_MEMORY_SWAP_LIMIT: "999g",
    },
  });
  const match = output.match(/cpus=([0-9.]+), memory=(\d+)m, memory\+swap=(\d+)m/);
  assert.ok(match, output);

  const hostCpus = Number(execFileSync("nproc", { encoding: "utf8" }).trim());
  const hostMemoryKiB = Number(
    execFileSync("awk", ["/^MemTotal:/ { print $2; exit }", "/proc/meminfo"], { encoding: "utf8" }).trim(),
  );
  assert.ok(Number(match[1]) <= hostCpus * 0.9 + 0.01);
  assert.ok(Number(match[2]) <= Math.floor(hostMemoryKiB * 0.9 / 1024));
  assert.ok(Number(match[3]) <= Math.floor(hostMemoryKiB * 0.9 / 1024));
});

test("本地部署脚本拒绝超过 90% 的资源比例", () => {
  const result = spawnSync(script, ["--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, RESOURCE_LIMIT_PERCENT: "91" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /10 到 90/);
});
