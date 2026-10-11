#!/usr/bin/env node
import { createAgentBridge } from "../src/agentBridge.js";

const bridge = createAgentBridge({ dataDir: process.env.DATA_DIR || "./data" });
try {
  const socketPath = await bridge.listen();
  process.stdout.write(`CLI bridge listening on ${socketPath}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

for (const name of ["SIGINT", "SIGTERM"]) {
  process.once(name, () => bridge.close().finally(() => process.exit()));
}
