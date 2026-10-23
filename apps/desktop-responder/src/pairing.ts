import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  Envelope,
  PairingPrekey,
  EncryptedPayload,
} from "@bimax/protocol";
import { NoiseIKResponder } from "./crypto/noise";
import { bytesToBase64, base64ToBytes } from "./crypto/base64";
import { formatVerificationCode, type EstablishedSession } from "./session/session";
import { canonicalJson, ed25519Verify, sha256Bytes, randomId } from "./crypto/keys";
import { generateDeviceId, type Identity } from "./identity";
import {
  OneTimePqPrekeys,
  decodePqBytes,
  PQ_CIPHERTEXT_BYTES,
  type PqKemBackend,
} from "@bimax/core/crypto/pq";
import {
  SESSION_CONFIRMATION,
  DEFAULT_SESSION_POLICY,
  withSessionLimits,
  verifyTransportConfirmation,
  type SessionPolicy,
} from "@bimax/core/session/lifecycle";

type PairingResult = {
  grantEnv: Envelope<"pairing_grant", PairingGrant>;
  isRehandshake: boolean;
  isRetry?: boolean;
  verificationCode?: string;
  session: EstablishedSession;
};

export interface TrustedPhoneRecord {
  phoneDeviceId: string;
  phoneX25519PubkeyB64: string;
  phoneHelloPubkeyB64: string;
  pairedAt: number;
  cryptoVersion?: 2;
}

export interface CandidatePairing {
  phoneDeviceId: string;
  phoneX25519PubkeyB64: string;
  phoneHelloPubkeyB64?: string;
  verificationCode: string;
  session: EstablishedSession;
  handshakeHash: Uint8Array;
  expiresAt: number;
  cryptoVersion?: 2;
}

export interface PairingManagerOptions {
  identity: Identity;
  relayUrl: string;
  lanRelayUrl?: string;
  storePath?: string;
  refRotationIntervalMs?: number;
  refTtlMs?: number;
  enablePqPairing?: boolean;
  pqBackend?: PqKemBackend;
  sessionPolicy?: SessionPolicy;
}

const DEFAULT_REF_ROTATION_MS = 20_000;
const DEFAULT_REF_TTL_MS = 60_000;

export class PairingManager {
  private identity: Identity;
  private disposed = false;
  private enablePqPairing: boolean;
  private pqPrekeys: OneTimePqPrekeys;
  private currentPrekey: PairingPrekey | null = null;
  private recoveryPrekeyId: string | null = null;
  private sessionPolicy: SessionPolicy;
  private requestQueue: Promise<unknown> = Promise.resolve();
  private queuedRequests = 0;
  private acceptedRequests = new Map<string, { result: PairingResult; expiresAt: number }>();
  private confirmations = new Map<
    string,
    {
      session: EstablishedSession;
      isRehandshake: boolean;
      authorizedAs: string | null;
      confirmed: boolean;
      expiresAt: number;
      confirmation?: string;
    }
  >();
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
  private seenInitiatorEphemerals = new Map<string, number>();
  private replayPersistence: Promise<void> = Promise.resolve();
  private lifecycle = 0;
  private trustPersistence: Promise<void> = Promise.resolve();

  /** Retained as a no-op for legacy callers; signing identity is always taken from the authenticated Noise transcript. */
  public noteHelloPubkey(_deviceId: string, _helloPubkeyB64: string): void {}

  constructor(opts: PairingManagerOptions) {
    this.identity = opts.identity;
    this.enablePqPairing = opts.enablePqPairing ?? false;
    this.pqPrekeys = new OneTimePqPrekeys(opts.pqBackend);
    this.sessionPolicy = { ...DEFAULT_SESSION_POLICY, ...opts.sessionPolicy };
    this.relayUrl = opts.relayUrl;
    this.lanRelayUrl = opts.lanRelayUrl;
    this.storePath = opts.storePath;
    this.refRotationIntervalMs = opts.refRotationIntervalMs ?? DEFAULT_REF_ROTATION_MS;
    this.refTtlMs = opts.refTtlMs ?? DEFAULT_REF_TTL_MS;

    this.rotateRef();
    this.refTimer = setInterval(() => {
      this.rotateRef();
    }, this.refRotationIntervalMs);
    if (
      this.refTimer &&
      typeof (this.refTimer as unknown as { unref?: () => void }).unref === "function"
    ) {
      (this.refTimer as unknown as { unref: () => void }).unref();
    }
  }

