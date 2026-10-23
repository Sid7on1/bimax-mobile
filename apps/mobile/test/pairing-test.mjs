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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-pairing-test-"));
const distDir = path.join(tmpDir, "dist");
const dbPath = path.join(tmpDir, "pairing-test.db");
const PORT = 18790;

let relayProc = null;
let testSuccess = false;

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
  return relayProc;
}

async function main() {
  // Ensure the compiled files in tmpdir can resolve node_modules
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile testable files into tmpdir
  const compileCmd = `npx tsc apps/mobile/lib/session/session.ts apps/mobile/lib/crypto/noise.ts apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/crypto/pairing.ts apps/mobile/lib/relay/client.ts --outDir ${distDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  const {
    PairingManager,
    formatVerificationCode,
  } = require(path.join(distDir, "session", "session.js"));
  const {
    generateX25519Keypair,
  } = require(path.join(distDir, "crypto", "keys.js"));
  const {
    bytesToBase64,
    base64ToBytes,
  } = require(path.join(distDir, "crypto", "base64.js"));
  const {
    NoiseIKResponder,
  } = require(path.join(distDir, "crypto", "noise.js"));
  const {
    RelayClient,
  } = require(path.join(distDir, "relay", "client.js"));

  // Build apps/relay if needed and start it
  execSync("npx tsc -p apps/relay/tsconfig.json", { cwd: repoRoot, stdio: "pipe" });
  startRelay();
  await waitForHealth();

  // Desktop setup (simulated desktop side)
  const desktopKeypair = generateX25519Keypair();
  const desktopDeviceId = "desktop-1";
  const advert = {
    relayUrl: `ws://127.0.0.1:${PORT}`,
    ref: "test-ref-001",
    desktopDeviceId,
    desktopPublicKey: bytesToBase64(desktopKeypair.publicKey),
    app: "bimax",
  };

  // Helper to wait for client to come online
  function waitForOnline(client, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (client.status === "online") return resolve();
      const timer = setTimeout(() => reject(new Error("Timeout waiting for online")), timeoutMs);
      const prevOnStatus = client.opts.onStatus;
      client.opts.onStatus = (s) => {
        prevOnStatus?.(s);
        if (s === "online") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  // STEP 1 (full pairing over relay)
  console.log("STEP 1 (full pairing over relay):");
  const phoneKeypair = generateX25519Keypair();
  const phoneDeviceId = "mobile-1";
  const phoneManager = new PairingManager({
    deviceId: phoneDeviceId,
    staticKeypair: phoneKeypair,
  });

  const { ed25519 } = require("@noble/curves/ed25519.js");
  const signer = () => {const key=ed25519.keygen();return {pubkeyB64:bytesToBase64(key.publicKey),sign:async msg=>ed25519.sign(msg,key.secretKey)};};
  let desktopReceivedReq = null;
  let desktopResolveReq = null;
  const desktopReqPromise = new Promise((res) => {
    desktopResolveReq = res;
  });

  const desktopClient = new RelayClient({
    url: advert.relayUrl,
    deviceId: desktopDeviceId,
    role: "desktop",
    wsImpl: WebSocket,
    helloSigner: signer(),
    onMessage: (env) => {
      if (env.kind === "pairing_request") {
        desktopReceivedReq = env;
        desktopResolveReq?.(env);
      }
    },
  });
  desktopClient.connect();
  await waitForOnline(desktopClient);

  let phoneReceivedGrant = null;
  let phoneResolveGrant = null;
  const phoneGrantPromise = new Promise((res) => {
    phoneResolveGrant = res;
  });

  const phoneClient = new RelayClient({
    url: advert.relayUrl,
    deviceId: phoneDeviceId,
    role: "mobile",
    wsImpl: WebSocket,
    helloSigner: signer(),
    onMessage: (env) => {
      if (env.kind === "pairing_grant") {
        phoneReceivedGrant = env;
        phoneResolveGrant?.(env);
      }
    },
  });
  phoneClient.connect();
  await waitForOnline(phoneClient);

  // Phone begins pairing
  const requestEnv = phoneManager.beginPairing(advert);
  phoneClient.send(requestEnv);

  await Promise.race([desktopReqPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Pairing request deadline")),5000))]);
  assert.ok(desktopReceivedReq, "desktop must receive pairing_request envelope");
  assert.strictEqual(desktopReceivedReq.payload.ref, advert.ref);
  assert.strictEqual(desktopReceivedReq.payload.mobileDeviceId, phoneDeviceId);

  // Desktop simulator handles pairing_request
  const desktopResponder = new NoiseIKResponder({
    staticKeypair: desktopKeypair,
  });
  const readReq = desktopResponder.readMessage1(
    base64ToBytes(desktopReceivedReq.payload.handshakeMessage),
  );
  assert.deepStrictEqual(
    readReq.remoteStaticPublicKey,
    phoneKeypair.publicKey,
    "desktop must authenticate phone static public key",
  );

  const handshakeMsg2 = desktopResponder.writeMessage2(new Uint8Array(0));
  const grantEnv = {
    v: 2,
    id: "grant-env-1",
    ts: Date.now(),
    from: desktopDeviceId,
    to: phoneDeviceId,
    kind: "pairing_grant",
    payload: {
      mobileDeviceId: phoneDeviceId,
      grantedAt: Date.now(),
      handshakeMessage: bytesToBase64(handshakeMsg2),
    },
  };
  desktopClient.send(grantEnv);

  await Promise.race([phoneGrantPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Pairing grant deadline")),5000))]);
  assert.ok(phoneReceivedGrant, "phone must receive pairing_grant envelope");

  const session = phoneManager.handleGrant(phoneReceivedGrant);
  assert.strictEqual(session.peerDeviceId, desktopDeviceId);
  assert.strictEqual(session.handshakeHash.length, 32);
  assert.deepStrictEqual(
    session.handshakeHash,
    desktopResponder.getHandshakeHash(),
    "handshake hashes must be byte-equal",
  );
  console.log("PASS");

  // STEP 2 (tampered grant)
  console.log("STEP 2 (tampered grant):");
  const phoneKeypair2 = generateX25519Keypair();
  const phoneManager2 = new PairingManager({
    deviceId: "mobile-2",
    staticKeypair: phoneKeypair2,
  });
  const advert2 = {
    ...advert,
    desktopDeviceId: "desktop-1",
  };
  const reqEnv2 = phoneManager2.beginPairing(advert2);

  const desktopResponder2 = new NoiseIKResponder({
    staticKeypair: desktopKeypair,
  });
  desktopResponder2.readMessage1(base64ToBytes(reqEnv2.payload.handshakeMessage));
  const msg2Valid = desktopResponder2.writeMessage2(new Uint8Array(0));

  const tamperedBytes = new Uint8Array(msg2Valid);
  tamperedBytes[tamperedBytes.length - 1] ^= 1;

  const tamperedGrantEnv = {
    v: 2,
    id: "grant-tampered",
    ts: Date.now(),
    from: "desktop-1",
    to: "mobile-2",
    kind: "pairing_grant",
    payload: {
      mobileDeviceId: "mobile-2",
      grantedAt: Date.now(),
      handshakeMessage: bytesToBase64(tamperedBytes),
    },
  };

  assert.throws(
    () => phoneManager2.handleGrant(tamperedGrantEnv),
    /authentication failed|chachaDecrypt/,
    "phone handleGrant must throw when grant handshakeMessage is tampered",
  );
  assert.strictEqual(
    phoneManager2.hasPending("desktop-1"),
    false,
    "failed grant must clear the pending pairing",
  );
  console.log("PASS");

  // STEP 3 (grant with no pending pairing)
  console.log("STEP 3 (grant with no pending pairing):");
  const unknownGrantEnv = {
    v: 2,
    id: "grant-unknown",
    ts: Date.now(),
    from: "desktop-unknown-peer",
    to: phoneDeviceId,
    kind: "pairing_grant",
    payload: {
      mobileDeviceId: phoneDeviceId,
      grantedAt: Date.now(),
      handshakeMessage: bytesToBase64(handshakeMsg2),
    },
  };
  assert.throws(
    () => phoneManager.handleGrant(unknownGrantEnv),
    /no pending pairing found/,
    "handleGrant must throw if no pending pairing exists for peer",
  );
  console.log("PASS");

  // STEP 4 (session transport)
  console.log("STEP 4 (session transport):");
  const mobileMessage = new TextEncoder().encode("Hello desktop from mobile!");
  const ciphertextFromPhone = session.encrypt(mobileMessage);
  const decryptedAtDesktop = desktopResponder.decrypt(ciphertextFromPhone);
  assert.deepStrictEqual(
    decryptedAtDesktop,
    mobileMessage,
    "desktop must decrypt message from mobile session",
  );

  const desktopReply = new TextEncoder().encode("Tool approval request: OS_COMMAND");
  const ciphertextFromDesktop = desktopResponder.encrypt(desktopReply);
  const decryptedAtPhone = session.decrypt(ciphertextFromDesktop);
  assert.deepStrictEqual(
    decryptedAtPhone,
    desktopReply,
    "mobile session must decrypt reply from desktop",
  );
  console.log("PASS");

  // STEP 5 (verification code)
  console.log("STEP 5 (verification code):");
  const codePhone = formatVerificationCode(session.handshakeHash);
  const codeDesktop = formatVerificationCode(desktopResponder.getHandshakeHash());
  assert.strictEqual(codePhone, codeDesktop, "verification codes must be identical on both sides");
  assert.match(
    codePhone,
    /^\d{4}(-\d{4}){5}$/,
    "verification code must match format XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  );
  // Determinism check
  const codeRepeat = formatVerificationCode(session.handshakeHash);
  assert.strictEqual(codePhone, codeRepeat, "verification code generation must be deterministic");
  console.log("PASS");

  // Cleanup clients
  phoneClient.close();
  desktopClient.close();

  testSuccess = true;
}

main()
  .catch((err) => {
    console.error("Test failed with error:", err);
    testSuccess = false;
  })
  .finally(() => {
    cleanup();
    process.exit(testSuccess ? 0 : 1);
  });
