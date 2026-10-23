/** @deprecated Import from "@bimax/core/crypto/keys" directly. */
export {
  configureRandomBytes,
  secureRandomBytes,
  type KeyPair,
  generateX25519Keypair,
  generateEd25519Keypair,
  x25519GetPublicKey,
  ed25519GetPublicKey,
  x25519SharedSecret,
  hkdfSha256,
  sha256Bytes,
  chachaEncrypt,
  chachaDecrypt,
  ed25519Sign,
  ed25519Verify,
  canonicalJson,
  randomId,
} from "@bimax/core/crypto/keys";
