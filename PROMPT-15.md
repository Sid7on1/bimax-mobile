# Bimax Mobile — Prompt #15: ~/Bimax adapter — wire the real engine to EnginePort

Copy everything below the line into Antigravity as one prompt.

---

Background: `DESKTOP-RESPONDER-CONTRACT.md` (repo root) is the finalized spec for
the desktop side of the phone↔laptop system. `apps/desktop-responder/` implements
it — verified, 13/13 integration tests green on real sockets + real Noise + the
real phone stack. This prompt connects the REAL engine: a thin adapter inside
`~/Bimax` (`/Users/vishsiddharth/Bimax/app`) that implements the `EnginePort`
interface from contract §14, so the phone UI (pairing, approvals, sessions, kill,
chat, files) drives a real laptop. This is the first prompt that touches `~/Bimax`.

**Read `DESKTOP-RESPONDER-CONTRACT.md` §14 (`EnginePort`, verbatim) and §6/§7/§8
(authorization, approvals, idempotency) before writing any code. Where this prompt
and the contract disagree, the CONTRACT wins — flag the discrepancy in your return.**

## 0. Recon first — `ENGINE-MAP.md` (read-only, no code changes)

Before writing any adapter code, explore the `~/Bimax/app` TypeScript source (not
just the built `app/engine/index.js` bundle) and write
`/Users/vishsiddharth/Bimax/ENGINE-MAP.md` documenting, with EXACT file paths +
function names:

1. **Tool execution pipeline** — where does a tool call go from "decided" to
   "executing"? Name the exact function/module where a pre-execution
   interception point exists (or can be added with a ~5-line hook). This is where
   approval suspension will hook in (§2).
2. **Session model** — how to list sessions, read a session's status, send an
   instruction/message into a session, abort/kill a session.
3. **Chat entry point** — how to submit a user message and receive streamed
   response tokens (or poll them).
4. **Status events** — what events/emitters exist for engine status changes.
5. **File ingestion** — where an approved file (absolute path by then) enters the
   engine for reading/attachment.
6. **Main-process APIs** — confirm `safeStorage` availability in the Electron
   main process; note the IPC conventions used to talk to the renderer.

If ANY of 1–5 has no clean answer, STOP after this section and report — do not
write adapter code around a missing hook.

## 1. Adapter layout — `/Users/vishsiddharth/Bimax/app/src/main/responder/`

(Match the `~/Bimax` repo conventions found in §0; suggested names below.)

```
/Users/vishsiddharth/Bimax/app/src/main/responder/
  adapter.ts         — implements EnginePort (contract §14, copy it verbatim —
                       do NOT broaden it): getStatus, listSessions,
                       sendInstruction, chat, kill, attachFile, onStatusChanged,
                       resolveApproval. Each method is a THIN mapping onto the
                       engine APIs from ENGINE-MAP.md. No protocol logic here.
  approval-hook.ts   — the §2 suspension mechanism: intercepts at the
                       pre-execution point from ENGINE-MAP.md item 1, suspends
                       the tool call BEFORE it starts, emits via the responder's
                       onApprovalRequest, awaits the decision, resumes or drops.
                       approve → resume with ORIGINAL args, byte-identical;
                       deny/timeout/kill → tool NEVER executes, engine gets a
                       denial result and continues its turn.
  identity-secure.ts — loadOrCreateIdentity() via Electron safeStorage
                       (OS keychain): deviceId + X25519 + Ed25519 keys encrypted
                       at rest. NO plaintext key files — the responder's
                       file-store identity is dev/test only (PROMPT-14 noted
                       this wiring was the adapter's job).
  pairing-ui.ts      — expose to the renderer via the repo's existing IPC
                       conventions: pairing advertisement payload (for QR
                       display), verification-code display, user confirm /
                       revoke actions. Renderer UI itself is out of scope;
                       the wiring is in scope.
  index.ts           — wiring: if process.env.BIMAX_RESPONDER === "1", load
                       identity-secure → import the responder package →
                       construct the Responder with the adapter as its
                       EnginePort → connect. Default (env unset): adapter inert,
                       zero behavior change to ~/Bimax.
```

Wire the responder package in: add a `file:` dependency from
`/Users/vishsiddharth/Bimax/app` to
`/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder` (check how
`apps/*` reference `@bimax/protocol` and follow the same convention). Verify the
BUILT Electron app resolves it — prove it works packaged, not just under ts-node.

`kill(target)` must GENUINELY abort the engine's in-flight work (prove the tool
process/promise actually stops — a boolean flag is not a kill). `chat(message)`
streams tokens back in order → chat_done; approvals may arrive mid-turn (the
responder handles routing; the adapter just surfaces them). The phone-side
E2E-reset (FIX-15) lands separately; the adapter's E2E validation runs after it.

## 2. Tests — colocated with the adapter

Real engine, but destructive tool tests run against a SCRATCH workspace dir —
never the real FS. No mocked crypto (the responder rule carries over).

1. **Approval suspension**: tool spy — assert the tool function is NOT called
   before the approval resolves; IS called exactly once with the original args
   after approve.
2. **Deny path**: tool spy never called; engine receives a denial result and
   continues its turn.
3. **Timeout path**: no decision within the window → tool never called.
4. **Kill-during-pending**: kill with an approval outstanding → tool never
   called; engine work actually aborted (assert the abort, not a flag).
5. **Concurrent approvals**: two tools suspended; approve one, deny the other;
   each decision routes to the correct suspended call.
6. **Regression**: re-run ALL 13 responder integration tests
   (`node apps/desktop-responder/test/integration-test.mjs` from the
   bimax-mobile repo) — must stay green.

## SCOPE — DO NOT DO

- Do NOT modify `apps/desktop-responder/*` — it is verified. If you find a
  genuine gap, STOP and report; do not "fix" it.
- Do NOT modify `packages/protocol/*`, `apps/mobile`, `apps/relay`, or
  `apps/cloud-relay`.
- Do NOT reimplement protocol/crypto/pairing/approvals — import the responder.
  If you are writing protocol logic, you are in the wrong place.
- Do NOT "simplify" the approval gate: no auto-approve, no cached decisions,
  no skipping the suspension.
- No TODOs in the suspension path. A TODO there is a fail.

## ACCEPTANCE (paste the FULL terminal output)

1. `ENGINE-MAP.md` exists with exact hook points named (paste its item 1)
2. `cd /Users/vishsiddharth/Bimax/app && npx tsc --noEmit` → zero errors
3. `npx eslint <responder dir>` (repo config) → zero errors
4. Adapter tests → all six cases PASS
5. Regression: `node apps/desktop-responder/test/integration-test.mjs` → 13/13 PASS
6. `~/Bimax` builds and launches with `BIMAX_RESPONDER` unset → app behaves
   exactly as before (adapter inert)
7. `grep -n "writeFile" <path to identity-secure.ts>` → no hits (no key
   material ever written to disk — safeStorage only)

## RETURN FOR REVIEW (paste all four)

1. The file tree of the new `responder/` dir
2. `approval-hook.ts` and `identity-secure.ts` IN FULL (the security core —
   these get the closest review)
3. The FULL terminal output of acceptance commands 1–7
4. Explicit confirmation of each SCOPE item (responder untouched, protocol
   untouched, no reimplemented protocol logic, no weakened gate)
