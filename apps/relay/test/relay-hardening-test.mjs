import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";
import { ed25519 } from "@noble/curves/ed25519.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-relay-hardening-"));
const dbPath = path.join(tmpDir, "hardening.db");
const PORT = 18789;
const wsUrl = `ws://127.0.0.1:${PORT}`;

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

// Build relay
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

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function canonicalJson(value) {
  if (value === undefined) throw new Error("cannot serialize undefined");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = [];
  for (const k of keys) {
    const v = value[k];
    if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
      entries.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
    }
  }
  return `{${entries.join(",")}}`;
}

function buildSignedHello(deviceId, role, kp, overrides = {}) {
  const id = overrides.id || `hello-${Math.random().toString(36).slice(2)}`;
  const ts = overrides.ts !== undefined ? overrides.ts : Date.now();
  const from = overrides.from !== undefined ? overrides.from : deviceId;
  const to = overrides.to !== undefined ? overrides.to : "relay";
  const helloPubkey = overrides.helloPubkey !== undefined ? overrides.helloPubkey : bytesToBase64(kp.publicKey);
  const msg = canonicalJson({
    id,
    ts,
    from,
    deviceId,
    role,
    helloPubkey,
  });
  const sig = bytesToBase64(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey));
  return {
    v: overrides.v !== undefined ? overrides.v : 1,
    id,
    ts,
    from,
    to,
    kind: "hello",
    payload: {
      protocolVersion: 1,
      deviceId,
      role,
      helloPubkey,
      helloSignature: overrides.helloSignature !== undefined ? overrides.helloSignature : sig,
    },
  };
}

