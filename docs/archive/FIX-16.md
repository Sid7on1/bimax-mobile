# Bimax Mobile — FIX-16: connect the adapter to ThreadManager's deps seam (approvals + chat), fix double-submit

Copy everything below the line into Antigravity as one prompt.

**Work location: `/Users/vishsiddharth/Bimax`** — the adapter has lived there since PROMPT-15 (authorized). All paths below are relative to that repo unless stated otherwise.

---

Background: PROMPT-15 built the `~/Bimax` adapter (`app/src/main/responder/`).
Review of the actual code found the adapter is NOT connected to the engine at
the seams that matter — `ENGINE-MAP.md` describes the intended hooks, but they
were never implemented:

1. `ThreadManager.deps.approval` (set at construction in `app/src/main/index.ts`)
   still points at the desktop popup. Nothing calls `adapter.handleThreadApproval`
   — it is dead code. Real engine approvals never reach the phone.
2. `deps.message` / `deps.finished` are never wrapped, so
   `adapter.handleStreamToken` / `adapter.handleTurnFinished` are dead code.
   `EnginePort.chat()` awaits `turnPromise` forever → the responder's
   `ChatHandler` has no timeout on `enginePort.chat()` → the phone's
   `chat_message` hangs indefinitely with no `chat_done`.
3. `ThreadManager.create(root, prompt)` auto-submits non-empty prompts
   (`thread.manager.ts`: `if (prompt.trim()) this.submit(id, prompt)`), and the
   adapter then calls `submit()` again → every phone instruction/chat that
   creates a thread executes TWICE.

This FIX connects the seams. Do not redesign the adapter; wire it.

**Read these before writing any code:** `app/src/main/thread.manager.ts`
(`holdApproval`, `takeReply`, `send`, `create`, `receive`), `app/src/main/index.ts`
(ThreadManager construction ~line 1770 with the `approval:` dep; the
`BIMAX_RESPONDER` injection ~line 1888), and
`app/src/main/responder/{index,adapter,approval-hook}.ts`.

## 1. Wire the deps seam — `app/src/main/responder/index.ts`

Add an exported `wireThreadHooks()` and call it inside `initResponderIfEnabled`
AFTER the responder is constructed (the paired-check needs it). It wraps three
deps on the live ThreadManager instance. `deps` is TS-private but a plain
runtime property — access it via a structural cast with a comment explaining
why (do NOT edit `thread.manager.ts`):

```ts
type DepsShape = {
  approval: (v: ThreadApproval) => void;
  message: (id: string, msg: unknown) => void;
  finished?: (id: string, tookMs?: number) => void;
};
```

- `approval`: if `responder.pairingManager.getTrustedPhone()` is truthy →
  `adapter.handleThreadApproval(value)` ONLY (desktop popup suppressed — one
  approver, no double-approval races). Else → call the ORIGINAL approval
  callback (desktop behaves exactly as today).
- `message`: call the original FIRST, then snoop: if `msg` matches
  `{t:'event', name:'stream_token', args:[string]}` →
  `adapter.handleStreamToken(id, args[0])`.
- `finished`: call the original, then `adapter.handleTurnFinished(id)`.

`stopResponder()` must UNWRAP all three (restore the originals) — disabling the
responder must leave zero trace.

Document the tradeoff in a comment where you wrap: phone-paired ⇒ the phone is
the SOLE approver. Phone paired but offline ⇒ approvals wait for the
responder's 30s auto-deny (fail closed). This is V1 behavior; do NOT build
dual-approval.

## 2. Fix double-submit — `app/src/main/responder/adapter.ts`

In `sendInstruction` and `chat`, change
`this.threads.create(this.defaultWorkspaceDir, input.instruction / input.text, 'project')`
to `this.threads.create(this.defaultWorkspaceDir, '', 'project')` — `create()`
already submits non-empty prompts, so pass `''` and keep the single explicit
`submit()` that follows. One instruction in ⇒ one engine turn.

## 3. Harden allow/deny mapping — `adapter.ts` `handleThreadApproval`

The current regex fallback can pick a value not in `request.options` →
`takeReply` throws "Invalid approval choice" → the engine wedges at
`'needs-you'` and the `void intercept(...)` becomes an unhandled rejection.

- Find `notificationChoices` / `answerFromNotification` in `app/src/main/index.ts`
  and use the IDENTICAL derivation for the allow/deny option values.
- If no confident mapping exists: do NOT send a reply. Instead
  `this.threads.send(threadId, {t:'interrupt'})` (fail closed — the tool never
  runs, the turn ends interrupted) and log a security event. Never send an
  invalid choice; never wedge the engine.
- Attach a `.catch()` to the `void this.approvalHook.intercept({...})` call that
  logs a security event. No silent unhandled rejections.

## 4. `attachFile` → engine ingest (verify-first)

Today `attachFile` only records metadata; `ENGINE-MAP.md` §5 says files must
reach the engine via the `\0composer:ingest:<absPath>` query channel, and the
adapter never sends it. The adapter also cannot know the inbox path —
`EnginePort.attachFile` carries no path.

