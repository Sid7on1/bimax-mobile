import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(__dirname, "..");
const port = 18787;
const dbPath = path.join(
  os.tmpdir(),
  `relay-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

function cleanupDb() {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

// 1. Spawn server
const serverProcess = spawn("node", ["dist/index.js"], {
  cwd: relayDir,
  env: {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
  },
  stdio: "pipe",
});

let serverExited = false;
serverProcess.on("exit", () => {
  serverExited = true;
});

function killServer() {
  if (!serverExited) {
    serverProcess.kill("SIGTERM");
  }
  cleanupDb();
}

process.on("exit", killServer);
process.on("SIGINT", () => {
  killServer();
  process.exit(1);
});

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverExited) {
      throw new Error("Server process exited prematurely");
    }
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (r) => {
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

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connect timeout"));
    }, 3000);
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function run() {
  console.log("Starting smoke test...");
  await waitForHealth();
  console.log("Server healthy on port " + port);

  const wsUrl = `ws://127.0.0.1:${port}`;

  // STEP 1 (live delivery)
  let step1Passed = false;
  const clientBMsgsStep1 = [];

  const wsA = await connectWs(wsUrl);
  const msgsA = [];
  wsA.on("message", (data) => {
    try {
      msgsA.push(JSON.parse(data.toString()));
    } catch {}
  });

  // Client A hellos as desktop-1
  wsA.send(
    JSON.stringify({
      v: 2,
      id: "hello-desktop-1",
      ts: Date.now(),
      from: "desktop-1",
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: "desktop-1",
        role: "desktop",
        protocolVersion: 2,
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 100));

  const wsB = await connectWs(wsUrl);
  wsB.on("message", (data) => {
    try {
      clientBMsgsStep1.push(JSON.parse(data.toString()));
    } catch {}
  });

  // Client B hellos as mobile-1
  wsB.send(
    JSON.stringify({
      v: 2,
      id: "hello-mobile-1",
      ts: Date.now(),
      from: "mobile-1",
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: "mobile-1",
        role: "mobile",
        protocolVersion: 2,
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 150));

  // A sends Envelope<"session_list", SessionList> to B
  const sessionListId = "sess-list-1";
  wsA.send(
    JSON.stringify({
      v: 2,
      id: sessionListId,
      ts: Date.now(),
      from: "desktop-1",
      to: "mobile-1",
      kind: "session_list",
      payload: { sessions: [] },
    }),
  );

  // Wait up to 2s for B to receive session_list
  const startWait1 = Date.now();
  let receivedSessionList = null;
  while (Date.now() - startWait1 < 2000) {
    receivedSessionList = clientBMsgsStep1.find((m) => m.id === sessionListId);
    if (receivedSessionList) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (receivedSessionList && receivedSessionList.id === sessionListId) {
    step1Passed = true;
    console.log("STEP 1 (live delivery): PASS");
  } else {
    console.log("STEP 1 (live delivery): FAIL");
    throw new Error("Step 1 failed: client B did not receive session_list envelope");
  }

  // STEP 2 (offline queue)
  let step2Passed = false;
  // B disconnects
  await new Promise((resolve) => {
    wsB.on("close", resolve);
    wsB.close();
  });

  await new Promise((r) => setTimeout(r, 100));

  const offlineMsgId = "sess-list-2-offline";
  wsA.send(
    JSON.stringify({
      v: 2,
      id: offlineMsgId,
      ts: Date.now(),
      from: "desktop-1",
      to: "mobile-1",
      kind: "session_list",
      payload: { sessions: [] },
    }),
  );

  // Assert B receives nothing within 1s
  const msgsReceivedOnClosedB = [];
  wsB.on("message", (data) => {
    msgsReceivedOnClosedB.push(data);
  });

  await new Promise((r) => setTimeout(r, 1000));

  if (msgsReceivedOnClosedB.length === 0 && wsB.readyState === WebSocket.CLOSED) {
    step2Passed = true;
    console.log("STEP 2 (offline queue): PASS");
  } else {
    console.log("STEP 2 (offline queue): FAIL");
    throw new Error("Step 2 failed: disconnected client received messages or socket not closed");
  }

  // STEP 3 (drain + ack)
  let step3Passed = false;
  const msgsBReconnected = [];
  const wsB2 = await connectWs(wsUrl);
  wsB2.on("message", (data) => {
    try {
      msgsBReconnected.push(JSON.parse(data.toString()));
    } catch {}
  });

  // B reconnects with a fresh hello
  wsB2.send(
    JSON.stringify({
      v: 2,
      id: "hello-mobile-2",
      ts: Date.now(),
      from: "mobile-1",
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: "mobile-1",
        role: "mobile",
        protocolVersion: 2,
      },
    }),
  );

  // Wait for queued envelope
  const startWait3 = Date.now();
  let receivedQueued = null;
  while (Date.now() - startWait3 < 2000) {
    receivedQueued = msgsBReconnected.find((m) => m.id === offlineMsgId);
    if (receivedQueued) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!receivedQueued) {
    console.log("STEP 3 (drain + ack): FAIL (queued message not received)");
    throw new Error("Step 3 failed: did not receive queued message on reconnect");
  }

  // B replies delivery_ack
  wsB2.send(
    JSON.stringify({
      v: 2,
      id: "ack-sess-list-2",
      ts: Date.now(),
      from: "mobile-1",
      to: "relay",
      kind: "delivery_ack",
      payload: { id: offlineMsgId },
    }),
  );

  await new Promise((r) => setTimeout(r, 150));

  // B disconnects
  await new Promise((resolve) => {
    wsB2.on("close", resolve);
    wsB2.close();
  });

  await new Promise((r) => setTimeout(r, 100));

  // B reconnects AGAIN
  const msgsBReconnectedAgain = [];
  const wsB3 = await connectWs(wsUrl);
  wsB3.on("message", (data) => {
    try {
      msgsBReconnectedAgain.push(JSON.parse(data.toString()));
    } catch {}
  });

  wsB3.send(
    JSON.stringify({
      v: 2,
      id: "hello-mobile-3",
      ts: Date.now(),
      from: "mobile-1",
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: "mobile-1",
        role: "mobile",
        protocolVersion: 2,
      },
    }),
  );

  // Assert B receives NOTHING from outbox (specifically no duplicate of offlineMsgId or any other queued envelopes)
  await new Promise((r) => setTimeout(r, 1000));

  const duplicateOrQueued = msgsBReconnectedAgain.filter(
    (m) => m.id === offlineMsgId || m.kind !== "presence",
  );

  if (duplicateOrQueued.length === 0) {
    step3Passed = true;
    console.log("STEP 3 (drain + ack): PASS");
  } else {
    console.log("STEP 3 (drain + ack): FAIL");
    throw new Error(
      `Step 3 failed: expected no outbox messages but received: ${JSON.stringify(duplicateOrQueued)}`,
    );
  }

  // STEP 4 (presence)
  let step4Passed = false;
  // Assert that on B's first hello, B received presence envelopes for known devices
  const desktopPresence = clientBMsgsStep1.find(
    (m) => m.kind === "presence" && m.payload && m.payload.deviceId === "desktop-1",
  );

  if (desktopPresence) {
    step4Passed = true;
    console.log("STEP 4 (presence): PASS");
  } else {
    console.log("STEP 4 (presence): FAIL");
    throw new Error(
      "Step 4 failed: B did not receive presence envelope for desktop-1 on first hello",
    );
  }

  wsA.close();
  wsB3.close();

  if (step1Passed && step2Passed && step3Passed && step4Passed) {
    console.log("All smoke test steps passed!");
  }
}

try {
  await run();
  killServer();
  process.exit(0);
} catch (err) {
  console.error("Smoke test error:", err);
  killServer();
  process.exit(1);
}
