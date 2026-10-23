import type { Envelope, MessageKind, PairingAdvertisement, PairingPrekey } from "@bimax/protocol";
import { randomId } from "../crypto/keys";
import {
  assertPqAdvertisement,
  decodePqBytes,
  verifyPqPrekey,
  PQ_PUBLIC_KEY_BYTES,
} from "../crypto/pq";

/** Only a QR-committed key is accepted; the relay response itself is untrusted. */
export class PqPrekeyLookup {
  private pending = new Map<
    string,
    {
      advert: PairingAdvertisement;
      resolve: (key: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  fetch(
    advert: PairingAdvertisement,
    from: string,
    send: (env: Envelope) => void,
  ): Promise<string> {
    try {
      assertPqAdvertisement(advert);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pending.size >= 4) return Promise.reject(new Error("Too many pending PQ lookups"));
    return new Promise((resolve, reject) => {
      const id = randomId("prekey");
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("PQ prekey lookup timed out; no classical fallback"));
      }, 10_000);
      this.pending.set(id, { advert: { ...advert }, resolve, reject, timer });
      try {
        send({
          v: 2,
          id,
          ts: Date.now(),
          from,
          to: advert.desktopDeviceId,
          kind: "pairing_prekey_request",
          payload: { ref: advert.ref, pqPrekeyId: advert.pqPrekeyId },
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("PQ lookup send failed"));
      }
    });
  }

  handle(env: Envelope<MessageKind, unknown>, deviceId: string): boolean {
    if (env.kind !== "pairing_prekey") return false;
    if (env.v !== 2 || env.to !== deviceId) return true;
    const payload = env.payload as Partial<PairingPrekey> | null;
    const entry = payload?.requestId && this.pending.get(payload.requestId);
    if (!entry || env.from !== entry.advert.desktopDeviceId) return true;
    try {
      verifyPqPrekey(entry.advert, decodePqBytes(payload.publicKey, PQ_PUBLIC_KEY_BYTES));
    } catch {
      return true;
    } // substitution does not prevent a later valid response
    clearTimeout(entry.timer);
    this.pending.delete(payload.requestId!);
    entry.resolve(payload.publicKey!);
    return true;
  }

  destroy(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("PQ prekey lookup cancelled"));
    }
    this.pending.clear();
  }
}
