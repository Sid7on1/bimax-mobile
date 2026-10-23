import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { loadDeviceKey, saveDeviceKey } from "./crypto/secure-store";
import { secureRandomBytes } from "./crypto/keys";
import { bytesToBase64, base64ToBytes } from "./crypto/base64";

const creating = new Map<string, Promise<string>>();
export async function withStorageKey<T>(
  owner: string,
  fn: (key: Uint8Array) => Promise<T>,
  allowCreate = false,
): Promise<T> {
  let pending = creating.get(owner);
  if (!pending) {
    pending = (async () => {
      const saved = await loadDeviceKey("storage_key_v2", owner);
      if (saved) return saved;
      if (!allowCreate)
        throw new Error("Storage key unavailable; existing encrypted data was preserved");
      const key = secureRandomBytes(32);
      try {
        const value = bytesToBase64(key);
        await saveDeviceKey("storage_key_v2", value, owner);
        return value;
      } finally {
        key.fill(0);
      }
    })();
    creating.set(owner, pending);
  }
  let key: Uint8Array | undefined;
  try {
    key = base64ToBytes(await pending);
    return await fn(key);
  } finally {
    key?.fill(0);
    if (creating.get(owner) === pending) creating.delete(owner);
  }
}
export function encryptStored(key: Uint8Array, value: string, context: string): string {
  const nonce = secureRandomBytes(24);
  const plaintext = new TextEncoder().encode(value);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, new TextEncoder().encode(context)).encrypt(
      plaintext,
    );
    const bytes = new Uint8Array(nonce.length + ciphertext.length);
    bytes.set(nonce);
    bytes.set(ciphertext, 24);
    return "enc2:" + bytesToBase64(bytes);
  } finally {
    plaintext.fill(0);
  }
}
export function decryptStored(key: Uint8Array, value: string, context: string): string {
  if (!value.startsWith("enc2:")) throw new Error("Unencrypted storage record");
  const bytes = base64ToBytes(value.slice(5));
  const plaintext = xchacha20poly1305(
    key,
    bytes.subarray(0, 24),
    new TextEncoder().encode(context),
  ).decrypt(bytes.subarray(24));
  try {
    return new TextDecoder().decode(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
