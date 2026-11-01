import type { ToolApprovalRequest, ApprovalDecision } from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { canonicalJson, ed25519Verify, sha256Bytes } from "./crypto/keys";
import { bytesToBase64, base64ToBytes } from "./crypto/base64";

export interface SecurityEvent {
  type: string;
  detail: Record<string, unknown>;
  at: number;
}

export interface PendingApprovalRecord {
  request: ToolApprovalRequest;
  storedObject: ToolApprovalRequest;
  expiresAt: number;
  consumed: boolean;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    const b0 = aBytes[i];
    const b1 = bBytes[i];
    if (b0 !== undefined && b1 !== undefined) {
      diff |= b0 ^ b1;
    }
  }
  return diff === 0;
}

export class ApprovalsGate {
  private completed = new Map<string, { fingerprint: string; expiresAt: number }>();
  private pending = new Map<string, PendingApprovalRecord>();
  private enginePort: EnginePort;
  private getPinnedPhoneHelloPubkey: () => string | null;
  private onSecurityEvent?: (event: SecurityEvent) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    enginePort: EnginePort;
    getPinnedPhoneHelloPubkey: () => string | null;
    onSecurityEvent?: (event: SecurityEvent) => void;
    sweepIntervalMs?: number;
  }) {
    this.enginePort = opts.enginePort;
    this.getPinnedPhoneHelloPubkey = opts.getPinnedPhoneHelloPubkey;
    this.onSecurityEvent = opts.onSecurityEvent;

    const interval = opts.sweepIntervalMs ?? 30_000;
    this.sweepTimer = setInterval(() => {
      this.sweepExpired();
    }, interval);
    if (
      this.sweepTimer &&
      typeof (this.sweepTimer as unknown as { unref?: () => void }).unref === "function"
    ) {
      (this.sweepTimer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Registers a new approval request emitted by the engine to be tracked and sent over E2E.
   * Stores the exact object to guarantee byte-for-byte fidelity when hashing.
   */
  public registerRequest(req: ToolApprovalRequest): ToolApprovalRequest {
    const storedObject = Object.freeze(structuredClone(req));
    const existing = this.pending.get(req.approvalId);
    if (existing) {
      if (canonicalJson(existing.storedObject) !== canonicalJson(storedObject))
        throw new Error("Approval capability already belongs to a different request");
      return existing.storedObject;
    }
    if (this.completed.has(req.approvalId)) throw new Error("Approval capability was already consumed");
    this.pending.set(req.approvalId, {
      request: storedObject,
      storedObject,
      expiresAt: req.expiresAt,
      consumed: false,
    });
    return storedObject;
  }

  /**
   * Verification gate for incoming approval decisions per Contract §7.
   * EXACT 5-step order:
   * 1. approvalId matches pending, unexpired, unconsumed request; else ignore.
   * 2. Recompute requestHash over STORED request object with constant-time compare; mismatch => reject.
   * 3. Verify Ed25519 signature against PINNED phoneHelloPubkeyB64; fail => reject.
   * 4. decision.approvalId / sessionId equal stored request's; |now - decidedAt| <= 300_000; else reject.
   * 5. Mark consumed, then call enginePort.resolveApproval.
   *
   * Returns true iff the decision passed all 5 steps and was resolved.
   */
  public handleDecision(decision: ApprovalDecision, now: number = Date.now()): boolean {
    if (!decision || typeof decision !== "object") {
      this.emitSecurity("approval_malformed", { reason: "not an object" }, now);
      return false;
    }

    const { approvalId } = decision;
    const previous = this.completed.get(approvalId);
    if (previous && previous.expiresAt >= now) {
      try {
        return previous.fingerprint === canonicalJson(decision);
      } catch {
        return false;
      }
    }
    if (typeof approvalId !== "string" || !approvalId) {
      this.emitSecurity("approval_malformed", { reason: "missing approvalId" }, now);
      return false;
    }

    // STEP 1: approvalId matches a pending, unexpired, unconsumed request; else ignore.
    const stored = this.pending.get(approvalId);
    if (!stored || stored.consumed || now > stored.expiresAt) {
      this.emitSecurity(
        "approval_unknown_or_expired",
        {
          approvalId,
          found: Boolean(stored),
          consumed: stored?.consumed,
          isExpired: stored ? now > stored.expiresAt : false,
        },
        now,
      );
      return false;
    }

    // STEP 2: Recompute requestHash = base64(SHA-256(UTF-8(canonicalJson(STORED request object))))
    // and compare with decision.requestHash using constant-time compare.
    const canonicalStr = canonicalJson(stored.storedObject);
    const expectedHashBytes = sha256Bytes(new TextEncoder().encode(canonicalStr));
    const expectedHash = bytesToBase64(expectedHashBytes);

    if (
      typeof decision.requestHash !== "string" ||
      !constantTimeEqual(expectedHash, decision.requestHash)
    ) {
      this.emitSecurity(
        "approval_request_hash_mismatch",
        {
          approvalId,
          expectedHash,
          receivedHash: decision.requestHash,
        },
        now,
      );
      return false;
    }

    // STEP 3: Verify the Ed25519 signature over canonicalJson(decision minus "signature")
    // against the PINNED phoneHelloPubkeyB64 from the trusted-phone record — NEVER a key carried in the message.
    const pinnedPubkeyB64 = this.getPinnedPhoneHelloPubkey();
    if (!pinnedPubkeyB64) {
      this.emitSecurity(
        "approval_no_pinned_pubkey",
        { approvalId, detail: "no trusted phone hello pubkey pinned" },
        now,
      );
      return false;
    }

    let pubkeyBytes: Uint8Array;
    try {
      pubkeyBytes = base64ToBytes(pinnedPubkeyB64);
      if (pubkeyBytes.length !== 32) {
        throw new Error("pinned pubkey length is not 32 bytes");
      }
    } catch {
      this.emitSecurity("approval_corrupt_pinned_pubkey", { approvalId, pinnedPubkeyB64 }, now);
      return false;
    }

    if (typeof decision.signature !== "string" || !decision.signature) {
      this.emitSecurity("approval_bad_signature", { approvalId, reason: "missing signature" }, now);
      return false;
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = base64ToBytes(decision.signature);
      if (sigBytes.length !== 64) {
        throw new Error("signature length is not 64 bytes");
      }
    } catch {
      this.emitSecurity(
        "approval_bad_signature",
        { approvalId, reason: "invalid signature bytes" },
        now,
      );
      return false;
    }

    const { signature: _sig, ...unsignedDecision } = decision;
    const unsignedCanonical = canonicalJson(unsignedDecision);
    const unsignedBytes = new TextEncoder().encode(unsignedCanonical);

    const sigValid = ed25519Verify(pubkeyBytes, unsignedBytes, sigBytes);
    if (!sigValid) {
      this.emitSecurity(
        "approval_bad_signature",
        { approvalId, reason: "signature verification failed" },
        now,
      );
      return false;
    }

    // STEP 4: decision.approvalId / sessionId equal stored request's; |now - decidedAt| <= 300_000; else reject.
    if (
      decision.approvalId !== stored.request.approvalId ||
      decision.sessionId !== stored.request.sessionId
    ) {
      this.emitSecurity(
        "approval_id_mismatch",
        {
          approvalId,
          reqSessionId: stored.request.sessionId,
          decSessionId: decision.sessionId,
        },
        now,
      );
      return false;
    }

    if (
      typeof decision.decidedAt !== "number" ||
      !Number.isFinite(decision.decidedAt) ||
      Math.abs(now - decision.decidedAt) > 300_000
    ) {
      this.emitSecurity(
        "approval_skew_rejected",
        {
          approvalId,
          decidedAt: decision.decidedAt,
          now,
          skew: Math.abs(now - decision.decidedAt),
        },
        now,
      );
      return false;
    }

    // STEP 5: Mark consumed (decisions are SINGLE-USE), then call enginePort.resolveApproval.
    stored.consumed = true;
    this.pending.delete(approvalId);

    // If denyReason === "not_me", raise a SECURITY event
    if (decision.denyReason === "not_me") {
      this.emitSecurity("approval_not_me", { approvalId, sessionId: decision.sessionId }, now);
    }

    const verdict = decision.decision === "approved" ? "approved" : "denied";
    this.completed.set(approvalId, {
      fingerprint: canonicalJson(decision),
      expiresAt: now + 300_000,
    });
    while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!);
    this.enginePort.resolveApproval(approvalId, verdict, decision.denyReason);
    return true;
  }

  /**
   * Sweeps expired approvals and auto-resolves them as denied to the engine.
   */
  public sweepExpired(now: number = Date.now()): void {
    for (const [approvalId, rec] of this.pending.entries()) {
      if (!rec.consumed && now > rec.expiresAt) {
        rec.consumed = true;
        this.pending.delete(approvalId);
        this.enginePort.resolveApproval(approvalId, "denied", "mistake");
      }
    }
  }

  /**
   * Cancels pending approvals for a session (e.g. when session is killed).
   */
  public cancelForSession(sessionId?: string): void {
    for (const [approvalId, rec] of this.pending.entries()) {
      if (!rec.consumed && (!sessionId || rec.request.sessionId === sessionId)) {
        rec.consumed = true;
        this.pending.delete(approvalId);
        this.enginePort.resolveApproval(approvalId, "denied", "mistake");
      }
    }
  }

  public getPendingRequests(now = Date.now()): ToolApprovalRequest[] {
    this.sweepExpired(now);
    return [...this.pending.values()]
      .filter((item) => !item.consumed)
      .map((item) => item.storedObject);
  }
  public getPending(approvalId: string): PendingApprovalRecord | undefined {
    return this.pending.get(approvalId);
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.cancelForSession();
    this.pending.clear();
  }

  private emitSecurity(type: string, detail: Record<string, unknown>, at: number): void {
    this.onSecurityEvent?.({ type, detail, at });
  }
}
