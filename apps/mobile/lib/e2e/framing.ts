import type { MessageKind } from "@bimax/protocol";
import type { EstablishedSession } from "../session/session";
import { canonicalJson } from "../crypto/keys";
import { bytesToBase64, base64ToBytes } from "../crypto/base64";

export interface SealedFrame {
  fver: 1;
  innerKind: MessageKind; // never "encrypted"
  seq: number; // sender's per-peer monotonic counter, starts at 0
  body: unknown; // the original payload
  bound: { id: string; from: string; to: string }; // must equal the outer headers
}

export interface E2EState {
  sendSeq: number;
  recvHighestSeq: number;
  seenIds: Set<string>;
}

export function newE2EState(): E2EState {
  return {
    sendSeq: 0,
    recvHighestSeq: -1,
    seenIds: new Set<string>(),
  };
}

export function seal(
  session: EstablishedSession,
  state: E2EState,
  innerKind: MessageKind,
  body: unknown,
  outer: { id: string; from: string; to: string },
): string {
  if (innerKind === "encrypted") {
    throw new Error("seal: innerKind must not be 'encrypted'");
  }
  if (!outer || typeof outer !== "object") {
    throw new Error("seal: outer headers required");
  }
  if (typeof outer.id !== "string" || !outer.id) {
    throw new Error("seal: outer.id must be a non-empty string");
  }
  if (typeof outer.from !== "string" || !outer.from) {
    throw new Error("seal: outer.from must be a non-empty string");
  }
  if (typeof outer.to !== "string" || !outer.to) {
    throw new Error("seal: outer.to must be a non-empty string");
  }

  const frame: SealedFrame = {
    fver: 1,
    innerKind,
    seq: state.sendSeq,
    body,
    bound: {
      id: outer.id,
      from: outer.from,
      to: outer.to,
    },
  };

  const jsonStr = canonicalJson(frame);
  const plaintext = new TextEncoder().encode(jsonStr);
  const ciphertext = session.encrypt(plaintext);

  state.sendSeq += 1;

  return bytesToBase64(ciphertext);
}

export type OpenResult =
  | { duplicate: true }
  | { duplicate: false; innerKind: MessageKind; body: unknown };

const MAX_SEEN_IDS = 2000;

function recordSeenId(state: E2EState, id: string): void {
  state.seenIds.add(id);
  if (state.seenIds.size > MAX_SEEN_IDS) {
    const oldest = state.seenIds.values().next().value;
    if (oldest !== undefined) {
      state.seenIds.delete(oldest);
    }
  }
}

export function open(
  session: EstablishedSession,
  state: E2EState,
  outer: { id: string; from: string; to: string; kind: string; ciphertextB64: string },
): OpenResult {
  if (!outer || typeof outer !== "object") {
    throw new Error("open: outer headers required");
  }
  if (typeof outer.id !== "string" || !outer.id) {
    throw new Error("open: outer.id must be a non-empty string");
  }

  // (1) If state.seenIds.has(outer.id) return {duplicate:true} BEFORE any decrypt
  if (state.seenIds.has(outer.id)) {
    return { duplicate: true };
  }

  // (2) base64-decode, session.decrypt (throws on tamper — propagate)
  if (typeof outer.ciphertextB64 !== "string") {
    throw new Error("open: outer.ciphertextB64 must be a string");
  }
  const ciphertext = base64ToBytes(outer.ciphertextB64);
  const plaintext = session.decrypt(ciphertext);

  // (3) JSON-parse and validate
  const jsonStr = new TextDecoder().decode(plaintext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `open: failed to parse decrypted JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("open: decrypted frame must be an object");
  }

  const frame = parsed as Record<string, unknown>;
  if (frame.fver !== 1) {
    throw new Error(`open: unsupported frame version ${String(frame.fver)}`);
  }
  if (typeof frame.innerKind !== "string" || frame.innerKind === "encrypted") {
    throw new Error(`open: invalid innerKind '${String(frame.innerKind)}'`);
  }
  if (typeof frame.seq !== "number" || !Number.isFinite(frame.seq)) {
    throw new Error(`open: invalid seq '${String(frame.seq)}'`);
  }
  if (!frame.bound || typeof frame.bound !== "object" || Array.isArray(frame.bound)) {
    throw new Error("open: missing or invalid bound headers");
  }

  const bound = frame.bound as Record<string, unknown>;
  if (
    bound.id !== outer.id ||
    bound.from !== outer.from ||
    bound.to !== outer.to
  ) {
    throw new Error(
      `open: bound header mismatch (bound: id=${String(bound.id)}, from=${String(bound.from)}, to=${String(bound.to)}; outer: id=${outer.id}, from=${outer.from}, to=${outer.to})`,
    );
  }

  // (4) if seq <= state.recvHighestSeq throw (replay)
  if (frame.seq <= state.recvHighestSeq) {
    throw new Error(
      `open: replay detected - sequence ${frame.seq} <= highest seen ${state.recvHighestSeq}`,
    );
  }

  // (5) add id to seenIds (with the 2000 cap), set recvHighestSeq = seq, return {duplicate:false, innerKind, body}
  recordSeenId(state, outer.id);
  state.recvHighestSeq = frame.seq;

  return {
    duplicate: false,
    innerKind: frame.innerKind as MessageKind,
    body: frame.body,
  };
}
