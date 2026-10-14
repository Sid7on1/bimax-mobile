# Bimax Mobile — Protocol v1.6: bind approval decisions to the exact request content

Copy everything below the line into Antigravity as one prompt.

---

Background: an `ApprovalDecision` signature today covers only `{approvalId, sessionId, decision, decidedAt, denyReason?}`. It does NOT commit to the request content the user actually saw (`tool`, `summary`, `detail`, `cwd`). That means a signed "approved" is not self-contained evidence of WHAT was approved: a buggy or malicious desktop can display request A ("Run npm test"), collect the approval, and execute request B ("rm -rf /") under the same `approvalId` — and nothing cryptographic catches the swap.

Fix (protocol v1.6, additive — same convention as v1.1–v1.5, no `PROTOCOL_VERSION` bump): every signed decision carries `requestHash`, the base64 SHA-256 over the canonical JSON bytes of the full `ToolApprovalRequest` the user saw. The signature automatically covers it (it signs the whole unsigned object minus `signature`). The desktop MUST recompute the hash from the request it holds and reject on mismatch BEFORE acting — that check lands in the desktop contract prompt later; this prompt only puts the commitment on the wire.

## Change 1 — `packages/protocol/src/index.ts`: v1.6 changelog + `requestHash`

(a) Changelog — add the v1.6 entry above the v1.5 entry:

OLD:
```
 * v1.5 (2026-10-13, additive): authenticated DeviceHello (helloPubkey, helloSignature)
```
NEW:
```
 * v1.6 (2026-10-13, additive): ApprovalDecision gains required `requestHash`
 * (base64 SHA-256 over the canonical JSON bytes of the ToolApprovalRequest
 * the user saw), binding the signed decision to the exact request content.
 *
 * v1.5 (2026-10-13, additive): authenticated DeviceHello (helloPubkey, helloSignature)
```

(b) The decision type:

OLD:
```ts
export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecisionValue;
  decidedAt: number;
  denyReason?: "not_me" | "mistake"; // "not_me" raises a security alert
  signature: string; // base64 Ed25519 over canonical bytes; desktop verifies
}
```
NEW:
```ts
export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecisionValue;
  decidedAt: number;
  denyReason?: "not_me" | "mistake"; // "not_me" raises a security alert
  requestHash: string; // base64 SHA-256 over the canonical JSON bytes of the
                       // ToolApprovalRequest the user saw; the desktop MUST
                       // recompute it from its stored request and reject on
                       // mismatch BEFORE acting on the decision
  signature: string; // base64 Ed25519 over canonical bytes of everything above; desktop verifies
}
```

## Change 2 — `apps/mobile/lib/crypto/keys.ts`: export a `sha256Bytes` helper

Insert after the `hkdfSha256` function, before the ChaCha20 comment block:

OLD:
```ts
  return hkdf(sha256, ikm, salt, info, length);
}

/**
 * ChaCha20-Poly1305 AEAD encryption.
```
NEW:
```ts
  return hkdf(sha256, ikm, salt, info, length);
}

/**
 * SHA-256 digest. Returns the raw 32-byte digest.
 */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new Error("sha256Bytes: data must be a Uint8Array");
  }
  return sha256(data);
}

/**
 * ChaCha20-Poly1305 AEAD encryption.
```

## Change 3 — `apps/mobile/lib/approvals/approvals.ts`: compute, expose, and document the binding

(a) Extend the keys import:

OLD:
```ts
import { canonicalJson, ed25519Sign, ed25519Verify } from "../crypto/keys";
```
NEW:
```ts
import { canonicalJson, ed25519Sign, ed25519Verify, sha256Bytes } from "../crypto/keys";
```

(b) In `buildApprovalDecision`, bind the request:

OLD:
```ts
  const unsigned: Omit<ApprovalDecision, "signature"> = {
    approvalId: req.approvalId,
    sessionId: req.sessionId,
    decision: decisionValue,
    decidedAt: Date.now(),
  };
```
NEW:
```ts
  const unsigned: Omit<ApprovalDecision, "signature"> = {
    approvalId: req.approvalId,
    sessionId: req.sessionId,
    decision: decisionValue,
    decidedAt: Date.now(),
    requestHash: approvalRequestHash(req),
  };
```

(c) Add the two helpers immediately AFTER `buildApprovalDecision` (before `signApprovalDecision`):

```ts
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
```

(d) Document the split responsibility on `verifyApprovalDecision` (comment only, no logic change — the signature already covers `requestHash`, so an old-format or tampered hash fails signature verification automatically):

OLD:
```ts
/**
 * Verifies an approval decision's signature against an Ed25519 public key.
 * Returns false (does not throw) on any malformed input or verification failure.
 */
```
NEW:
```ts
/**
 * Verifies an approval decision's signature against an Ed25519 public key.
 * Returns false (does not throw) on any malformed input or verification failure.
 * NOTE: this checks the signature only. It does NOT check that the decision
 * was made for a particular request — call verifyDecisionBinding(dec, req)
 * with the request the user saw, and require BOTH to pass.
 */
```

