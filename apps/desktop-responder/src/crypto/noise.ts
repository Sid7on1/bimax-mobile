import { blake2s } from "@noble/hashes/blake2.js";
import {
  type KeyPair,
  generateX25519Keypair,
  x25519SharedSecret,
  chachaEncrypt,
  chachaDecrypt,
} from "./keys";

const PROTOCOL_NAME = new TextEncoder().encode(
  "Noise_IK_25519_ChaChaPoly_BLAKE2s",
);
const BLAKE2S_BLOCK_SIZE = 64;
const MAX_NONCE = 0xffffffffffffffffn;

/**
 * 12-byte Noise nonce: 4 zero bytes followed by n as 64-bit little-endian.
 */
export function nonce12(n: bigint | number): Uint8Array {
  const bigN = typeof n === "bigint" ? n : BigInt(n);
  if (bigN < 0n || bigN > MAX_NONCE) {
    throw new Error("nonce12: nonce out of range");
  }
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  dv.setBigUint64(4, bigN, true); // little-endian
  return nonce;
}

/**
 * HMAC-BLAKE2s using the standard ipad/opad construction over the 64-byte BLAKE2s block size.
 */
export function hmacBlake2s(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLAKE2S_BLOCK_SIZE);
  if (key.length > BLAKE2S_BLOCK_SIZE) {
    k.set(blake2s(key));
  } else {
    k.set(key);
  }

  const ipad = new Uint8Array(BLAKE2S_BLOCK_SIZE);
  const opad = new Uint8Array(BLAKE2S_BLOCK_SIZE);
  for (let i = 0; i < BLAKE2S_BLOCK_SIZE; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }

  const innerInput = new Uint8Array(BLAKE2S_BLOCK_SIZE + data.length);
  innerInput.set(ipad, 0);
  innerInput.set(data, BLAKE2S_BLOCK_SIZE);
  const inner = blake2s(innerInput);

  const outerInput = new Uint8Array(BLAKE2S_BLOCK_SIZE + inner.length);
  outerInput.set(opad, 0);
  outerInput.set(inner, BLAKE2S_BLOCK_SIZE);
  return blake2s(outerInput);
}

/**
 * HKDF using HMAC-BLAKE2s per the Noise Protocol Framework specification (RFC 5869).
 */
