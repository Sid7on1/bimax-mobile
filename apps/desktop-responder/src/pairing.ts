import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  Envelope,
} from "@bimax/protocol";
import {
  NoiseIKResponder,
} from "./crypto/noise";
import {
  bytesToBase64,
  base64ToBytes,
} from "./crypto/base64";
import {
  formatVerificationCode,
  type EstablishedSession,
} from "./session/session";
import { generateDeviceId, type Identity } from "./identity";

export interface TrustedPhoneRecord {
  phoneDeviceId: string;
  phoneX25519PubkeyB64: string;
  phoneHelloPubkeyB64: string;
  pairedAt: number;
}

export interface CandidatePairing {
  phoneDeviceId: string;
  phoneX25519PubkeyB64: string;
  phoneHelloPubkeyB64?: string;
  verificationCode: string;
  session: EstablishedSession;
  handshakeHash: Uint8Array;
}

export interface PairingManagerOptions {
  identity: Identity;
  relayUrl: string;
  lanRelayUrl?: string;
  storePath?: string;
  refRotationIntervalMs?: number;
  refTtlMs?: number;
}

const DEFAULT_REF_ROTATION_MS = 20_000;
const DEFAULT_REF_TTL_MS = 60_000;

export class PairingManager {
  private identity: Identity;
  private relayUrl: string;
  private lanRelayUrl?: string;
  private storePath?: string;
  private refRotationIntervalMs: number;
  private refTtlMs: number;

  private currentRef: string = "";
  private validRefs = new Map<string, number>(); // ref -> createdAt
  private refTimer: ReturnType<typeof setInterval> | null = null;

  private trustedPhone: TrustedPhoneRecord | null = null;
  private activeSession: EstablishedSession | null = null;
  private candidatePairing: CandidatePairing | null = null;
  private observedHelloPubkeys = new Map<string, string>();

  /** Records a helloPubkey observed on a relay-verified signed hello. */
  public noteHelloPubkey(deviceId: string, helloPubkeyB64: string): void {
    if (typeof deviceId !== "string" || !deviceId) return;
    if (typeof helloPubkeyB64 !== "string" || !helloPubkeyB64) return;
    this.observedHelloPubkeys.set(deviceId, helloPubkeyB64);
  }

  constructor(opts: PairingManagerOptions) {
    this.identity = opts.identity;
    this.relayUrl = opts.relayUrl;
    this.lanRelayUrl = opts.lanRelayUrl;
    this.storePath = opts.storePath;
    this.refRotationIntervalMs = opts.refRotationIntervalMs ?? DEFAULT_REF_ROTATION_MS;
    this.refTtlMs = opts.refTtlMs ?? DEFAULT_REF_TTL_MS;

    this.rotateRef();
    this.refTimer = setInterval(() => {
      this.rotateRef();
    }, this.refRotationIntervalMs);
    if (this.refTimer && typeof (this.refTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.refTimer as unknown as { unref: () => void }).unref();
    }
  }

  public async init(): Promise<void> {
    if (!this.storePath) return;
    let data: string;
    try {
      data = await fs.readFile(this.storePath, "utf-8");
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      const backupPath = `${this.storePath}.corrupt-${Date.now()}`;
      await fs.rename(this.storePath, backupPath).catch(() => {});
      throw new Error(`Corrupt trusted-phone store backed up to ${backupPath}`);
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Partial<TrustedPhoneRecord>;
      if (
        typeof obj.phoneDeviceId === "string" &&
        typeof obj.phoneX25519PubkeyB64 === "string" &&
        typeof obj.phoneHelloPubkeyB64 === "string" &&
        typeof obj.pairedAt === "number"
      ) {
        this.trustedPhone = {
          phoneDeviceId: obj.phoneDeviceId,
          phoneX25519PubkeyB64: obj.phoneX25519PubkeyB64,
          phoneHelloPubkeyB64: obj.phoneHelloPubkeyB64,
          pairedAt: obj.pairedAt,
        };
        return;
      }
    }

    const backupPath = `${this.storePath}.corrupt-${Date.now()}`;
    await fs.rename(this.storePath, backupPath).catch(() => {});
    throw new Error(`Invalid trusted-phone record shape backed up to ${backupPath}`);
  }

  /**
   * Rotates pairing ref every 20s and purges refs older than 60s.
   */
  public rotateRef(): string {
    const now = Date.now();
    const newRef = "ref-" + generateDeviceId().slice(0, 16) + "-" + now.toString(36);
    this.currentRef = newRef;
    this.validRefs.set(newRef, now);

    // Purge expired refs
    for (const [r, ts] of this.validRefs.entries()) {
      if (now - ts > this.refTtlMs) {
        this.validRefs.delete(r);
      }
    }

    return newRef;
  }

