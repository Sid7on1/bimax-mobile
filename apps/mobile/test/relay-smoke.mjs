import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-mobile-smoke-"));
const clientDistDir = path.join(tmpDir, "client-dist");
const dbPath = path.join(tmpDir, "smoke.db");
const PORT = 18788;

const rootNodeModules = path.join(repoRoot, "node_modules");
if (fs.existsSync(rootNodeModules)) {
  fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
}

let relayProc = null;

function cleanup() {
  if (relayProc) {
    try {
      relayProc.kill("SIGKILL");
    } catch {}
    relayProc = null;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

// Compile client.ts
console.log("Compiling client.ts...");
execSync(
  `npx tsc apps/mobile/lib/relay/client.ts --outDir ${clientDistDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`,
  { cwd: repoRoot, stdio: "inherit" },
);

const clientFile = fs.existsSync(path.join(clientDistDir, "client.js"))
  ? path.join(clientDistDir, "client.js")
  : path.join(clientDistDir, "relay", "client.js");
const { RelayClient } = require(clientFile);

// Build relay if needed
console.log("Building apps/relay...");
execSync("npx tsc -p apps/relay/tsconfig.json", { cwd: repoRoot, stdio: "inherit" });

function startRelay() {
  relayProc = spawn("node", ["apps/relay/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
    },
    stdio: "pipe",
  });
  return relayProc;
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${PORT}/health`, (r) => {
          let body = "";
          r.on("data", (chunk) => (body += chunk));
          r.on("end", () => {
            if (r.statusCode === 200) {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Status ${r.statusCode}`));
            }
          });
        });
        req.on("error", reject);
        req.setTimeout(500, () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });
      if (res && res.ok === true) {
        return;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Server failed to become healthy within 10s");
}

