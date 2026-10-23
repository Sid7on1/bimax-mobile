import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import type { PairingAdvertisement, PairingPrekey } from "@bimax/protocol";
import { validateRelayUrl } from "../relay/url";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { canonicalJson, hkdfSha256, randomId, secureRandomBytes, sha256Bytes } from "./keys";

export const PQ_SUITE = "PQIK_MLKEM768_IKPSK0_25519_CHACHAPOLY_BLAKE2S" as const;
export const PQ_PUBLIC_KEY_BYTES = 1184;
export const PQ_CIPHERTEXT_BYTES = 1088;
export const PQ_SECRET_KEY_BYTES = 2400;
const encoder = new TextEncoder();

/** Backend-independent, synchronous interface. Implementations own returned buffers. */
export interface PqKemBackend {
  readonly algorithm: "ML-KEM-768";
  keygen(): { publicKey: Uint8Array; secretKey: Uint8Array };
  encapsulate(publicKey: Uint8Array): { ciphertext: Uint8Array; sharedSecret: Uint8Array };
  decapsulate(ciphertext: Uint8Array, secretKey: Uint8Array): Uint8Array;
  destroy(secretKey: Uint8Array): void;
}

/** Best-effort erasure only: JavaScript/JIT/GC cannot promise constant-time execution or erasure. */
export const nobleMlKem768: PqKemBackend = {
  algorithm: "ML-KEM-768",
  keygen() {
    const seed = secureRandomBytes(64);
    try {
      return ml_kem768.keygen(seed);
    } finally {
      seed.fill(0);
    }
  },
  encapsulate(publicKey) {
    requireBytes(publicKey, PQ_PUBLIC_KEY_BYTES);
    const randomness = secureRandomBytes(32);
    try {
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey, randomness);
      return { ciphertext: cipherText, sharedSecret };
    } finally {
      randomness.fill(0);
    }
  },
  decapsulate(ciphertext, secretKey) {
    requireBytes(ciphertext, PQ_CIPHERTEXT_BYTES);
    requireBytes(secretKey, PQ_SECRET_KEY_BYTES);
    return ml_kem768.decapsulate(ciphertext, secretKey);
  },
  destroy(secretKey) {
    secretKey.fill(0);
  },
};

function requireBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error(`PQ: expected ${length} bytes`);
}

export function decodePqBytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length !== 4 * Math.ceil(length / 3))
    throw new Error("PQ: invalid encoded length");
  const bytes = base64ToBytes(value);
  requireBytes(bytes, length);
  if (bytesToBase64(bytes) !== value) throw new Error("PQ: noncanonical base64");
  return bytes;
}

export function isPqAdvertisement(advert: PairingAdvertisement): boolean {
  return [
    advert.cryptoVersion,
    advert.suite,
    advert.pqPrekeyId,
    advert.pqPrekeyHash,
    advert.expiresAt,
  ].some((field) => field !== undefined);
}

export function assertPqAdvertisement(advert: PairingAdvertisement, now = Date.now()): void {
  if (!advert || advert.cryptoVersion !== 2 || advert.suite !== PQ_SUITE)
    throw new Error("Unsupported pairing crypto version or suite; update required");
  if (typeof advert.pqPrekeyId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(advert.pqPrekeyId))
    throw new Error("PQ: invalid prekey ID");
  if (
    advert.app !== "bimax" ||
    typeof advert.ref !== "string" ||
    advert.ref.length === 0 ||
    advert.ref.length > 128 ||
    typeof advert.desktopDeviceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(advert.desktopDeviceId)
  )
    throw new Error("PQ: invalid advertisement identity");
  validateRelayUrl(advert.relayUrl);
  if (advert.lanRelayUrl !== undefined) validateRelayUrl(advert.lanRelayUrl);
  decodePqBytes(advert.desktopPublicKey, 32);
  decodePqBytes(advert.pqPrekeyHash, 32);
  if (!Number.isSafeInteger(advert.expiresAt) || advert.expiresAt! <= now)
    throw new Error("PQ pairing advertisement expired; scan a fresh QR code");
}

/** Freeze only the specified wire fields; object insertion order never affects the transcript. */
export function canonicalPqAdvertisement(advert: PairingAdvertisement): string {
  return canonicalJson({
    app: advert.app,
    relayUrl: advert.relayUrl,
    lanRelayUrl: advert.lanRelayUrl,
    ref: advert.ref,
    desktopDeviceId: advert.desktopDeviceId,
    desktopPublicKey: advert.desktopPublicKey,
    cryptoVersion: advert.cryptoVersion,
    suite: advert.suite,
    pqPrekeyId: advert.pqPrekeyId,
    pqPrekeyHash: advert.pqPrekeyHash,
    expiresAt: advert.expiresAt,
  });
}

export function verifyPqPrekey(advert: PairingAdvertisement, publicKey: Uint8Array): void {
  assertPqAdvertisement(advert);
  requireBytes(publicKey, PQ_PUBLIC_KEY_BYTES);
  if (bytesToBase64(sha256Bytes(publicKey)) !== advert.pqPrekeyHash)
    throw new Error("PQ prekey does not match QR commitment");
}

