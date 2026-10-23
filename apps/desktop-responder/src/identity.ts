import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateX25519Keypair, generateEd25519Keypair, type KeyPair } from "./crypto/keys";
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
    await fs.chmod(filePath, 0o600);
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

  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(stored, null, 2), { encoding: "utf-8", mode: 0o600 });

  return identity;
}

export interface IdentityStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}
export interface IdentityEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}
/** Accepts Electron safeStorage (or an equivalent OS-keychain adapter); no plaintext fallback. */
export function encryptedIdentityStore(
  filePath: string,
  encryption: IdentityEncryption,
): IdentityStore {
  const check = () => {
    if (
      !encryption.isEncryptionAvailable() ||
      encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("OS-backed identity encryption is unavailable");
  };
  return {
    async read() {
      check();
      try {
        return encryption.decryptString(await fs.readFile(filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(value) {
      check();
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.tmp`;
      const handle = await fs.open(temp, "w", 0o600);
      try {
        await handle.writeFile(encryption.encryptString(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, filePath);
    },
  };
}
export async function loadIdentity(store: IdentityStore): Promise<Identity> {
  const value = await store.read();
  if (value) {
    const record = JSON.parse(value) as StoredIdentity;
    const noisePrivate = base64ToBytes(record.noiseStaticPrivateKeyB64),
      helloPrivate = base64ToBytes(record.helloPrivateKeyB64);
    const { x25519GetPublicKey, ed25519GetPublicKey } = await import("./crypto/keys");
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(record.deviceId) ||
      bytesToBase64(x25519GetPublicKey(noisePrivate)) !== record.noiseStaticPublicKeyB64 ||
      bytesToBase64(ed25519GetPublicKey(helloPrivate)) !== record.helloPublicKeyB64
    )
      throw new Error("Corrupt identity store");
    return {
      deviceId: record.deviceId,
      noiseStaticKeypair: {
        privateKey: noisePrivate,
        publicKey: base64ToBytes(record.noiseStaticPublicKeyB64),
      },
      helloKeypair: {
        privateKey: helloPrivate,
        publicKey: base64ToBytes(record.helloPublicKeyB64),
      },
      helloPubkeyB64: record.helloPublicKeyB64,
      noisePublicKeyB64: record.noiseStaticPublicKeyB64,
    };
  }
  const identity = createIdentity();
  await store.write(
    JSON.stringify({
      deviceId: identity.deviceId,
      noiseStaticPrivateKeyB64: bytesToBase64(identity.noiseStaticKeypair.privateKey),
      noiseStaticPublicKeyB64: identity.noisePublicKeyB64,
      helloPrivateKeyB64: bytesToBase64(identity.helloKeypair.privateKey),
      helloPublicKeyB64: identity.helloPubkeyB64,
    }),
  );
  return identity;
}
