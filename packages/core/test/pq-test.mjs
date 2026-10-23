import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import crypto from "node:crypto";
const require = createRequire(import.meta.url);
const {
  nobleMlKem768,
  OneTimePqPrekeys,
  verifyPqPrekey,
  derivePqHandshake,
  PQ_SUITE,
} = require("@bimax/core/crypto/pq");
const {
  generateX25519Keypair,
  generateEd25519Keypair,
  configureRandomBytes,
  x25519GetPublicKey,
} = require("@bimax/core/crypto/keys");
const { bytesToBase64: b64, base64ToBytes: unb64 } = require("@bimax/core/crypto/base64");
const { parseAdvertisement } = require("@bimax/core/crypto/pairing");
const { NoiseIKInitiator, NoiseIKResponder } = require("@bimax/core/crypto/noise");
const { PairingManager: Phone } = require("@bimax/core/session/session");
const { PairingManager: Desktop } = require("../../../apps/desktop-responder/dist/pairing.js");
const { createIdentity } = require("../../../apps/desktop-responder/dist/identity.js");
const {
  buildTransportConfirmation,
  withSessionLimits,
  DEFAULT_SESSION_POLICY,
} = require("@bimax/core/session/lifecycle");
const { PqPrekeyLookup } = require("@bimax/core/session/prekey-lookup");
const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b) => Buffer.from(b).toString("hex");
const text = (s) => new TextEncoder().encode(s);
const readVector = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./vectors/${name}.json`, import.meta.url)));
const randomSource = (n) => crypto.getRandomValues(new Uint8Array(n));
let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`PASS ${name}`);
}

check("NIST ACVP ML-KEM-768 key generation", () => {
  const vectors = readVector("ML-KEM-keyGen-FIPS203");
  for (const group of vectors.testGroups)
    for (const v of group.tests) {
      configureRandomBytes((n) => {
        assert.equal(n, 64);
        return hex(v.d + v.z);
      });
      try {
        const pair = nobleMlKem768.keygen();
        assert.equal(toHex(pair.publicKey).toUpperCase(), v.ek);
        assert.equal(toHex(pair.secretKey).toUpperCase(), v.dk);
        nobleMlKem768.destroy(pair.secretKey);
      } finally {
        configureRandomBytes(randomSource);
      }
    }
});
check("NIST ACVP encapsulation, decapsulation and invalid public keys", () => {
  const vectors = readVector("ML-KEM-encapDecap-FIPS203");
  for (const group of vectors.testGroups)
    for (const v of group.tests) {
      if (group.function === "encapsulation") {
        configureRandomBytes((n) => {
          assert.equal(n, 32);
          return hex(v.m);
        });
        try {
          const result = nobleMlKem768.encapsulate(hex(v.ek));
          assert.equal(toHex(result.ciphertext).toUpperCase(), v.c);
          assert.equal(toHex(result.sharedSecret).toUpperCase(), v.k);
          assert.deepEqual(
            nobleMlKem768.decapsulate(result.ciphertext, hex(v.dk)),
            result.sharedSecret,
          );
        } finally {
          configureRandomBytes(randomSource);
        }
      } else if (group.function === "decapsulation") {
        assert.equal(toHex(nobleMlKem768.decapsulate(hex(v.c), hex(v.dk))).toUpperCase(), v.k);
      } else if (group.function === "encapsulationKeyCheck" && !v.testPassed) {
        assert.throws(() => nobleMlKem768.encapsulate(hex(v.ek)));
      }
    }
});
check("ML-KEM differential round trips with Node/OpenSSL", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ml-kem-768");
  const nativeDer = publicKey.export({ type: "spki", format: "der" });
  const noble = nobleMlKem768.encapsulate(new Uint8Array(nativeDer.subarray(-1184)));
  assert.equal(toHex(crypto.decapsulate(privateKey, noble.ciphertext)), toHex(noble.sharedSecret));
  const pair = nobleMlKem768.keygen();
  const imported = crypto.createPublicKey({
    key: Buffer.concat([nativeDer.subarray(0, -1184), pair.publicKey]),
    format: "der",
    type: "spki",
  });
  const native = crypto.encapsulate(imported);
  assert.equal(
    toHex(nobleMlKem768.decapsulate(new Uint8Array(native.ciphertext), pair.secretKey)),
    toHex(native.sharedKey),
  );
  nobleMlKem768.destroy(pair.secretKey);
});
check("product prologue and KDF match independent Python HKDF fixture", () => {
  const v = readVector("pq-composition");
  const nist = readVector("ML-KEM-encapDecap-FIPS203").testGroups[0].tests[0];
  const result = derivePqHandshake(v.advertisement, hex(nist.c), hex(nist.k));
  assert.equal(crypto.createHash("sha256").update(result.prologue).digest("hex"), v.prologueSha256);
  assert.equal(toHex(result.psk), v.psk);
  result.psk.fill(0);
});
check("IKpsk0 ciphertext, transcript and transport match independent Python reference", () => {
  const v = readVector("noise-ikpsk0");
  const key = (s) => ({ privateKey: hex(s), publicKey: x25519GetPublicKey(hex(s)) });
  const rs = key(v.resp_static);
  const i = new NoiseIKInitiator({
    staticKeypair: key(v.init_static),
    remoteStaticPublicKey: rs.publicKey,
    ephemeralKeypair: key(v.init_ephemeral),
    psk: hex(v.psk),
    prologue: hex(v.prologue),
  });
  const r = new NoiseIKResponder({
    staticKeypair: rs,
    ephemeralKeypair: key(v.resp_ephemeral),
    psk: hex(v.psk),
    prologue: hex(v.prologue),
  });
  const m1 = i.writeMessage1(hex(v.msg1_payload));
  assert.equal(toHex(m1), v.msg1_ciphertext);
  assert.deepEqual(r.readMessage1(m1).payload, hex(v.msg1_payload));
  const m2 = r.writeMessage2(hex(v.msg2_payload));
  assert.equal(toHex(m2), v.msg2_ciphertext);
  assert.deepEqual(i.readMessage2(m2), hex(v.msg2_payload));
  assert.equal(toHex(i.getHandshakeHash()), v.handshake_hash);
  assert.equal(toHex(r.getHandshakeHash()), v.handshake_hash);
  const ct = i.encrypt(text("phone transport"));
  assert.equal(toHex(ct.subarray(8)), v.transport_i);
  r.decrypt(ct);
  const reply = r.encrypt(text("desktop transport"));
  assert.equal(toHex(reply.subarray(8)), v.transport_r);
  i.decrypt(reply);
  i.destroy();
  r.destroy();
  assert.throws(() => i.writeMessage1(new Uint8Array()));
  assert.throws(() => r.readMessage1(m1));
});

const identity = createIdentity("desktop-pq");
const signing = generateEd25519Keypair(),
  phoneKey = generateX25519Keypair();
const phone = () =>
  new Phone({ deviceId: "phone-pq", staticKeypair: phoneKey, helloKeypair: signing });
const desktop = new Desktop({ identity, relayUrl: "ws://127.0.0.1:8787", enablePqPairing: true });
try {
  const advert = desktop.getAdvertisement();
  const prekey = desktop.getPublicPrekey(advert.pqPrekeyId, advert.ref);
  check("versioned QR parsing and relay substitution rejection", () => {
    assert.equal(advert.suite, PQ_SUITE);
    assert.deepEqual(parseAdvertisement(JSON.stringify(advert)), advert);
    assert.throws(
      () => parseAdvertisement(JSON.stringify({ ...advert, cryptoVersion: 3 })),
      /version|suite/,
    );
    assert.throws(
      () => parseAdvertisement(JSON.stringify({ ...advert, cryptoVersion: undefined })),
      /version|suite/,
    );
    assert.throws(
      () => parseAdvertisement(JSON.stringify({ ...advert, expiresAt: Date.now() - 1 })),
      /expired/,
    );
    const wrong = unb64(prekey.publicKey);
    wrong[0] ^= 1;
    assert.throws(() => verifyPqPrekey(advert, wrong), /commitment/);
    assert.throws(() => phone().beginPairing(advert), /encoded/);
    assert.throws(
      () => phone().beginPairing({ ...advert, suite: "other" }, prekey.publicKey),
      /suite/,
    );
  });
  const lookup = new PqPrekeyLookup();
  let lookupEnv;
  const lookupPromise = lookup.fetch(advert, "phone-pq", (e) => {
    lookupEnv = e;
  });
  const response = {
    v: 2,
    id: "lookup-response",
    from: identity.deviceId,
    to: "phone-pq",
    kind: "pairing_prekey",
    payload: { ...prekey, requestId: lookupEnv.id },
  };
  lookup.handle(
    { ...response, payload: { ...response.payload, publicKey: b64(new Uint8Array(1184)) } },
    "phone-pq",
  );
  lookup.handle(response, "phone-pq");
  assert.equal(await lookupPromise, prekey.publicKey);
  lookup.destroy();
  checks++;
  console.log("PASS public prekey lookup verifies the scanned commitment");

  const p = phone(),
    req = p.beginPairing(advert, prekey.publicKey);
  for (const field of ["cryptoVersion", "pqPrekeyId", "kemCiphertext"]) {
    const bad = structuredClone(req);
    delete bad.payload[field];
    assert.equal(await desktop.handlePairingRequest(bad), null);
  }
  for (const length of [0, 1, 1087, 1089, 4096]) {
    const malformed = structuredClone(req);
    malformed.payload.kemCiphertext = b64(new Uint8Array(length));
    assert.equal(await desktop.handlePairingRequest(malformed), null);
  }
  // Valid Noise M1 with an invalid application signature must not consume the prekey.
  const invalidKem = nobleMlKem768.encapsulate(unb64(prekey.publicKey));
  const invalidState = derivePqHandshake(advert, invalidKem.ciphertext, invalidKem.sharedSecret);
  const invalidNoise = new NoiseIKInitiator({
    ...invalidState,
    staticKeypair: phoneKey,
    remoteStaticPublicKey: identity.noiseStaticKeypair.publicKey,
  });
  invalidState.psk.fill(0);
  invalidKem.sharedSecret.fill(0);
  const invalidProof = {
    ...req,
    payload: {
      ...req.payload,
      kemCiphertext: b64(invalidKem.ciphertext),
      handshakeMessage: b64(
        invalidNoise.writeMessage1(
          text(JSON.stringify({ pairingVersion: 2, signature: "invalid" })),
        ),
      ),
    },
  };
  assert.equal(await desktop.handlePairingRequest(invalidProof), null);
  invalidNoise.destroy();
  const changedCt = structuredClone(req);
  const ct = unb64(changedCt.payload.kemCiphertext);
  ct[0] ^= 1;
  changedCt.payload.kemCiphertext = b64(ct);
  assert.equal(await desktop.handlePairingRequest(changedCt), null);
  const changedNoise = structuredClone(req);
  const m1 = unb64(changedNoise.payload.handshakeMessage);
  m1[m1.length - 1] ^= 1;
  changedNoise.payload.handshakeMessage = b64(m1);
  assert.equal(await desktop.handlePairingRequest(changedNoise), null);
  const wrongRoute = structuredClone(req);
  wrongRoute.payload.ref = "wrong-ref";
  assert.equal(await desktop.handlePairingRequest(wrongRoute), null);
  // A v2 prekey must remain usable after all unauthenticated attempts above.
  const [accepted, retry] = await Promise.all([
    desktop.handlePairingRequest(req),
    desktop.handlePairingRequest(req),
  ]);
  assert.ok(accepted);
  assert.ok(retry?.isRetry);
  assert.deepEqual(accepted.grantEnv, retry.grantEnv);
  const alternate = phone().beginPairing(advert, prekey.publicKey);
  assert.equal(await desktop.handlePairingRequest(alternate), null);
  checks++;
  console.log(
    "PASS malformed input cannot burn a prekey; simultaneous identical retries are idempotent; alternate M1 cannot reuse it",
  );

  const ps = p.handleGrant(accepted.grantEnv);
  assert.deepEqual(ps.handshakeHash, accepted.session.handshakeHash);
  assert.ok(ps.nextPqPrekey);
  assert.throws(() => accepted.session.encrypt(text("sensitive")), /confirmation/);
  await assert.rejects(desktop.confirmPairing(accepted.verificationCode), /confirmation/);
  assert.equal(desktop.getActiveSession(), null);
  const confirm = buildTransportConfirmation(ps, "phone-pq");
  const badConfirm = structuredClone(confirm);
  const c = unb64(badConfirm.payload.ciphertext);
  c[c.length - 1] ^= 1;
  badConfirm.payload.ciphertext = b64(c);
  assert.equal(desktop.confirmTransport(badConfirm), "rejected");
  assert.equal(desktop.confirmTransport(confirm), "confirmed");
  const record = await desktop.confirmPairing(accepted.verificationCode);
  assert.equal(record.cryptoVersion, 2);
  assert.deepEqual(ps.decrypt(accepted.session.encrypt(text("sensitive"))), text("sensitive"));
  checks++;
  console.log(
    "PASS responder cannot send or establish trust before first initiator transport confirmation",
  );

  // Session-key erasure must retain the independent, unused reconnect prekey.
  const clock = Date.now;
  Date.now = () => clock() + DEFAULT_SESSION_POLICY.maxAgeMs + 1;
  try {
    assert.equal(desktop.getActiveSession(), null);
    assert.ok(
      desktop.getPublicPrekey(
        ps.nextPqPrekey.advertisement.pqPrekeyId,
        ps.nextPqPrekey.advertisement.ref,
      ),
    );
  } finally {
    Date.now = clock;
  }
  checks++;
  console.log(
    "PASS session expiry erases transport keys while preserving unused PQ reconnect material",
  );

  const classic = phone().beginPairing({
    relayUrl: advert.relayUrl,
    ref: "rehandshake",
    desktopDeviceId: identity.deviceId,
    desktopPublicKey: advert.desktopPublicKey,
    app: "bimax",
  });
  assert.equal(await desktop.handlePairingRequest(classic), null);
  const next = ps.nextPqPrekey,
    rephone = phone();
  const reRequest = rephone.beginPairing(next.advertisement, next.publicKey);
  const oldSession = accepted.session;
  const activeBeforeRefresh = desktop.getActiveSession();
  const fresh = await desktop.handlePairingRequest(reRequest);
  assert.ok(fresh?.isRehandshake);
  assert.equal(desktop.getActiveSession(), activeBeforeRefresh);
  const refreshed = rephone.handleGrant(fresh.grantEnv);
  assert.notDeepEqual(refreshed.handshakeHash, ps.handshakeHash);
  assert.equal(
    desktop.confirmTransport(buildTransportConfirmation(refreshed, "phone-pq")),
    "confirmed",
  );
  assert.equal(desktop.getActiveSession(), fresh.session);
  assert.throws(() => oldSession.encrypt(text("old keys")));
  assert.deepEqual(
    refreshed.decrypt(fresh.session.encrypt(text("fresh keys"))),
    text("fresh keys"),
  );
  checks++;
  console.log(
    "PASS PQ refresh provisions a new one-time prekey and swaps sessions only after confirmation; classical downgrade rejected",
  );
  p.destroy();
  rephone.destroy();
} finally {
  desktop.destroy();
}

// Persisting a classical->PQ upgrade prevents downgrade after a restart/flag change.
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-pq-policy-"));
const policyPath = path.join(policyDir, "trust.json");
const upgradeIdentity = createIdentity("desktop-upgrade");
let upgrading, restarted;
try {
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      phoneDeviceId: "phone-pq",
      phoneX25519PubkeyB64: b64(phoneKey.publicKey),
      phoneHelloPubkeyB64: b64(signing.publicKey),
      pairedAt: Date.now(),
    }),
  );
  upgrading = new Desktop({
    identity: upgradeIdentity,
    relayUrl: "ws://127.0.0.1:8787",
    enablePqPairing: true,
    storePath: policyPath,
  });
  await upgrading.init();
  const ad = upgrading.getAdvertisement(),
    pk = upgrading.getPublicPrekey(ad.pqPrekeyId, ad.ref);
  const p = phone(),
    result = await upgrading.handlePairingRequest(p.beginPairing(ad, pk.publicKey));
  assert.ok(result?.isRehandshake);
  const session = p.handleGrant(result.grantEnv);
  assert.equal(
    upgrading.confirmTransport(buildTransportConfirmation(session, "phone-pq")),
    "confirmed",
  );
  assert.equal(upgrading.getTrustedPhone().cryptoVersion, 2);
  upgrading.destroy();
  restarted = new Desktop({
    identity: upgradeIdentity,
    relayUrl: "ws://127.0.0.1:8787",
    enablePqPairing: false,
    storePath: policyPath,
  });
  await restarted.init();
  assert.equal(restarted.getTrustedPhone().cryptoVersion, 2);
  assert.equal(
    await restarted.handlePairingRequest(phone().beginPairing(restarted.getAdvertisement())),
    null,
  );
  p.destroy();
  checks++;
  console.log(
    "PASS classical-to-PQ policy upgrade persists and refuses downgrade across restart/flag changes",
  );
} finally {
  upgrading?.destroy();
  restarted?.destroy();
  fs.rmSync(policyDir, { recursive: true, force: true });
}

check(
  "explicit nonce tampering, replay, forward gaps, malformed lengths, and failed-auth recovery",
  () => {
    const s = generateX25519Keypair(),
      i = new NoiseIKInitiator({
        staticKeypair: generateX25519Keypair(),
        remoteStaticPublicKey: s.publicKey,
      });
    const r = new NoiseIKResponder({ staticKeypair: s });
    r.readMessage1(i.writeMessage1(new Uint8Array()));
    i.readMessage2(r.writeMessage2(new Uint8Array()));
    const first = i.encrypt(text("zero"));
    const tampered = first.slice();
    tampered[0] = 12;
    assert.throws(() => r.decrypt(tampered));
    assert.deepEqual(r.decrypt(first), text("zero"));
    assert.throws(() => r.decrypt(first));
    const skipped = i.encrypt(text("skip")),
      high = i.encrypt(text("high"));
    assert.deepEqual(r.decrypt(high), text("high"));
    assert.throws(() => r.decrypt(skipped));
    assert.throws(() => r.decrypt(new Uint8Array(23)));
    assert.throws(() => i.encrypt(new Uint8Array(65520)));
    assert.deepEqual(r.decrypt(i.encrypt(text("still works"))), text("still works"));
    i.destroy();
    r.destroy();
  },
);
check(
  "age, byte and record limits force a fresh handshake without consuming failed operations",
  () => {
    const fake = {
      peerDeviceId: "peer",
      establishedAt: Date.now(),
      handshakeHash: new Uint8Array(32),
      encrypt: (p) => p,
      decrypt: (c) => c,
    };
    const records = withSessionLimits(fake, { ...DEFAULT_SESSION_POLICY, maxRecords: 1 });
    records.encrypt(text("first"));
    assert.throws(() => records.encrypt(text("second")), /fresh handshake/);
    const bytes = withSessionLimits(fake, { ...DEFAULT_SESSION_POLICY, maxBytes: 3 });
    assert.throws(() => bytes.encrypt(text("four")), /fresh handshake/);
    bytes.encrypt(text("one"));
    const old = withSessionLimits({
      ...fake,
      establishedAt: Date.now() - DEFAULT_SESSION_POLICY.maxAgeMs,
    });
    assert.throws(() => old.encrypt(text("expired")), /fresh handshake/);
  },
);
check("expiry and destruction erase owned one-time prekey buffers", () => {
  const secrets = [];
  const backend = {
    ...nobleMlKem768,
    keygen() {
      const p = nobleMlKem768.keygen();
      secrets.push(p.secretKey);
      return p;
    },
  };
  const store = new OneTimePqPrekeys(backend);
  const ad = {
    relayUrl: "ws://127.0.0.1:8787",
    ref: "ref",
    desktopDeviceId: "desktop",
    desktopPublicKey: b64(generateX25519Keypair().publicKey),
    app: "bimax",
  };
  const entry = store.create(ad, Date.now() + 60_000);
  store.prune(entry.advertisement.expiresAt);
  assert.ok(secrets[0].every((b) => b === 0));
  store.create(ad, Date.now() + 60_000);
  store.destroy();
  assert.ok(secrets[1].every((b) => b === 0));
});
console.log(`\n${checks} PQ/Noise regression groups passed.`);
