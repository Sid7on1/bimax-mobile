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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-e2e-test-"));
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
    bytesToBase64,
    base64ToBytes,
  } = require(path.join(distDir, "crypto", "base64.js"));

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
  const senderState = newE2EState();
  const receiverState = newE2EState();

  const fakeDecision = {
    approvalId: "appr-101",
    sessionId: "sess-202",
    decision: "approved",
    decidedAt: Date.now(),
    signature: "sig-base64-placeholder",
  };

  // ==========================================
  // STEP 1 (roundtrip)
  // ==========================================
  console.log("STEP 1 (roundtrip):");
  try {
    const outer1 = {
      id: "env-step1",
      from: "mobile-1",
      to: "desktop-1",
    };
    const ctB64 = seal(initSession, senderState, "approval_decision", fakeDecision, outer1);
    assert.strictEqual(typeof ctB64, "string", "ciphertext must be a base64 string");
    assert.strictEqual(senderState.sendSeq, 1, "sendSeq must increment after seal");

    const res = open(respSession, receiverState, {
      ...outer1,
      kind: "encrypted",
      ciphertextB64: ctB64,
    });
    assert.strictEqual(res.duplicate, false, "first delivery must not be duplicate");
    assert.strictEqual(res.innerKind, "approval_decision", "innerKind must match original");
    assert.deepStrictEqual(res.body, fakeDecision, "body must match original");
    assert.strictEqual(receiverState.recvHighestSeq, 0, "receiver recvHighestSeq must be 0");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 2 (tamper)
  // ==========================================
  console.log("STEP 2 (tamper):");
  try {
    const outer2 = {
      id: "env-step2",
      from: "mobile-1",
      to: "desktop-1",
    };
    const ctB64 = seal(initSession, senderState, "approval_decision", fakeDecision, outer2);
    const ctBytes = base64ToBytes(ctB64);
    ctBytes[0] ^= 0x55; // flip bits
    const tamperedB64 = bytesToBase64(ctBytes);

    let threw = false;
    try {
      open(respSession, receiverState, {
        ...outer2,
        kind: "encrypted",
        ciphertextB64: tamperedB64,
      });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, "open must throw on tampered ciphertext");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 3 (header tampering)
  // ==========================================
  console.log("STEP 3 (header tampering):");
  try {
    const { initSession: init3, respSession: resp3 } = createPairedSessions();
    const sender3 = newE2EState();
    const receiver3 = newE2EState();

    const outer3 = {
      id: "env-step3",
      from: "mobile-1",
      to: "desktop-1",
    };
    const ctB64 = seal(init3, sender3, "approval_decision", fakeDecision, outer3);

    let threw = false;
    try {
      open(resp3, receiver3, {
        id: "env-step3",
        from: "evil",
        to: "desktop-1",
        kind: "encrypted",
        ciphertextB64: ctB64,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /bound header mismatch/);
    }
    assert.strictEqual(threw, true, "open must throw on outer header mismatch");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 4 (duplicates + replay)
  // ==========================================
  console.log("STEP 4 (duplicates + replay):");
  try {
    const { initSession: init4, respSession: resp4 } = createPairedSessions();
    const sender4 = newE2EState();
    const receiver4 = newE2EState();

    const outer4 = {
      id: "env-step4",
      from: "mobile-1",
      to: "desktop-1",
    };
    const ctB64 = seal(init4, sender4, "approval_decision", fakeDecision, outer4);

    const first = open(resp4, receiver4, {
      ...outer4,
      kind: "encrypted",
      ciphertextB64: ctB64,
    });
    assert.strictEqual(first.duplicate, false, "first delivery must not be duplicate");

    // Re-deliver same envelope
    const second = open(resp4, receiver4, {
      ...outer4,
      kind: "encrypted",
      ciphertextB64: ctB64,
    });
    assert.strictEqual(second.duplicate, true, "duplicate delivery must return duplicate: true");

    // Now craft an envelope with an older seq but a fresh id
    // Receiver currently has recvHighestSeq = 0.
    // Send one more message so receiver's recvHighestSeq becomes 1.
    const outer4b = {
      id: "env-step4b",
      from: "mobile-1",
      to: "desktop-1",
    };
    const ctB64b = seal(init4, sender4, "approval_decision", fakeDecision, outer4b);
    const normal = open(resp4, receiver4, {
      ...outer4b,
      kind: "encrypted",
      ciphertextB64: ctB64b,
    });
    assert.strictEqual(normal.duplicate, false);
    assert.strictEqual(receiver4.recvHighestSeq, 1);

    // Now seal with a stale senderState (sendSeq = 0)
    const staleSender = { sendSeq: 0, recvHighestSeq: -1, seenIds: new Set() };
    const staleOuter = {
      id: "env-fresh-id-stale-seq",
      from: "mobile-1",
      to: "desktop-1",
    };
    const staleCt = seal(init4, staleSender, "approval_decision", fakeDecision, staleOuter);

    let threw = false;
    try {
      open(resp4, receiver4, {
        ...staleOuter,
        kind: "encrypted",
        ciphertextB64: staleCt,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /replay detected/);
    }
    assert.strictEqual(threw, true, "open must throw on replayed seq");

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 5 (wrong peer)
  // ==========================================
  console.log("STEP 5 (wrong peer):");
  try {
    const pairA = createPairedSessions("mobile-A", "desktop-A");
    const pairB = createPairedSessions("mobile-B", "desktop-B");
    const senderA = newE2EState();
    const receiverB = newE2EState();

    const outer5 = {
      id: "env-step5",
      from: "mobile-A",
      to: "desktop-A",
    };
    const ctA = seal(pairA.initSession, senderA, "approval_decision", fakeDecision, outer5);

    let threw = false;
    try {
      open(pairB.respSession, receiverB, {
        ...outer5,
        kind: "encrypted",
        ciphertextB64: ctA,
      });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, "open must throw when ciphertext is decrypted by wrong peer session");

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