  /**
   * Produces the QR code PairingAdvertisement.
   */
  public getAdvertisement(): PairingAdvertisement {
    const cleanBase = this.relayUrl.replace(/\/+$/, "");
    const roomUrl = cleanBase.includes("/room/")
      ? cleanBase
      : `${cleanBase}/room/${this.identity.deviceId}`;
    const advert: PairingAdvertisement = {
      relayUrl: roomUrl,
      ref: this.currentRef,
      desktopDeviceId: this.identity.deviceId,
      desktopPublicKey: this.identity.noisePublicKeyB64,
      app: "bimax",
    };
    if (this.lanRelayUrl) {
      advert.lanRelayUrl = this.lanRelayUrl;
    }
    return advert;
  }

  public getTrustedPhone(): TrustedPhoneRecord | null {
    return this.trustedPhone;
  }

  public getActiveSession(): EstablishedSession | null {
    return this.activeSession;
  }

  public getCandidatePairing(): CandidatePairing | null {
    return this.candidatePairing;
  }

  /**
   * Handles an incoming pairing_request envelope.
   * Distinguishes two paths by the phone's X25519 static key:
   * - Re-handshake (phone static key matches trustedPhone): skip ref validation, complete handshake.
   * - Fresh pairing (new key): ref must be a valid, unexpired, unconsumed ref. Single-use.
   * - Unknown key + bad/missing ref: silent reject (returns null).
   */
  public handlePairingRequest(
    env: Envelope<"pairing_request", PairingRequest>,
  ): {
    grantEnv: Envelope<"pairing_grant", PairingGrant>;
    isRehandshake: boolean;
    verificationCode?: string;
    session: EstablishedSession;
  } | null {
    if (!env || typeof env !== "object" || env.kind !== "pairing_request" || !env.payload) {
      return null;
    }

    const { ref, mobileDeviceId, mobilePublicKey, handshakeMessage } = env.payload;
    if (
      typeof mobileDeviceId !== "string" ||
      typeof mobilePublicKey !== "string" ||
      typeof handshakeMessage !== "string" ||
      env.from !== mobileDeviceId
    ) {
      return null;
    }

    const responder = new NoiseIKResponder({
      staticKeypair: this.identity.noiseStaticKeypair,
    });

    let msg1Bytes: Uint8Array;
    try {
      msg1Bytes = base64ToBytes(handshakeMessage);
    } catch {
      return null;
    }

    let readResult: { payload: Uint8Array; remoteStaticPublicKey: Uint8Array };
    try {
      readResult = responder.readMessage1(msg1Bytes);
    } catch {
      return null;
    }

    const phoneX25519PubkeyB64 = bytesToBase64(readResult.remoteStaticPublicKey);

    const isRehandshake =
      this.trustedPhone !== null &&
      this.trustedPhone.phoneX25519PubkeyB64 === phoneX25519PubkeyB64 &&
      this.trustedPhone.phoneDeviceId === mobileDeviceId;

    if (!isRehandshake) {
      // Fresh pairing: ref MUST be live, unexpired, and single-use
      if (typeof ref !== "string" || !this.validRefs.has(ref)) {
        return null;
      }
      const refAge = Date.now() - (this.validRefs.get(ref) ?? 0);
      if (refAge > this.refTtlMs) {
        this.validRefs.delete(ref);
        return null;
      }
      // Single-use: consume ref
      this.validRefs.delete(ref);
    }

    // Complete Noise IK step 2
    let msg2: Uint8Array;
    try {
      msg2 = responder.writeMessage2(new Uint8Array(0));
    } catch {
      return null;
    }

    const handshakeHash = responder.getHandshakeHash();
    const session: EstablishedSession = {
      peerDeviceId: mobileDeviceId,
      handshakeHash,
      establishedAt: Date.now(),
      encrypt: (plaintext: Uint8Array) => responder.encrypt(plaintext),
      decrypt: (ciphertext: Uint8Array) => responder.decrypt(ciphertext),
    };

    const grantEnv: Envelope<"pairing_grant", PairingGrant> = {
      v: 1,
      id: "grant-" + generateDeviceId().slice(0, 16) + "-" + Date.now().toString(36),
      ts: Date.now(),
      from: this.identity.deviceId,
      to: mobileDeviceId,
      kind: "pairing_grant",
      payload: {
        mobileDeviceId,
        grantedAt: Date.now(),
        handshakeMessage: bytesToBase64(msg2),
      },
    };

    if (isRehandshake) {
      // Re-handshake: replace live session, keep trusted record
      this.activeSession = session;
      return {
        grantEnv,
        isRehandshake: true,
        session,
      };
    }

    // Fresh pairing: derive verification code and save candidate
    const verificationCode = formatVerificationCode(handshakeHash);
    const payloadObj = env.payload as unknown as Record<string, unknown>;
    const candidateHelloPubkey =
      typeof payloadObj["helloPubkey"] === "string"
        ? payloadObj["helloPubkey"]
        : undefined;

    this.candidatePairing = {
      phoneDeviceId: mobileDeviceId,
      phoneX25519PubkeyB64,
      phoneHelloPubkeyB64: candidateHelloPubkey,
      verificationCode,
      session,
      handshakeHash,
    };

    return {
      grantEnv,
      isRehandshake: false,
      verificationCode,
      session,
    };
  }