`apps/mobile/lib/approvals/index.ts` already re-exports everything (`export * from "./approvals"`), so no change needed there. No changes needed in `provider.tsx` — both approve/deny paths already pass the full stored request into `buildApprovalDecision`.

## Change 4 — `apps/mobile/test/approvals-test.mjs`: new STEP 6 (request binding)

(a) Extend the destructured imports from the compiled approvals module:

OLD:
```ts
    buildApprovalDecision,
    signApprovalDecision,
    verifyApprovalDecision,
    decideWithBiometric,
  } = require(path.join(distDir, "approvals", "approvals.js"));
```
NEW:
```ts
    buildApprovalDecision,
    signApprovalDecision,
    verifyApprovalDecision,
    verifyDecisionBinding,
    approvalRequestHash,
    decideWithBiometric,
  } = require(path.join(distDir, "approvals", "approvals.js"));
```

(b) Insert STEP 6 immediately BEFORE the final `console.log("\nALL STEPS PASSED");` line:

```js
  // ==========================================
  // STEP 6 (request binding — protocol v1.6)
  // ==========================================
  console.log("STEP 6 (request binding):");
  try {
    const now = Date.now();
    const reqA = {
      approvalId: "appr-bind-1",
      sessionId: "sess-bind-1",
      tool: "bash",
      summary: "Run npm test",
      detail: "npm test -- --coverage",
      requestedAt: now,
      expiresAt: now + 60000,
    };
    // Same IDs, DIFFERENT command — the swap attack.
    const reqB = {
      ...reqA,
      summary: "Clean temp files",
      detail: "rm -rf /tmp/*",
    };

    const edKeypair = generateEd25519Keypair();
    const unsigned = buildApprovalDecision(reqA, "approve");
    assert.ok(
      typeof unsigned.requestHash === "string" && unsigned.requestHash.length > 0,
      "buildApprovalDecision must set a non-empty requestHash",
    );
    const signed = signApprovalDecision(unsigned, edKeypair.privateKey);

    assert.strictEqual(
      verifyApprovalDecision(signed, edKeypair.publicKey),
      true,
      "signed v1.6 decision must verify",
    );
    assert.strictEqual(
      verifyDecisionBinding(signed, reqA),
      true,
      "binding must hold for the exact request the user saw",
    );
    assert.strictEqual(
      verifyDecisionBinding(signed, reqB),
      false,
      "binding must FAIL for a swapped request with the same approvalId",
    );

    // Canonicalization: key order must not change the hash.
    const reqAShuffled = {
      detail: reqA.detail,
      tool: reqA.tool,
      expiresAt: reqA.expiresAt,
      summary: reqA.summary,
      approvalId: reqA.approvalId,
      requestedAt: reqA.requestedAt,
      sessionId: reqA.sessionId,
    };
    assert.strictEqual(
      approvalRequestHash(reqAShuffled),
      approvalRequestHash(reqA),
      "hash must be stable regardless of key order",
    );

    // Swapping the hash breaks the signature.
    const hashSwapped = { ...signed, requestHash: approvalRequestHash(reqB) };
    assert.strictEqual(
      verifyApprovalDecision(hashSwapped, edKeypair.publicKey),
      false,
      "a decision with a swapped requestHash must fail signature verification",
    );

    // Malformed inputs return false, never throw.
    assert.strictEqual(verifyDecisionBinding({}, reqA), false);
    assert.strictEqual(verifyDecisionBinding(signed, null), false);
    assert.strictEqual(
      verifyDecisionBinding({ ...signed, requestHash: "" }, reqA),
      false,
    );

    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err);
    process.exit(1);
  }
```

## NOTE FOR THE DESKTOP CONTRACT (later prompt, not this one)

When the desktop responder is specified, it MUST, before acting on any `approval_decision`: (1) recompute `requestHash` as base64(SHA-256(UTF-8(canonicalJson(storedRequest)))) where canonicalJson = recursively key-sorted, whitespace-free JSON, and reject on mismatch; (2) verify the Ed25519 signature over the canonical bytes of the decision minus `signature`. Both must pass. The desktop's canonical-JSON implementation must be byte-identical to the phone's `canonicalJson` for identical structured data.

## SCOPE — DO NOT DO

No `PROTOCOL_VERSION` bump (v1.6 is additive, same as v1.1–v1.5). No signature-scheme changes. No desktop verifier code (desktop doesn't exist yet). No changes to `provider.tsx` approve/deny flow, relay, pairing, or E2E. No UI changes.

## ACCEPTANCE (repo root, paste the FULL terminal output)

1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. `node apps/mobile/test/approvals-test.mjs` → all 6 steps PASS
4. `npm run noise-kat && npm run pairing && npm run e2e && npm run control && npm run hello-auth && npm run relay-smoke && npm run nonce` → all green (regression)
5. `grep -n "requestHash" packages/protocol/src/index.ts apps/mobile/lib/approvals/approvals.ts` → hits in both files

## RETURN FOR REVIEW (paste both)

1. Confirmation of each of the 4 changes (file + what was done)
2. The FULL terminal output of acceptance commands 1–5
