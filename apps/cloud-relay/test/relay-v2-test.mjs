import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert";
import Database from "better-sqlite3";
import { ed25519 } from "@noble/curves/ed25519.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-cloud-relay-test-"));
const outDir = path.join(tmpDir, "dist");

let testSuccess = false;

function createBetterSql(db) {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) {
        return { rows: stmt.all(...params) };
      }
      stmt.run(...params);
      return { rows: [] };
    },
  };
}

try {
  const rootNodeModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    fs.symlinkSync(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");
  }

  // Compile logic.ts, canonical.ts, base64.ts
  const compileCmd = `npx tsc apps/cloud-relay/src/base64.ts apps/cloud-relay/src/canonical.ts apps/cloud-relay/src/logic.ts --outDir ${outDir} --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`;
  execSync(compileCmd, { cwd: repoRoot, stdio: "pipe" });

  let distDir = outDir;
  if (!fs.existsSync(path.join(distDir, "logic.js"))) {
    if (fs.existsSync(path.join(distDir, "apps/cloud-relay/src/logic.js"))) {
      distDir = path.join(distDir, "apps/cloud-relay/src");
    }
  }

  const { bytesToBase64 } = require(path.join(distDir, "base64.js"));
  const { canonicalJson } = require(path.join(distDir, "canonical.js"));
  const {
    verifyHello,
    isOversize,
    RoomStore,
    RateLimiter,
    processPostHelloMessage,
  } = require(path.join(distDir, "logic.js"));

  // ==========================================
  // STEP 1 (canonical JSON)
  // ==========================================
  try {
    const input = { b: 1, a: { d: 4, c: 3 }, e: null };
    const expected = '{"a":{"c":3,"d":4},"b":1,"e":null}';
    assert.strictEqual(canonicalJson(input), expected, "sorted key ordering mismatch");

    const withUndefined = { b: 1, a: undefined, c: 2 };
    assert.strictEqual(canonicalJson(withUndefined), '{"b":1,"c":2}', "undefined object property must be skipped");

    const arrayWithUndefined = [1, undefined, 2];
    assert.strictEqual(canonicalJson(arrayWithUndefined), "[1,null,2]", "undefined array item must become null");

    assert.throws(() => canonicalJson(undefined), /undefined/, "must throw on undefined root");
    console.log("STEP 1 (canonical JSON): PASS");
  } catch (err) {
    console.log("STEP 1 (canonical JSON): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 2 (hello verify)
  // ==========================================
  let validEnv;
  let validNow;
  try {
    const kp = ed25519.keygen();
    const helloPubkey = bytesToBase64(kp.publicKey);
    validNow = Date.now();
    const helloMsg = {
      id: "hello-env-1",
      ts: validNow,
      from: "dev-mobile-1",
      deviceId: "dev-mobile-1",
      role: "mobile",
      helloPubkey,
    };
    const canonicalStr = canonicalJson(helloMsg);
    const msgBytes = new TextEncoder().encode(canonicalStr);
    const sigBytes = ed25519.sign(msgBytes, kp.secretKey);
    const helloSignature = bytesToBase64(sigBytes);

    validEnv = {
      v: 1,
      id: "hello-env-1",
      ts: validNow,
      from: "dev-mobile-1",
      to: "relay",
      kind: "hello",
      payload: {
        protocolVersion: 1,
        deviceId: "dev-mobile-1",
        role: "mobile",
        helloPubkey,
        helloSignature,
      },
    };

    const res = verifyHello(validEnv, validNow, () => null);
    assert.strictEqual(res.ok, true, "valid hello must verify");
    assert.strictEqual(res.deviceId, "dev-mobile-1");
    assert.strictEqual(res.role, "mobile");

    // ts tampered by 1 → reject
    const tamperedTsEnv = { ...validEnv, ts: validEnv.ts + 1 };
    const resTampered = verifyHello(tamperedTsEnv, validNow, () => null);
    assert.strictEqual(resTampered.ok, false, "tampered ts must fail");

    // wrong public key → reject
    const otherKp = ed25519.keygen();
    const wrongKeyEnv = {
      ...validEnv,
      payload: { ...validEnv.payload, helloPubkey: bytesToBase64(otherKp.publicKey) },
    };
    const resWrongKey = verifyHello(wrongKeyEnv, validNow, () => null);
    assert.strictEqual(resWrongKey.ok, false, "wrong public key must fail");

    // ts 121 seconds old → reject
    const staleEnv = { ...validEnv, ts: validNow - 121000 };
    const resStale = verifyHello(staleEnv, validNow, () => null);
    assert.strictEqual(resStale.ok, false, "stale ts must fail");
    assert.strictEqual(resStale.code, 4401);
    assert.strictEqual(resStale.reason, "stale hello");

    // missing helloSignature → reject
    const missingSigPayload = { ...validEnv.payload };
    delete missingSigPayload.helloSignature;
    const missingSigEnv = { ...validEnv, payload: missingSigPayload };
    const resMissingSig = verifyHello(missingSigEnv, validNow, () => null);
    assert.strictEqual(resMissingSig.ok, false, "missing helloSignature must fail");

    // env.from !== deviceId → reject
    const fromMismatchEnv = { ...validEnv, from: "someone-else" };
    const resFromMismatch = verifyHello(fromMismatchEnv, validNow, () => null);
    assert.strictEqual(resFromMismatch.ok, false, "from mismatch must fail");

    console.log("STEP 2 (hello verify): PASS");
  } catch (err) {
    console.log("STEP 2 (hello verify): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 3 (TOFU)
  // ==========================================
  try {
    const pinDb = new Database(":memory:");
    const pinStore = new RoomStore(createBetterSql(pinDb));

    // First hello pins the pubkey
    const res1 = verifyHello(validEnv, validNow, (id) => pinStore.getPin(id));
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.isNewPin, true);
    pinStore.setPin(res1.deviceId, res1.helloPubkey);
    assert.strictEqual(pinStore.getPin("dev-mobile-1"), validEnv.payload.helloPubkey);

    // Same deviceId with a different pubkey → reject
    const imposterKp = ed25519.keygen();
    const imposterPub = bytesToBase64(imposterKp.publicKey);
    const imposterMsg = {
      id: "hello-env-2",
      ts: validNow,
      from: "dev-mobile-1",
      deviceId: "dev-mobile-1",
      role: "mobile",
      helloPubkey: imposterPub,
    };
    const imposterSig = bytesToBase64(
      ed25519.sign(new TextEncoder().encode(canonicalJson(imposterMsg)), imposterKp.secretKey),
    );
    const imposterEnv = {
      v: 1,
      id: "hello-env-2",
      ts: validNow,
      from: "dev-mobile-1",
      to: "relay",
      kind: "hello",
      payload: {
        protocolVersion: 1,
        deviceId: "dev-mobile-1",
        role: "mobile",
        helloPubkey: imposterPub,
        helloSignature: imposterSig,
      },
    };

    const res2 = verifyHello(imposterEnv, validNow, (id) => pinStore.getPin(id));
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, 4401);
    assert.strictEqual(res2.reason, "device key changed");

    // Same pubkey → ok
    const res3 = verifyHello(validEnv, validNow, (id) => pinStore.getPin(id));
    assert.strictEqual(res3.ok, true);
    assert.strictEqual(res3.isNewPin, false);

    console.log("STEP 3 (TOFU): PASS");
  } catch (err) {
    console.log("STEP 3 (TOFU): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 4 (sender binding + validation)
  // ==========================================
  try {
    const db4 = new Database(":memory:");
    const store4 = new RoomStore(createBetterSql(db4));
    const limiter4 = new RateLimiter();
    const att = { deviceId: "mobile-1", role: "mobile" };
    const now = Date.now();

    // Message with from different from authed device → rejected
    const badFromMsg = JSON.stringify({
      v: 1,
      id: "msg-1",
      ts: now,
      from: "desktop-imposter",
      to: "desktop-1",
      kind: "encrypted",
      payload: {},
    });
    const resBadFrom = processPostHelloMessage(badFromMsg, att, store4, limiter4, () => null, now);
    assert.strictEqual(resBadFrom.ok, false);
    assert.strictEqual(resBadFrom.closeCode, 4400);

    // Envelope with empty id → rejected before storage
    const emptyIdMsg = JSON.stringify({
      v: 1,
      id: "",
      ts: now,
      from: "mobile-1",
      to: "desktop-offline",
      kind: "encrypted",
      payload: {},
    });
    const resEmptyId = processPostHelloMessage(emptyIdMsg, att, store4, limiter4, () => null, now);
    assert.strictEqual(resEmptyId.ok, false);
    assert.strictEqual(store4.drainOutbox("desktop-offline").length, 0);

    // Envelope with empty to → dropped, nothing stored
    const emptyToMsg = JSON.stringify({
      v: 1,
      id: "msg-valid-2",
      ts: now,
      from: "mobile-1",
      to: "",
      kind: "encrypted",
      payload: {},
    });
    const resEmptyTo = processPostHelloMessage(emptyToMsg, att, store4, limiter4, () => null, now);
    assert.strictEqual(resEmptyTo.action, "dropped");
    assert.strictEqual(store4.drainOutbox("").length, 0);

    console.log("STEP 4 (sender binding + validation): PASS");
  } catch (err) {
    console.log("STEP 4 (sender binding + validation): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 5 (outbox)
  // ==========================================
  try {
    const db5 = new Database(":memory:");
    const store5 = new RoomStore(createBetterSql(db5), {
      outboxTtlMs: 10000,
      outboxMaxPerDevice: 3,
      drainMax: 10,
    });

    const baseTime = 100000;

    // Save three rows for an offline device → retrieved in created_at order
    store5.saveOutbox("r1", "dev-offline", "env-1", baseTime + 1000);
    store5.saveOutbox("r2", "dev-offline", "env-2", baseTime + 2000);
    store5.saveOutbox("r3", "dev-offline", "env-3", baseTime + 3000);
    assert.deepStrictEqual(store5.drainOutbox("dev-offline"), ["env-1", "env-2", "env-3"]);

    // Insert a row older than the TTL → pruned on the next save
    // Insert r-old at baseTime - 20000 (80000). Cutoff on next save at baseTime + 4000 (104000) will be 94000.
    store5.saveOutbox("r-old", "dev-ttl", "env-old", baseTime - 20000);

    // With small test constants (cap 3), saving a 4th row trims the oldest (and prunes r-old)
    store5.saveOutbox("r4", "dev-offline", "env-4", baseTime + 4000);
    // r-old was pruned:
    assert.deepStrictEqual(store5.drainOutbox("dev-ttl"), [], "row older than TTL must be pruned");
    // r1 was trimmed by cap 3:
    assert.deepStrictEqual(store5.drainOutbox("dev-offline"), ["env-2", "env-3", "env-4"]);

    // delivery_ack from a DIFFERENT device → row kept
    store5.saveOutbox("r-ack", "dev-owner", "env-ack", baseTime + 5000);
    store5.deleteOutboxIfOwner("r-ack", "dev-imposter");
    assert.deepStrictEqual(store5.drainOutbox("dev-owner"), ["env-ack"]);

    // ack from the owning device → row deleted
    store5.deleteOutboxIfOwner("r-ack", "dev-owner");
    assert.deepStrictEqual(store5.drainOutbox("dev-owner"), []);

    console.log("STEP 5 (outbox): PASS");
  } catch (err) {
    console.log("STEP 5 (outbox): FAIL");
    throw err;
  }

  // ==========================================
  // STEP 6 (limits + config)
  // ==========================================
  try {
    // 257 KB message → rejected as oversize
    const oversizeMsg = "x".repeat(257 * 1024);
    assert.strictEqual(isOversize(oversizeMsg), true, "257KB must be oversize");

    const normalMsg = "x".repeat(256 * 1024);
    assert.strictEqual(isOversize(normalMsg), false, "256KB must not be oversize");

    // wrangler.toml exists, declares class_name = "Room", a [[durable_objects.bindings]] named ROOM, and a v1 migration with new_sqlite_classes = ["Room"]
    const wranglerPath = path.resolve(__dirname, "../wrangler.toml");
    assert.strictEqual(fs.existsSync(wranglerPath), true, "wrangler.toml must exist");
    const wranglerContent = fs.readFileSync(wranglerPath, "utf8");
    assert.ok(wranglerContent.includes('class_name = "Room"'), "class_name = 'Room' missing");
    assert.ok(wranglerContent.includes('name = "ROOM"'), "name = 'ROOM' binding missing");
    assert.ok(wranglerContent.includes('new_sqlite_classes = ["Room"]'), "new_sqlite_classes missing");
    assert.ok(wranglerContent.includes('tag = "v1"'), "v1 tag missing");

    console.log("STEP 6 (limits + config): PASS");
  } catch (err) {
    console.log("STEP 6 (limits + config): FAIL");
    throw err;
  }

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