  /**
   * Confirms human verification code for candidate pairing.
   * If no phone is trusted yet, establishes trust immediately.
   * If a phone is already trusted, requires explicit `confirmReplaceTrustedPhone()`.
   * Note: The future ~/Bimax adapter MUST call Responder.confirmTrustedPhone — not
   * pairingManager.confirmPairing directly.
   */
  public async confirmPairing(
    code: string,
    phoneHelloPubkeyB64?: string,
  ): Promise<TrustedPhoneRecord> {
    if (!this.candidatePairing) {
      throw new Error("No candidate pairing to confirm");
    }
    if (this.candidatePairing.verificationCode !== code) {
      throw new Error("Verification code does not match");
    }

    if (this.trustedPhone !== null) {
      throw new Error(
        "A trusted phone is already registered; use confirmReplaceTrustedPhone() to replace it",
      );
    }

    const helloPubkey =
      phoneHelloPubkeyB64 ??
      this.observedHelloPubkeys.get(this.candidatePairing.phoneDeviceId) ??
      this.candidatePairing.phoneHelloPubkeyB64;
    if (!helloPubkey) {
      throw new Error("Missing phone hello pubkey for trust record");
    }

    const record: TrustedPhoneRecord = {
      phoneDeviceId: this.candidatePairing.phoneDeviceId,
      phoneX25519PubkeyB64: this.candidatePairing.phoneX25519PubkeyB64,
      phoneHelloPubkeyB64: helloPubkey,
      pairedAt: Date.now(),
    };

    this.trustedPhone = record;
    this.activeSession = this.candidatePairing.session;
    this.candidatePairing = null;

    await this.persistTrustedPhone();
    return record;
  }

  /**
   * Replaces the currently trusted phone with the candidate pairing after explicit confirmation.
   */
  public async confirmReplaceTrustedPhone(
    code: string,
    phoneHelloPubkeyB64?: string,
  ): Promise<TrustedPhoneRecord> {
    if (!this.candidatePairing || this.candidatePairing.verificationCode !== code) {
      throw new Error("Verification code does not match");
    }

    const helloPubkey =
      phoneHelloPubkeyB64 ??
      this.observedHelloPubkeys.get(this.candidatePairing.phoneDeviceId) ??
      this.candidatePairing.phoneHelloPubkeyB64;

    if (!helloPubkey) {
      throw new Error("Missing phone hello pubkey for trust record");
    }

    const record: TrustedPhoneRecord = {
      phoneDeviceId: this.candidatePairing.phoneDeviceId,
      phoneX25519PubkeyB64: this.candidatePairing.phoneX25519PubkeyB64,
      phoneHelloPubkeyB64: helloPubkey,
      pairedAt: Date.now(),
    };

    this.trustedPhone = record;
    this.activeSession = this.candidatePairing.session;
    this.candidatePairing = null;

    await this.persistTrustedPhone();
    return record;
  }

  /**
   * Directly sets the trusted phone record (used in test setups).
   */
  public async setTrustedPhone(record: TrustedPhoneRecord): Promise<void> {
    this.trustedPhone = record;
    await this.persistTrustedPhone();
  }

  public setActiveSession(session: EstablishedSession): void {
    this.activeSession = session;
  }

  /**
   * Revokes the trusted phone record: deletes persisted record, tears down sessions.
   */
  public async revokeTrustedPhone(): Promise<string | null> {
    const prevDeviceId = this.trustedPhone?.phoneDeviceId ?? null;
    this.trustedPhone = null;
    this.activeSession = null;
    this.candidatePairing = null;

    if (this.storePath) {
      try {
        await fs.unlink(this.storePath);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== "ENOENT") {
          throw err;
        }
      }
    }

    return prevDeviceId;
  }

  public destroy(): void {
    if (this.refTimer) {
      clearInterval(this.refTimer);
      this.refTimer = null;
    }
    this.validRefs.clear();
    this.activeSession = null;
    this.candidatePairing = null;
  }

  private async persistTrustedPhone(): Promise<void> {
    if (!this.storePath || !this.trustedPhone) return;
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(
      this.storePath,
      JSON.stringify(this.trustedPhone, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}
