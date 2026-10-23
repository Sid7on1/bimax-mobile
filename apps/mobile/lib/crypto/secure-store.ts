import { assertPqAdvertisement, decodePqBytes, PQ_PUBLIC_KEY_BYTES } from "@bimax/core/crypto/pq";
import type { PairingPrekey, PairingAdvertisement } from "@bimax/protocol";
import { validateRelayUrl } from "../relay/url";
import { accountStorageKey, requireActiveAccount, isActiveAccount } from "../account-scope";
import * as SecureStore from "expo-secure-store";
import { bytesToBase64, base64ToBytes } from "./base64";
import {
  secureRandomBytes,
  sha256Bytes,
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519GetPublicKey,
  ed25519GetPublicKey,
} from "./keys";

export const BIMAX_X25519_PRIV = "bimax_x25519_priv";
export const BIMAX_ED25519_PRIV = "bimax_ed25519_priv";
export const BIMAX_DEVICE_ID = "bimax_device_id";
export const BIMAX_TRUSTED_DESKTOP = "bimax_trusted_desktop";
let trustedPersistence: Promise<void> = Promise.resolve();

export interface TrustedDesktop {
  deviceId: string;
  staticPublicKeyB64: string;
  relayUrl: string;
  lanRelayUrl?: string;
  lastWorking?: "lan" | "cloud";
  cryptoVersion?: 2;
  /** Public key is an optional in-memory cache; only its compact commitment is persisted. */
  nextPqPrekey?: PairingPrekey;
  nextPqAdvertisement?: PairingAdvertisement;
}

function validateTrustedCrypto(record: TrustedDesktop): void {
  const advertisement = record.nextPqPrekey?.advertisement ?? record.nextPqAdvertisement;
  if (record.cryptoVersion === undefined && advertisement === undefined) return;
  if (record.cryptoVersion !== 2 || !advertisement)
    throw new Error("Invalid PQ trusted desktop record; scan a fresh QR code");
  assertPqAdvertisement(advertisement, 0); // Keep expired trust; reject expiry when using the prekey.
  if (
    advertisement.app !== "bimax" ||
    advertisement.desktopDeviceId !== record.deviceId ||
    advertisement.desktopPublicKey !== record.staticPublicKeyB64
  )
    throw new Error("PQ reconnect identity mismatch");
  if (
    record.nextPqPrekey &&
    bytesToBase64(
      sha256Bytes(decodePqBytes(record.nextPqPrekey.publicKey, PQ_PUBLIC_KEY_BYTES)),
    ) !== advertisement.pqPrekeyHash
  )
    throw new Error("Invalid stored PQ prekey commitment");
}

/**
 * Stores a base64-encoded private key or string identifier in hardware-backed secure storage.
 */
export async function saveDeviceKey(
  name: string,
  privateKeyBase64: string,
  owner = requireActiveAccount(),
): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new Error("saveDeviceKey: invalid key name");
  }
  if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") {
    throw new Error("saveDeviceKey: invalid privateKeyBase64");
  }
  await SecureStore.setItemAsync(accountStorageKey(name, owner), privateKeyBase64, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Loads a base64-encoded private key or string identifier from secure storage, or returns null if not found.
 */
export async function loadDeviceKey(
  name: string,
  owner = requireActiveAccount(),
): Promise<string | null> {
  if (!name || typeof name !== "string") {
    throw new Error("loadDeviceKey: invalid key name");
  }
  return await SecureStore.getItemAsync(accountStorageKey(name, owner));
}

/**
 * Deletes a stored key from secure storage.
 */
export async function deleteDeviceKey(name: string, owner = requireActiveAccount()): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new Error("deleteDeviceKey: invalid key name");
  }
  await SecureStore.deleteItemAsync(accountStorageKey(name, owner));
}