async function run() {
  startRelay();
  await waitForHealth(10000);

  // ==========================================
  // STEP 1 (unsigned hello rejected)
  // ==========================================
  try {
    const ws1 = new WebSocket(wsUrl);
    const closePromise1 = new Promise((resolve) => {
      ws1.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise((r) => ws1.on("open", r));
    ws1.send(
      JSON.stringify({
        v: 1,
        id: "legacy-hello-1",
        ts: Date.now(),
        from: "dev-legacy",
        to: "relay",
        kind: "hello",
        payload: {
          protocolVersion: 1,
          deviceId: "dev-legacy",
          role: "desktop",
        },
      }),
    );
    const closeEvent1 = await closePromise1;
    assert.strictEqual(closeEvent1.code, 4401, `legacy hello must be rejected with 4401 (got ${closeEvent1.code})`);
    console.log("STEP 1 (unsigned hello rejected): PASS");
  } catch (err) {
    console.log("STEP 1 (unsigned hello rejected): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 2 (squatting blocked)
  // ==========================================
  try {
    const kpX1 = ed25519.keygen();
    const kpX2 = ed25519.keygen();
    const wsX1 = new WebSocket(wsUrl);
    await new Promise((r) => wsX1.on("open", r));
    wsX1.send(JSON.stringify(buildSignedHello("device-X", "desktop", kpX1)));
    await new Promise((r) => setTimeout(r, 100));

    const wsX2 = new WebSocket(wsUrl);
    const closePromiseX2 = new Promise((resolve) => {
      wsX2.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise((r) => wsX2.on("open", r));
    wsX2.send(JSON.stringify(buildSignedHello("device-X", "desktop", kpX2)));
    const closeEventX2 = await closePromiseX2;
    assert.strictEqual(closeEventX2.code, 4401, `squatter must be rejected with 4401 (got ${closeEventX2.code})`);
    assert.ok(
      closeEventX2.reason.includes("device key changed"),
      `reason must contain 'device key changed' (got '${closeEventX2.reason}')`,
    );
    wsX1.close();
    console.log("STEP 2 (squatting blocked): PASS");
  } catch (err) {
    console.log("STEP 2 (squatting blocked): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 3 (stale hello)
  // ==========================================
  try {
    const kpStale = ed25519.keygen();
    const staleHello = buildSignedHello("device-stale", "mobile", kpStale, {
      ts: Date.now() - 121000,
    });
    const wsStale = new WebSocket(wsUrl);
    const closePromiseStale = new Promise((resolve) => {
      wsStale.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise((r) => wsStale.on("open", r));
    wsStale.send(JSON.stringify(staleHello));
    const closeEventStale = await closePromiseStale;
    assert.strictEqual(closeEventStale.code, 4401, `stale hello must be rejected with 4401 (got ${closeEventStale.code})`);
    console.log("STEP 3 (stale hello): PASS");
  } catch (err) {
    console.log("STEP 3 (stale hello): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 4 (sender binding)
  // ==========================================
  try {
    const kpA = ed25519.keygen();
    const wsA = new WebSocket(wsUrl);
    const closePromiseA = new Promise((resolve) => {
      wsA.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise((r) => wsA.on("open", r));
    wsA.send(JSON.stringify(buildSignedHello("device-A", "mobile", kpA)));
    await new Promise((r) => setTimeout(r, 100));

    wsA.send(
      JSON.stringify({
        v: 1,
        id: "msg-bad-from-1",
        ts: Date.now(),
        from: "device-B",
        to: "device-A",
        kind: "encrypted",
        payload: {},
      }),
    );
    const closeEventA = await closePromiseA;
    assert.strictEqual(closeEventA.code, 4400, `sender mismatch must be rejected with 4400 (got ${closeEventA.code})`);
    console.log("STEP 4 (sender binding): PASS");
  } catch (err) {
    console.log("STEP 4 (sender binding): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 5 (empty id never stored)
  // ==========================================
  try {
    const kpA5 = ed25519.keygen();
    const kpB5 = ed25519.keygen();

    const wsA5 = new WebSocket(wsUrl);
    await new Promise((r) => wsA5.on("open", r));
    wsA5.send(JSON.stringify(buildSignedHello("device-A5", "desktop", kpA5)));
    await new Promise((r) => setTimeout(r, 100));

    wsA5.send(
      JSON.stringify({
        v: 1,
        id: "",
        ts: Date.now(),
        from: "device-A5",
        to: "device-B5",
        kind: "encrypted",
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    wsA5.close();

    const msgsB5 = [];
    const wsB5 = new WebSocket(wsUrl);
    wsB5.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.kind !== "presence") {
          msgsB5.push(parsed);
        }
      } catch {}
    });
    await new Promise((r) => wsB5.on("open", r));
    wsB5.send(JSON.stringify(buildSignedHello("device-B5", "mobile", kpB5)));
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(msgsB5.length, 0, "B5 must not drain empty-id message");
    wsB5.close();
    console.log("STEP 5 (empty id never stored): PASS");
  } catch (err) {
    console.log("STEP 5 (empty id never stored): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 6 (ack ownership)
  // ==========================================
  try {
    const kpA6 = ed25519.keygen();
    const kpB6 = ed25519.keygen();
    const kpC6 = ed25519.keygen();

    const wsA6 = new WebSocket(wsUrl);
    await new Promise((r) => wsA6.on("open", r));
    wsA6.send(JSON.stringify(buildSignedHello("device-A6", "desktop", kpA6)));
    await new Promise((r) => setTimeout(r, 100));

    wsA6.send(
      JSON.stringify({
        v: 1,
        id: "msg-ack-test-1",
        ts: Date.now(),
        from: "device-A6",
        to: "device-B6",
        kind: "encrypted",
        payload: { text: "secret" },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    wsA6.close();

    const wsC6 = new WebSocket(wsUrl);
    await new Promise((r) => wsC6.on("open", r));
    wsC6.send(JSON.stringify(buildSignedHello("device-C6", "desktop", kpC6)));
    await new Promise((r) => setTimeout(r, 100));

    wsC6.send(
      JSON.stringify({
        v: 1,
        id: "ack-c-1",
        ts: Date.now(),
        from: "device-C6",
        to: "relay",
        kind: "delivery_ack",
        payload: { id: "msg-ack-test-1" },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    wsC6.close();

    const msgsB6_1 = [];
    const wsB6_1 = new WebSocket(wsUrl);
    wsB6_1.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.kind !== "presence") {
          msgsB6_1.push(parsed);
        }
      } catch {}
    });
    await new Promise((r) => wsB6_1.on("open", r));
    wsB6_1.send(JSON.stringify(buildSignedHello("device-B6", "mobile", kpB6)));
    await new Promise((r) => setTimeout(r, 500));

    const foundMsg = msgsB6_1.find((m) => m.id === "msg-ack-test-1");
    assert.ok(foundMsg, "B must receive message despite imposter ack from C");

    wsB6_1.send(
      JSON.stringify({
        v: 1,
        id: "ack-b-1",
        ts: Date.now(),
        from: "device-B6",
        to: "relay",
        kind: "delivery_ack",
        payload: { id: "msg-ack-test-1" },
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    wsB6_1.close();

    const msgsB6_2 = [];
    const wsB6_2 = new WebSocket(wsUrl);
    wsB6_2.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.kind !== "presence") {
          msgsB6_2.push(parsed);
        }
      } catch {}
    });
    await new Promise((r) => wsB6_2.on("open", r));
    wsB6_2.send(JSON.stringify(buildSignedHello("device-B6", "mobile", kpB6)));
    await new Promise((r) => setTimeout(r, 500));

    const foundMsg2 = msgsB6_2.find((m) => m.id === "msg-ack-test-1");
    assert.strictEqual(foundMsg2, undefined, "second drain must be empty after B acks");
    wsB6_2.close();
    console.log("STEP 6 (ack ownership): PASS");
  } catch (err) {
    console.log("STEP 6 (ack ownership): FAIL");
    throw err;
  }
}

try {
  await run();
  cleanup();
  process.exit(0);
} catch (err) {
  console.error("Hardening test failed:", err);
  cleanup();
  process.exit(1);
}
