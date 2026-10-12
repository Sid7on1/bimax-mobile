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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-approvals-test-"));
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
  // Ensure the compiled files in tmpdir can resolve node_modules
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile testable files into tmpdir
  const compileCmd = `npx tsc apps/mobile/lib/approvals/approvals.ts apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/session/session.ts apps/mobile/lib/crypto/noise.ts apps/mobile/lib/crypto/pairing.ts --outDir ${distDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  const {
    addApproval,
    getPending,
    removeApproval,
    clearApprovals,
    buildApprovalDecision,
    signApprovalDecision,
    verifyApprovalDecision,
    decideWithBiometric,
  } = require(path.join(distDir, "approvals", "approvals.js"));

  const {
    generateEd25519Keypair,
    generateX25519Keypair,
  } = require(path.join(distDir, "crypto", "keys.js"));

  const {
    bytesToBase64,
    base64ToBytes,
  } = require(path.join(distDir, "crypto", "base64.js"));

  const {
    PairingManager,
  } = require(path.join(distDir, "session", "session.js"));

  const {
    NoiseIKResponder,
  } = require(path.join(distDir, "crypto", "noise.js"));

  // ==========================================
  // STEP 1 (sign/verify)
  // ==========================================
  console.log("STEP 1 (sign/verify):");
  try {
    const fakeReq = {
      approvalId: "appr-fake-1",
      sessionId: "sess-fake-1",
      tool: "bash",
      summary: "Run npm test",
      detail: "npm test -- --coverage",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };

    const edKeypair = generateEd25519Keypair();
    const unsigned = buildApprovalDecision(fakeReq, "approve");
    const signed = signApprovalDecision(unsigned, edKeypair.privateKey);

    assert.ok(signed.signature, "signed decision must have signature");
    assert.strictEqual(
      verifyApprovalDecision(signed, edKeypair.publicKey),
      true,
      "verifyApprovalDecision must return true for valid signature",
    );

    // Tamper decidedAt
    const tampered = { ...signed, decidedAt: signed.decidedAt + 1 };
    assert.strictEqual(
      verifyApprovalDecision(tampered, edKeypair.publicKey),
      false,
      "verifyApprovalDecision must return false for tampered decision",
    );

    // Verify with a wrong public key
    const wrongKeypair = generateEd25519Keypair();
    assert.strictEqual(
      verifyApprovalDecision(signed, wrongKeypair.publicKey),
      false,
      "verifyApprovalDecision must return false for wrong public key",
    );

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 2 (approval store)
  // ==========================================
  console.log("STEP 2 (approval store):");
  try {
    clearApprovals();

    const now = Date.now();
    const liveReq = {
      approvalId: "appr-live-1",
      sessionId: "sess-live-1",
      tool: "file_edit",
      summary: "Update index.ts",
      detail: "diff --git a/index.ts b/index.ts",
      requestedAt: now,
      expiresAt: now + 60000,
    };

    const expiredReq = {
      approvalId: "appr-expired-1",
      sessionId: "sess-expired-1",
      tool: "exec_command",
      summary: "Run git status",
      detail: "git status",
      requestedAt: now - 10000,
      expiresAt: now - 1000,
    };

    addApproval(liveReq);
    addApproval(expiredReq);

    const pending = getPending();
    assert.strictEqual(pending.length, 1, "getPending() must return only non-expired approvals");
    assert.strictEqual(pending[0].approvalId, liveReq.approvalId);

    removeApproval(liveReq.approvalId);
    assert.strictEqual(
      getPending().length,
      0,
      "removeApproval must remove live approval from getPending()",
    );

    // Re-adding the same approvalId throws
    assert.throws(
      () => addApproval(expiredReq),
      /duplicate approvalId/,
      "re-adding the same approvalId must throw",
    );

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 3 (re-handshake)
  // ==========================================
  console.log("STEP 3 (re-handshake):");
  try {
    const desktopDeviceId = "desktop-device-001";
    const phoneDeviceId = "phone-device-001";
    const desktopStaticKeypair = generateX25519Keypair();
    const phoneStaticKeypair = generateX25519Keypair();

    // 1. Initial pairing
    const advert1 = {
      relayUrl: "wss://relay.example.com",
      ref: "ref-initial-001",
      desktopDeviceId,
      desktopPublicKey: bytesToBase64(desktopStaticKeypair.publicKey),
      app: "bimax",
    };

    const phonePm1 = new PairingManager({
      deviceId: phoneDeviceId,
      staticKeypair: phoneStaticKeypair,
    });
    const reqEnv1 = phonePm1.beginPairing(advert1);

    const desktopResponder1 = new NoiseIKResponder({
      staticKeypair: desktopStaticKeypair,
    });
    const readReq1 = desktopResponder1.readMessage1(
      base64ToBytes(reqEnv1.payload.handshakeMessage),
    );
    assert.deepStrictEqual(
      readReq1.remoteStaticPublicKey,
      phoneStaticKeypair.publicKey,
      "desktop responder 1 must authenticate phone static public key",
    );

    const msg2_1 = desktopResponder1.writeMessage2(new Uint8Array(0));
    const grantEnv1 = {
      v: 1,
      id: "grant-env-1",
      ts: Date.now(),
      from: desktopDeviceId,
      to: phoneDeviceId,
      kind: "pairing_grant",
      payload: {
        mobileDeviceId: phoneDeviceId,
        grantedAt: Date.now(),
        handshakeMessage: bytesToBase64(msg2_1),
      },
    };
    const session1 = phonePm1.handleGrant(grantEnv1);
    assert.strictEqual(session1.peerDeviceId, desktopDeviceId);
    assert.deepStrictEqual(
      session1.handshakeHash,
      desktopResponder1.getHandshakeHash(),
      "session 1 handshake hashes must match",
    );

    // 2. Simulate app restart: new PairingManager with the SAME static keypair
    const phonePmRestart = new PairingManager({
      deviceId: phoneDeviceId,
      staticKeypair: phoneStaticKeypair,
    });

    // Synthesized re-handshake advert using saved trusted desktop values
    const synthAdvert = {
      relayUrl: advert1.relayUrl,
      ref: "rehandshake-" + Math.random().toString(36).slice(2),
      desktopDeviceId: advert1.desktopDeviceId,
      desktopPublicKey: advert1.desktopPublicKey,
      app: "bimax",
    };

    const rehandshakeReqEnv = phonePmRestart.beginPairing(synthAdvert);

    // Desktop responder with the SAME desktop static keypair
    const desktopResponder2 = new NoiseIKResponder({
      staticKeypair: desktopStaticKeypair,
    });
    const readReq2 = desktopResponder2.readMessage1(
      base64ToBytes(rehandshakeReqEnv.payload.handshakeMessage),
    );
    assert.deepStrictEqual(
      readReq2.remoteStaticPublicKey,
      phoneStaticKeypair.publicKey,
      "desktop responder 2 must authenticate known phone static public key",
    );

    const msg2_2 = desktopResponder2.writeMessage2(new Uint8Array(0));
    const grantEnv2 = {
      v: 1,
      id: "grant-env-2",
      ts: Date.now(),
      from: desktopDeviceId,
      to: phoneDeviceId,
      kind: "pairing_grant",
      payload: {
        mobileDeviceId: phoneDeviceId,
        grantedAt: Date.now(),
        handshakeMessage: bytesToBase64(msg2_2),
      },
    };

    const session2 = phonePmRestart.handleGrant(grantEnv2);
    assert.ok(session2, "second session must establish");
    assert.strictEqual(session2.peerDeviceId, desktopDeviceId);
    assert.deepStrictEqual(
      session2.handshakeHash,
      desktopResponder2.getHandshakeHash(),
      "second session handshake hashes must match between initiator and responder",
    );

    // Verify channel encryption works end-to-end
    const testPlaintext = new TextEncoder().encode("re-handshake secure transport ping");
    const ciphertext = session2.encrypt(testPlaintext);
    const decrypted = desktopResponder2.decrypt(ciphertext);
    assert.deepStrictEqual(decrypted, testPlaintext);

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }

  // ==========================================
  // STEP 4 (biometric gate)
  // ==========================================
  console.log("STEP 4 (biometric gate):");
  try {
    const fakeReq = {
      approvalId: "appr-bio-1",
      sessionId: "sess-bio-1",
      tool: "terminal_exec",
      summary: "Restart server",
      detail: "pm2 restart app",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };
    const edKeypair = generateEd25519Keypair();

    // Case 1: requestBiometric resolves false
    let decisionCalledFalse = false;
    let deniedReason = null;
    await decideWithBiometric({
      requestBiometric: async () => false,
      build: () => buildApprovalDecision(fakeReq, "approve"),
      sign: (unsigned) => signApprovalDecision(unsigned, edKeypair.privateKey),
      onDecision: () => {
        decisionCalledFalse = true;
      },
      onDenied: (reason) => {
        deniedReason = reason;
      },
    });

    assert.strictEqual(
      decisionCalledFalse,
      false,
      "onDecision must NOT be called when biometric fails",
    );
    assert.strictEqual(
      deniedReason,
      "biometric-failed",
      "onDenied must be called with 'biometric-failed'",
    );

    // Case 2: requestBiometric resolves true
    let signedDecisionResult = null;
    let deniedCalledTrue = false;
    await decideWithBiometric({
      requestBiometric: async () => true,
      build: () => buildApprovalDecision(fakeReq, "approve"),
      sign: (unsigned) => signApprovalDecision(unsigned, edKeypair.privateKey),
      onDecision: (dec) => {
        signedDecisionResult = dec;
      },
      onDenied: () => {
        deniedCalledTrue = true;
      },
    });

    assert.strictEqual(deniedCalledTrue, false);
    assert.ok(signedDecisionResult, "onDecision must be called with signed decision");
    assert.strictEqual(
      verifyApprovalDecision(signedDecisionResult, edKeypair.publicKey),
      true,
      "decision signed via biometric gate must be verifiable",
    );

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
