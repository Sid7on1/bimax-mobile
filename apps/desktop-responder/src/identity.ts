import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  generateX25519Keypair,
  generateEd25519Keypair,
  type KeyPair,
} from "./crypto/keys";
import { bytesToBase64, base64ToBytes } from "./crypto/base64";

/**
 * Identity of the desktop responder.
 * - deviceId: 128-bit random hex string.
 * - noiseStaticKeypair: X25519 static keypair used for Noise IK handshakes.
 * - helloKeypair: Ed25519 keypair used for signing DeviceHello envelopes.
 */
export interface Identity {
  deviceId: string;
  noiseStaticKeypair: KeyPair;
  helloKeypair: KeyPair;
  helloPubkeyB64: string;
  noisePublicKeyB64: string;
}

interface StoredIdentity {
  deviceId: string;
  noiseStaticPrivateKeyB64: string;
  noiseStaticPublicKeyB64: string;
  helloPrivateKeyB64: string;
  helloPublicKeyB64: string;
}

/**
 * Generates a random 128-bit hex string (32 characters).
 */
export function generateDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      hex += b.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/**
 * Creates a brand new identity in memory.
 */
export function createIdentity(deviceId?: string): Identity {
  const id = deviceId ?? generateDeviceId();
  const noiseStatic = generateX25519Keypair();
  const hello = generateEd25519Keypair();
  return {
    deviceId: id,
    noiseStaticKeypair: noiseStatic,
    helloKeypair: hello,
    helloPubkeyB64: bytesToBase64(hello.publicKey),
    noisePublicKeyB64: bytesToBase64(noiseStatic.publicKey),
  };
}

/**
 * Loads an existing identity from a file, or generates a new one and persists it.
 *
 * NOTE: This is a file-based store intended for dev and test environments.
 * Production wiring to the OS keychain (e.g. Electron safeStorage or macOS Keychain)
 * is the responsibility of the later ~/Bimax adapter.
 */
export async function loadOrCreateIdentity(filePath: string): Promise<Identity> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const stored = parsed as Partial<StoredIdentity>;
      if (
        typeof stored.deviceId === "string" &&
        typeof stored.noiseStaticPrivateKeyB64 === "string" &&
        typeof stored.noiseStaticPublicKeyB64 === "string" &&
        typeof stored.helloPrivateKeyB64 === "string" &&
        typeof stored.helloPublicKeyB64 === "string"
      ) {
        return {
          deviceId: stored.deviceId,
          noiseStaticKeypair: {
            privateKey: base64ToBytes(stored.noiseStaticPrivateKeyB64),
            publicKey: base64ToBytes(stored.noiseStaticPublicKeyB64),
          },
          helloKeypair: {
            privateKey: base64ToBytes(stored.helloPrivateKeyB64),
            publicKey: base64ToBytes(stored.helloPublicKeyB64),
          },
          helloPubkeyB64: stored.helloPublicKeyB64,
          noisePublicKeyB64: stored.noiseStaticPublicKeyB64,
        };
      }
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const identity = createIdentity();
  const stored: StoredIdentity = {
    deviceId: identity.deviceId,
    noiseStaticPrivateKeyB64: bytesToBase64(identity.noiseStaticKeypair.privateKey),
    noiseStaticPublicKeyB64: identity.noisePublicKeyB64,
    helloPrivateKeyB64: bytesToBase64(identity.helloKeypair.privateKey),
    helloPublicKeyB64: identity.helloPubkeyB64,
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(stored, null, 2), "utf-8");

  return identity;
}
