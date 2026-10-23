import type { Envelope, EncryptedPayload } from "@bimax/protocol";
import type { EstablishedSession } from "./session";
import { base64ToBytes, bytesToBase64 } from "../crypto/base64";
import { canonicalJson, randomId } from "../crypto/keys";

export const SESSION_CONFIRMATION = "bimax/session-confirm/v2";
export interface SessionPolicy {
  maxAgeMs: number;
  maxRecords: number;
  maxBytes: number;
  confirmationTimeoutMs: number;
}
export const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({
  maxAgeMs: 30 * 60_000,
  maxRecords: 1_048_576,
  maxBytes: 256 * 1024 * 1024,
  confirmationTimeoutMs: 30_000,
});

/** Shared budget across both directions; failed authentication never consumes a record. */
export function withSessionLimits(
  session: EstablishedSession,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  monotonicNow: () => number = () => {
    if (!globalThis.performance?.now)
      throw new Error("A monotonic clock is required for secure session limits");
    return globalThis.performance.now();
  },
): EstablishedSession {
  for (const key of ["maxAgeMs", "maxRecords", "maxBytes", "confirmationTimeoutMs"] as const)
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0)
      throw new Error("Invalid session policy");
  policy = { ...policy };
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw new Error("Invalid monotonic clock");
  let records = 0,
    bytes = 0,
    destroyed = false,
    rotationRequested = false;
  const needsRehandshake = (nextBytes = 0) =>
    destroyed ||
    rotationRequested ||
    Date.now() - session.establishedAt >= policy.maxAgeMs ||
    monotonicNow() - startedAt >= policy.maxAgeMs ||
    records >= policy.maxRecords ||
    bytes >= policy.maxBytes ||
    bytes + nextBytes > policy.maxBytes;
  const check = (size: number) => {
    if (needsRehandshake()) {
      if (!destroyed) {
        destroyed = true;
        session.destroy?.();
      }
      throw new Error("Session limit reached; fresh handshake required");
    }
    if (bytes + size > policy.maxBytes) {
      // A valid record that would fit a fresh session must trigger rotation, even
      // when a few unused bytes remain. An intrinsically oversized input does not.
      if (size <= policy.maxBytes) rotationRequested = true;
      throw new Error("Session byte limit would be exceeded; fresh handshake required");
    }
  };
  return {
    ...session,
    needsRehandshake: () => needsRehandshake(),
    encrypt(plaintext) {
      check(plaintext.length);
      const ciphertext = session.encrypt(plaintext);
      records++;
      bytes += plaintext.length;
      return ciphertext;
    },
    decrypt(ciphertext, validate) {
      check(Math.max(0, ciphertext.length - 24));
      const plaintext = session.decrypt(ciphertext, validate);
      records++;
      bytes += plaintext.length;
      return plaintext;
    },
    destroy() {
      destroyed = true;
      session.destroy?.();
    },
  };
}

export function buildTransportConfirmation(
  session: EstablishedSession,
  from: string,
): Envelope<"encrypted", EncryptedPayload> {
  const outer = { id: randomId("confirm"), from, to: session.peerDeviceId };
  const plaintext = new TextEncoder().encode(
    canonicalJson({
      confirmation: SESSION_CONFIRMATION,
      handshakeHash: bytesToBase64(session.handshakeHash),
      bound: outer,
    }),
  );
  return {
    ...outer,
    v: 2,
    ts: Date.now(),
    kind: "encrypted",
    payload: { ciphertext: bytesToBase64(session.encrypt(plaintext)) },
  };
}

/** Receiver validates the exact confirmation content and all routing headers before releasing data. */
export function verifyTransportConfirmation(
  session: EstablishedSession,
  env: Envelope<"encrypted", EncryptedPayload>,
): void {
  if (typeof env.payload?.ciphertext !== "string" || env.payload.ciphertext.length > 2048)
    throw new Error("Invalid confirmation size");
  const bytes = base64ToBytes(env.payload.ciphertext);
  if (
    bytes.length < 24 ||
    new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true) !== 0n
  )
    throw new Error("Confirmation must be the first transport record");
  const expected = canonicalJson({
    confirmation: SESSION_CONFIRMATION,
    handshakeHash: bytesToBase64(session.handshakeHash),
    bound: { id: env.id, from: env.from, to: env.to },
  });
  const validate = (plaintext: Uint8Array) => {
    if (new TextDecoder().decode(plaintext) !== expected)
      throw new Error("Invalid transport confirmation");
  };
  // Also enforce validation for external session adapters that ignore the optional callback.
  validate(session.decrypt(bytes, validate));
}
