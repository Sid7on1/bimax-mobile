import type {
  Envelope,
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  PairingPrekey,
} from "@bimax/protocol";
import {
  type KeyPair,
  generateEd25519Keypair,
  randomId,
  ed25519Sign,
  canonicalJson,
  sha256Bytes,
} from "../crypto/keys";
import { base64ToBytes, bytesToBase64 } from "../crypto/base64";
import { validateGrant } from "../crypto/pairing";
import { NoiseIKInitiator } from "../crypto/noise";
import {
  decodePqBytes,
  derivePqHandshake,
  isPqAdvertisement,
  nobleMlKem768,
  verifyPqPrekey,
  type PqKemBackend,
  PQ_PUBLIC_KEY_BYTES,
} from "../crypto/pq";
import { SESSION_CONFIRMATION, withSessionLimits, type SessionPolicy } from "./lifecycle";

export interface EstablishedSession {
  peerDeviceId: string;
  peerStaticPublicKey?: string; // In-memory trust binding; never emitted as outer PQ framing.
  handshakeHash: Uint8Array;
  establishedAt: number;
  encrypt(plaintext: Uint8Array): Uint8Array;
  /** Validation runs after AEAD authentication and before receive-state commitment. */
  decrypt(ciphertext: Uint8Array, validate?: (plaintext: Uint8Array) => void): Uint8Array;
  destroy?(): void;
  needsRehandshake?(): boolean;
  requiresConfirmation?: boolean;
  nextPqPrekey?: PairingPrekey;
}

/**
 * Formats the 32-byte handshake hash into a human-readable 6-chunk verification code
 * of the form "1234-5678-9012-3456-7890-1234".
 * Reads the first 12 bytes as 6 big-endian uint16 values, formatted mod 10000.
 */
export function formatVerificationCode(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array) || hash.length < 12) {
    throw new Error("formatVerificationCode: hash must be a Uint8Array of at least 12 bytes");
  }

  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const b0 = hash[i * 2];
    const b1 = hash[i * 2 + 1];
    const val = ((b0 << 8) | b1) % 10000;
    parts.push(val.toString().padStart(4, "0"));
  }

  return parts.join("-");
}

export interface PairingManagerOptions {
  deviceId: string;
  staticKeypair: KeyPair;
  helloKeypair?: KeyPair;
  pqBackend?: PqKemBackend;
  sessionPolicy?: SessionPolicy;
}

export class PairingManager {
  private opts: PairingManagerOptions;
  private disposed = false;
  private pending = new Map<string, NoiseIKInitiator>();
  private pendingHandshakeIds = new Map<string, string>();
  private pendingAdvertisements = new Map<string, PairingAdvertisement>();
  private sessions = new Map<string, EstablishedSession>();

  constructor(opts: PairingManagerOptions) {
    if (!opts.deviceId || typeof opts.deviceId !== "string") {
      throw new Error("PairingManager: invalid deviceId");
    }
    if (
      !(opts.staticKeypair.privateKey instanceof Uint8Array) ||
      opts.staticKeypair.privateKey.length !== 32 ||
      !(opts.staticKeypair.publicKey instanceof Uint8Array) ||
      opts.staticKeypair.publicKey.length !== 32
    ) {
      throw new Error("PairingManager: invalid staticKeypair");
    }
    this.opts = opts;
  }

  beginPairing(
    advert: PairingAdvertisement,
    pqPublicKey?: string,
  ): Envelope<"pairing_request", PairingRequest> {
    if (this.disposed) throw new Error("PairingManager has been destroyed");
    if (this.pending.has(advert.desktopDeviceId)) {
      throw new Error(
        `PairingManager: pairing already pending for device ${advert.desktopDeviceId}`,
      );
    }

    const remoteStaticPublicKey = base64ToBytes(advert.desktopPublicKey);
    let pq: ReturnType<typeof derivePqHandshake> | undefined;
    let kemCiphertext: string | undefined;
    if (isPqAdvertisement(advert)) {
      const publicKey = decodePqBytes(pqPublicKey, PQ_PUBLIC_KEY_BYTES);
      verifyPqPrekey(advert, publicKey);
      const result = (this.opts.pqBackend ?? nobleMlKem768).encapsulate(publicKey);
      try {
        pq = derivePqHandshake(advert, result.ciphertext, result.sharedSecret);
        kemCiphertext = bytesToBase64(result.ciphertext);
      } finally {
        result.sharedSecret.fill(0);
      }
    }
    const initiator = new NoiseIKInitiator({
      ...pq,
      staticKeypair: this.opts.staticKeypair,
      remoteStaticPublicKey,
    });

    pq?.psk.fill(0);

    // Bind the approval signing key to the authenticated Noise transcript.
    const signing = this.opts.helloKeypair ?? generateEd25519Keypair();
    const proof = {
      pairingVersion: 2,
      sentAt: Date.now(),
      mobileDeviceId: this.opts.deviceId,
      ref: advert.ref,
      helloPubkey: bytesToBase64(signing.publicKey),
      noisePublicKey: bytesToBase64(this.opts.staticKeypair.publicKey),
      desktopPublicKey: advert.desktopPublicKey,
    };
    let msg1: Uint8Array;
    try {
      const signature = bytesToBase64(
        ed25519Sign(signing.privateKey, new TextEncoder().encode(canonicalJson(proof))),
      );
      msg1 = initiator.writeMessage1(
        new TextEncoder().encode(canonicalJson({ ...proof, signature })),
      );
    } catch (error) {
      initiator.destroy();
      throw error;
    } finally {
      if (!this.opts.helloKeypair) signing.privateKey.fill(0);
    }

    this.pending.set(advert.desktopDeviceId, initiator);
    this.pendingAdvertisements.set(advert.desktopDeviceId, { ...advert });
    this.pendingHandshakeIds.set(advert.desktopDeviceId, bytesToBase64(sha256Bytes(msg1)));

    const envelopeId = randomId();

    return {
      v: 2,
      id: envelopeId,
      ts: Date.now(),
      from: this.opts.deviceId,
      to: advert.desktopDeviceId,
      kind: "pairing_request",
      payload: {
        ref: advert.ref,
        ...(pq ? { cryptoVersion: 2 as const, pqPrekeyId: advert.pqPrekeyId, kemCiphertext } : {}),
        mobileDeviceId: this.opts.deviceId,
        ...(!pq ? { mobilePublicKey: bytesToBase64(this.opts.staticKeypair.publicKey) } : {}),
        handshakeMessage: bytesToBase64(msg1),
      },
    };
  }

