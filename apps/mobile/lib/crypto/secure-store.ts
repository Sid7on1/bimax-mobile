import * as SecureStore from "expo-secure-store";
import { bytesToBase64, base64ToBytes } from "./base64";
import {
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519GetPublicKey,
  ed25519GetPublicKey,
} from "./keys";

export const BIMAX_X25519_PRIV = "bimax_x25519_priv";
export const BIMAX_ED25519_PRIV = "bimax_ed25519_priv";
export const BIMAX_DEVICE_ID = "bimax_device_id";
export const BIMAX_TRUSTED_DESKTOP = "bimax_trusted_desktop";

export interface TrustedDesktop {
  deviceId: string;
  staticPublicKeyB64: string;
  relayUrl: string;
  lanRelayUrl?: string;
  lastWorking?: "lan" | "cloud";
}

/**
 * Stores a base64-encoded private key or string identifier in hardware-backed secure storage.
 */
export async function saveDeviceKey(
  name: string,
  privateKeyBase64: string,
): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new Error("saveDeviceKey: invalid key name");
  }
  if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") {
    throw new Error("saveDeviceKey: invalid privateKeyBase64");
  }
  await SecureStore.setItemAsync(name, privateKeyBase64);
}

/**
 * Loads a base64-encoded private key or string identifier from secure storage, or returns null if not found.
 */
export async function loadDeviceKey(name: string): Promise<string | null> {
  if (!name || typeof name !== "string") {
    throw new Error("loadDeviceKey: invalid key name");
  }
  return await SecureStore.getItemAsync(name);
}

/**
 * Deletes a stored key from secure storage.
 */
export async function deleteDeviceKey(name: string): Promise<void> {
  if (!name || typeof name !== "string") {
    throw new Error("deleteDeviceKey: invalid key name");
  }
  await SecureStore.deleteItemAsync(name);
}

/**
 * Loads the stored device ID or generates a new one, stores it, and returns it.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await loadDeviceKey(BIMAX_DEVICE_ID);
  if (existing) {
    return existing;
  }
  const newId =
    "m-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await saveDeviceKey(BIMAX_DEVICE_ID, newId);
  return newId;
}

/**
 * Loads the existing X25519 private key or generates and stores a new one.
 * Returns the public key as base64.
 */
export async function getOrCreateX25519Keypair(): Promise<{
  publicKeyBase64: string;
}> {
  const existing = await loadDeviceKey(BIMAX_X25519_PRIV);
  if (existing) {
    const privBytes = base64ToBytes(existing);
    const pubBytes = x25519GetPublicKey(privBytes);
    return { publicKeyBase64: bytesToBase64(pubBytes) };
  }

  const kp = generateX25519Keypair();
  await saveDeviceKey(BIMAX_X25519_PRIV, bytesToBase64(kp.privateKey));
  return { publicKeyBase64: bytesToBase64(kp.publicKey) };
}

/**
 * Loads the existing Ed25519 private key or generates and stores a new one.
 * Returns the public key as base64.
 */
export async function getOrCreateEd25519Keypair(): Promise<{
  publicKeyBase64: string;
}> {
  const existing = await loadDeviceKey(BIMAX_ED25519_PRIV);
  if (existing) {
    const privBytes = base64ToBytes(existing);
    const pubBytes = ed25519GetPublicKey(privBytes);
    return { publicKeyBase64: bytesToBase64(pubBytes) };
  }

  const kp = generateEd25519Keypair();
  await saveDeviceKey(BIMAX_ED25519_PRIV, bytesToBase64(kp.privateKey));
  return { publicKeyBase64: bytesToBase64(kp.publicKey) };
}

/**
 * Stores a trusted desktop record as JSON in secure store.
 * Validates that all three fields are non-empty strings.
 */
export async function saveTrustedDesktop(
  record: TrustedDesktop,
): Promise<void> {
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

  if (
    record.lanRelayUrl !== undefined &&
    typeof record.lanRelayUrl !== "string"
  ) {
    throw new Error("saveTrustedDesktop: invalid lanRelayUrl");
  }
  if (
    record.lastWorking !== undefined &&
    record.lastWorking !== "lan" &&
    record.lastWorking !== "cloud"
  ) {
    throw new Error("saveTrustedDesktop: invalid lastWorking");
  }

  const serialized = JSON.stringify({
    deviceId: record.deviceId,
    staticPublicKeyB64: record.staticPublicKeyB64,
    relayUrl: record.relayUrl,
    lanRelayUrl: record.lanRelayUrl,
    lastWorking: record.lastWorking,
  });
  await saveDeviceKey(BIMAX_TRUSTED_DESKTOP, serialized);
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
  if (
    typeof obj.staticPublicKeyB64 !== "string" ||
    obj.staticPublicKeyB64.trim().length === 0
  ) {
    throw new Error(
      "loadTrustedDesktop: corrupt record: invalid staticPublicKeyB64",
    );
  }
  if (typeof obj.relayUrl !== "string" || obj.relayUrl.trim().length === 0) {
    throw new Error("loadTrustedDesktop: corrupt record: invalid relayUrl");
  }

  const lanRelayUrl =
    typeof obj.lanRelayUrl === "string" && obj.lanRelayUrl.trim().length > 0
      ? obj.lanRelayUrl
      : undefined;
  const lastWorking =
    obj.lastWorking === "lan" || obj.lastWorking === "cloud"
      ? obj.lastWorking
      : undefined;

  return {
    deviceId: obj.deviceId,
    staticPublicKeyB64: obj.staticPublicKeyB64,
    relayUrl: obj.relayUrl,
    lanRelayUrl,
    lastWorking,
  };
}

/**
 * Clears the trusted desktop record from secure store.
 */
export async function clearTrustedDesktop(): Promise<void> {
  await deleteDeviceKey(BIMAX_TRUSTED_DESKTOP);
}
