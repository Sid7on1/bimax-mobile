import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-control-test-"));
const distDir = path.join(tmpDir, "dist");

function cleanup() {
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

async function main() {
  console.log("Compiling testable files to tmpdir...");
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  const compileCmd = `npx tsc apps/mobile/lib/e2e/framing.ts apps/mobile/lib/session/session.ts apps/mobile/lib/crypto/noise.ts apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/crypto/pairing.ts --outDir ${distDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  const {
    seal,
    open,
    newE2EState,
  } = require(path.join(distDir, "e2e", "framing.js"));

  const {
    generateX25519Keypair,
  } = require(path.join(distDir, "crypto", "keys.js"));

  const {
    NoiseIKInitiator,
    NoiseIKResponder,
  } = require(path.join(distDir, "crypto", "noise.js"));

  // Helper to establish paired Noise sessions
  function createPairedSessions(initDeviceId = "mobile-1", respDeviceId = "desktop-1") {
    const initStatic = generateX25519Keypair();
    const respStatic = generateX25519Keypair();

    const initiator = new NoiseIKInitiator({
      staticKeypair: initStatic,
      remoteStaticPublicKey: respStatic.publicKey,
    });
    const responder = new NoiseIKResponder({
      staticKeypair: respStatic,
    });

    const msg1 = initiator.writeMessage1(new Uint8Array(0));
    responder.readMessage1(msg1);
    const msg2 = responder.writeMessage2(new Uint8Array(0));
    initiator.readMessage2(msg2);

    const initSession = {
      peerDeviceId: respDeviceId,
      handshakeHash: initiator.getHandshakeHash(),
      establishedAt: Date.now(),
      encrypt: (pt) => initiator.encrypt(pt),
      decrypt: (ct) => initiator.decrypt(ct),
    };

    const respSession = {
      peerDeviceId: initDeviceId,
      handshakeHash: responder.getHandshakeHash(),
      establishedAt: Date.now(),
      encrypt: (pt) => responder.encrypt(pt),
      decrypt: (ct) => responder.decrypt(ct),
    };

    return { initSession, respSession };
  }

  const { initSession, respSession } = createPairedSessions();
  const phoneState = newE2EState();
  const desktopState = newE2EState();

  // ==========================================
  // STEP 1 (command roundtrip)
  // ==========================================
  console.log("STEP 1 (command roundtrip):");
  try {
    const cmdReq = {
      instruction: "git status",
      idempotencyKey: "cmd-test-101",
      sentAt: Date.now(),
    };
    const outerReq = { id: "env-cmd-101", from: "mobile-1", to: "desktop-1" };
    const ctReq = seal(initSession, phoneState, "command_request", cmdReq, outerReq);

    const openedCmd = open(respSession, desktopState, {
      ...outerReq,
      kind: "encrypted",
      ciphertextB64: ctReq,
    });
    assert.strictEqual(openedCmd.duplicate, false);
    assert.strictEqual(openedCmd.innerKind, "command_request");
    assert.strictEqual(openedCmd.body.instruction, "git status");
    assert.strictEqual(openedCmd.body.idempotencyKey, "cmd-test-101");

    const cmdRes = {
      idempotencyKey: "cmd-test-101",
      ok: true,
      summary: "Working tree clean, on branch main",
    };
    const outerRes = { id: "env-res-101", from: "desktop-1", to: "mobile-1" };
    const ctRes = seal(respSession, desktopState, "command_result", cmdRes, outerRes);

    const openedRes = open(initSession, phoneState, {
      ...outerRes,
      kind: "encrypted",
      ciphertextB64: ctRes,
    });
    assert.strictEqual(openedRes.duplicate, false);
    assert.strictEqual(openedRes.innerKind, "command_result");
    assert.strictEqual(openedRes.body.ok, true);
    assert.strictEqual(openedRes.body.summary, "Working tree clean, on branch main");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 2 (status + sessions)
  // ==========================================
  console.log("STEP 2 (status + sessions):");
  try {
    const statusPayload = {
      state: "working",
      sessionId: "sess-abc-123",
      taskSummary: "Building mobile remote-control surface",
      updatedAt: Date.now(),
    };
    const outerStatus = { id: "env-status-201", from: "desktop-1", to: "mobile-1" };
    const statusCt = seal(respSession, desktopState, "agent_status", statusPayload, outerStatus);

    const openedStatus = open(initSession, phoneState, {
      ...outerStatus,
      kind: "encrypted",
      ciphertextB64: statusCt,
    });
    assert.strictEqual(openedStatus.duplicate, false);
    assert.strictEqual(openedStatus.innerKind, "agent_status");
    assert.deepStrictEqual(openedStatus.body, statusPayload);

    const sessionsPayload = {
      sessions: [
        {
          sessionId: "sess-1",
          title: "Refactor core session provider",
          status: "idle",
          startedAt: Date.now() - 10000,
        },
        {
          sessionId: "sess-2",
          title: "Implement biometric approvals",
          status: "working",
          startedAt: Date.now() - 5000,
        },
      ],
    };
    const outerList = { id: "env-list-202", from: "desktop-1", to: "mobile-1" };
    const listCt = seal(respSession, desktopState, "session_list", sessionsPayload, outerList);

    const openedList = open(initSession, phoneState, {
      ...outerList,
      kind: "encrypted",
      ciphertextB64: listCt,
    });
    assert.strictEqual(openedList.duplicate, false);
    assert.strictEqual(openedList.innerKind, "session_list");
    assert.deepStrictEqual(openedList.body, sessionsPayload);

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 3 (kill)
  // ==========================================
  console.log("STEP 3 (kill):");
  try {
    const killReq = {
      reason: "User requested abort from phone",
      sentAt: Date.now(),
    };
    const outerKill = { id: "env-kill-301", from: "mobile-1", to: "desktop-1" };
    const killCt = seal(initSession, phoneState, "kill_request", killReq, outerKill);

    const openedKill = open(respSession, desktopState, {
      ...outerKill,
      kind: "encrypted",
      ciphertextB64: killCt,
    });
    assert.strictEqual(openedKill.duplicate, false);
    assert.strictEqual(openedKill.innerKind, "kill_request");
    assert.deepStrictEqual(openedKill.body, killReq);

    // Tamper outer 'to' header
    const outerKill2 = { id: "env-kill-302", from: "mobile-1", to: "desktop-1" };
    const killCt2 = seal(initSession, phoneState, "kill_request", killReq, outerKill2);

    let threw = false;
    try {
      open(respSession, desktopState, {
        id: "env-kill-302",
        from: "mobile-1",
        to: "evil-desktop",
        kind: "encrypted",
        ciphertextB64: killCt2,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /bound header mismatch/);
    }
    assert.strictEqual(threw, true, "open must throw on tampered outer to header");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 4 (duplicate command)
  // ==========================================
  console.log("STEP 4 (duplicate command):");
  try {
    const { initSession: pInit, respSession: pResp } = createPairedSessions();
    const pPhoneState = newE2EState();
    const pDesktopState = newE2EState();

    const cmdReq4 = {
      instruction: "npm test",
      idempotencyKey: "cmd-dup-401",
      sentAt: Date.now(),
    };
    const dupOuter = { id: "env-dup-401", from: "mobile-1", to: "desktop-1" };
    const dupCt = seal(pInit, pPhoneState, "command_request", cmdReq4, dupOuter);

    const first = open(pResp, pDesktopState, {
      ...dupOuter,
      kind: "encrypted",
      ciphertextB64: dupCt,
    });
    assert.strictEqual(first.duplicate, false, "first delivery must not be duplicate");

    const second = open(pResp, pDesktopState, {
      ...dupOuter,
      kind: "encrypted",
      ciphertextB64: dupCt,
    });
    assert.strictEqual(second.duplicate, true, "second delivery must return duplicate: true");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 5 (large instruction)
  // ==========================================
  console.log("STEP 5 (large instruction):");
  try {
    const { initSession: pInit5, respSession: pResp5 } = createPairedSessions();
    const pPhoneState5 = newE2EState();
    const pDesktopState5 = newE2EState();

    const largeInstruction = "Z".repeat(4096);
    const largeCmd = {
      instruction: largeInstruction,
      idempotencyKey: "cmd-large-501",
      sentAt: Date.now(),
    };
    const largeOuter = { id: "env-large-501", from: "mobile-1", to: "desktop-1" };
    const largeCt = seal(pInit5, pPhoneState5, "command_request", largeCmd, largeOuter);

    const openedLarge = open(pResp5, pDesktopState5, {
      ...largeOuter,
      kind: "encrypted",
      ciphertextB64: largeCt,
    });
    assert.strictEqual(openedLarge.duplicate, false);
    assert.strictEqual(openedLarge.innerKind, "command_request");
    assert.strictEqual(openedLarge.body.instruction.length, 4096);
    assert.strictEqual(openedLarge.body.instruction, largeInstruction);

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  console.log("\nALL STEPS PASSED");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("Test error:", err);
  cleanup();
  process.exit(1);
});
