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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-crypto-test-"));
const outDir = path.join(tmpDir, "crypto-dist");

let testSuccess = false;

try {
  // Ensure the compiled files in tmpdir can resolve node_modules
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile the testable lib via tsc
  const compileCmd = `npx tsc apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/crypto/pairing.ts --outDir ${outDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  let distDir = fs.existsSync(path.join(outDir,"crypto/keys.js")) ? path.join(outDir,"crypto") : outDir;
  if (!fs.existsSync(path.join(distDir, "keys.js"))) {
    if (fs.existsSync(path.join(distDir, "apps/mobile/lib/crypto/keys.js"))) {
      distDir = path.join(distDir, "apps/mobile/lib/crypto");
    }
  }

  const { bytesToBase64, base64ToBytes } = require(path.join(distDir, "base64.js"));
  const {
    generateX25519Keypair,
    generateEd25519Keypair,
    x25519SharedSecret,
    hkdfSha256,
    chachaEncrypt,
    chachaDecrypt,
    ed25519Sign,
    ed25519Verify,
    canonicalJson,
  } = require(path.join(distDir, "keys.js"));
  const {
    parseAdvertisement,
    buildPairingRequest,
    validateGrant,
  } = require(path.join(distDir, "pairing.js"));

  // STEP 1 (base64)
  console.log("STEP 1 (base64):");
  for (const len of [0, 16, 32, 64]) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    const encoded = bytesToBase64(bytes);
    const decoded = base64ToBytes(encoded);
    assert.deepStrictEqual(decoded, bytes, `roundtrip failed for length ${len}`);
  }

  const knownBytes = new Uint8Array([104, 101, 108, 108, 111]);
  assert.strictEqual(bytesToBase64(knownBytes), "aGVsbG8=", "known vector encoding mismatch");
  assert.deepStrictEqual(base64ToBytes("aGVsbG8="), knownBytes, "known vector decoding mismatch");

  assert.throws(() => base64ToBytes("aGVsbG8-"), /base64/, "did not throw on '-'");
  assert.throws(() => base64ToBytes("invalid-char!"), /base64/, "did not throw on '!'");
  assert.throws(() => base64ToBytes("abc"), /length/, "did not throw on length % 4 !== 0");
  console.log("PASS");

  // STEP 2 (ECDH)
  console.log("STEP 2 (ECDH):");
  const a = generateX25519Keypair();
  const b = generateX25519Keypair();
  assert.strictEqual(a.privateKey.length, 32);
  assert.strictEqual(a.publicKey.length, 32);
  assert.strictEqual(b.privateKey.length, 32);
  assert.strictEqual(b.publicKey.length, 32);

  const ssAB = x25519SharedSecret(a.privateKey, b.publicKey);
  const ssBA = x25519SharedSecret(b.privateKey, a.publicKey);
  assert.strictEqual(ssAB.length, 32, "shared secret must be 32 bytes");
  assert.deepStrictEqual(ssAB, ssBA, "shared secrets must deep-equal");
  console.log("PASS");

  // STEP 3 (AEAD)
  console.log("STEP 3 (AEAD):");
  const ikm = new Uint8Array(32);
  crypto.getRandomValues(ikm);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const info = new TextEncoder().encode("bimax-test-session");
  const derivedKey = hkdfSha256(ikm, salt, info, 32);
  assert.strictEqual(derivedKey.length, 32, "derived key must be 32 bytes");

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode("hello bimax");
  const ciphertext = chachaEncrypt(derivedKey, nonce, plaintext);
  const decrypted = chachaDecrypt(derivedKey, nonce, ciphertext);
  assert.deepStrictEqual(decrypted, plaintext, "decrypted plaintext must match original");

  const tamperedCiphertext = new Uint8Array(ciphertext);
  tamperedCiphertext[0] ^= 1;
  assert.throws(
    () => chachaDecrypt(derivedKey, nonce, tamperedCiphertext),
    /chachaDecrypt/,
    "tampered ciphertext decryption must throw",
  );
  console.log("PASS");

  // STEP 4 (signatures + canonical JSON)
  console.log("STEP 4 (signatures + canonical JSON):");
  assert.strictEqual(
    canonicalJson({ b: 2, a: 1 }),
    canonicalJson({ a: 1, b: 2 }),
    "canonical JSON key ordering must be deterministic",
  );
  assert.strictEqual(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');

  const signer = generateEd25519Keypair();
  const imposter = generateEd25519Keypair();
  const canonicalBytes = new TextEncoder().encode(canonicalJson({ b: 2, a: 1 }));
  const signature = ed25519Sign(signer.privateKey, canonicalBytes);
  assert.strictEqual(signature.length, 64, "signature must be 64 bytes");

  assert.strictEqual(
    ed25519Verify(signer.publicKey, canonicalBytes, signature),
    true,
    "valid signature must verify",
  );
  assert.strictEqual(
    ed25519Verify(imposter.publicKey, canonicalBytes, signature),
    false,
    "verification with different public key must return false",
  );

  const tamperedMessage = new TextEncoder().encode(canonicalJson({ b: 3, a: 1 }));
  assert.strictEqual(
    ed25519Verify(signer.publicKey, tamperedMessage, signature),
    false,
    "verification on tampered message must return false",
  );
  console.log("PASS");

  // STEP 5 (pairing messages)
  console.log("STEP 5 (pairing messages):");
  const validAdvert = {
    relayUrl: "wss://relay.bimax.local:8787",
    ref: "ref-sample-1234",
    desktopDeviceId: "desktop-device-001",
    desktopPublicKey: bytesToBase64(generateX25519Keypair().publicKey),
    app: "bimax",
  };
  const parsedAdvert = parseAdvertisement(JSON.stringify(validAdvert));
  assert.deepStrictEqual(parsedAdvert, validAdvert, "parsed advertisement must match original");

  assert.throws(
    () => parseAdvertisement("invalid json{{"),
    /invalid JSON/,
    "garbage JSON must throw",
  );

  const missingFieldAdvert = { ...validAdvert };
  delete missingFieldAdvert.desktopPublicKey;
  assert.throws(
    () => parseAdvertisement(JSON.stringify(missingFieldAdvert)),
    /desktopPublicKey/,
    "missing field must throw",
  );

  const badAppAdvert = { ...validAdvert, app: "not-bimax" };
  assert.throws(
    () => parseAdvertisement(JSON.stringify(badAppAdvert)),
    /app/,
    "app !== bimax must throw",
  );

  const mobileDeviceId = "mobile-device-777";
  const mobilePublicKeyBase64 = "bW9iaWxlLXB1YmxpYy1rZXk=";
  const pairingReq = buildPairingRequest(parsedAdvert, mobileDeviceId, mobilePublicKeyBase64);
  assert.strictEqual(pairingReq.to, parsedAdvert.desktopDeviceId, "to must match desktopDeviceId");
  assert.strictEqual(pairingReq.payload.ref, parsedAdvert.ref, "payload.ref must match advert.ref");
  assert.strictEqual(pairingReq.from, mobileDeviceId, "from must match mobileDeviceId");
  assert.strictEqual(pairingReq.v, 2, "protocol version must be 2");
  assert.strictEqual(pairingReq.kind, "pairing_request", "kind must be pairing_request");
  assert.strictEqual(pairingReq.payload.mobileDeviceId, mobileDeviceId);
  assert.strictEqual(pairingReq.payload.mobilePublicKey, mobilePublicKeyBase64);

  const grantEnvelope = {
    v: 2,
    id: "grant-test-1",
    ts: Date.now(),
    from: parsedAdvert.desktopDeviceId,
    to: mobileDeviceId,
    kind: "pairing_grant",
    payload: {
      mobileDeviceId,
      grantedAt: 1700000000000,
      handshakeMessage: "bXNnMi1iYXNlNjQ=",
    },
  };
  const validatedGrant = validateGrant(grantEnvelope);
  assert.strictEqual(validatedGrant.mobileDeviceId, mobileDeviceId);
  assert.strictEqual(validatedGrant.grantedAt, 1700000000000);
  assert.strictEqual(validatedGrant.handshakeMessage, "bXNnMi1iYXNlNjQ=");
  console.log("PASS");

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
