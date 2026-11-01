# Bimax Mobile — FIX-14b: unhandled rejection on invalid idempotency key (regression from FIX-2)

Copy everything below the line into Antigravity as one prompt.

---

Background: FIX-2 removed the outer try/catch around `idempotency.execute()` in
`dispatchInnerFrame`'s `command_request`/`kill_request` cases (engine failures
now flow through the `onError` mapper — correct). But `IdempotencyLog.execute()`
calls `IdempotencyLog.validateKey(key)` at the top, OUTSIDE its internal
try/catch. An invalid key (empty, missing, >128 chars) therefore throws out of
`execute()`, out of `dispatchInnerFrame`, and — since `handleRelayMessage` is
invoked as `void this.handleRelayMessage(env)` — becomes an UNHANDLED PROMISE
REJECTION, which crashes Node by default. Before FIX-2 the outer catch turned
this into `command_result{ok:false}`.

## The fix

In `src/responder.ts`, wrap the `execute()` call in BOTH the
`command_request` and `kill_request` cases with a narrow outer try/catch that
sends the error result directly (it can only trigger for pre-execution
failures such as `validateKey`, because engine failures are converted by
`onError` and never reach it):

```ts
case "command_request": {
  const req = body as CommandRequest;
  if (!req || typeof req !== "object") return;
  try {
    const { result: cmdRes } = await this.idempotency.execute<CommandResult>(
      req.idempotencyKey,
      async () => {
        return this.enginePort.sendInstruction({
          idempotencyKey: req.idempotencyKey,
          instruction: req.instruction,
        });
      },
      (err) => ({
        idempotencyKey: req.idempotencyKey,
        ok: false,
        summary: err instanceof Error ? err.message : "Engine error",
      }),
    );
    this.sendEncrypted("command_result", cmdRes);
  } catch {
    // Pre-execution failure (e.g. invalid idempotency key): no log entry exists.
    this.sendEncrypted("command_result", {
      idempotencyKey: typeof req.idempotencyKey === "string" ? req.idempotencyKey : "",
      ok: false,
      summary: "Invalid request",
    });
  }
  break;
}
```

Mirror it for `kill_request` with `kill_result` /
`{ idempotencyKey, ok: false, detail: "Invalid request", at: Date.now() }`,
keeping the existing `cancelForSession()` call where it is.

Do NOT change `idempotency.ts` — `validateKey` throwing on a bad key is correct
behavior; the responder just has to handle it.

## SCOPE — DO NOT DO

- Only `src/responder.ts` and the test. Nothing else.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/desktop-responder && npx tsc --noEmit` → zero errors
2. `npx eslint apps/desktop-responder` (from repo root) → zero errors
3. `node apps/desktop-responder/test/integration-test.mjs` → all cases PASS,
   including new **CASE 13 (malformed key):** send `command_request` with an
   empty-string `idempotencyKey` → the phone receives
   `command_result{ok:false}` and the suite continues (no unhandled rejection,
   process stays alive).

## RETURN FOR REVIEW (paste both)

1. The changed hunks for the two cases.
2. The FULL terminal output of acceptance commands 1–3.
