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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-noise-test-"));
const outDir = path.join(tmpDir, "crypto-dist");

let testSuccess = false;

try {
  // Ensure the compiled files in tmpdir can resolve node_modules
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile noise.ts, keys.ts, base64.ts
  const compileCmd = `npx tsc apps/mobile/lib/crypto/noise.ts apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts --outDir ${outDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  let distDir = outDir;
  if (!fs.existsSync(path.join(distDir, "noise.js"))) {
    if (fs.existsSync(path.join(distDir, "apps/mobile/lib/crypto/noise.js"))) {
      distDir = path.join(distDir, "apps/mobile/lib/crypto");
    }
  }

  const {
    generateX25519Keypair,
    x25519GetPublicKey,
  } = require(path.join(distDir, "keys.js"));
  const {
    NoiseIKInitiator,
    NoiseIKResponder,
  } = require(path.join(distDir, "noise.js"));

  // STEP 1 (full handshake)
  console.log("STEP 1 (full handshake):");
  const initStatic = generateX25519Keypair();
  const respStatic = generateX25519Keypair();

  const initiator1 = new NoiseIKInitiator({
    staticKeypair: initStatic,
    remoteStaticPublicKey: respStatic.publicKey,
  });
  const responder1 = new NoiseIKResponder({
    staticKeypair: respStatic,
  });

  const refPayload = new TextEncoder().encode("ref-bimax-pairing-01");
  const grantPayload = new TextEncoder().encode("grant-bimax-approved-01");

  const msg1 = initiator1.writeMessage1(refPayload);
  const read1 = responder1.readMessage1(msg1);
  assert.deepStrictEqual(read1.payload, refPayload, "responder decrypted payload1 mismatch");
  assert.deepStrictEqual(
    read1.remoteStaticPublicKey,
    initStatic.publicKey,
    "responder learned wrong initiator static pubkey",
  );

  const msg2 = responder1.writeMessage2(grantPayload);
  const read2 = initiator1.readMessage2(msg2);
  assert.deepStrictEqual(read2, grantPayload, "initiator decrypted payload2 mismatch");

  const initHash = initiator1.getHandshakeHash();
  const respHash = responder1.getHandshakeHash();
  assert.strictEqual(initHash.length, 32, "handshake hash must be 32 bytes");
  assert.deepStrictEqual(initHash, respHash, "handshake hashes must match");

  // Transport: 3 messages each direction
  for (let i = 0; i < 3; i++) {
    const i2rMsg = new TextEncoder().encode(`initiator->responder message ${i}`);
    const ct1 = initiator1.encrypt(i2rMsg);
    const pt1 = responder1.decrypt(ct1);
    assert.deepStrictEqual(pt1, i2rMsg, `i2r transport message ${i} failed`);

    const r2iMsg = new TextEncoder().encode(`responder->initiator message ${i}`);
    const ct2 = responder1.encrypt(r2iMsg);
    const pt2 = initiator1.decrypt(ct2);
    assert.deepStrictEqual(pt2, r2iMsg, `r2i transport message ${i} failed`);
  }
  console.log("PASS");

  // STEP 2 (tamper)
  console.log("STEP 2 (tamper):");
  const initStatic2 = generateX25519Keypair();
  const respStatic2 = generateX25519Keypair();

  // Tampered message 1
  const initTamper1 = new NoiseIKInitiator({
    staticKeypair: initStatic2,
    remoteStaticPublicKey: respStatic2.publicKey,
  });
  const respTamper1 = new NoiseIKResponder({
    staticKeypair: respStatic2,
  });
  const validMsg1 = initTamper1.writeMessage1(new TextEncoder().encode("tamper-test-1"));
  const tamperedMsg1 = new Uint8Array(validMsg1);
  tamperedMsg1[tamperedMsg1.length - 1] ^= 1;
  assert.throws(
    () => respTamper1.readMessage1(tamperedMsg1),
    /authentication failed|chachaDecrypt/,
    "responder must throw on tampered message1",
  );

  // Tampered message 2
  const initTamper2 = new NoiseIKInitiator({
    staticKeypair: initStatic2,
    remoteStaticPublicKey: respStatic2.publicKey,
  });
  const respTamper2 = new NoiseIKResponder({
    staticKeypair: respStatic2,
  });
  const goodMsg1 = initTamper2.writeMessage1(new TextEncoder().encode("tamper-test-2"));
  respTamper2.readMessage1(goodMsg1);
  const validMsg2 = respTamper2.writeMessage2(new TextEncoder().encode("tamper-grant"));
  const tamperedMsg2 = new Uint8Array(validMsg2);
  tamperedMsg2[tamperedMsg2.length - 1] ^= 1;
  assert.throws(
    () => initTamper2.readMessage2(tamperedMsg2),
    /authentication failed|chachaDecrypt/,
    "initiator must throw on tampered message2",
  );
  console.log("PASS");

  // STEP 3 (wrong peer)
  console.log("STEP 3 (wrong peer):");
  const initStatic3 = generateX25519Keypair();
  const respStatic3 = generateX25519Keypair();
  const wrongStatic = generateX25519Keypair();

  const initWrongPeer = new NoiseIKInitiator({
    staticKeypair: initStatic3,
    remoteStaticPublicKey: wrongStatic.publicKey, // wrong peer!
  });
  const respWrongPeer = new NoiseIKResponder({
    staticKeypair: respStatic3,
  });

  const msg1Wrong = initWrongPeer.writeMessage1(new TextEncoder().encode("wrong-peer-ref"));
  assert.throws(
    () => respWrongPeer.readMessage1(msg1Wrong),
    /authentication failed|chachaDecrypt/,
    "responder must throw when initiator configured with wrong remote key",
  );
  console.log("PASS");

  // STEP 4 (known-answer)
  console.log("STEP 4 (known-answer):");
  const fromHex = (hex) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  };
  const toHex = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
  };

  // Official Noise_IK_25519_ChaChaPoly_BLAKE2s vector constants from noise-c
  const VECTOR = {
    protocol_name: "Noise_IK_25519_ChaChaPoly_BLAKE2s",
    prologue: "50726f6c6f677565313233",
    init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
    init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    init_remote_static: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    msg1_payload: "4c756477696720766f6e204d69736573",
    msg1_ciphertext:
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79440b03ddc7aac5123d06a1b23b71670e32e76c28239a7ca4ac8f784de7e44c1adb78f2058771dfd4229fbdc85c5fba3b587b1d171ce368229c7b752ac25b8faf4e7b2fab7326f0d6fa1fdbef58de623245",
    msg2_payload: "4d757272617920526f746862617264",
    msg2_ciphertext:
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d9b5a8927f0ac9655ef76833bc7e55269c081ec38c61031f76fe15b2aaaad5",
    handshake_hash: "45e34c56ca0de9c348e104edcf503035e5559ceed661ac22916f6f171696d994",
  };

  const vectorInitStatic = {
    privateKey: fromHex(VECTOR.init_static),
    publicKey: x25519GetPublicKey(fromHex(VECTOR.init_static)),
  };
  const vectorInitEphemeral = {
    privateKey: fromHex(VECTOR.init_ephemeral),
    publicKey: x25519GetPublicKey(fromHex(VECTOR.init_ephemeral)),
  };
  const vectorRespStatic = {
    privateKey: fromHex(VECTOR.resp_static),
    publicKey: x25519GetPublicKey(fromHex(VECTOR.resp_static)),
  };
  const vectorRespEphemeral = {
    privateKey: fromHex(VECTOR.resp_ephemeral),
    publicKey: x25519GetPublicKey(fromHex(VECTOR.resp_ephemeral)),
  };

  const vectorInitiator = new NoiseIKInitiator({
    staticKeypair: vectorInitStatic,
    remoteStaticPublicKey: vectorRespStatic.publicKey,
    ephemeralKeypair: vectorInitEphemeral,
    prologue: fromHex(VECTOR.prologue),
  });
  const vectorResponder = new NoiseIKResponder({
    staticKeypair: vectorRespStatic,
    ephemeralKeypair: vectorRespEphemeral,
    prologue: fromHex(VECTOR.prologue),
  });

  const vectorMsg1 = vectorInitiator.writeMessage1(fromHex(VECTOR.msg1_payload));
  assert.strictEqual(
    toHex(vectorMsg1),
    VECTOR.msg1_ciphertext,
    "vector message 1 ciphertext mismatch",
  );

  const vectorRead1 = vectorResponder.readMessage1(vectorMsg1);
  assert.strictEqual(
    toHex(vectorRead1.payload),
    VECTOR.msg1_payload,
    "vector message 1 decrypted payload mismatch",
  );

  const vectorMsg2 = vectorResponder.writeMessage2(fromHex(VECTOR.msg2_payload));
  assert.strictEqual(
    toHex(vectorMsg2),
    VECTOR.msg2_ciphertext,
    "vector message 2 ciphertext mismatch",
  );

  const vectorRead2 = vectorInitiator.readMessage2(vectorMsg2);
  assert.strictEqual(
    toHex(vectorRead2),
    VECTOR.msg2_payload,
    "vector message 2 decrypted payload mismatch",
  );

  assert.strictEqual(
    toHex(vectorInitiator.getHandshakeHash()),
    VECTOR.handshake_hash,
    "vector initiator handshake hash mismatch",
  );
  assert.strictEqual(
    toHex(vectorResponder.getHandshakeHash()),
    VECTOR.handshake_hash,
    "vector responder handshake hash mismatch",
  );
  console.log("PASS");

  // STEP 5 (transport nonce discipline)
  console.log("STEP 5 (transport nonce discipline):");
  const initStatic5 = generateX25519Keypair();
  const respStatic5 = generateX25519Keypair();

  const initiator5 = new NoiseIKInitiator({
    staticKeypair: initStatic5,
    remoteStaticPublicKey: respStatic5.publicKey,
  });
  const responder5 = new NoiseIKResponder({
    staticKeypair: respStatic5,
  });

  const m1 = initiator5.writeMessage1(new TextEncoder().encode("hs1"));
  responder5.readMessage1(m1);
  const m2 = responder5.writeMessage2(new TextEncoder().encode("hs2"));
  initiator5.readMessage2(m2);

  const secretPlaintext = new TextEncoder().encode("replay-discipline-test");
  const ctSingle = initiator5.encrypt(secretPlaintext);

  // Decrypt once: succeeds
  const ptSingle = responder5.decrypt(ctSingle);
  assert.deepStrictEqual(ptSingle, secretPlaintext, "first decrypt must succeed");

  // Attempt to decrypt the exact same ciphertext again: must throw (nonce advanced from 0 to 1)
  assert.throws(
    () => responder5.decrypt(ctSingle),
    /authentication failed|chachaDecrypt/,
    "decrypting same ciphertext again must throw due to advanced nonce",
  );
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