/**
 * Loads the stored device ID or generates a new one, stores it, and returns it.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const owner = requireActiveAccount();
  const existing = await loadDeviceKey(BIMAX_DEVICE_ID, owner);
  if (existing) {
    return existing;
  }
  const newId =
    "m-" + Array.from(secureRandomBytes(16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await saveDeviceKey(BIMAX_DEVICE_ID, newId, owner);
  return newId;
}

/**
 * Loads the existing X25519 private key or generates and stores a new one.
 * Returns the public key as base64.
 */
export async function getOrCreateX25519Keypair(): Promise<{
  publicKeyBase64: string;
}> {
  const owner = requireActiveAccount();
  const existing = await loadDeviceKey(BIMAX_X25519_PRIV, owner);
  if (existing) {
    const privBytes = base64ToBytes(existing);
    const pubBytes = x25519GetPublicKey(privBytes);
    privBytes.fill(0);
    return { publicKeyBase64: bytesToBase64(pubBytes) };
  }

  const kp = generateX25519Keypair();
  await saveDeviceKey(BIMAX_X25519_PRIV, bytesToBase64(kp.privateKey), owner);
  kp.privateKey.fill(0);
  return { publicKeyBase64: bytesToBase64(kp.publicKey) };
}

/**
 * Loads the existing Ed25519 private key or generates and stores a new one.
 * Returns the public key as base64.
 */
export async function getOrCreateEd25519Keypair(): Promise<{
  publicKeyBase64: string;
}> {
  const owner = requireActiveAccount();
  const existing = await loadDeviceKey(BIMAX_ED25519_PRIV, owner);
  if (existing) {
    const privBytes = base64ToBytes(existing);
    const pubBytes = ed25519GetPublicKey(privBytes);
    privBytes.fill(0);
    return { publicKeyBase64: bytesToBase64(pubBytes) };
  }

  const kp = generateEd25519Keypair();
  await saveDeviceKey(BIMAX_ED25519_PRIV, bytesToBase64(kp.privateKey), owner);
  kp.privateKey.fill(0);
  return { publicKeyBase64: bytesToBase64(kp.publicKey) };
}

/**
 * Stores a trusted desktop record as JSON in secure store.
 * Validates that all three fields are non-empty strings.
 */
export async function saveTrustedDesktop(record: TrustedDesktop): Promise<void> {
  if (!record || typeof record !== "object") {
    throw new Error("saveTrustedDesktop: expected object");
  }
  if (
    !record.deviceId ||
    typeof record.deviceId !== "string" ||
    record.deviceId.trim().length === 0
  ) {
    throw new Error("saveTrustedDesktop: missing or invalid deviceId");
  }
  if (
    !record.staticPublicKeyB64 ||
    typeof record.staticPublicKeyB64 !== "string" ||
    record.staticPublicKeyB64.trim().length === 0
  ) {
    throw new Error("saveTrustedDesktop: missing or invalid staticPublicKeyB64");
  }
  if (
    !record.relayUrl ||
    typeof record.relayUrl !== "string" ||
    record.relayUrl.trim().length === 0
  ) {
    throw new Error("saveTrustedDesktop: missing or invalid relayUrl");
  }

  if (record.lanRelayUrl !== undefined && typeof record.lanRelayUrl !== "string") {
    throw new Error("saveTrustedDesktop: invalid lanRelayUrl");
  }
  if (
    record.lastWorking !== undefined &&
    record.lastWorking !== "lan" &&
    record.lastWorking !== "cloud"
  ) {
    throw new Error("saveTrustedDesktop: invalid lastWorking");
  }

  validateTrustedCrypto(record);
  validateRelayUrl(record.relayUrl);
  if (record.lanRelayUrl) validateRelayUrl(record.lanRelayUrl);
  if (base64ToBytes(record.staticPublicKeyB64).length !== 32)
    throw new Error("Invalid trusted desktop key");
  const serialized = JSON.stringify({
    deviceId: record.deviceId,
    staticPublicKeyB64: record.staticPublicKeyB64,
    relayUrl: record.relayUrl,
    lanRelayUrl: record.lanRelayUrl,
    lastWorking: record.lastWorking,
    cryptoVersion: record.cryptoVersion,
    // Public KEM keys are fetched by commitment after restart, avoiding large SecureStore records.
    nextPqAdvertisement: record.nextPqPrekey?.advertisement ?? record.nextPqAdvertisement,
  });
  const owner = requireActiveAccount();
  const pending = trustedPersistence.then(async () => {
    if (!isActiveAccount(owner)) throw new Error("Account changed before saving trusted desktop");
    await saveDeviceKey(BIMAX_TRUSTED_DESKTOP, serialized, owner);
  });
  trustedPersistence = pending.catch(() => {});
  await pending;
}

