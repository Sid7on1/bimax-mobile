import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PairingManager: Desktop } = require("../../../apps/desktop-responder/dist/pairing.js");
const { createIdentity } = require("../../../apps/desktop-responder/dist/identity.js");
const { PairingManager: Phone } = require("@bimax/core/session/session");
const { generateX25519Keypair, generateEd25519Keypair } = require("@bimax/core/crypto/keys");
const { OneTimePqPrekeys, nobleMlKem768 } = require("@bimax/core/crypto/pq");
const {
  buildTransportConfirmation,
  withSessionLimits,
  DEFAULT_SESSION_POLICY,
} = require("@bimax/core/session/lifecycle");
const text = (v) => new TextEncoder().encode(v);
const desktop = () =>
  new Desktop({
    identity: createIdentity("desktop-review"),
    relayUrl: "ws://127.0.0.1:8787",
    enablePqPairing: true,
  });
const phone = (id) =>
  new Phone({
    deviceId: id,
    staticKeypair: generateX25519Keypair(),
    helloKeypair: generateEd25519Keypair(),
  });
function request(d, p, prekey) {
  const advert = prekey?.advertisement ?? d.getAdvertisement();
  const key = prekey ?? d.getPublicPrekey(advert.pqPrekeyId, advert.ref);
  return p.beginPairing(advert, key.publicKey);
}
async function exchange(d, p, prekey) {
  const req = request(d, p, prekey),
    accepted = await d.handlePairingRequest(req);
  assert.ok(accepted);
  const session = p.handleGrant(accepted.grantEnv),
    confirmation = buildTransportConfirmation(session, req.from);
  assert.equal(d.confirmTransport(confirmation), "confirmed");
  return { accepted, session, confirmation, req };
}