  public async init(): Promise<void> {
    if (!this.storePath) return;
    try {
      const rows: unknown = JSON.parse(await fs.readFile(this.storePath + ".replays", "utf8"));
      if (!Array.isArray(rows) || rows.length > 1024)
        throw new Error("Corrupt handshake replay cache");
      for (const entry of rows) {
        if (
          !Array.isArray(entry) ||
          !/^[A-Za-z0-9+/]{43}=$/.test(entry[0]) ||
          !Number.isSafeInteger(entry[1])
        )
          throw new Error("Corrupt handshake replay entry");
        if (entry[1] >= Date.now()) this.seenInitiatorEphemerals.set(entry[0], entry[1]);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
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
        typeof obj.pairedAt === "number" &&
        (obj.cryptoVersion === undefined || obj.cryptoVersion === 2)
      ) {
        this.trustedPhone = {
          phoneDeviceId: obj.phoneDeviceId,
          phoneX25519PubkeyB64: obj.phoneX25519PubkeyB64,
          phoneHelloPubkeyB64: obj.phoneHelloPubkeyB64,
          pairedAt: obj.pairedAt,
          cryptoVersion: obj.cryptoVersion,
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
    this.currentPrekey = null;
    this.pqPrekeys.prune();
    this.prunePendingCrypto();
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
  private classicalAdvertisement(): PairingAdvertisement {
    const url = new URL(this.relayUrl);
    if (!url.pathname.includes("/room/"))
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/room/${this.identity.deviceId}`;
    const roomUrl = url.toString();
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

  public getAdvertisement(): PairingAdvertisement {
    if (this.disposed) throw new Error("PairingManager has been destroyed");
    const base = this.classicalAdvertisement();
    if (!this.enablePqPairing) return base;
    if (!this.currentPrekey)
      this.currentPrekey = this.pqPrekeys.create(
        base,
        (this.validRefs.get(this.currentRef) ?? Date.now()) + this.refTtlMs,
      );
    return { ...this.currentPrekey.advertisement };
  }

  public getPublicPrekey(id: string, ref: string): PairingPrekey | null {
    return this.pqPrekeys.get(id, ref);
  }

  /** Consumes no application frame state; the next SealedFrame still has seq=0. */
  public confirmTransport(
    env: Envelope<"encrypted", EncryptedPayload>,
  ): "confirmed" | "duplicate" | "rejected" | "unrelated" {
    if (
      this.disposed ||
      env.v !== 2 ||
      env.kind !== "encrypted" ||
      env.to !== this.identity.deviceId
    )
      return "rejected";
    const pending = this.confirmations.get(env.from);
    if (!pending) return "unrelated";
    const ciphertext = env.payload?.ciphertext;
    if (typeof ciphertext !== "string") return "rejected";
    const fingerprint =
      ciphertext.length <= 2048
        ? canonicalJson({ id: env.id, from: env.from, to: env.to, ciphertext })
        : null;
    if (pending.confirmed && fingerprint === pending.confirmation) return "duplicate";
    let nonce: bigint;
    try {
      const header = base64ToBytes(ciphertext.slice(0, 12));
      if (header.length < 8) return "rejected";
      nonce = new DataView(header.buffer, header.byteOffset, 8).getBigUint64(0, true);
    } catch {
      return "rejected";
    }
    // Every managed session reserves nonce 0 for confirmation. Old application data
    // remains routable while a replacement session is awaiting confirmation.
    if (nonce !== 0n) return "unrelated";
    if (pending.confirmed || !fingerprint) return "rejected";
    if (
      Date.now() >= pending.expiresAt ||
      (pending.isRehandshake && pending.authorizedAs !== this.trustedPrincipal())
    ) {
      pending.session.destroy?.();
      this.confirmations.delete(env.from);
      return "rejected";
    }
    try {
      verifyTransportConfirmation(pending.session, env);
    } catch {
      return "rejected";
    }
    pending.confirmed = true;
    pending.confirmation = fingerprint;
    if (pending.isRehandshake) {
      this.retainRecoveryPrekey(pending.session);
      this.activeSession?.destroy?.();
      this.activeSession = pending.session;
    }
    return "confirmed";
  }

  public getTrustedPhone(): TrustedPhoneRecord | null {
    return this.trustedPhone;
  }

  public getActiveSession(): EstablishedSession | null {
    if (this.activeSession?.needsRehandshake?.()) {
      this.activeSession.destroy?.();
      this.activeSession = null;
    }
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
  ): Promise<PairingResult | null> {
    if (this.disposed || this.queuedRequests >= 16) return Promise.resolve(null);
    const generation = this.lifecycle;
    this.queuedRequests++;
    const task = this.requestQueue
      .then(async () => {
        if (generation !== this.lifecycle) return null;
        if (
          !env?.payload ||
          typeof env.payload.handshakeMessage !== "string" ||
          env.payload.handshakeMessage.length > 87400
        )
          return null;
        for (const [id, entry] of this.acceptedRequests)
          if (entry.expiresAt <= Date.now()) this.acceptedRequests.delete(id);
        const fingerprint = bytesToBase64(
          sha256Bytes(
            new TextEncoder().encode(
              canonicalJson({
                v: env.v,
                from: env.from,
                to: env.to,
                payload: env.payload,
              }),
            ),
          ),
        );
        const cached = this.acceptedRequests.get(fingerprint);
        if (cached) {
          if (!env.payload.cryptoVersion) return null;
          if (this.confirmations.get(env.from)?.session !== cached.result.session) return null;
          return { ...cached.result, isRetry: true };
        }
        const result = await this.handlePairingRequestInternal(env);
        if (result)
          this.acceptedRequests.set(fingerprint, {
            result,
            expiresAt: Date.now() + this.sessionPolicy.confirmationTimeoutMs,
          });
        return result;
      })
      .finally(() => {
        this.queuedRequests--;
      });
    this.requestQueue = task.catch(() => {});
    return task;
  }

  private async handlePairingRequestInternal(
    env: Envelope<"pairing_request", PairingRequest>,
  ): Promise<PairingResult | null> {
    if (!env || typeof env !== "object" || env.kind !== "pairing_request" || !env.payload) {
      return null;
    }
    const lifecycle = this.lifecycle;
    this.prunePendingCrypto();
    if (this.confirmations.size >= 8 && !this.confirmations.has(env.from)) return null;
    if (env.v !== 2 || env.to !== this.identity.deviceId) return null;

    const { ref, mobileDeviceId, mobilePublicKey, handshakeMessage } = env.payload;
    if (
      typeof mobileDeviceId !== "string" ||
      typeof handshakeMessage !== "string" ||
      env.from !== mobileDeviceId
    ) {
      return null;
    }

    const pqRequested =
      env.payload.cryptoVersion !== undefined ||
      env.payload.pqPrekeyId !== undefined ||
      env.payload.kemCiphertext !== undefined;
    if ((this.enablePqPairing || this.trustedPhone?.cryptoVersion === 2) && !pqRequested)
      return null;
    if (pqRequested ? mobilePublicKey !== undefined : typeof mobilePublicKey !== "string")
      return null;
    let pq: { psk: Uint8Array; prologue: Uint8Array } | undefined;
    try {
      if (pqRequested) {
        if (env.payload.cryptoVersion !== 2 || typeof env.payload.pqPrekeyId !== "string")
          return null;
        pq = this.pqPrekeys.derive(
          env.payload.pqPrekeyId,
          ref,
          decodePqBytes(env.payload.kemCiphertext, PQ_CIPHERTEXT_BYTES),
        );
      }
    } catch {
      return null;
    }
    const responder = new NoiseIKResponder({
      ...pq,
      staticKeypair: this.identity.noiseStaticKeypair,
    });
    pq?.psk.fill(0);
    let keepResponder = false;
    try {
      let msg1Bytes: Uint8Array;
      try {
        msg1Bytes = base64ToBytes(handshakeMessage);
      } catch {
        return null;
      }

      const ephemeral = bytesToBase64(msg1Bytes.slice(0, 32));
      const now = Date.now();
      for (const [key, until] of this.seenInitiatorEphemerals)
        if (until < now) this.seenInitiatorEphemerals.delete(key);
      if (this.seenInitiatorEphemerals.has(ephemeral) || this.seenInitiatorEphemerals.size >= 1024)
        return null;

      let readResult: { payload: Uint8Array; remoteStaticPublicKey: Uint8Array };
      try {
        readResult = responder.readMessage1(msg1Bytes);
      } catch {
        return null;
      }

      const phoneX25519PubkeyB64 = bytesToBase64(readResult.remoteStaticPublicKey);
      let authenticatedHelloPubkey: string;
      try {
        const payload = JSON.parse(new TextDecoder().decode(readResult.payload));
        const { signature, ...proof } = payload;
        if (
          proof.pairingVersion !== 2 ||
          !Number.isSafeInteger(proof.sentAt) ||
          Math.abs(now - proof.sentAt) > 120_000 ||
          proof.mobileDeviceId !== mobileDeviceId ||
          proof.ref !== ref ||
          proof.noisePublicKey !== phoneX25519PubkeyB64 ||
          (!pqRequested && mobilePublicKey !== phoneX25519PubkeyB64) ||
          proof.desktopPublicKey !== this.identity.noisePublicKeyB64 ||
          typeof proof.helloPubkey !== "string"
        )
          return null;
        const key = base64ToBytes(proof.helloPubkey);
        if (
          key.length !== 32 ||
          !ed25519Verify(
            key,
            new TextEncoder().encode(canonicalJson(proof)),
            base64ToBytes(signature),
          )
        )
          return null;
        authenticatedHelloPubkey = proof.helloPubkey;
      } catch {
        return null;
      }

      const isRehandshake =
        this.trustedPhone !== null &&
        this.trustedPhone.phoneX25519PubkeyB64 === phoneX25519PubkeyB64 &&
        this.trustedPhone.phoneDeviceId === mobileDeviceId &&
        this.trustedPhone.phoneHelloPubkeyB64 === authenticatedHelloPubkey;

      const authorizedAs = isRehandshake ? this.trustedPrincipal() : null;
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

      if (pqRequested) {
        this.pqPrekeys.consume(env.payload.pqPrekeyId!);
        if (this.recoveryPrekeyId === env.payload.pqPrekeyId) this.recoveryPrekeyId = null;
        if (ref === this.currentRef) this.rotateRef();
      }
      this.seenInitiatorEphemerals.set(ephemeral, now + 240_000);
      try {
        await this.persistReplayCache();
      } catch {
        responder.destroy();
        return null;
      }
      if (
        lifecycle !== this.lifecycle ||
        (isRehandshake && authorizedAs !== this.trustedPrincipal())
      ) {
        responder.destroy();
        return null;
      }
      // A trusted classical phone opting into PQ permanently raises its reconnect policy.
      if (pqRequested && isRehandshake && this.trustedPhone?.cryptoVersion !== 2) {
        const upgraded: TrustedPhoneRecord = { ...this.trustedPhone!, cryptoVersion: 2 };
        try {
          await this.persistTrustedPhone(upgraded);
        } catch {
          return null;
        }
        if (lifecycle !== this.lifecycle || authorizedAs !== this.trustedPrincipal()) return null;
        this.trustedPhone = upgraded;
      }
      let nextPqPrekey: PairingPrekey | undefined;
      try {
        if (pqRequested)
          nextPqPrekey = this.pqPrekeys.create(
            {
              ...this.classicalAdvertisement(),
              ref: randomId("resume"),
            },
            Date.now() + 24 * 60 * 60_000,
          );
      } catch {
        return null;
      }
      const handshakeId = bytesToBase64(sha256Bytes(msg1Bytes));
      // Complete Noise IK step 2; authenticate confirmation policy and the next prekey in M2.
      let msg2: Uint8Array;
      try {
        msg2 = responder.writeMessage2(
          new TextEncoder().encode(
            canonicalJson({ confirmation: SESSION_CONFIRMATION, nextPqPrekey, handshakeId }),
          ),
        );
      } catch {
        return null;
      }

      const handshakeHash = responder.getHandshakeHash();
      const confirmation = { confirmed: false };
      const session = withSessionLimits(
        {
          nextPqPrekey,
          destroy: () => {
            responder.destroy();
            if (nextPqPrekey && nextPqPrekey.advertisement.pqPrekeyId !== this.recoveryPrekeyId)
              this.pqPrekeys.discard(nextPqPrekey.advertisement.pqPrekeyId!);
          },
          peerDeviceId: mobileDeviceId,
          handshakeHash,
          establishedAt: Date.now(),
          encrypt: (plaintext: Uint8Array) => {
            if (!confirmation.confirmed)
              throw new Error("Initiator transport confirmation required");
            return responder.encrypt(plaintext);
          },
          decrypt: (ciphertext: Uint8Array, validate?: (plaintext: Uint8Array) => void) =>
            responder.decrypt(ciphertext, validate),
        },
        this.sessionPolicy,
      );
      const pendingConfirmation = {
        session,
        isRehandshake,
        authorizedAs,
        confirmation: undefined as string | undefined,
        expiresAt: Date.now() + this.sessionPolicy.confirmationTimeoutMs,
        get confirmed() {
          return confirmation.confirmed;
        },
        set confirmed(value: boolean) {
          confirmation.confirmed = value;
        },
      };
      const previous = this.confirmations.get(mobileDeviceId);
      if (previous && previous.session !== this.activeSession) previous.session.destroy?.();
      this.confirmations.set(mobileDeviceId, pendingConfirmation);
      keepResponder = true;

      const grantEnv: Envelope<"pairing_grant", PairingGrant> = {
        v: 2,
        id: "grant-" + generateDeviceId().slice(0, 16) + "-" + Date.now().toString(36),
        ts: Date.now(),
        from: this.identity.deviceId,
        to: mobileDeviceId,
        kind: "pairing_grant",
        payload: {
          mobileDeviceId,
          grantedAt: Date.now(),
          handshakeMessage: bytesToBase64(msg2),
          handshakeId,
        },
      };

      if (isRehandshake) {
        // The existing session remains active until the new initiator confirms its keys.
        return {
          grantEnv,
          isRehandshake: true,
          session,
        };
      }

      // Fresh pairing: derive verification code and save candidate
      const verificationCode = formatVerificationCode(handshakeHash);
      if (this.candidatePairing) {
        this.candidatePairing.session.destroy?.();
        if (this.candidatePairing.phoneDeviceId !== mobileDeviceId)
          this.confirmations.delete(this.candidatePairing.phoneDeviceId);
      }
      this.candidatePairing = {
        phoneDeviceId: mobileDeviceId,
        cryptoVersion: pqRequested ? 2 : undefined,
        phoneX25519PubkeyB64,
        phoneHelloPubkeyB64: authenticatedHelloPubkey,
        expiresAt: Date.now() + this.refTtlMs,
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
    } finally {
      if (!keepResponder) responder.destroy();
    }
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
    if (
      Date.now() > this.candidatePairing.expiresAt ||
      this.candidatePairing.verificationCode !== code
    ) {
      throw new Error("Verification code does not match");
    }

    if (this.trustedPhone !== null) {
      throw new Error(
        "A trusted phone is already registered; use confirmReplaceTrustedPhone() to replace it",
      );
    }

    if (!this.confirmations.get(this.candidatePairing.phoneDeviceId)?.confirmed)
      throw new Error("Initiator transport confirmation required before trusting phone");
    const helloPubkey = this.candidatePairing.phoneHelloPubkeyB64;
    if (phoneHelloPubkeyB64 && phoneHelloPubkeyB64 !== helloPubkey)
      throw new Error("Signing key does not match authenticated pairing transcript");
    if (!helloPubkey) {
      throw new Error("Missing phone hello pubkey for trust record");
    }

    const record: TrustedPhoneRecord = {
      phoneDeviceId: this.candidatePairing.phoneDeviceId,
      phoneX25519PubkeyB64: this.candidatePairing.phoneX25519PubkeyB64,
      phoneHelloPubkeyB64: helloPubkey,
      pairedAt: Date.now(),
      cryptoVersion: this.candidatePairing.cryptoVersion,
    };

    const session = this.candidatePairing.session;
    this.candidatePairing = null;
    const lifecycle = ++this.lifecycle;
    try {
      await this.persistTrustedPhone(record);
      if (
        lifecycle !== this.lifecycle ||
        this.confirmations.get(record.phoneDeviceId)?.session !== session ||
        session.needsRehandshake?.()
      )
        throw new Error("Pairing changed or expired during confirmation");
    } catch (error) {
      session.destroy?.();
      if (this.confirmations.get(record.phoneDeviceId)?.session === session)
        this.confirmations.delete(record.phoneDeviceId);
      throw error;
    }
    this.lifecycle++;
    this.trustedPhone = record;
    this.retainRecoveryPrekey(session);
    this.invalidateOtherSessions(session);
    this.activeSession?.destroy?.();
    this.activeSession = session;
    return record;
  }

  /**
   * Replaces the currently trusted phone with the candidate pairing after explicit confirmation.
   */
  public async confirmReplaceTrustedPhone(
    code: string,
    phoneHelloPubkeyB64?: string,
  ): Promise<TrustedPhoneRecord> {
    if (
      !this.candidatePairing ||
      Date.now() > this.candidatePairing.expiresAt ||
      this.candidatePairing.verificationCode !== code
    ) {
      throw new Error("Verification code does not match");
    }

    if (!this.confirmations.get(this.candidatePairing.phoneDeviceId)?.confirmed)
      throw new Error("Initiator transport confirmation required before trusting phone");
    const helloPubkey = this.candidatePairing.phoneHelloPubkeyB64;
    if (phoneHelloPubkeyB64 && phoneHelloPubkeyB64 !== helloPubkey)
      throw new Error("Signing key does not match authenticated pairing transcript");

    if (!helloPubkey) {
      throw new Error("Missing phone hello pubkey for trust record");
    }

    const record: TrustedPhoneRecord = {
      phoneDeviceId: this.candidatePairing.phoneDeviceId,
      phoneX25519PubkeyB64: this.candidatePairing.phoneX25519PubkeyB64,
      phoneHelloPubkeyB64: helloPubkey,
      pairedAt: Date.now(),
      cryptoVersion: this.candidatePairing.cryptoVersion,
    };

    const session = this.candidatePairing.session;
    this.candidatePairing = null;
    const lifecycle = ++this.lifecycle;
    try {
      await this.persistTrustedPhone(record);
      if (
        lifecycle !== this.lifecycle ||
        this.confirmations.get(record.phoneDeviceId)?.session !== session ||
        session.needsRehandshake?.()
      )
        throw new Error("Pairing changed or expired during confirmation");
    } catch (error) {
      session.destroy?.();
      if (this.confirmations.get(record.phoneDeviceId)?.session === session)
        this.confirmations.delete(record.phoneDeviceId);
      throw error;
    }
    this.lifecycle++;
    this.trustedPhone = record;
    this.retainRecoveryPrekey(session);
    this.invalidateOtherSessions(session);
    this.activeSession?.destroy?.();
    this.activeSession = session;
    return record;
  }

  public setActiveSession(session: EstablishedSession | null): void {
    if (this.activeSession !== session) this.activeSession?.destroy?.();
    this.activeSession = session;
  }

  /**
   * Revokes the trusted phone record: deletes persisted record, tears down sessions.
   */
  public async revokeTrustedPhone(): Promise<string | null> {
    this.lifecycle++;
    const prevDeviceId = this.trustedPhone?.phoneDeviceId ?? null;
    this.trustedPhone = null;
    this.activeSession?.destroy?.();
    this.activeSession = null;
    this.clearPendingCrypto();
    this.candidatePairing = null;

    if (this.storePath) {
      const filename = this.storePath;
      const pending = this.trustPersistence.then(async () => {
        await fs.unlink(filename).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
      });
      this.trustPersistence = pending.catch(() => {});
      await pending;
    }

    return prevDeviceId;
  }

  public destroy(): void {
    this.disposed = true;
    this.lifecycle++;
    if (this.refTimer) {
      clearInterval(this.refTimer);
      this.refTimer = null;
    }
    this.clearPendingCrypto();
    this.validRefs.clear();
    this.activeSession?.destroy?.();
    this.activeSession = null;
    this.candidatePairing = null;
  }

  private trustedPrincipal(): string | null {
    const trusted = this.trustedPhone;
    return trusted
      ? canonicalJson({
          id: trusted.phoneDeviceId,
          x25519: trusted.phoneX25519PubkeyB64,
          signing: trusted.phoneHelloPubkeyB64,
        })
      : null;
  }

  private invalidateOtherSessions(keep: EstablishedSession): void {
    for (const [peer, pending] of this.confirmations) {
      if (pending.session !== keep) {
        pending.session.destroy?.();
        this.confirmations.delete(peer);
      }
    }
    for (const [id, entry] of this.acceptedRequests) {
      if (entry.result.session !== keep) this.acceptedRequests.delete(id);
    }
    if (this.candidatePairing && this.candidatePairing.session !== keep) {
      this.candidatePairing.session.destroy?.();
      this.candidatePairing = null;
    }
  }

  private retainRecoveryPrekey(session: EstablishedSession): void {
    const next = session.nextPqPrekey?.advertisement.pqPrekeyId ?? null;
    if (this.recoveryPrekeyId && this.recoveryPrekeyId !== next)
      this.pqPrekeys.discard(this.recoveryPrekeyId);
    this.recoveryPrekeyId = next;
  }

  private prunePendingCrypto(): void {
    const now = Date.now();
    for (const [peer, pending] of this.confirmations) {
      if (!pending.confirmed && now >= pending.expiresAt) {
        pending.session.destroy?.();
        this.confirmations.delete(peer);
      }
    }
    if (this.candidatePairing && now >= this.candidatePairing.expiresAt) {
      this.candidatePairing.session.destroy?.();
      if (
        this.confirmations.get(this.candidatePairing.phoneDeviceId)?.session ===
        this.candidatePairing.session
      )
        this.confirmations.delete(this.candidatePairing.phoneDeviceId);
      this.candidatePairing = null;
    }
    for (const [id, entry] of this.acceptedRequests)
      if (entry.expiresAt <= now) this.acceptedRequests.delete(id);
    if (this.activeSession?.needsRehandshake?.()) {
      this.activeSession.destroy?.();
      this.activeSession = null;
    }
  }

  private clearPendingCrypto(): void {
    this.pqPrekeys.destroy();
    this.recoveryPrekeyId = null;
    this.currentPrekey = null;
    this.acceptedRequests.clear();
    for (const entry of this.confirmations.values()) entry.session.destroy?.();
    this.confirmations.clear();
    this.candidatePairing?.session.destroy?.();
  }

  private async persistTrustedPhone(trusted: TrustedPhoneRecord): Promise<void> {
    if (!this.storePath) return;
    const filename = this.storePath,
      record = JSON.stringify(trusted);
    const pending = this.trustPersistence.then(async () => {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = filename + ".tmp-" + generateDeviceId();
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(record);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, filename);
    });
    this.trustPersistence = pending.catch(() => {});
    await pending;
  }

  private persistReplayCache(): Promise<void> {
    if (!this.storePath) return Promise.resolve();
    const filename = this.storePath + ".replays";
    const write = async () => {
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = filename + ".tmp-" + generateDeviceId();
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify([...this.seenInitiatorEphemerals]));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, filename);
      const directory = await fs.open(path.dirname(filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    const pending = this.replayPersistence.then(write);
    this.replayPersistence = pending.catch(() => {});
    return pending;
  }
}
