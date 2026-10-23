import type { PairingAdvertisement } from "@bimax/protocol";
import { generateX25519Keypair, randomId, sha256Bytes } from "./keys";
import { bytesToBase64 } from "./base64";
import { NoiseIKInitiator, NoiseIKResponder } from "./noise";
import { derivePqHandshake, nobleMlKem768, PQ_SUITE, type PqKemBackend } from "./pq";

/** Call inside the shipped JS runtime, after configuring its CSPRNG. No network timing is implied. */
export function benchmarkPqPairing(iterations = 100, backend: PqKemBackend = nobleMlKem768) {
  if (!Number.isInteger(iterations) || iterations < 10 || iterations > 10_000)
    throw new Error("Benchmark iterations must be between 10 and 10000");
  const now = () => globalThis.performance?.now() ?? Date.now();
  const timings: Record<string, number[]> = {};
  const time = <T>(name: string, action: () => T): T => {
    const start = now();
    const result = action();
    (timings[name] ??= []).push(now() - start);
    return result;
  };
  const mobile = generateX25519Keypair(),
    desktop = generateX25519Keypair();
  let noiseBytes = 0;
  try {
    for (let n = 0; n < iterations; n++) {
      const total = now();
      const pair = time("prekeyGeneration", () => backend.keygen());
      const advertisement: PairingAdvertisement = {
        app: "bimax",
        relayUrl: "wss://benchmark.invalid/room/desktop",
        ref: randomId("ref"),
        desktopDeviceId: "desktop",
        desktopPublicKey: bytesToBase64(desktop.publicKey),
        cryptoVersion: 2,
        suite: PQ_SUITE,
        pqPrekeyId: randomId("pq"),
        pqPrekeyHash: bytesToBase64(sha256Bytes(pair.publicKey)),
        expiresAt: Date.now() + 60_000,
      };
      const kem = time("encapsulate", () => backend.encapsulate(pair.publicKey));
      const recovered = time("decapsulate", () =>
        backend.decapsulate(kem.ciphertext, pair.secretKey),
      );
      const ip = derivePqHandshake(advertisement, kem.ciphertext, kem.sharedSecret);
      const rp = derivePqHandshake(advertisement, kem.ciphertext, recovered);
      kem.sharedSecret.fill(0);
      recovered.fill(0);
      backend.destroy(pair.secretKey);
      const i = new NoiseIKInitiator({
        ...ip,
        staticKeypair: mobile,
        remoteStaticPublicKey: desktop.publicKey,
      });
      const r = new NoiseIKResponder({ ...rp, staticKeypair: desktop });
      ip.psk.fill(0);
      rp.psk.fill(0);
      try {
        const m1 = time("writeMessage1", () => i.writeMessage1(new Uint8Array(512)));
        time("readMessage1", () => r.readMessage1(m1));
        const m2 = time("writeMessage2", () => r.writeMessage2(new Uint8Array(0)));
        time("readMessage2", () => i.readMessage2(m2));
        noiseBytes = m1.length + m2.length;
      } finally {
        i.destroy();
        r.destroy();
      }
      (timings.totalCrypto ??= []).push(now() - total);
    }
  } finally {
    mobile.privateKey.fill(0);
    desktop.privateKey.fill(0);
  }
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const quantile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
    return { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
  };
  return {
    iterations,
    units: "milliseconds",
    suite: PQ_SUITE,
    initiatorPayloadBytes: 512,
    responderPayloadBytes: 0,
    noiseBytes,
    kemCiphertextBytes: 1088,
    publicPrekeyBytes: 1184,
    // This excludes JSON/base64 envelopes, QR/prekey fetch latency and next-prekey distribution.
    timing: Object.fromEntries(
      Object.entries(timings).map(([name, values]) => [name, distribution(values)]),
    ),
  };
}