/** Product protocol, not a standardized PQ Noise suite. See docs/security/pq-pairing-v2.md. */
export function derivePqHandshake(
  advert: PairingAdvertisement,
  ciphertext: Uint8Array,
  sharedSecret: Uint8Array,
): { prologue: Uint8Array; psk: Uint8Array } {
  assertPqAdvertisement(advert);
  requireBytes(ciphertext, PQ_CIPHERTEXT_BYTES);
  requireBytes(sharedSecret, 32);
  const prologue = encoder.encode(
    canonicalJson({
      domain: "bimax/pairing/pqik/v2",
      advertisement: JSON.parse(canonicalPqAdvertisement(advert)),
      kemCiphertext: bytesToBase64(ciphertext),
    }),
  );
  const psk = hkdfSha256(
    sharedSecret,
    sha256Bytes(prologue),
    encoder.encode("Noise_IKpsk0 pairing PSK"),
    32,
  );
  return { prologue, psk };
}

interface PrekeyEntry extends PairingPrekey {
  secretKey: Uint8Array | null;
  deadline: number;
}

/** Memory-only one-time prekeys. Restart discards all keys and requires a fresh advertisement. */
export class OneTimePqPrekeys {
  private entries = new Map<string, PrekeyEntry>();
  constructor(
    private backend: PqKemBackend = nobleMlKem768,
    private maxEntries = 16,
    private monotonicNow: () => number = () => {
      if (!globalThis.performance?.now)
        throw new Error("A monotonic clock is required for PQ prekey expiry");
      return globalThis.performance.now();
    },
  ) {
    if (
      backend.algorithm !== "ML-KEM-768" ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 1024
    )
      throw new Error("Invalid PQ backend or capacity");
  }

  prune(now = Date.now()): void {
    for (const [id, entry] of this.entries) {
      if (entry.advertisement.expiresAt! <= now || this.monotonicNow() >= entry.deadline) {
        if (entry.secretKey) this.backend.destroy(entry.secretKey);
        this.entries.delete(id);
      }
    }
  }

  create(base: PairingAdvertisement, expiresAt: number): PairingPrekey {
    this.prune();
    if (this.entries.size >= this.maxEntries) throw new Error("PQ prekey capacity reached");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new Error("Invalid PQ expiry");
    const deadline = this.monotonicNow() + (expiresAt - Date.now());
    if (!Number.isFinite(deadline)) throw new Error("Invalid monotonic clock");
    const pair = this.backend.keygen();
    let stored = false;
    try {
      requireBytes(pair.publicKey, PQ_PUBLIC_KEY_BYTES);
      requireBytes(pair.secretKey, PQ_SECRET_KEY_BYTES);
      const advertisement: PairingAdvertisement = {
        ...base,
        cryptoVersion: 2,
        suite: PQ_SUITE,
        pqPrekeyId: randomId("pq"),
        pqPrekeyHash: bytesToBase64(sha256Bytes(pair.publicKey)),
        expiresAt,
      };
      assertPqAdvertisement(advertisement);
      if (this.entries.has(advertisement.pqPrekeyId!)) throw new Error("PQ prekey ID collision");
      const entry: PrekeyEntry = {
        advertisement,
        publicKey: bytesToBase64(pair.publicKey),
        secretKey: pair.secretKey,
        deadline,
      };
      this.entries.set(advertisement.pqPrekeyId!, entry);
      stored = true;
      return this.publicEntry(entry);
    } finally {
      if (!stored && pair.secretKey instanceof Uint8Array) this.backend.destroy(pair.secretKey);
    }
  }

  get(id: string, ref: string): PairingPrekey | null {
    this.prune();
    const entry = this.entries.get(id);
    return entry && entry.advertisement.ref === ref ? this.publicEntry(entry) : null;
  }

  derive(id: string, ref: string, ciphertext: Uint8Array): ReturnType<typeof derivePqHandshake> {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry?.secretKey || entry.advertisement.ref !== ref)
      throw new Error("PQ prekey unavailable or consumed");
    const secret = this.backend.decapsulate(ciphertext, entry.secretKey);
    try {
      return derivePqHandshake(entry.advertisement, ciphertext, secret);
    } finally {
      secret.fill(0);
    }
  }

  /** Only call after Noise M1 AND application authorization authenticate successfully. */
  consume(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.secretKey) throw new Error("PQ prekey already consumed");
    this.backend.destroy(entry.secretKey);
    entry.secretKey = null;
    this.entries.delete(id);
  }

  discard(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.secretKey) this.backend.destroy(entry.secretKey);
    this.entries.delete(id);
  }

  destroy(): void {
    for (const entry of this.entries.values())
      if (entry.secretKey) this.backend.destroy(entry.secretKey);
    this.entries.clear();
  }

  private publicEntry(entry: PrekeyEntry): PairingPrekey {
    return { advertisement: { ...entry.advertisement }, publicKey: entry.publicKey };
  }
}
