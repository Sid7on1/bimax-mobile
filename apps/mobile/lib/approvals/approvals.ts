import type {
  ToolApprovalRequest,
  ApprovalDecision,
  ApprovalDecisionValue,
} from "@bimax/protocol";
import { canonicalJson, ed25519Sign, ed25519Verify, sha256Bytes } from "../crypto/keys";
import { bytesToBase64, base64ToBytes } from "../crypto/base64";

const approvalStore = new Map<string, ToolApprovalRequest>();

/**
 * Checks whether an approval request has expired.
 */
export function isExpired(req: ToolApprovalRequest): boolean {
  return Date.now() > req.expiresAt;
}

/**
 * Adds a new approval request to the approvals store.
 * Validates required fields and throws on duplicate approvalId.
 */
export function addApproval(req: ToolApprovalRequest): void {
  if (!req || typeof req !== "object") {
    throw new Error("addApproval: expected object");
  }
  if (
    typeof req.approvalId !== "string" ||
    req.approvalId.trim().length === 0
  ) {
    throw new Error("addApproval: missing or invalid approvalId");
  }
  if (typeof req.sessionId !== "string" || req.sessionId.trim().length === 0) {
    throw new Error("addApproval: missing or invalid sessionId");
  }
  if (typeof req.tool !== "string" || req.tool.trim().length === 0) {
    throw new Error("addApproval: missing or invalid tool");
  }
  if (typeof req.summary !== "string") {
    throw new Error("addApproval: missing or invalid summary");
  }
  if (typeof req.detail !== "string") {
    throw new Error("addApproval: missing or invalid detail");
  }
  if (typeof req.requestedAt !== "number" || !Number.isFinite(req.requestedAt)) {
    throw new Error("addApproval: missing or invalid requestedAt");
  }
  if (typeof req.expiresAt !== "number" || !Number.isFinite(req.expiresAt)) {
    throw new Error("addApproval: missing or invalid expiresAt");
  }

  const existing = approvalStore.get(req.approvalId);
  if (existing && !isExpired(existing)) {
    throw new Error(`addApproval: duplicate approvalId ${req.approvalId}`);
  }

  approvalStore.set(req.approvalId, req);
}

/**
 * Returns all pending approval requests in the store that have not expired,
 * pruning expired entries from the in-memory store.
 */
export function getPending(): ToolApprovalRequest[] {
  const pending: ToolApprovalRequest[] = [];
  for (const [id, req] of approvalStore.entries()) {
    if (isExpired(req)) {
      approvalStore.delete(id);
    } else {
      pending.push(req);
    }
  }
  return pending;
}

/**
 * Removes an approval request from the store by its ID.
 */
export function removeApproval(approvalId: string): void {
  approvalStore.delete(approvalId);
}

/**
 * Clears all approvals from the store (useful for testing).
 */
export function clearApprovals(): void {
  approvalStore.clear();
}

/**
 * Builds an unsigned approval decision object.
 */
export function buildApprovalDecision(
  req: ToolApprovalRequest,
  decision: "approve" | "deny" | ApprovalDecisionValue,
  denyReason?: "not_me" | "mistake",
): Omit<ApprovalDecision, "signature"> {
  let decisionValue: ApprovalDecisionValue;
  if (decision === "approve" || decision === "approved") {
    decisionValue = "approved";
  } else if (decision === "deny" || decision === "denied") {
    decisionValue = "denied";
  } else {
    throw new Error(`buildApprovalDecision: invalid decision ${String(decision)}`);
  }

  const unsigned: Omit<ApprovalDecision, "signature"> = {
    approvalId: req.approvalId,
    sessionId: req.sessionId,
    decision: decisionValue,
    decidedAt: Date.now(),
    requestHash: approvalRequestHash(req),
  };

  if (denyReason) {
    unsigned.denyReason = denyReason;
  }

  return unsigned;
}

/**
 * Computes the request-binding hash for an approval decision:
 * base64 SHA-256 over the canonical JSON bytes of the full request.
 * Both peers produce identical bytes for identical structured data
 * (canonicalJson sorts keys recursively and strips whitespace), so the
 * desktop can recompute this from the request it sent.
 */
export function approvalRequestHash(req: ToolApprovalRequest): string {
  const canonicalBytes = new TextEncoder().encode(canonicalJson(req));
  return bytesToBase64(sha256Bytes(canonicalBytes));
}

/**
 * Checks that a decision's requestHash matches the given request.
 * Returns false (does not throw) on malformed input. This does NOT check
 * the signature — callers must ALSO call verifyApprovalDecision. A decision
 * is only trustworthy when BOTH pass.
 */
export function verifyDecisionBinding(
  dec: ApprovalDecision,
  req: ToolApprovalRequest,
): boolean {
  try {
    if (!dec || typeof dec !== "object") return false;
    if (typeof dec.requestHash !== "string" || dec.requestHash.length === 0) {
      return false;
    }
    if (!req || typeof req !== "object") return false;
    return dec.requestHash === approvalRequestHash(req);
  } catch {
    return false;
  }
}

/**
 * Signs an unsigned approval decision with an Ed25519 private key over its canonical JSON bytes.
 */
export function signApprovalDecision(
  unsigned: Omit<ApprovalDecision, "signature">,
  ed25519PrivateKey: Uint8Array,
): ApprovalDecision {
  const jsonStr = canonicalJson(unsigned);
  const canonicalBytes = new TextEncoder().encode(jsonStr);
  const signatureBytes = ed25519Sign(ed25519PrivateKey, canonicalBytes);
  return {
    ...unsigned,
    signature: bytesToBase64(signatureBytes),
  };
}

/**
 * Verifies an approval decision's signature against an Ed25519 public key.
 * Returns false (does not throw) on any malformed input or verification failure.
 * NOTE: this checks the signature only. It does NOT check that the decision
 * was made for a particular request — call verifyDecisionBinding(dec, req)
 * with the request the user saw, and require BOTH to pass.
 */
export function verifyApprovalDecision(
  dec: ApprovalDecision,
  publicKey: Uint8Array,
): boolean {
  try {
    if (!dec || typeof dec !== "object") return false;
    if (typeof dec.signature !== "string" || dec.signature.length === 0) {
      return false;
    }
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
      return false;
    }

    const { signature, ...unsigned } = dec;
    const sigBytes = base64ToBytes(signature);
    if (sigBytes.length !== 64) {
      return false;
    }

    const jsonStr = canonicalJson(unsigned);
    const canonicalBytes = new TextEncoder().encode(jsonStr);
    return ed25519Verify(publicKey, canonicalBytes, sigBytes);
  } catch {
    return false;
  }
}

export interface DecideWithBiometricOptions {
  requestBiometric: () => Promise<boolean>;
  build: () => Omit<ApprovalDecision, "signature">;
  sign: (unsigned: Omit<ApprovalDecision, "signature">) => ApprovalDecision;
  onDecision: (dec: ApprovalDecision) => Promise<void>;
  onDenied: (reason: string) => void;
}

/**
 * Injected biometric gate for approving or denying decisions.
 * Only executes signing when requestBiometric resolves to true.
 */
export async function decideWithBiometric(
  opts: DecideWithBiometricOptions,
): Promise<void> {
  const allowed = await opts.requestBiometric();
  if (!allowed) {
    opts.onDenied("biometric-failed");
    return;
  }

  const unsigned = opts.build();
  const signed = opts.sign(unsigned);
  await opts.onDecision(signed);
}