export function hkdfBlake2s(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 2 | 3,
): Uint8Array[] {
  const tempKey = hmacBlake2s(chainingKey, inputKeyMaterial);

  const out1 = hmacBlake2s(tempKey, new Uint8Array([0x01]));

  const in2 = new Uint8Array(out1.length + 1);
  in2.set(out1, 0);
  in2[out1.length] = 0x02;
  const out2 = hmacBlake2s(tempKey, in2);

  if (numOutputs === 2) {
    return [out1, out2];
  }

  const in3 = new Uint8Array(out2.length + 1);
  in3.set(out2, 0);
  in3[out2.length] = 0x03;
  const out3 = hmacBlake2s(tempKey, in3);

  return [out1, out2, out3];
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface NoiseIKInitiatorOptions {
  staticKeypair: KeyPair;
  remoteStaticPublicKey: Uint8Array;
  ephemeralKeypair?: KeyPair; // test-only
  prologue?: Uint8Array;
}

export class NoiseIKInitiator {
  private opts: NoiseIKInitiatorOptions;
  private stage: "uninitialized" | "sent_msg1" | "complete" = "uninitialized";
  private h: Uint8Array = new Uint8Array(32);
  private ck: Uint8Array = new Uint8Array(32);
  private k: Uint8Array | null = null;
  private n: bigint = 0n;
  private e: KeyPair | null = null;

  private sendCipherKey: Uint8Array | null = null;
  private sendNonce: bigint = 0n;
  private recvCipherKey: Uint8Array | null = null;
  private recvNonce: bigint = 0n;
  private handshakeHash: Uint8Array | null = null;

  constructor(opts: NoiseIKInitiatorOptions) {
    if (
      !(opts.staticKeypair.privateKey instanceof Uint8Array) ||
      opts.staticKeypair.privateKey.length !== 32
    ) {
      throw new Error("NoiseIKInitiator: staticKeypair.privateKey must be 32 bytes");
    }
    if (
      !(opts.staticKeypair.publicKey instanceof Uint8Array) ||
      opts.staticKeypair.publicKey.length !== 32
    ) {
      throw new Error("NoiseIKInitiator: staticKeypair.publicKey must be 32 bytes");
    }
    if (
      !(opts.remoteStaticPublicKey instanceof Uint8Array) ||
      opts.remoteStaticPublicKey.length !== 32
    ) {
      throw new Error("NoiseIKInitiator: remoteStaticPublicKey must be 32 bytes");
    }
    if (opts.ephemeralKeypair) {
      if (
        !(opts.ephemeralKeypair.privateKey instanceof Uint8Array) ||
        opts.ephemeralKeypair.privateKey.length !== 32 ||
        !(opts.ephemeralKeypair.publicKey instanceof Uint8Array) ||
        opts.ephemeralKeypair.publicKey.length !== 32
      ) {
        throw new Error("NoiseIKInitiator: invalid ephemeralKeypair");
      }
    }
    this.opts = opts;
  }

  private initializeSymmetric(): void {
    // PROTOCOL_NAME is 34 bytes (> HASHLEN 32), so h = BLAKE2s(PROTOCOL_NAME)
    this.h = blake2s(PROTOCOL_NAME);
    this.ck = new Uint8Array(this.h);
    this.k = null;
    this.n = 0n;
  }

  private mixHash(data: Uint8Array): void {
    const buf = new Uint8Array(this.h.length + data.length);
    buf.set(this.h, 0);
    buf.set(data, this.h.length);
    this.h = blake2s(buf);
  }

  private mixKey(input: Uint8Array): void {
    const [newCk, tempK] = hkdfBlake2s(this.ck, input, 2);
    this.ck = newCk;
    this.k = tempK;
    this.n = 0n;
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    let ct: Uint8Array;
    if (this.k === null) {
      ct = plaintext;
    } else {
      ct = chachaEncrypt(this.k, nonce12(this.n), plaintext, this.h);
      this.n++;
    }
    this.mixHash(ct);
    return ct;
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    let pt: Uint8Array;
    if (this.k === null) {
      pt = ciphertext;
    } else {
      // Throws on auth failure before modifying n or h
      pt = chachaDecrypt(this.k, nonce12(this.n), ciphertext, this.h);
      this.n++;
    }
    this.mixHash(ciphertext);
    return pt;
  }

  private split(): [Uint8Array, Uint8Array] {
    const [c1, c2] = hkdfBlake2s(this.ck, new Uint8Array(0), 2);
    return [c1, c2];
  }

  writeMessage1(payload: Uint8Array): Uint8Array {
    if (this.stage !== "uninitialized") {
      throw new Error("NoiseIKInitiator: writeMessage1 already called");
    }
    if (!(payload instanceof Uint8Array)) {
      throw new Error("NoiseIKInitiator: payload must be a Uint8Array");
    }

    this.initializeSymmetric();
    if (this.opts.prologue && this.opts.prologue.length > 0) {
      this.mixHash(this.opts.prologue);
    }
    this.mixHash(this.opts.remoteStaticPublicKey);

    this.e = this.opts.ephemeralKeypair ?? generateX25519Keypair();
    this.mixHash(this.e.publicKey);
    const msgE = this.e.publicKey;

    const dh_es = x25519SharedSecret(
      this.e.privateKey,
      this.opts.remoteStaticPublicKey,
    );
    this.mixKey(dh_es);

    const msgS = this.encryptAndHash(this.opts.staticKeypair.publicKey);

    const dh_ss = x25519SharedSecret(
      this.opts.staticKeypair.privateKey,
      this.opts.remoteStaticPublicKey,
    );
    this.mixKey(dh_ss);

    const msgPayload = this.encryptAndHash(payload);

    this.stage = "sent_msg1";
    return concat(concat(msgE, msgS), msgPayload);
  }

  readMessage2(message: Uint8Array): Uint8Array {
    if (this.stage !== "sent_msg1") {
      throw new Error("NoiseIKInitiator: readMessage2 invalid state");
    }
    if (!(message instanceof Uint8Array) || message.length < 48) {
      throw new Error("NoiseIKInitiator: readMessage2 message too short");
    }
    if (!this.e) {
      throw new Error("NoiseIKInitiator: missing ephemeral keypair");
    }

    const e_r_pub = message.slice(0, 32);
    this.mixHash(e_r_pub);

    const dh_ee = x25519SharedSecret(this.e.privateKey, e_r_pub);
    this.mixKey(dh_ee);

    const dh_se = x25519SharedSecret(
      this.opts.staticKeypair.privateKey,
      e_r_pub,
    );
    this.mixKey(dh_se);

    const ctPayload = message.slice(32);
    const ptPayload = this.decryptAndHash(ctPayload);

    const [tempK1, tempK2] = this.split();
    this.sendCipherKey = tempK1;
    this.sendNonce = 0n;
    this.recvCipherKey = tempK2;
    this.recvNonce = 0n;
    this.handshakeHash = new Uint8Array(this.h);
    this.stage = "complete";

    return ptPayload;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.stage !== "complete" || !this.sendCipherKey) {
      throw new Error("NoiseIKInitiator: handshake not complete");
    }
    if (!(plaintext instanceof Uint8Array)) {
      throw new Error("NoiseIKInitiator: plaintext must be a Uint8Array");
    }
    if (this.sendNonce >= MAX_NONCE) {
      throw new Error("NoiseIKInitiator: nonce exhaustion");
    }

    const ct = chachaEncrypt(
      this.sendCipherKey,
      nonce12(this.sendNonce),
      plaintext,
    );
    this.sendNonce++;
    return ct;
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.stage !== "complete" || !this.recvCipherKey) {
      throw new Error("NoiseIKInitiator: handshake not complete");
    }
    if (!(ciphertext instanceof Uint8Array)) {
      throw new Error("NoiseIKInitiator: ciphertext must be a Uint8Array");
    }
    if (this.recvNonce >= MAX_NONCE) {
      throw new Error("NoiseIKInitiator: nonce exhaustion");
    }

    const pt = chachaDecrypt(
      this.recvCipherKey,
      nonce12(this.recvNonce),
      ciphertext,
    );
    this.recvNonce++;
    return pt;
  }

  getHandshakeHash(): Uint8Array {
    if (this.stage !== "complete" || !this.handshakeHash) {
      throw new Error("NoiseIKInitiator: handshake not complete");
    }
    return new Uint8Array(this.handshakeHash);
  }
}

