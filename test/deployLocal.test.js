import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/deploy-local.sh", import.meta.url));

function hostCpuCount() {
  if (process.platform === "darwin") {
    return Number(spawnSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).stdout.trim());
  }
  return Number(spawnSync("nproc", { encoding: "utf8" }).stdout.trim());
}

function hostMemoryKiB() {
  if (process.platform === "darwin") {
    const bytes = Number(spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout.trim());
    return Math.floor(bytes / 1024);
  }
  return Number(
    spawnSync("awk", ["/^MemTotal:/ { print $2; exit }", "/proc/meminfo"], { encoding: "utf8" }).stdout.trim(),
  );
}

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

  const hostCpus = hostCpuCount();
  const totalMemoryKiB = hostMemoryKiB();
  assert.ok(Number(match[1]) <= hostCpus * 0.9 + 0.01);
  assert.ok(Number(match[2]) <= Math.floor(totalMemoryKiB * 0.9 / 1024));
  assert.ok(Number(match[3]) <= Math.floor(totalMemoryKiB * 0.9 / 1024));
});

test("本地部署脚本拒绝超过 90% 的资源比例", () => {
  const result = spawnSync(script, ["--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, RESOURCE_LIMIT_PERCENT: "91" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /10 到 90/);
});