  matchesPendingGrant(env: Envelope<"pairing_grant", PairingGrant>): boolean {
    const advert = this.pendingAdvertisements.get(env.from);
    if (!advert || !env.payload) return false;
    const id = env.payload.handshakeId;
    return id === undefined
      ? !isPqAdvertisement(advert)
      : id === this.pendingHandshakeIds.get(env.from);
  }

  handleGrant(env: Envelope<"pairing_grant", PairingGrant>): EstablishedSession {
    const grant = validateGrant(env);
    if (env.v !== 2 || env.to !== this.opts.deviceId || grant.mobileDeviceId !== this.opts.deviceId)
      throw new Error("Pairing grant recipient mismatch");

    const initiator = this.pending.get(env.from);
    if (!initiator) {
      throw new Error(`PairingManager: no pending pairing found for peer ${env.from}`);
    }

    if (!this.matchesPendingGrant(env)) throw new Error("Unrelated pairing grant");
    const expectedId = this.pendingHandshakeIds.get(env.from);
    let response: { confirmation?: string; nextPqPrekey?: PairingPrekey; handshakeId?: string } =
      {};
    try {
      if (grant.handshakeMessage.length > 87400) throw new Error("Pairing grant too large");
      const payload = initiator.readMessage2(base64ToBytes(grant.handshakeMessage));
      if (payload.length) {
        response = JSON.parse(new TextDecoder().decode(payload));
        if (
          (grant.handshakeId !== undefined ||
            isPqAdvertisement(this.pendingAdvertisements.get(env.from)!)) &&
          response.handshakeId !== expectedId
        )
          throw new Error("Authenticated handshake ID mismatch");
        if (response.confirmation !== SESSION_CONFIRMATION)
          throw new Error("Unsupported session confirmation");
        if (isPqAdvertisement(this.pendingAdvertisements.get(env.from)!) && !response.nextPqPrekey)
          throw new Error("PQ pairing requires a fresh reconnect prekey");
        if (response.nextPqPrekey) {
          const next = response.nextPqPrekey;
          if (
            next.advertisement.desktopDeviceId !== env.from ||
            next.advertisement.desktopPublicKey !==
              this.pendingAdvertisements.get(env.from)?.desktopPublicKey
          )
            throw new Error("Invalid next prekey identity");
          verifyPqPrekey(next.advertisement, decodePqBytes(next.publicKey, PQ_PUBLIC_KEY_BYTES));
        }
      } else if (isPqAdvertisement(this.pendingAdvertisements.get(env.from)!)) {
        throw new Error("PQ pairing requires transport confirmation");
      }
    } catch (err) {
      // The Noise state is corrupted after a failed read — this initiator can
      // never complete. Drop it so a fresh beginPairing can retry.
      this.pending.delete(env.from);
      this.pendingAdvertisements.delete(env.from);
      this.pendingHandshakeIds.delete(env.from);
      initiator.destroy();
      throw err;
    }

    const session = withSessionLimits(
      {
        requiresConfirmation: response.confirmation === SESSION_CONFIRMATION,
        nextPqPrekey: response.nextPqPrekey,
        destroy: () => initiator.destroy(),
        peerDeviceId: env.from,
        peerStaticPublicKey: this.pendingAdvertisements.get(env.from)!.desktopPublicKey,
        handshakeHash: initiator.getHandshakeHash(),
        establishedAt: Date.now(),
        encrypt: (plaintext: Uint8Array) => initiator.encrypt(plaintext),
        decrypt: (ciphertext: Uint8Array, validate?: (plaintext: Uint8Array) => void) =>
          initiator.decrypt(ciphertext, validate),
      },
      this.opts.sessionPolicy,
    );

    this.pending.delete(env.from);
    this.pendingAdvertisements.delete(env.from);
    this.pendingHandshakeIds.delete(env.from);
    this.sessions.get(env.from)?.destroy?.();
    this.sessions.set(env.from, session);
    return session;
  }

  destroy(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.destroy();
    for (const session of this.sessions.values()) session.destroy?.();
    this.pending.clear();
    this.pendingAdvertisements.clear();
    this.pendingHandshakeIds.clear();
    this.sessions.clear();
  }

  getSession(peerDeviceId: string): EstablishedSession | undefined {
    return this.sessions.get(peerDeviceId);
  }

  hasPending(deviceId: string): boolean {
    return this.pending.has(deviceId);
  }

  hasPendingPairing(deviceId: string): boolean {
    return this.hasPending(deviceId);
  }
}