export interface NoiseIKResponderOptions {
  staticKeypair: KeyPair;
  ephemeralKeypair?: KeyPair; // test-only
  prologue?: Uint8Array;
}

export class NoiseIKResponder {
  private opts: NoiseIKResponderOptions;
  private stage: "uninitialized" | "read_msg1" | "complete" = "uninitialized";
  private h: Uint8Array = new Uint8Array(32);
  private ck: Uint8Array = new Uint8Array(32);
  private k: Uint8Array | null = null;
  private n: bigint = 0n;

  private e_i_pub: Uint8Array | null = null;
  private s_i_pub: Uint8Array | null = null;

  private sendCipherKey: Uint8Array | null = null;
  private sendNonce: bigint = 0n;
  private recvCipherKey: Uint8Array | null = null;
  private recvNonce: bigint = 0n;
  private handshakeHash: Uint8Array | null = null;

  constructor(opts: NoiseIKResponderOptions) {
    if (
      !(opts.staticKeypair.privateKey instanceof Uint8Array) ||
      opts.staticKeypair.privateKey.length !== 32
    ) {
      throw new Error("NoiseIKResponder: staticKeypair.privateKey must be 32 bytes");
    }
    if (
      !(opts.staticKeypair.publicKey instanceof Uint8Array) ||
      opts.staticKeypair.publicKey.length !== 32
    ) {
      throw new Error("NoiseIKResponder: staticKeypair.publicKey must be 32 bytes");
    }
    if (opts.ephemeralKeypair) {
      if (
        !(opts.ephemeralKeypair.privateKey instanceof Uint8Array) ||
        opts.ephemeralKeypair.privateKey.length !== 32 ||
        !(opts.ephemeralKeypair.publicKey instanceof Uint8Array) ||
        opts.ephemeralKeypair.publicKey.length !== 32
      ) {
        throw new Error("NoiseIKResponder: invalid ephemeralKeypair");
      }
    }
    this.opts = opts;
  }

  private initializeSymmetric(): void {
    this.h = blake2s(PROTOCOL_NAME);
    this.ck = new Uint8Array(this.h);
    this.k = null;
    this.n = 0n;
  }

  private mixHash(data: Uint8Array): void {
    const buf = new Uint8Array(this.h.length + data.length);
    buf.set(this.h, 0);
    buf.set(data, this.h.length);
    this.h = blake2s(buf);
  }

  private mixKey(input: Uint8Array): void {
    const [newCk, tempK] = hkdfBlake2s(this.ck, input, 2);
    this.ck = newCk;
    this.k = tempK;
    this.n = 0n;
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    let ct: Uint8Array;
    if (this.k === null) {
      ct = plaintext;
    } else {
      ct = chachaEncrypt(this.k, nonce12(this.n), plaintext, this.h);
      this.n++;
    }
    this.mixHash(ct);
    return ct;
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    let pt: Uint8Array;
    if (this.k === null) {
      pt = ciphertext;
    } else {
      pt = chachaDecrypt(this.k, nonce12(this.n), ciphertext, this.h);
      this.n++;
    }
    this.mixHash(ciphertext);
    return pt;
  }