async function run() {
  console.log("Spawning relay server on port " + PORT + "...");
  startRelay();
  await waitForHealth(10000);
  console.log("Relay server is healthy.");

  const wsUrl = `ws://127.0.0.1:${PORT}`;

  // STEP 1 (hello + presence)
  const msgsA = [];
  const statusesA = [];
  const clientA = new RelayClient({
    url: wsUrl,
    deviceId: "desktop-1",
    role: "desktop",
    wsImpl: WebSocket,
    onMessage: (env) => msgsA.push(env),
    onStatus: (s) => statusesA.push(s),
  });
  clientA.connect();

  // Wait for clientA to become online
  const startWaitA = Date.now();
  while (clientA.status !== "online" && Date.now() - startWaitA < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const msgsB = [];
  const clientB = new RelayClient({
    url: wsUrl,
    deviceId: "mobile-1",
    role: "mobile",
    wsImpl: WebSocket,
    onMessage: (env) => msgsB.push(env),
  });
  clientB.connect();

  // Assert B's onMessage received a presence envelope for desktop-1 with status "online"
  let presenceEnv = null;
  const start1 = Date.now();
  while (Date.now() - start1 < 3000) {
    presenceEnv = msgsB.find(
      (m) =>
        m.kind === "presence" &&
        m.payload &&
        m.payload.deviceId === "desktop-1" &&
        m.payload.status === "online",
    );
    if (presenceEnv) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (presenceEnv) {
    console.log("STEP 1 (hello + presence): PASS");
  } else {
    console.log("STEP 1 (hello + presence): FAIL");
    throw new Error("Step 1 failed: client B did not receive presence for desktop-1");
  }

  // STEP 2 (live delivery)
  const sessionListEnv = {
    v: 1,
    id: "sess-msg-1",
    ts: Date.now(),
    from: "desktop-1",
    to: "mobile-1",
    kind: "session_list",
    payload: { sessions: [] },
  };
  clientA.send(sessionListEnv);

  let receivedSessionList = null;
  const start2 = Date.now();
  while (Date.now() - start2 < 3000) {
    receivedSessionList = msgsB.find((m) => m.id === "sess-msg-1");
    if (receivedSessionList) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (receivedSessionList && receivedSessionList.id === "sess-msg-1") {
    console.log("STEP 2 (live delivery): PASS");
  } else {
    console.log("STEP 2 (live delivery): FAIL");
    throw new Error("Step 2 failed: client B did not receive session_list envelope");
  }

  // STEP 3 (offline queue + drain + ack, no duplicate)
  clientB.close();
  await new Promise((r) => setTimeout(r, 100));

  const msgsBCountBefore = msgsB.length;
  const offlineEnv = {
    v: 1,
    id: "sess-msg-2-offline",
    ts: Date.now(),
    from: "desktop-1",
    to: "mobile-1",
    kind: "session_list",
    payload: { sessions: [] },
  };
  clientA.send(offlineEnv);

  // Wait 1s, assert B got nothing
  await new Promise((r) => setTimeout(r, 1000));
  if (msgsB.length !== msgsBCountBefore) {
    console.log("STEP 3 (offline queue + drain + ack, no duplicate): FAIL");
    throw new Error("Step 3 failed: closed client B received messages while offline");
  }

  // Create B2 (same deviceId "mobile-1") and connect
  const msgsB2 = [];
  const clientB2 = new RelayClient({
    url: wsUrl,
    deviceId: "mobile-1",
    role: "mobile",
    wsImpl: WebSocket,
    onMessage: (env) => msgsB2.push(env),
  });
  clientB2.connect();

  // Assert B2 receives the queued envelope
  let receivedQueued = null;
  const start3 = Date.now();
  while (Date.now() - start3 < 3000) {
    receivedQueued = msgsB2.find((m) => m.id === "sess-msg-2-offline");
    if (receivedQueued) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!receivedQueued) {
    console.log("STEP 3 (offline queue + drain + ack, no duplicate): FAIL");
    throw new Error("Step 3 failed: B2 did not receive queued envelope");
  }

  // B2 auto-acks (built into the client). Wait 300ms for ack to reach relay.
  await new Promise((r) => setTimeout(r, 300));

  // Then B2.close(); create B3 (same deviceId), connect
  clientB2.close();
  await new Promise((r) => setTimeout(r, 100));

  const msgsB3 = [];
  const clientB3 = new RelayClient({
    url: wsUrl,
    deviceId: "mobile-1",
    role: "mobile",
    wsImpl: WebSocket,
    onMessage: (env) => msgsB3.push(env),
  });
  clientB3.connect();

  // Wait 1s, assert B3 receives NOTHING from outbox within 1s (proves the ack deleted the row)
  await new Promise((r) => setTimeout(r, 1000));

  const queuedInB3 = msgsB3.filter((m) => m.id === "sess-msg-2-offline" || m.kind !== "presence");
  if (queuedInB3.length === 0) {
    console.log("STEP 3 (offline queue + drain + ack, no duplicate): PASS");
  } else {
    console.log("STEP 3 (offline queue + drain + ack, no duplicate): FAIL");
    throw new Error(
      `Step 3 failed: B3 received duplicate queued message: ${JSON.stringify(queuedInB3)}`,
    );
  }

  // STEP 4 (auto-reconnect)
  // Kill the relay child process → assert A's status becomes "reconnecting" within 5s
  relayProc.kill("SIGKILL");
  relayProc = null;

  let aBecameReconnecting = false;
  const start4 = Date.now();
  while (Date.now() - start4 < 5000) {
    if (clientA.status === "reconnecting" || statusesA.includes("reconnecting")) {
      aBecameReconnecting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (aBecameReconnecting) {
    // Restart the relay on the same port
    startRelay();
    await waitForHealth(10000);

    // Assert A's status returns to "online" within 40s (backoff cap is 30s)
    let aReturnedOnline = false;
    const startReconnect = Date.now();
    while (Date.now() - startReconnect < 40000) {
      if (clientA.status === "online") {
        aReturnedOnline = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (aReturnedOnline) {
      console.log("STEP 4 (auto-reconnect): PASS");
    } else {
      console.log("STEP 4 (auto-reconnect): FAIL");
      throw new Error("Step 4 failed: A did not return to 'online' within 40s");
    }
  } else {
    console.log("STEP 4 (auto-reconnect): FAIL");
    throw new Error("Step 4 failed: A did not become 'reconnecting' within 5s");
  }

  clientA.close();
  clientB3.close();
  console.log("All four steps PASS");
}

try {
  await run();
  cleanup();
  process.exit(0);
} catch (err) {
  console.error("Smoke test error:", err);
  cleanup();
  process.exit(1);
}