await test("PQ outer framing does not disclose the initiator static public key", () => {
  const d = desktop(),
    p = phone("phone-a");
  try {
    assert.equal(request(d, p).payload.mobilePublicKey, undefined);
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("replacing trust invalidates the former phone's pending key confirmation", async () => {
  const d = desktop(),
    a = phone("phone-a"),
    b = phone("phone-b");
  try {
    const first = await exchange(d, a);
    await d.confirmPairing(first.accepted.verificationCode);
    const pendingA = await d.handlePairingRequest(request(d, a, first.session.nextPqPrekey));
    const pendingSession = a.handleGrant(pendingA.grantEnv);
    const delayed = buildTransportConfirmation(pendingSession, "phone-a");
    const replacement = await exchange(d, b);
    await d.confirmReplaceTrustedPhone(replacement.accepted.verificationCode);
    assert.notEqual(d.confirmTransport(delayed), "confirmed");
    assert.equal(d.getActiveSession(), replacement.accepted.session);
    assert.equal(d.getTrustedPhone().phoneDeviceId, "phone-b");
  } finally {
    a.destroy();
    b.destroy();
    d.destroy();
  }
});

await test("an in-progress refresh does not swallow authenticated data from the old active channel", async () => {
  const d = desktop(),
    p = phone("phone-a");
  try {
    const first = await exchange(d, p);
    await d.confirmPairing(first.accepted.verificationCode);
    await d.handlePairingRequest(request(d, p, first.session.nextPqPrekey));
    const body = text("old session remains usable before confirmation");
    const ct = first.session.encrypt(body);
    const env = {
      v: 2,
      id: "old-data",
      from: "phone-a",
      to: "desktop-review",
      kind: "encrypted",
      payload: { ciphertext: require("@bimax/core/crypto/base64").bytesToBase64(ct) },
    };
    assert.equal(d.confirmTransport(env), "unrelated");
    assert.deepEqual(first.accepted.session.decrypt(ct), body);
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("a retried verified confirmation is idempotent and never resets the application session", async () => {
  const d = desktop(),
    p = phone("phone-a");
  try {
    const first = await exchange(d, p);
    await d.confirmPairing(first.accepted.verificationCode);
    assert.equal(d.confirmTransport(first.confirmation), "duplicate");
    const ct = first.session.encrypt(text("nonce one"));
    assert.deepEqual(first.accepted.session.decrypt(ct), text("nonce one"));
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("hitting the exact byte budget marks the session for immediate re-handshake", () => {
  const fake = {
    peerDeviceId: "peer",
    establishedAt: Date.now(),
    handshakeHash: new Uint8Array(32),
    encrypt: (p) => p,
    decrypt: (p) => p,
  };
  const session = withSessionLimits(fake, { ...DEFAULT_SESSION_POLICY, maxBytes: 3 });
  session.encrypt(text("abc"));
  assert.equal(session.needsRehandshake(), true);
});

await test("a backend validation failure erases an already-generated prekey secret", () => {
  let secret;
  const backend = {
    ...nobleMlKem768,
    keygen() {
      const pair = nobleMlKem768.keygen();
      secret = pair.secretKey;
      return { ...pair, publicKey: new Uint8Array(1183) };
    },
  };
  const store = new OneTimePqPrekeys(backend);
  const d = desktop();
  try {
    assert.throws(() => store.create(d.getAdvertisement(), Date.now() + 60_000));
    assert.ok(secret.every((b) => b === 0));
  } finally {
    store.destroy();
    d.destroy();
  }
});

await test("a delayed M2 from an earlier attempt cannot corrupt the current pending handshake", async () => {
  const d = desktop(),
    old = phone("phone-a"),
    current = phone("phone-a");
  try {
    const oldResult = await d.handlePairingRequest(request(d, old));
    const result = await d.handlePairingRequest(request(d, current));
    assert.ok(oldResult && result);
    assert.equal(current.matchesPendingGrant(oldResult.grantEnv), false);
    assert.throws(() => current.handleGrant(oldResult.grantEnv), /Unrelated/);
    assert.ok(current.hasPending("desktop-review"));
    const session = current.handleGrant(result.grantEnv);
    assert.equal(d.confirmTransport(buildTransportConfirmation(session, "phone-a")), "confirmed");
  } finally {
    old.destroy();
    current.destroy();
    d.destroy();
  }
});

await test("changing a confirmation's bound header does not consume nonce zero", async () => {
  const d = desktop(),
    p = phone("phone-a");
  try {
    const req = request(d, p),
      result = await d.handlePairingRequest(req);
    const session = p.handleGrant(result.grantEnv),
      confirm = buildTransportConfirmation(session, "phone-a");
    assert.equal(d.confirmTransport({ ...confirm, id: "relay-mutated-id" }), "rejected");
    assert.equal(d.confirmTransport(confirm), "confirmed");
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("a LAN URL is validated without changing QR transcript bytes", async () => {
  const d = new Desktop({
    identity: createIdentity("desktop-review"),
    relayUrl: "ws://127.0.0.1:8787",
    lanRelayUrl: "ws://192.168.1.20:8787",
    enablePqPairing: true,
  });
  const p = phone("phone-a");
  try {
    const original = d.getAdvertisement();
    const parsed = require("@bimax/core/crypto/pairing").parseAdvertisement(
      JSON.stringify(original),
    );
    assert.deepEqual(parsed, original);
    const key = d.getPublicPrekey(parsed.pqPrekeyId, parsed.ref);
    assert.ok(await d.handlePairingRequest(p.beginPairing(parsed, key.publicKey)));
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("session and prekey age limits survive a backward wall-clock adjustment", () => {
  const clock = Date.now;
  let mono = 0,
    destroyed = false,
    secret;
  const fake = {
    peerDeviceId: "peer",
    establishedAt: clock(),
    handshakeHash: new Uint8Array(32),
    encrypt: (p) => p,
    decrypt: (p) => p,
    destroy: () => {
      destroyed = true;
    },
  };
  const session = withSessionLimits(
    fake,
    { ...DEFAULT_SESSION_POLICY, maxAgeMs: 60_000 },
    () => mono,
  );
  const backend = {
    ...nobleMlKem768,
    keygen() {
      const result = nobleMlKem768.keygen();
      secret = result.secretKey;
      return result;
    },
  };
  const store = new OneTimePqPrekeys(backend, 16, () => mono),
    d = desktop();
  try {
    const entry = store.create(d.getAdvertisement(), clock() + 60_000);
    Date.now = () => clock() - 86_400_000;
    mono = 60_001;
    assert.throws(() => session.encrypt(text("expired")), /fresh handshake/);
    assert.ok(destroyed);
    assert.equal(store.get(entry.advertisement.pqPrekeyId, entry.advertisement.ref), null);
    assert.ok(secret.every((b) => b === 0));
  } finally {
    Date.now = clock;
    store.destroy();
    d.destroy();
  }
});

await test("cancelled async pairing work cannot finish or clear a newer attempt", async () => {
  const { PairingAttemptScope, sameDesktopTrust } = require("@bimax/core/session/attempt");
  const scope = new PairingAttemptScope();
  const first = scope.begin();
  const commitIsCurrent = scope.capture();
  let release;
  const fetched = new Promise((resolve) => {
    release = resolve;
  });
  let committed = false;
  const stale = fetched.then(() => {
    if (first.isCurrent()) committed = true;
    first.finish();
  });
  const latest = scope.begin();
  assert.equal(commitIsCurrent(), false);
  release();
  await stale;
  assert.equal(committed, false);
  assert.equal(latest.isCurrent(), true);
  scope.cancel();
  assert.equal(latest.isCurrent(), false);
  const trust = { deviceId: "desktop", staticPublicKeyB64: "pinned", cryptoVersion: 2 };
  assert.equal(sameDesktopTrust(trust, { ...trust, staticPublicKeyB64: "replaced" }), false);
  assert.equal(sameDesktopTrust(trust, { ...trust, cryptoVersion: undefined }), false);
});

await test("M2 authenticates the M1 correlation value, rather than trusting the outer hint", async () => {
  const { NoiseIKResponder } = require("@bimax/core/crypto/noise");
  const original = NoiseIKResponder.prototype.writeMessage2;
  const d = desktop(),
    p = phone("phone-a");
  try {
    NoiseIKResponder.prototype.writeMessage2 = function (payload) {
      const value = JSON.parse(new TextDecoder().decode(payload));
      value.handshakeId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      return original.call(this, text(JSON.stringify(value)));
    };
    const result = await d.handlePairingRequest(request(d, p));
    assert.ok(result);
    assert.ok(p.matchesPendingGrant(result.grantEnv));
    assert.throws(() => p.handleGrant(result.grantEnv), /Authenticated handshake ID mismatch/);
    assert.equal(p.hasPending("desktop-review"), false);
  } finally {
    NoiseIKResponder.prototype.writeMessage2 = original;
    p.destroy();
    d.destroy();
  }
});

await test("M1 mutation matrix cannot consume the committed PQ prekey", async () => {
  const { base64ToBytes, bytesToBase64 } = require("@bimax/core/crypto/base64");
  const d = desktop(),
    p = phone("phone-a");
  try {
    const req = request(d, p),
      m1 = base64ToBytes(req.payload.handshakeMessage);
    for (const offset of [0, 15, 31, 32, 47, 79, 80, 95, m1.length - 1]) {
      const mutated = m1.slice();
      mutated[offset] ^= 1;
      assert.equal(
        await d.handlePairingRequest({
          ...req,
          payload: { ...req.payload, handshakeMessage: bytesToBase64(mutated) },
        }),
        null,
      );
    }
    const legacyLeak = {
      ...req,
      payload: { ...req.payload, mobilePublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    };
    assert.equal(await d.handlePairingRequest(legacyLeak), null);
    assert.ok(await d.handlePairingRequest(req));
  } finally {
    p.destroy();
    d.destroy();
  }
});

await test("a record crossing the remaining byte budget requests rotation without consuming it", () => {
  let operations = 0;
  const fake = {
    peerDeviceId: "peer",
    establishedAt: Date.now(),
    handshakeHash: new Uint8Array(32),
    encrypt: (p) => {
      operations++;
      return p;
    },
    decrypt: (p) => p,
  };
  const session = withSessionLimits(fake, { ...DEFAULT_SESSION_POLICY, maxBytes: 5 });
  session.encrypt(text("abc"));
  assert.throws(() => session.encrypt(text("def")), /fresh handshake/);
  assert.equal(session.needsRehandshake(), true);
  assert.equal(operations, 1);
});

await test("activating saved trust requires the verified session's exact pinned desktop key", () => {
  const { matchesDesktopSession } = require("@bimax/core/session/attempt");
  const trust = { deviceId: "desktop", staticPublicKeyB64: "new-pinned-key", cryptoVersion: 2 };
  assert.equal(
    matchesDesktopSession(trust, { peerDeviceId: "desktop", peerStaticPublicKey: "old-key" }),
    false,
  );
  assert.equal(
    matchesDesktopSession(trust, {
      peerDeviceId: "desktop",
      peerStaticPublicKey: "new-pinned-key",
    }),
    true,
  );
});