/**
 * Loads the trusted desktop record from secure store, or returns null if not configured.
 * Throws if the stored data is corrupt JSON or missing required fields.
 */
export async function loadTrustedDesktop(): Promise<TrustedDesktop | null> {
  const raw = await loadDeviceKey(BIMAX_TRUSTED_DESKTOP);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadTrustedDesktop: corrupt JSON in secure store: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("loadTrustedDesktop: invalid trusted desktop record");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.deviceId !== "string" || obj.deviceId.trim().length === 0) {
    throw new Error("loadTrustedDesktop: corrupt record: invalid deviceId");
  }
  if (typeof obj.staticPublicKeyB64 !== "string" || obj.staticPublicKeyB64.trim().length === 0) {
    throw new Error("loadTrustedDesktop: corrupt record: invalid staticPublicKeyB64");
  }
  if (typeof obj.relayUrl !== "string" || obj.relayUrl.trim().length === 0) {
    throw new Error("loadTrustedDesktop: corrupt record: invalid relayUrl");
  }

  const lanRelayUrl =
    typeof obj.lanRelayUrl === "string" && obj.lanRelayUrl.trim().length > 0
      ? obj.lanRelayUrl
      : undefined;
  const lastWorking =
    obj.lastWorking === "lan" || obj.lastWorking === "cloud" ? obj.lastWorking : undefined;

  if (obj.cryptoVersion !== undefined && obj.cryptoVersion !== 2)
    throw new Error("Unsupported trusted crypto version");
  validateRelayUrl(obj.relayUrl);
  if (lanRelayUrl) validateRelayUrl(lanRelayUrl);
  if (base64ToBytes(obj.staticPublicKeyB64).length !== 32)
    throw new Error("Invalid trusted desktop key");
  const record: TrustedDesktop = {
    deviceId: obj.deviceId,
    staticPublicKeyB64: obj.staticPublicKeyB64,
    relayUrl: obj.relayUrl,
    lanRelayUrl,
    lastWorking,
    cryptoVersion: obj.cryptoVersion as 2 | undefined,
    nextPqPrekey: obj.nextPqPrekey as PairingPrekey | undefined,
    nextPqAdvertisement: obj.nextPqAdvertisement as PairingAdvertisement | undefined,
  };
  validateTrustedCrypto(record);
  return record;
}

/**
 * Clears the trusted desktop record from secure store.
 */
export async function clearTrustedDesktop(): Promise<void> {
  const owner = requireActiveAccount();
  const pending = trustedPersistence.then(() => deleteDeviceKey(BIMAX_TRUSTED_DESKTOP, owner));
  trustedPersistence = pending.catch(() => {});
  await pending;
}

/** Remove pre-account-scope device credentials; they cannot be safely attributed to an account. */
export async function removeLegacyDeviceKeys(): Promise<void> {
  for (const key of [
    BIMAX_X25519_PRIV,
    BIMAX_ED25519_PRIV,
    BIMAX_DEVICE_ID,
    BIMAX_TRUSTED_DESKTOP,
    "bimax.x25519.priv",
    "bimax.ed25519.priv",
    "bimax.trusted.desktop",
  ])
    await SecureStore.deleteItemAsync(key);
}