  private split(): [Uint8Array, Uint8Array] {
    const [c1, c2] = hkdfBlake2s(this.ck, new Uint8Array(0), 2);
    return [c1, c2];
  }

  readMessage1(message: Uint8Array): {
    payload: Uint8Array;
    remoteStaticPublicKey: Uint8Array;
  } {
    if (this.stage !== "uninitialized") {
      throw new Error("NoiseIKResponder: readMessage1 already called");
    }
    if (!(message instanceof Uint8Array) || message.length < 96) {
      throw new Error("NoiseIKResponder: readMessage1 message too short (min 96 bytes)");
    }

    this.initializeSymmetric();
    if (this.opts.prologue && this.opts.prologue.length > 0) {
      this.mixHash(this.opts.prologue);
    }
    this.mixHash(this.opts.staticKeypair.publicKey);

    this.e_i_pub = message.slice(0, 32);
    this.mixHash(this.e_i_pub);

    const dh_es = x25519SharedSecret(
      this.opts.staticKeypair.privateKey,
      this.e_i_pub,
    );
    this.mixKey(dh_es);

    const encS = message.slice(32, 80);
    this.s_i_pub = this.decryptAndHash(encS);
    if (this.s_i_pub.length !== 32) {
      throw new Error("NoiseIKResponder: invalid initiator static public key length");
    }

    const dh_ss = x25519SharedSecret(
      this.opts.staticKeypair.privateKey,
      this.s_i_pub,
    );
    this.mixKey(dh_ss);

    const encPayload = message.slice(80);
    const payload1 = this.decryptAndHash(encPayload);

    this.stage = "read_msg1";
    return {
      payload: payload1,
      remoteStaticPublicKey: this.s_i_pub,
    };
  }

  writeMessage2(payload: Uint8Array): Uint8Array {
    if (this.stage !== "read_msg1" || !this.e_i_pub || !this.s_i_pub) {
      throw new Error("NoiseIKResponder: writeMessage2 invalid state");
    }
    if (!(payload instanceof Uint8Array)) {
      throw new Error("NoiseIKResponder: payload must be a Uint8Array");
    }

    const e_r = this.opts.ephemeralKeypair ?? generateX25519Keypair();
    this.mixHash(e_r.publicKey);
    const msgE = e_r.publicKey;

    const dh_ee = x25519SharedSecret(e_r.privateKey, this.e_i_pub);
    this.mixKey(dh_ee);

    const dh_se = x25519SharedSecret(e_r.privateKey, this.s_i_pub);
    this.mixKey(dh_se);

    const encPayload = this.encryptAndHash(payload);

    const [tempK1, tempK2] = this.split();
    this.sendCipherKey = tempK2; // responder -> initiator uses c2
    this.sendNonce = 0n;
    this.recvCipherKey = tempK1; // initiator -> responder uses c1
    this.recvNonce = 0n;
    this.handshakeHash = new Uint8Array(this.h);
    this.stage = "complete";

    return concat(msgE, encPayload);
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.stage !== "complete" || !this.sendCipherKey) {
      throw new Error("NoiseIKResponder: handshake not complete");
    }
    if (!(plaintext instanceof Uint8Array)) {
      throw new Error("NoiseIKResponder: plaintext must be a Uint8Array");
    }
    if (this.sendNonce >= MAX_NONCE) {
      throw new Error("NoiseIKResponder: nonce exhaustion");
    }

    const ct = chachaEncrypt(
      this.sendCipherKey,
      nonce12(this.sendNonce),
      plaintext,
    );
    this.sendNonce++;
    return ct;
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.stage !== "complete" || !this.recvCipherKey) {
      throw new Error("NoiseIKResponder: handshake not complete");
    }
    if (!(ciphertext instanceof Uint8Array)) {
      throw new Error("NoiseIKResponder: ciphertext must be a Uint8Array");
    }
    if (this.recvNonce >= MAX_NONCE) {
      throw new Error("NoiseIKResponder: nonce exhaustion");
    }

    const pt = chachaDecrypt(
      this.recvCipherKey,
      nonce12(this.recvNonce),
      ciphertext,
    );
    this.recvNonce++;
    return pt;
  }

  getHandshakeHash(): Uint8Array {
    if (this.stage !== "complete" || !this.handshakeHash) {
      throw new Error("NoiseIKResponder: handshake not complete");
    }
    return new Uint8Array(this.handshakeHash);
  }
}
