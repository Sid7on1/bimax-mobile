import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const gatewayRequire = createRequire(path.resolve("apps/gateway/package.json"));
const vitestPackage = gatewayRequire("vitest/package.json");
const vitestCli = path.resolve(
  path.dirname(gatewayRequire.resolve("vitest/package.json")),
  typeof vitestPackage.bin === "string" ? vitestPackage.bin : vitestPackage.bin.vitest,
);
const tscCli = path.resolve("node_modules/typescript/bin/tsc");
// Fail fast, avoid indefinitely hanging suites, and use the same pinned Node for children.
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24 (see .nvmrc)");
const cases = [
  [tscCli, "-p", "packages/core/tsconfig.json"],
  [tscCli, "-p", "apps/relay/tsconfig.json"],
  [tscCli, "-p", "apps/desktop-responder/tsconfig.json"],
  ["apps/mobile/test/auth-flow-test.mjs"],
  ["apps/mobile/test/chat-stream-test.mjs"],
  ["apps/mobile/test/preferences-test.mjs"],
  ["apps/mobile/test/renderer-recovery-test.mjs"],
  ["apps/mobile/test/preferences-mutations.mjs"],
  ["apps/mobile/test/native-pairing-test.mjs"],
  ["apps/mobile/test/device-auth-test.mjs"],
  ["packages/core/test/pq-test.mjs"],
  ["packages/core/test/security-review-test.mjs"],
  [
    vitestCli,
    "run",
    "--config",
    path.resolve("apps/gateway/vitest.config.ts"),
    "--root",
    "apps/gateway",
  ],
  ...[
    "crypto-test",
    "noise-test",
    "e2e-test",
    "approvals-test",
    "control-test",
    "hello-auth-test",
    "pairing-test",
    "relay-smoke",
  ].map((name) => [`apps/mobile/test/${name}.mjs`]),
  ["apps/relay/test/relay-hardening-test.mjs"],
  ["apps/cloud-relay/test/relay-v2-test.mjs"],
  ["apps/desktop-responder/test/integration-test.mjs"],
  ["artifacts/audit/reproduce-findings.cjs"],
  ["artifacts/audit/security-regressions-round-3.cjs"],
  ["scripts/platform-test.mjs"],
  ["scripts/relay-admission-test.mjs"],
  ["scripts/test-linked-ui.mjs"],
];
for (const args of cases) {
  console.log(`\nRunning ${args.join(" ")}`);
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  const timeout = setTimeout(() => {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill();
  }, 90_000);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timeout);
  if (code !== 0) process.exit(code ?? 1);
}
console.log("\nAll regression suites passed.");
