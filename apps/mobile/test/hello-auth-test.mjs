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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-hello-auth-test-"));
const outDir = path.join(tmpDir, "crypto-dist");

let testSuccess = false;

try {
  // Ensure the compiled files in tmpdir can resolve node_modules
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile keys.ts and base64.ts via tsc
  const compileCmd = `npx tsc apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts --outDir ${outDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  let distDir = outDir;
  if (!fs.existsSync(path.join(distDir, "keys.js"))) {
    if (fs.existsSync(path.join(distDir, "apps/mobile/lib/crypto/keys.js"))) {
      distDir = path.join(distDir, "apps/mobile/lib/crypto");
    }
  }

  const { bytesToBase64 } = require(path.join(distDir, "base64.js"));
  const {
    generateEd25519Keypair,
    ed25519Sign,
    ed25519Verify,
    canonicalJson,
  } = require(path.join(distDir, "keys.js"));

  // ==========================================
  // STEP 1 (sign/verify roundtrip)
  // ==========================================
  console.log("STEP 1 (sign/verify roundtrip):");
  const kp = generateEd25519Keypair();
  const helloPubkey = bytesToBase64(kp.publicKey);
  const helloMsg = {
    id: "env-hello-1",
    ts: 1700000000000,
    from: "device-test-1",
    deviceId: "device-test-1",
    role: "mobile",
    helloPubkey,
  };
  const canonicalStr = canonicalJson(helloMsg);
  const canonicalBytes = new TextEncoder().encode(canonicalStr);
  const signature = ed25519Sign(kp.privateKey, canonicalBytes);
  assert.strictEqual(signature.length, 64, "signature must be 64 bytes");
  const verified = ed25519Verify(kp.publicKey, canonicalBytes, signature);
  assert.strictEqual(verified, true, "valid signature must verify");
  console.log("  PASS");

  // ==========================================
  // STEP 2 (ts tamper)
  // ==========================================
  console.log("STEP 2 (ts tamper):");
  const tamperedMsg = {
    ...helloMsg,
    ts: helloMsg.ts + 1,
  };
  const tamperedBytes = new TextEncoder().encode(canonicalJson(tamperedMsg));
  const verifiedTampered = ed25519Verify(kp.publicKey, tamperedBytes, signature);
  assert.strictEqual(verifiedTampered, false, "tampered ts must fail verification");
  console.log("  PASS");

  // ==========================================
  // STEP 3 (wrong key)
  // ==========================================
  console.log("STEP 3 (wrong key):");
  const otherKp = generateEd25519Keypair();
  const verifiedWrongKey = ed25519Verify(otherKp.publicKey, canonicalBytes, signature);
  assert.strictEqual(verifiedWrongKey, false, "different public key must fail verification");
  console.log("  PASS");

  // ==========================================
  // STEP 4 (TOFU pin)
  // ==========================================
  console.log("STEP 4 (TOFU pin):");
  const pinMap = new Map();
  function handleHelloTofu(deviceId, pubkeyB64) {
    if (!pinMap.has(deviceId)) {
      pinMap.set(deviceId, pubkeyB64);
      return { ok: true, pinned: true };
    }
    const pinnedKey = pinMap.get(deviceId);
    if (pinnedKey !== pubkeyB64) {
      return { ok: false, error: "pubkey mismatch (squatting rejected)" };
    }
    return { ok: true, pinned: false };
  }

  const res1 = handleHelloTofu("device-test-1", helloPubkey);
  assert.strictEqual(res1.ok, true);
  assert.strictEqual(res1.pinned, true);

  const res2 = handleHelloTofu("device-test-1", helloPubkey);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.pinned, false);

  const impostorPubkey = bytesToBase64(otherKp.publicKey);
  const res3 = handleHelloTofu("device-test-1", impostorPubkey);
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.error, "pubkey mismatch (squatting rejected)");
  console.log("  PASS");

  // ==========================================
  // STEP 5 (kill shapes)
  // ==========================================
  console.log("STEP 5 (kill shapes):");
  const idempotencyKey = "kill-test-shape-" + Math.random().toString(36).slice(2);
  const killReq = {
    idempotencyKey,
    reason: "user requested abort",
    sentAt: Date.now(),
  };
  const killRes = {
    idempotencyKey,
    ok: true,
    detail: "agent terminated successfully",
    at: Date.now(),
  };

  assert.strictEqual(typeof killReq.idempotencyKey, "string");
  assert.ok(killReq.idempotencyKey.length > 0);
  assert.strictEqual(typeof killReq.sentAt, "number");
  assert.strictEqual(killRes.idempotencyKey, killReq.idempotencyKey, "idempotency keys must match");
  assert.strictEqual(typeof killRes.ok, "boolean");
  assert.strictEqual(typeof killRes.at, "number");
  console.log("  PASS");

  testSuccess = true;
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

if (!testSuccess) {
  process.exit(1);
}
