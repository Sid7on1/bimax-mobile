import type {
  Envelope,
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
} from "@bimax/protocol";
import type { KeyPair } from "../crypto/keys";
import { base64ToBytes, bytesToBase64 } from "../crypto/base64";
import { validateGrant } from "../crypto/pairing";
import { NoiseIKInitiator } from "../crypto/noise";

export interface EstablishedSession {
  peerDeviceId: string;
  handshakeHash: Uint8Array;
  establishedAt: number;
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array): Uint8Array;
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
}

export class PairingManager {
  private opts: PairingManagerOptions;
  private pending = new Map<string, NoiseIKInitiator>();
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

  beginPairing(advert: PairingAdvertisement): Envelope<"pairing_request", PairingRequest> {
    if (this.pending.has(advert.desktopDeviceId)) {
      throw new Error(
        `PairingManager: pairing already pending for device ${advert.desktopDeviceId}`,
      );
    }

    const remoteStaticPublicKey = base64ToBytes(advert.desktopPublicKey);
    const initiator = new NoiseIKInitiator({
      staticKeypair: this.opts.staticKeypair,
      remoteStaticPublicKey,
    });

    // Write message 1 with empty payload (the pairing ref travels in the transport envelope)
    const msg1 = initiator.writeMessage1(new Uint8Array(0));

    this.pending.set(advert.desktopDeviceId, initiator);

    const randomId =
      "m-" +
      Math.random().toString(36).slice(2) +
      "-" +
      Date.now().toString(36);

    return {
      v: 1,
      id: randomId,
      ts: Date.now(),
      from: this.opts.deviceId,
      to: advert.desktopDeviceId,
      kind: "pairing_request",
      payload: {
        ref: advert.ref,
        mobileDeviceId: this.opts.deviceId,
        mobilePublicKey: bytesToBase64(this.opts.staticKeypair.publicKey),
        handshakeMessage: bytesToBase64(msg1),
      },
    };
  }

  handleGrant(env: Envelope<"pairing_grant", PairingGrant>): EstablishedSession {
    const grant = validateGrant(env);

    const initiator = this.pending.get(env.from);
    if (!initiator) {
      throw new Error(
        `PairingManager: no pending pairing found for peer ${env.from}`,
      );
    }

    const msg2 = base64ToBytes(grant.handshakeMessage);
    try {
      initiator.readMessage2(msg2);
    } catch (err) {
      // The Noise state is corrupted after a failed read — this initiator can
      // never complete. Drop it so a fresh beginPairing can retry.
      this.pending.delete(env.from);
      throw err;
    }

    const session: EstablishedSession = {
      peerDeviceId: env.from,
      handshakeHash: initiator.getHandshakeHash(),
      establishedAt: Date.now(),
      encrypt: (plaintext: Uint8Array) => initiator.encrypt(plaintext),
      decrypt: (ciphertext: Uint8Array) => initiator.decrypt(ciphertext),
    };

    this.pending.delete(env.from);
    this.sessions.set(env.from, session);
    return session;
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
