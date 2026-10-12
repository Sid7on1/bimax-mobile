import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generates an X25519 keypair for Diffie-Hellman key exchange.
 * Both publicKey and privateKey are 32 bytes.
 */
export function generateX25519Keypair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    privateKey: secretKey,
    publicKey,
  };
}

/**
 * Generates an Ed25519 keypair for digital signatures.
 * Both publicKey and privateKey are 32 bytes.
 */
export function generateEd25519Keypair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    privateKey: secretKey,
    publicKey,
  };
}

/**
 * Derives an X25519 public key from a 32-byte private key.
 */
export function x25519GetPublicKey(privateKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error("x25519GetPublicKey: privateKey must be a 32-byte Uint8Array");
  }
  return x25519.getPublicKey(privateKey);
}

/**
 * Derives an Ed25519 public key from a 32-byte private key.
 */
export function ed25519GetPublicKey(privateKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error("ed25519GetPublicKey: privateKey must be a 32-byte Uint8Array");
  }
  return ed25519.getPublicKey(privateKey);
}

/**
 * Computes the 32-byte raw ECDH shared secret using X25519.
 */
export function x25519SharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error("x25519SharedSecret: privateKey must be a 32-byte Uint8Array");
  }
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Error("x25519SharedSecret: publicKey must be a 32-byte Uint8Array");
  }

  const shared = x25519.getSharedSecret(privateKey, publicKey);
  if (shared.length !== 32) {
    throw new Error("x25519SharedSecret: shared secret output must be 32 bytes");
  }
  return shared;
}

/**
 * HKDF-SHA-256 key derivation.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  if (!(ikm instanceof Uint8Array)) {
    throw new Error("hkdfSha256: ikm must be a Uint8Array");
  }
  if (!(salt instanceof Uint8Array)) {
    throw new Error("hkdfSha256: salt must be a Uint8Array");
  }
  if (!(info instanceof Uint8Array)) {
    throw new Error("hkdfSha256: info must be a Uint8Array");
  }
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0) {
    throw new Error("hkdfSha256: length must be a positive integer");
  }

  return hkdf(sha256, ikm, salt, info, length);
}

/**
 * ChaCha20-Poly1305 AEAD encryption.
 * Key must be 32 bytes; nonce must be 12 bytes.
 */
export function chachaEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("chachaEncrypt: key must be a 32-byte Uint8Array");
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) {
    throw new Error("chachaEncrypt: nonce must be a 12-byte Uint8Array");
  }
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error("chachaEncrypt: plaintext must be a Uint8Array");
  }
  if (aad !== undefined && !(aad instanceof Uint8Array)) {
    throw new Error("chachaEncrypt: aad must be a Uint8Array if provided");
  }

  const cipher = chacha20poly1305(key, nonce, aad);
  return cipher.encrypt(plaintext);
}

/**
 * ChaCha20-Poly1305 AEAD decryption.
 * Key must be 32 bytes; nonce must be 12 bytes.
 * Throws Error on authentication failure and never returns partial plaintext.
 */
export function chachaDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("chachaDecrypt: key must be a 32-byte Uint8Array");
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) {
    throw new Error("chachaDecrypt: nonce must be a 12-byte Uint8Array");
  }
  if (!(ciphertext instanceof Uint8Array)) {
    throw new Error("chachaDecrypt: ciphertext must be a Uint8Array");
  }
  if (ciphertext.length < 16) {
    throw new Error("chachaDecrypt: ciphertext must be at least 16 bytes (Poly1305 tag)");
  }
  if (aad !== undefined && !(aad instanceof Uint8Array)) {
    throw new Error("chachaDecrypt: aad must be a Uint8Array if provided");
  }

  try {
    const cipher = chacha20poly1305(key, nonce, aad);
    return cipher.decrypt(ciphertext);
  } catch (err) {
    throw new Error(
      `chachaDecrypt: authentication failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Ed25519 digital signature generation.
 * privateKey must be 32 bytes.
 * Returns 64-byte signature.
 */
export function ed25519Sign(
  privateKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error("ed25519Sign: privateKey must be a 32-byte Uint8Array");
  }
  if (!(message instanceof Uint8Array)) {
    throw new Error("ed25519Sign: message must be a Uint8Array");
  }

  return ed25519.sign(message, privateKey);
}

/**
 * Ed25519 digital signature verification.
 * publicKey must be 32 bytes; signature must be 64 bytes.
 */
export function ed25519Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Error("ed25519Verify: publicKey must be a 32-byte Uint8Array");
  }
  if (!(message instanceof Uint8Array)) {
    throw new Error("ed25519Verify: message must be a Uint8Array");
  }
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("ed25519Verify: signature must be a 64-byte Uint8Array");
  }

  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Deterministic canonical JSON: recursively sorts object keys, removes all whitespace.
 * Both sides produce identical bytes for identical structured data.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalJson: cannot serialize undefined");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];

  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
      entries.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
    }
  }

  return `{${entries.join(",")}}`;
}
