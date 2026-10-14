import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const { ed25519 } = require("@noble/curves/ed25519.js");
const { sha256 } = require("@noble/hashes/sha2.js");

const PORT = 18796;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-responder-test-"));
const dbPath = path.join(tmpDir, "relay.db");
const mobileDistDir = path.join(tmpDir, "mobile-dist");
const desktopDistDir = path.join(tmpDir, "desktop-dist");

let relayProc = null;

function cleanup() {
  if (relayProc) {
    try {
      relayProc.kill("SIGKILL");
    } catch {
      // ignore
    }
    relayProc = null;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

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
  throw new Error("Relay server failed to become healthy within 10s");
}

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
  relayProc.stdout.on("data", (d) => process.stdout.write(`[RELAY] ${d}`));
  relayProc.stderr.on("data", (d) => process.stderr.write(`[RELAY ERR] ${d}`));
  return relayProc;
}

function waitForStatus(client, targetStatus, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (client.status === targetStatus) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for client status ${targetStatus} (current: ${client.status})`)),
      timeoutMs,
    );
    const prev = client.opts.onStatus;
    client.opts.onStatus = (s) => {
      prev?.(s);
      if (s === targetStatus) {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

async function main() {
  console.log("=== DESKTOP RESPONDER INTEGRATION TEST SUITE ===");
  console.log("Setting up build environments in tmpdir...");

  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // 1. Compile apps/relay and start it
  console.log("Building apps/relay...");
  execSync("npx tsc -p apps/relay/tsconfig.json", { cwd: repoRoot, stdio: "inherit" });
  startRelay();
  await waitForHealth();
  console.log("Relay running on port", PORT);

  // 2. Compile desktop-responder into tmpdir
  console.log("Compiling desktop-responder...");
  execSync(`npx tsc -p apps/desktop-responder/tsconfig.json --outDir ${desktopDistDir}`, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // 3. Compile mobile stack into tmpdir
  console.log("Compiling mobile stack...");
  execSync(
    `npx tsc apps/mobile/lib/relay/client.ts apps/mobile/lib/session/session.ts apps/mobile/lib/e2e/framing.ts apps/mobile/lib/crypto/noise.ts apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/crypto/pairing.ts apps/mobile/lib/approvals/approvals.ts --outDir ${mobileDistDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`,
    { cwd: repoRoot, stdio: "inherit" },
  );

  // Load compiled modules
  const { Responder } = require(path.join(desktopDistDir, "responder.js"));
  const { FakeEngine } = require(path.join(desktopDistDir, "fake-engine.js"));
  const { createIdentity } = require(path.join(desktopDistDir, "identity.js"));

  const { RelayClient } = require(path.join(mobileDistDir, "relay", "client.js"));
  const {
    PairingManager: PhonePairingManager,
    formatVerificationCode,
  } = require(path.join(mobileDistDir, "session", "session.js"));
  const {
    seal: mobileSeal,
    open: mobileOpen,
    newE2EState: mobileNewE2EState,
  } = require(path.join(mobileDistDir, "e2e", "framing.js"));
  const {
    generateX25519Keypair,
    generateEd25519Keypair,
  } = require(path.join(mobileDistDir, "crypto/keys.js"));
  const {
    bytesToBase64,
    base64ToBytes,
  } = require(path.join(mobileDistDir, "crypto/base64.js"));
  const {
    NoiseIKInitiator,
  } = require(path.join(mobileDistDir, "crypto/noise.js"));
  const {
    buildApprovalDecision,
    signApprovalDecision,
  } = require(path.join(mobileDistDir, "approvals/approvals.js"));

  const relayUrl = `ws://127.0.0.1:${PORT}`;

  // Initialize Desktop Responder & FakeEngine
  const fakeEngine = new FakeEngine();
  const desktopIdentity = createIdentity("desktop-dev-1");
  const responder = new Responder({
    identity: desktopIdentity,
    enginePort: fakeEngine,
    relayUrl,
    dataDir: path.join(tmpDir, "responder-data"),
    wsImpl: WebSocket,
  });

  await responder.start();
  console.log("Desktop Responder started.");

  // Initialize Phone test stack
  const phoneDeviceId = "phone-dev-1";
  const phoneX25519 = generateX25519Keypair();
  const phoneEd25519 = generateEd25519Keypair();

  let phoneSession = null;
  let phoneE2EState = mobileNewE2EState();

  const unhandledMessages = [];
  const messageListeners = [];

  const unhandledDecrypted = [];
  const decryptedListeners = [];

  function onNewMessage(env) {
    if (env.kind === "encrypted" && phoneSession) {
      try {
        const res = mobileOpen(phoneSession, phoneE2EState, {
          id: env.id,
          from: env.from,
          to: env.to,
          kind: env.kind,
          ciphertextB64: env.payload.ciphertext,
        });
        if (!res.duplicate) {
          onNewDecrypted(res);
        }
      } catch (err) {
        console.error("mobileOpen threw on phone side:", err);
      }
    }

    for (let i = 0; i < messageListeners.length; i++) {
      const listener = messageListeners[i];
      if (listener(env)) {
        messageListeners.splice(i, 1);
        return;
      }
    }
    unhandledMessages.push(env);
  }

  function waitForMessage(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const idx = unhandledMessages.findIndex(predicate);
      if (idx !== -1) {
        const [msg] = unhandledMessages.splice(idx, 1);
        return resolve(msg);
      }

      const timer = setTimeout(() => {
        const lIdx = messageListeners.indexOf(check);
        if (lIdx !== -1) messageListeners.splice(lIdx, 1);
        reject(new Error("Timeout waiting for message"));
      }, timeoutMs);

      function check(env) {
        if (predicate(env)) {
          clearTimeout(timer);
          resolve(env);
          return true;
        }
        return false;
      }
      messageListeners.push(check);
    });
  }

  function onNewDecrypted(frame) {
    for (let i = 0; i < decryptedListeners.length; i++) {
      const listener = decryptedListeners[i];
      if (listener(frame)) {
        decryptedListeners.splice(i, 1);
        return;
      }
    }
    unhandledDecrypted.push(frame);
  }

  function waitForDecrypted(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const idx = unhandledDecrypted.findIndex((f) => predicate(f.innerKind, f.body));
      if (idx !== -1) {
        const [frame] = unhandledDecrypted.splice(idx, 1);
        return resolve(frame);
      }

      const timer = setTimeout(() => {
        const lIdx = decryptedListeners.indexOf(check);
        if (lIdx !== -1) decryptedListeners.splice(lIdx, 1);
        reject(new Error("Timeout waiting for decrypted message"));
      }, timeoutMs);

      function check(frame) {
        if (predicate(frame.innerKind, frame.body)) {
          clearTimeout(timer);
          resolve(frame);
          return true;
        }
        return false;
      }
      decryptedListeners.push(check);
    });
  }

  const phoneRelayClient = new RelayClient({
    url: relayUrl,
    deviceId: phoneDeviceId,
    role: "mobile",
    wsImpl: WebSocket,
    helloSigner: {
      pubkeyB64: bytesToBase64(phoneEd25519.publicKey),
      sign: async (msg) => ed25519.sign(msg, phoneEd25519.privateKey),
    },
    onMessage: (env) => {
      onNewMessage(env);
    },
  });

  phoneRelayClient.connect();
  await waitForStatus(phoneRelayClient, "online");
  console.log("Phone RelayClient online.");

  const phonePairingManager = new PhonePairingManager({
    deviceId: phoneDeviceId,
    staticKeypair: phoneX25519,
  });

  function sendPhoneEncrypted(innerKind, body) {
    assert.ok(phoneSession, "phoneSession must be established");
    const id = "p-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    const ts = Date.now();
    const from = phoneDeviceId;
    const to = desktopIdentity.deviceId;

    const ciphertext = mobileSeal(phoneSession, phoneE2EState, innerKind, body, {
      id,
      from,
      to,
    });

    phoneRelayClient.send({
      v: 1,
      id,
      ts,
      from,
      to,
      kind: "encrypted",
      payload: { ciphertext },
    });
    return id;
  }

  // ==========================================
  // CASE 1: Pairing
  // ==========================================
  console.log("\n--- CASE 1: Pairing ---");
  try {
    const advert = responder.pairingManager.getAdvertisement();
    const reqEnv = phonePairingManager.beginPairing(advert);
    phoneRelayClient.send(reqEnv);

    const grantEnv = await waitForMessage((m) => m.kind === "pairing_grant");
    phoneSession = phonePairingManager.handleGrant(grantEnv);

    const candidate = responder.pairingManager.getCandidatePairing();
    assert.ok(candidate, "Candidate pairing must be present on responder");

    const phoneCode = formatVerificationCode(phoneSession.handshakeHash);
    const desktopCode = candidate.verificationCode;
    assert.strictEqual(phoneCode, desktopCode, "Verification codes must match on both sides");

    const trustedRecord = await responder.confirmTrustedPhone(
      desktopCode,
      bytesToBase64(phoneEd25519.publicKey),
    );
    assert.strictEqual(trustedRecord.phoneDeviceId, phoneDeviceId);
    assert.strictEqual(trustedRecord.phoneHelloPubkeyB64, bytesToBase64(phoneEd25519.publicKey));

    phoneE2EState = mobileNewE2EState();
    console.log("CASE 1: PASS");
  } catch (err) {
    console.error("CASE 1: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 2: Re-handshake + E2E reset
  // ==========================================
  console.log("\n--- CASE 2: Re-handshake + E2E reset ---");
  try {
    const oldPhoneSession = phoneSession;

    // Start fresh Noise session using phone's pinned static key
    const advert = responder.pairingManager.getAdvertisement();
    const initiator = new NoiseIKInitiator({
      staticKeypair: phoneX25519,
      remoteStaticPublicKey: base64ToBytes(advert.desktopPublicKey),
    });
    const msg1 = initiator.writeMessage1(new Uint8Array(0));

    const rehandshakeReq = {
      v: 1,
      id: "re-req-case-2",
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "pairing_request",
      payload: {
        ref: "skip-ref-rehandshake",
        mobileDeviceId: phoneDeviceId,
        mobilePublicKey: bytesToBase64(phoneX25519.publicKey),
        handshakeMessage: bytesToBase64(msg1),
      },
    };

    phoneRelayClient.send(rehandshakeReq);
    const reGrantEnv = await waitForMessage((m) => m.kind === "pairing_grant");

    initiator.readMessage2(base64ToBytes(reGrantEnv.payload.handshakeMessage));
    const newPhoneSession = {
      peerDeviceId: desktopIdentity.deviceId,
      handshakeHash: initiator.getHandshakeHash(),
      establishedAt: Date.now(),
      encrypt: (pt) => initiator.encrypt(pt),
      decrypt: (ct) => initiator.decrypt(ct),
    };

    // Both sides reset E2E state
    phoneSession = newPhoneSession;
    phoneE2EState = mobileNewE2EState();

    // Save established session before testing rejection
    const currentResponderSession = responder.pairingManager.getActiveSession();

    // Verify: frame sealed under the OLD session is rejected
    const dummyState = mobileNewE2EState();
    const oldCiphertext = mobileSeal(
      oldPhoneSession,
      dummyState,
      "session_list_request",
      {},
      {
        id: "old-session-frame-1",
        from: phoneDeviceId,
        to: desktopIdentity.deviceId,
      },
    );

    const prevCryptoFailures = responder.cryptoFailureCount;
    phoneRelayClient.send({
      v: 1,
      id: "old-session-frame-1",
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "encrypted",
      payload: { ciphertext: oldCiphertext },
    });

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      responder.cryptoFailureCount,
      prevCryptoFailures + 1,
      "Frame sealed under old session must be rejected with crypto failure",
    );

    // Re-activate current session on responder and verify new frames flow
    responder.pairingManager.setActiveSession(currentResponderSession);
    responder.e2e.resetPeer(phoneDeviceId);

    const promiseList = waitForDecrypted((k) => k === "session_list");
    sendPhoneEncrypted("session_list_request", {});
    const listRes = await promiseList;
    assert.strictEqual(listRes.innerKind, "session_list");
    console.log("CASE 2: PASS");
  } catch (err) {
    console.error("CASE 2: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 3: In-session replay
  // ==========================================
  console.log("\n--- CASE 3: In-session replay ---");
  try {
    const replayId = "replay-msg-unique-1";
    const ct = mobileSeal(
      phoneSession,
      phoneE2EState,
      "session_list_request",
      {},
      { id: replayId, from: phoneDeviceId, to: desktopIdentity.deviceId },
    );

    const sendEnv = {
      v: 1,
      id: replayId,
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "encrypted",
      payload: { ciphertext: ct },
    };

    // 1. Send first time: should succeed
    const waitFirst = waitForDecrypted((k) => k === "session_list");
    phoneRelayClient.send(sendEnv);
    await waitFirst;

    // 2. Duplicate frame with same outer id: must be silently dropped
    let duplicateReceived = false;
    const testListener = () => {
      duplicateReceived = true;
      return false;
    };
    decryptedListeners.push(testListener);
    phoneRelayClient.send(sendEnv);
    await new Promise((r) => setTimeout(r, 200));
    const lIdx = decryptedListeners.indexOf(testListener);
    if (lIdx !== -1) decryptedListeners.splice(lIdx, 1);
    assert.strictEqual(duplicateReceived, false, "Duplicated outer id frame must be dropped");

    // 3. Frame with an old sequence number: must be rejected
    const sessionBeforeOldSeq = responder.pairingManager.getActiveSession();
    const prevFailures = responder.cryptoFailureCount;
    const oldSeqState = { sendSeq: 0, recvHighestSeq: -1, seenIds: new Set() };
    const oldSeqCt = mobileSeal(
      phoneSession,
      oldSeqState,
      "session_list_request",
      {},
      { id: "old-seq-msg-2", from: phoneDeviceId, to: desktopIdentity.deviceId },
    );

    phoneRelayClient.send({
      v: 1,
      id: "old-seq-msg-2",
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "encrypted",
      payload: { ciphertext: oldSeqCt },
    });

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      responder.cryptoFailureCount,
      prevFailures + 1,
      "Frame with old sequence number must be rejected",
    );

    // Reconnect session
    responder.pairingManager.setActiveSession(sessionBeforeOldSeq);
    responder.e2e.resetPeer(phoneDeviceId);
    phoneE2EState = mobileNewE2EState();

    console.log("CASE 3: PASS");
  } catch (err) {
    console.error("CASE 3: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 4: Chat
  // ==========================================
  console.log("\n--- CASE 4: Chat ---");
  try {
    fakeEngine.chatScript = ["Chunk1", " ", "Chunk2", " ", "Done"];
    const tokensReceived = [];

    const promiseDone = waitForDecrypted((k, body) => {
      if (k === "chat_token") {
        tokensReceived.push(body);
      }
      return k === "chat_done";
    });

    sendPhoneEncrypted("chat_message", {
      idempotencyKey: "chat-key-turn-1",
      sessionId: "session-chat-1",
      text: "Tell me something",
      sentAt: Date.now(),
    });

    const doneRes = await promiseDone;
    assert.strictEqual(doneRes.innerKind, "chat_done");
    assert.strictEqual(doneRes.body.ok, true);
    assert.strictEqual(doneRes.body.sessionId, "session-chat-1");
    assert.strictEqual(doneRes.body.idempotencyKey, "chat-key-turn-1");
    assert.ok(tokensReceived.length > 0, "Must receive chat tokens");
    assert.strictEqual(tokensReceived[0].seq, 0, "Tokens must start at seq 0");

    // SessionId continuity across turns
    const promiseDone2 = waitForDecrypted((k) => k === "chat_done");
    sendPhoneEncrypted("chat_message", {
      idempotencyKey: "chat-key-turn-2",
      sessionId: "session-chat-1",
      text: "Turn 2 question",
      sentAt: Date.now(),
    });

    const doneRes2 = await promiseDone2;
    assert.strictEqual(doneRes2.body.sessionId, "session-chat-1");

    console.log("CASE 4: PASS");
  } catch (err) {
    console.error("CASE 4: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 5: Approval v1.6
  // ==========================================
  console.log("\n--- CASE 5: Approval v1.6 ---");
  try {
    // 1. Happy path: FakeEngine emits approval -> phone approves -> resolveApproval("approved")
    const approvalReq = {
      approvalId: "appr-v16-happy",
      sessionId: "sess-v16",
      tool: "BASH",
      summary: "Run tests",
      detail: "npm test",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };

    const waitApprReq = waitForDecrypted((k, body) => k === "approval_request" && body.approvalId === "appr-v16-happy");
    fakeEngine.emitApproval(approvalReq);
    const recvReq = await waitApprReq;

    const unsignedDec = buildApprovalDecision(recvReq.body, "approved");
    const signedDec = signApprovalDecision(unsignedDec, phoneEd25519.privateKey);

    sendPhoneEncrypted("approval_decision", signedDec);
    await new Promise((r) => setTimeout(r, 200));

    const resolution = fakeEngine.resolutions.find((r) => r.approvalId === "appr-v16-happy");
    assert.ok(resolution, "FakeEngine must observe approval resolution");
    assert.strictEqual(resolution.verdict, "approved");

    // 2. Attack case A: Decision with requestHash for DIFFERENT content -> rejected, engine never told
    const attackReq = {
      approvalId: "appr-swap-attack",
      sessionId: "sess-v16",
      tool: "BASH",
      summary: "Harmless echo",
      detail: "echo hi",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };

    const waitSwapReq = waitForDecrypted((k, body) => k === "approval_request" && body.approvalId === "appr-swap-attack");
    fakeEngine.emitApproval(attackReq);
    await waitSwapReq;

    const swappedRequest = {
      ...attackReq,
      detail: "rm -rf /",
    };
    const unsignedSwapped = buildApprovalDecision(swappedRequest, "approved");
    const signedSwapped = signApprovalDecision(unsignedSwapped, phoneEd25519.privateKey);

    sendPhoneEncrypted("approval_decision", signedSwapped);
    await new Promise((r) => setTimeout(r, 200));

    const attackRes = fakeEngine.resolutions.find((r) => r.approvalId === "appr-swap-attack");
    assert.strictEqual(attackRes, undefined, "Swapped requestHash must be rejected and engine never told");

    // 3. Attack case B: Decision with bad signature -> rejected
    const badSigDec = {
      ...signedDec,
      approvalId: "appr-bad-sig",
      signature: bytesToBase64(new Uint8Array(64).fill(0xaa)),
    };
    fakeEngine.emitApproval({
      ...approvalReq,
      approvalId: "appr-bad-sig",
    });

    sendPhoneEncrypted("approval_decision", badSigDec);
    await new Promise((r) => setTimeout(r, 200));

    const badSigRes = fakeEngine.resolutions.find((r) => r.approvalId === "appr-bad-sig");
    assert.strictEqual(badSigRes, undefined, "Bad signature decision must be rejected and engine never told");

    console.log("CASE 5: PASS");
  } catch (err) {
    console.error("CASE 5: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 6: Idempotency
  // ==========================================
  console.log("\n--- CASE 6: Idempotency ---");
  try {
    const key = "idemp-key-test-6";
    const initialCount = fakeEngine.instructionExecutionCount;

    // Send command_request
    const waitCmd = waitForDecrypted((k, b) => k === "command_result" && b.idempotencyKey === key);
    sendPhoneEncrypted("command_request", {
      idempotencyKey: key,
      instruction: "Do task",
      sentAt: Date.now(),
    });
    const res1 = await waitCmd;
    assert.strictEqual(res1.body.ok, true);
    assert.strictEqual(fakeEngine.instructionExecutionCount, initialCount + 1);

    // Drop socket mid-flight
    phoneRelayClient.close();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect socket
    phoneRelayClient.connect();
    await waitForStatus(phoneRelayClient, "online");

    // Re-send with same key K
    const waitCmd2 = waitForDecrypted((k, b) => k === "command_result" && b.idempotencyKey === key);
    sendPhoneEncrypted("command_request", {
      idempotencyKey: key,
      instruction: "Do task again",
      sentAt: Date.now(),
    });
    const res2 = await waitCmd2;
    assert.strictEqual(res2.body.ok, true);

    // Engine execution counter MUST stay 1
    assert.strictEqual(
      fakeEngine.instructionExecutionCount,
      initialCount + 1,
      "Engine must execute exactly once under same idempotencyKey",
    );

    console.log("CASE 6: PASS");
  } catch (err) {
    console.error("CASE 6: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 7: Kill
  // ==========================================
  console.log("\n--- CASE 7: Kill ---");
  try {
    await new Promise((r) => setTimeout(r, 1100));
    fakeEngine.taskDurationMs = 2000;

    // Start long task
    sendPhoneEncrypted("chat_message", {
      idempotencyKey: "long-task-chat-1",
      sessionId: "session-kill-test",
      text: "Start long calculation",
      sentAt: Date.now(),
    });

    // Register pending approval for that session
    fakeEngine.emitApproval({
      approvalId: "appr-kill-pending-1",
      sessionId: "session-kill-test",
      tool: "SYSTEM",
      summary: "Pending tool",
      detail: "will be denied on kill",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Send kill_request
    const waitKill = waitForDecrypted((k, b) => k === "kill_result" && b.idempotencyKey === "kill-req-1");
    sendPhoneEncrypted("kill_request", {
      idempotencyKey: "kill-req-1",
      reason: "user cancellation",
      sentAt: Date.now(),
    });

    const killRes = await waitKill;
    assert.strictEqual(killRes.body.ok, true);
    assert.strictEqual(killRes.body.detail, "stopped after current step");

    // Pending approval for that session must be auto-denied to the engine
    const killApprovalRes = fakeEngine.resolutions.find((r) => r.approvalId === "appr-kill-pending-1");
    assert.ok(killApprovalRes, "Pending approval must be resolved on kill");
    assert.strictEqual(killApprovalRes.verdict, "denied");

    fakeEngine.taskDurationMs = 0;
    console.log("CASE 7: PASS");
  } catch (err) {
    console.error("CASE 7: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 8: File transfer
  // ==========================================
  console.log("\n--- CASE 8: File transfer ---");
  try {
    await new Promise((r) => setTimeout(r, 600));
    // 1. Happy path: 1 MB PDF offer -> chunks -> file_received with verified SHA-256
    const fileSize = 1024 * 1024;
    const fileBytes = new Uint8Array(fileSize);
    for (let i = 0; i < fileSize; i++) {
      fileBytes[i] = i % 256;
    }
    const fileSha256Bytes = sha256(fileBytes);
    let fileSha256Hex = "";
    for (const b of fileSha256Bytes) fileSha256Hex += b.toString(16).padStart(2, "0");

    const transferId1 = "11223344556677889900aabbccddeeff";
    const waitAccept1 = waitForDecrypted((k, b) => k === "file_accept" && b.transferId === transferId1);

    console.log("Sending file_offer...");
    sendPhoneEncrypted("file_offer", {
      transferId: transferId1,
      name: "report.pdf",
      mime: "application/pdf",
      sizeBytes: fileSize,
      sha256: fileSha256Hex,
    });
    await waitAccept1;
    console.log("file_offer accepted! Sending chunks...");

    // Send 64 KB chunks (spaced to respect relay's 30 msg/sec rate limit)
    const chunkSize = 64 * 1024;
    let seq = 0;
    for (let offset = 0; offset < fileSize; offset += chunkSize) {
      const slice = fileBytes.subarray(offset, Math.min(offset + chunkSize, fileSize));
      sendPhoneEncrypted("file_chunk", {
        transferId: transferId1,
        seq: seq++,
        data: bytesToBase64(slice),
      });
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log("Chunks sent! Sending file_done...");

    const waitReceived1 = waitForDecrypted((k, b) => k === "file_received" && b.transferId === transferId1);
    sendPhoneEncrypted("file_done", { transferId: transferId1 });
    const recRes1 = await waitReceived1;
    console.log("file_received!");

    assert.ok(recRes1.body.fileId, "Must receive fileId");
    assert.ok(
      fakeEngine.attachedFiles.some((f) => f.fileId === recRes1.body.fileId),
      "Engine must receive attachFile",
    );
    await new Promise((r) => setTimeout(r, 400));

    // 2. Oversized offer rejected (> 25 MB)
    console.log("Subcase 8.2: sending oversized offer...");
    const transferIdOversized = "aabbccddeeff00112233445566778899";
    const waitReject = waitForDecrypted((k, b) => k === "file_reject" && b.transferId === transferIdOversized);
    sendPhoneEncrypted("file_offer", {
      transferId: transferIdOversized,
      name: "huge.pdf",
      mime: "application/pdf",
      sizeBytes: 30 * 1024 * 1024,
      sha256: fileSha256Hex,
    });
    const rejRes = await waitReject;
    assert.ok(rejRes.body.reason.includes("25 MB"), "Oversized file offer must be rejected");
    console.log("Subcase 8.2: PASS");
    await new Promise((r) => setTimeout(r, 400));

    // 3. Path traversal attack: name "../../evil.sh" stored safely under fileId
    console.log("Subcase 8.3: sending path traversal offer...");
    const transferIdEvil = "deadbeefcafebabe0123456789abcdef";
    const evilBytes = new Uint8Array([1, 2, 3, 4]);
    const evilHashBytes = sha256(evilBytes);
    let evilHashHex = "";
    for (const b of evilHashBytes) evilHashHex += b.toString(16).padStart(2, "0");

    const waitAcceptEvil = waitForDecrypted((k, b) => k === "file_accept" && b.transferId === transferIdEvil);
    sendPhoneEncrypted("file_offer", {
      transferId: transferIdEvil,
      name: "../../evil.sh",
      mime: "text/plain",
      sizeBytes: evilBytes.length,
      sha256: evilHashHex,
    });
    await waitAcceptEvil;
    await new Promise((r) => setTimeout(r, 100));

    sendPhoneEncrypted("file_chunk", {
      transferId: transferIdEvil,
      seq: 0,
      data: bytesToBase64(evilBytes),
    });
    await new Promise((r) => setTimeout(r, 100));

    const waitReceivedEvil = waitForDecrypted((k, b) => k === "file_received" && b.transferId === transferIdEvil);
    sendPhoneEncrypted("file_done", { transferId: transferIdEvil });
    const recEvil = await waitReceivedEvil;

    assert.ok(!fs.existsSync(path.join(tmpDir, "evil.sh")), "Path traversal must not write to relative path");
    const safeInboxFile = path.join(tmpDir, "responder-data", "inbox", recEvil.body.fileId);
    assert.ok(fs.existsSync(safeInboxFile), "File must be safely written under fileId in inbox");
    console.log("Subcase 8.3: PASS");
    await new Promise((r) => setTimeout(r, 400));

    // 4. Corrupted bytes -> file_error and FakeEngine never sees it
    console.log("Subcase 8.4: sending corrupted file...");
    const transferIdCorrupt = "00112233445566778899aabbccddeeff";
    const waitAcceptCorrupt = waitForDecrypted((k, b) => k === "file_accept" && b.transferId === transferIdCorrupt);
    sendPhoneEncrypted("file_offer", {
      transferId: transferIdCorrupt,
      name: "corrupt.pdf",
      mime: "application/pdf",
      sizeBytes: 4,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    console.log("Subcase 8.4: waiting for file_accept...");
    await waitAcceptCorrupt;
    console.log("Subcase 8.4: file_accept received! Sending chunk...");

    sendPhoneEncrypted("file_chunk", {
      transferId: transferIdCorrupt,
      seq: 0,
      data: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
    });
    console.log("Subcase 8.4: chunk sent! Sending file_done...");
    await new Promise((r) => setTimeout(r, 60));

    const waitCorruptErr = waitForDecrypted((k, b) => k === "file_error" && b.transferId === transferIdCorrupt);
    sendPhoneEncrypted("file_done", { transferId: transferIdCorrupt });
    console.log("Subcase 8.4: waiting for file_error...");
    const errRes = await waitCorruptErr;
    console.log("Subcase 8.4: file_error received:", errRes.body);
    assert.strictEqual(errRes.body.code, "INTEGRITY_ERROR");
    console.log("Subcase 8.4: PASS");

    console.log("CASE 8: PASS");
  } catch (err) {
    console.error("CASE 8: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 9: Recovery
  // ==========================================
  console.log("\n--- CASE 9: Recovery ---");
  try {
    fakeEngine.taskDurationMs = 500;
    const recoveryKey = "recovery-task-key-9";
    const initialExecutionCount = fakeEngine.instructionExecutionCount;

    // 1. Task in-flight
    sendPhoneEncrypted("command_request", {
      idempotencyKey: recoveryKey,
      instruction: "Long background task",
      sentAt: Date.now(),
    });

    // 2. Socket dropped while task is running
    await new Promise((r) => setTimeout(r, 50));
    phoneRelayClient.close();
    console.log("Socket dropped while task in-flight.");

    // Wait for task to finish in background on laptop
    await new Promise((r) => setTimeout(r, 600));

    // 3. Reconnect + re-handshake
    phoneRelayClient.connect();
    await waitForStatus(phoneRelayClient, "online");

    const advert = responder.pairingManager.getAdvertisement();
    const initiator = new NoiseIKInitiator({
      staticKeypair: phoneX25519,
      remoteStaticPublicKey: base64ToBytes(advert.desktopPublicKey),
    });
    const msg1 = initiator.writeMessage1(new Uint8Array(0));

    const rehandshakeReq = {
      v: 1,
      id: "recovery-rehandshake",
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "pairing_request",
      payload: {
        ref: "skip-ref",
        mobileDeviceId: phoneDeviceId,
        mobilePublicKey: bytesToBase64(phoneX25519.publicKey),
        handshakeMessage: bytesToBase64(msg1),
      },
    };

    phoneRelayClient.send(rehandshakeReq);
    const grant = await waitForMessage((m) => m.kind === "pairing_grant");

    initiator.readMessage2(base64ToBytes(grant.payload.handshakeMessage));
    phoneSession = {
      peerDeviceId: desktopIdentity.deviceId,
      handshakeHash: initiator.getHandshakeHash(),
      establishedAt: Date.now(),
      encrypt: (pt) => initiator.encrypt(pt),
      decrypt: (ct) => initiator.decrypt(ct),
    };

    phoneE2EState = mobileNewE2EState();

    // 4. Re-request by key
    const waitRecoveredResult = waitForDecrypted((k, b) => k === "command_result" && b.idempotencyKey === recoveryKey);
    sendPhoneEncrypted("command_request", {
      idempotencyKey: recoveryKey,
      instruction: "Long background task",
      sentAt: Date.now(),
    });

    const recoveredRes = await waitRecoveredResult;
    assert.strictEqual(recoveredRes.body.ok, true);
    assert.strictEqual(
      fakeEngine.instructionExecutionCount,
      initialExecutionCount + 1,
      "Task must not execute twice; counter unchanged",
    );

    console.log("CASE 9: PASS");
  } catch (err) {
    console.error("CASE 9: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 10: hello-capture (FIX-1, FIX-5)
  // ==========================================
  console.log("\n--- CASE 10: hello-capture ---");
  try {
    // Revoke previous pairing so we test fresh pairing
    await responder.pairingManager.revokeTrustedPhone();
    responder.e2e.clearPeer(phoneDeviceId);
    await new Promise((r) => setTimeout(r, 100));

    // Phone sends relay hello containing helloPubkey
    phoneRelayClient.send({
      v: 1,
      id: "hello-capture-env-10",
      ts: Date.now(),
      from: phoneDeviceId,
      to: desktopIdentity.deviceId,
      kind: "hello",
      payload: {
        helloPubkey: bytesToBase64(phoneEd25519.publicKey),
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    // Fresh pairing
    responder.pairingManager.rotateRef();
    const advert10 = responder.pairingManager.getAdvertisement();
    const reqEnv10 = phonePairingManager.beginPairing(advert10);
    phoneRelayClient.send(reqEnv10);

    const grantEnv10 = await waitForMessage((m) => m.kind === "pairing_grant");
    phoneSession = phonePairingManager.handleGrant(grantEnv10);
    phoneE2EState = mobileNewE2EState();

    const candidate10 = responder.pairingManager.getCandidatePairing();
    assert.ok(candidate10, "Candidate pairing must exist");
    const code10 = candidate10.verificationCode;

    // Call responder.confirmTrustedPhone(code) with NO explicit hello pubkey!
    const record10 = await responder.confirmTrustedPhone(code10);
    assert.strictEqual(
      record10.phoneHelloPubkeyB64,
      bytesToBase64(phoneEd25519.publicKey),
      "Must capture hello pubkey from observed hello",
    );

    // Emit approval request from FakeEngine
    fakeEngine.emitApproval({
      approvalId: "appr-case-10",
      sessionId: "session-case-10",
      tool: "SYSTEM_COMMAND",
      summary: "Test command",
      detail: "echo test",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    });

    const apprReq10 = await waitForDecrypted(
      (k, b) => k === "approval_request" && b.approvalId === "appr-case-10",
    );
    const dec10 = buildApprovalDecision(
      apprReq10.body,
      "approved",
      undefined,
      Date.now(),
    );
    const signedDec10 = signApprovalDecision(dec10, phoneEd25519.privateKey);
    sendPhoneEncrypted("approval_decision", signedDec10);

    await new Promise((r) => setTimeout(r, 200));
    const resolution10 = fakeEngine.resolutions.find(
      (r) => r.approvalId === "appr-case-10",
    );
    assert.ok(resolution10, "FakeEngine must receive approval resolution");
    assert.strictEqual(resolution10.verdict, "approved");

    console.log("CASE 10: PASS");
  } catch (err) {
    console.error("CASE 10: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 11: failure idempotency (FIX-2)
  // ==========================================
  console.log("\n--- CASE 11: failure idempotency ---");
  try {
    fakeEngine.shouldFailInstruction = true;
    fakeEngine.instructionFailureError = "Simulated engine instruction failure";
    const initialExecutionCount = fakeEngine.instructionExecutionCount;
    const failKey = "fail-idemp-key-11";

    // 1. First execution attempt fails on engine
    const waitFail1 = waitForDecrypted(
      (k, b) => k === "command_result" && b.idempotencyKey === failKey,
    );
    sendPhoneEncrypted("command_request", {
      idempotencyKey: failKey,
      instruction: "Fail me",
      sentAt: Date.now(),
    });

    const res1 = await waitFail1;
    assert.strictEqual(res1.body.ok, false);
    assert.ok(
      res1.body.summary.includes("Simulated engine instruction failure"),
      "Must receive failure summary",
    );
    assert.strictEqual(
      fakeEngine.instructionExecutionCount,
      initialExecutionCount + 1,
      "Engine should have executed once",
    );

    await new Promise((r) => setTimeout(r, 100));

    // 2. Redeliver same key -> engine execution count stays 1, phone gets ok:false
    const waitFail2 = waitForDecrypted(
      (k, b) => k === "command_result" && b.idempotencyKey === failKey,
    );
    sendPhoneEncrypted("command_request", {
      idempotencyKey: failKey,
      instruction: "Fail me again",
      sentAt: Date.now(),
    });

    const res2 = await waitFail2;
    assert.strictEqual(res2.body.ok, false);
    assert.strictEqual(
      fakeEngine.instructionExecutionCount,
      initialExecutionCount + 1,
      "Engine execution count must not increase on redelivery",
    );

    fakeEngine.shouldFailInstruction = false;
    console.log("CASE 11: PASS");
  } catch (err) {
    console.error("CASE 11: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 12: transfer cap (FIX-3)
  // ==========================================
  console.log("\n--- CASE 12: transfer cap ---");
  try {
    const tids = [
      "20000000000000000000000000000001",
      "20000000000000000000000000000002",
      "20000000000000000000000000000003",
      "20000000000000000000000000000004",
      "20000000000000000000000000000005",
    ];

    // Open 4 concurrent transfers
    for (let i = 0; i < 4; i++) {
      const waitAcc = waitForDecrypted(
        (k, b) => k === "file_accept" && b.transferId === tids[i],
      );
      sendPhoneEncrypted("file_offer", {
        transferId: tids[i],
        name: `concurrent-${i}.txt`,
        mime: "text/plain",
        sizeBytes: 100,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      });
      await waitAcc;
      await new Promise((r) => setTimeout(r, 50));
    }

    // 5th concurrent transfer must be rejected
    const waitRej = waitForDecrypted(
      (k, b) => k === "file_reject" && b.transferId === tids[4],
    );
    sendPhoneEncrypted("file_offer", {
      transferId: tids[4],
      name: "concurrent-4.txt",
      mime: "text/plain",
      sizeBytes: 100,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    const rejRes = await waitRej;
    assert.strictEqual(rejRes.body.transferId, tids[4]);
    assert.strictEqual(rejRes.body.reason, "Too many concurrent transfers");

    console.log("CASE 12: PASS");
  } catch (err) {
    console.error("CASE 12: FAIL", err);
    process.exit(1);
  }

  // ==========================================
  // CASE 13: malformed key (FIX-14b)
  // ==========================================
  console.log("\n--- CASE 13: malformed key ---");
  try {
    const waitMalformed = waitForDecrypted(
      (k, b) => k === "command_result" && b.idempotencyKey === "",
    );
    sendPhoneEncrypted("command_request", {
      idempotencyKey: "",
      instruction: "Do something with empty key",
      sentAt: Date.now(),
    });

    const malformedRes = await waitMalformed;
    assert.strictEqual(malformedRes.body.ok, false);
    assert.strictEqual(malformedRes.body.summary, "Invalid request");
    assert.strictEqual(malformedRes.body.idempotencyKey, "");

    console.log("CASE 13: PASS");
  } catch (err) {
    console.error("CASE 13: FAIL", err);
    process.exit(1);
  }

  // Teardown
  console.log("\n=== ALL THIRTEEN INTEGRATION CASES PASSED ===");
  await responder.stop();
  phoneRelayClient.close();
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("Integration test suite failure:", err);
  cleanup();
  process.exit(1);
});