- In `initResponderIfEnabled`, pass an explicit `dataDir` (default
  `path.join(app.getPath('userData'), 'responder')`) to BOTH the Responder and
  the adapter. (This also fixes the responder's default
  `process.cwd()/.responder-data`, which is unpredictable under Electron. The
  inbox layout `<dataDir>/inbox/<fileId>` is confirmed in `responder.ts`.)
- In `attachFile`, resolve `<dataDir>/inbox/<fileId>`, verify it exists and the
  size matches, then deliver it through the SAME channel the renderer uses for
  `\0composer:ingest:` — FIRST trace how `window.bimax.send({t:'query',...})`
  reaches the engine from the main process (read the handler in `index.ts`);
  if there is no clean main-process path, STOP and report instead of hacking one.
- Keep the metadata registry (the chat file-notes still work).

## 5. Wiring regression tests — the tests PROMPT-15 lacked

PROMPT-15's tests never touched the ThreadManager seam, which is why the
missing wiring passed. Add `__tests__/wiring.test.ts` driving a REAL
`ThreadManager` with stub deps (stub `ThreadEngine`, stub dep fns):

1. **Approval → phone**: wire hooks with paired=true; `tm.start(tid)` so
   `receive()` has an engine; `tm.receive(tid, {t:'request', id:7, kind:'prompt',
   question:'Run rm?', options:['Allow','Deny']})`. Assert: the desktop approval
   stub was NOT called; the approvalHook holds a pending approval; the emitted
   `ToolApprovalRequest` carries the question. Then
   `adapter.resolveApproval(id,'approved')` → assert the stub engine received
   `{t:'reply', value:'Allow'}` carrying the correct token.
2. **Approval → desktop when unpaired**: paired=false → desktop stub called,
   nothing pending on the hook.
3. **Chat streams + completes**: `const p = adapter.chat({idempotencyKey:'k',
   text:'hi'}, onToken)` (do not await yet);
   `tm.receive(tid, {t:'event', name:'stream_token', args:['he']})` → onToken got
   `'he'`; `tm.receive(tid, {t:'event', name:'spinner_state', args:['idle']})`
   → `p` resolves with `{sessionId}`.
4. **No double-submit**: `adapter.sendInstruction({idempotencyKey:'k2',
   instruction:'do X'})` with no active thread → the stub engine received
   EXACTLY ONE `{t:'input'}` containing `'do X'`.
5. **Unwrap**: after the unwrap path, `deps.approval/message/finished` are the
   original functions again.

Keep the existing 6 adapter tests green. No mocked crypto.

## 6. Small hardening — `identity-secure.ts`

If the identity file exists but is corrupt/unparseable, the current code
silently generates a FRESH identity and overwrites it — new deviceId + keys,
breaking pair trust without a word. Change: back the corrupt file up to
`<path>.corrupt-<timestamp>` and THROW. Fail loud; never silently re-key.

## SCOPE — DO NOT DO

- Do NOT modify anything in `/Users/vishsiddharth/Desktop/bimax-mobile`
  (`apps/desktop-responder/*`, `packages/protocol/*`, `apps/mobile/*`,
  `apps/relay`, `apps/cloud-relay`) — the verified responder and protocol are
  read-only dependencies. The ONLY exception is re-running the existing
  `node apps/desktop-responder/test/integration-test.mjs` for the acceptance
  regression (read-only run, no edits).
- Do NOT edit `app/src/main/thread.manager.ts` — the seam is wrapped at runtime
  via structural cast, never edited.
- In `app/src/main/index.ts`: touch ONLY the `BIMAX_RESPONDER`-gated block.
  Do NOT alter the existing ThreadManager construction or its deps.
- Do NOT change the root `jest.config.ts` further.
- No new dependencies. No UI. No TODOs in the wiring path.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd /Users/vishsiddharth/Bimax/app && npx tsc --noEmit` → zero errors
2. `cd /Users/vishsiddharth/Bimax && npx eslint app/src/main/responder` → zero errors
3. `npx jest app/src/main/responder/__tests__/wiring.test.ts` → all five wiring cases PASS
4. `npx jest app/src/main/responder/__tests__/adapter.test.ts` → still green
5. `node apps/desktop-responder/test/integration-test.mjs` (from the bimax-mobile repo) → 13/13 PASS
6. `grep -n "wireThreadHooks" /Users/vishsiddharth/Bimax/app/src/main/responder/index.ts` → hits (the seam is actually connected)
7. `cd /Users/vishsiddharth/Bimax/app && npm run build` → success

## RETURN FOR REVIEW (paste all four)

1. The diff of `app/src/main/responder/index.ts` (the wiring) and `adapter.ts` (double-submit + option hardening)
2. `__tests__/wiring.test.ts` IN FULL
3. The FULL terminal output of acceptance commands 1–7
4. Explicit confirmation of each SCOPE item + the §4 verdict (ingest path found and used, or reported as not clean)
