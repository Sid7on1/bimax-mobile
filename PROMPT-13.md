# Bimax Mobile — Prompt #13: Node LAN relay hardening (auth backport)

Copy everything below the line into Antigravity as one prompt.

---

Background: the audit found the Node LAN relay (`apps/relay`) trusts far too much: no hello-auth verification, device-ID squatting, NULL-ID outbox rows that can never be acked or deleted, no outbox TTL/cap/pruning, no rate limiting, no idle reaping, no explicit `maxPayload`, `env.from` not bound to the authenticated socket, outbox acks with no recipient-ownership check, and outbox drain loading every row into memory. Prompt #12 already solved every one of these in `apps/cloud-relay/src/logic.ts` — audited, tested, and deliberately platform-agnostic (it only needs a minimal `Sql` interface). This prompt backports those exact protections instead of inventing a second implementation.

## Design (build exactly this)

**1. Copy the audited modules unchanged.** Copy `apps/cloud-relay/src/canonical.ts`, `src/base64.ts`, and `src/logic.ts` into `apps/relay/src/` byte-for-byte. Do not edit them. Sync rule (permanent): if these files ever need a fix, fix them in `apps/cloud-relay` first, then re-copy. Acceptance command 6 enforces it.

**2. `apps/relay/package.json`** — add to `dependencies`:
```json
"@noble/curves": "^2.4.0",
"@noble/hashes": "^2.4.0"
```

**3. `apps/relay/src/store.ts`** — stop hand-rolling outbox SQL; reuse `RoomStore`:
- Add the `pins` table to `init()`:
```sql
CREATE TABLE IF NOT EXISTS pins(device_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL);
```
- Add a `getSql()` method returning the `Sql` interface from `./logic`, adapted over better-sqlite3 (no `as any` — `stmt.reader` is a typed boolean on better-sqlite3's Statement):
```ts
import type { Sql } from "./logic";

getSql(): Sql {
  const db = this.db;
  return {
    exec: (sql: string, ...params: unknown[]) => {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        return { rows: stmt.all(...params) as Record<string, unknown>[] };
      }
      stmt.run(...params);
      return { rows: [] };
    },
  };
}
```
- DELETE the old outbox methods `saveOutbox`, `getOutboxForDevice`, `deleteOutbox` and the now-unused `OutboxRow` interface (confirm with grep that nothing else calls them). Keep `recordDevice`, `updateLastSeen`, `getOtherDevices`, `getAllDevices`, `close` — presence bookkeeping stays.
- All outbox/pin access goes through `RoomStore` from now on.

**4. `apps/relay/src/relay.ts`** — the surgery:
- Import `{ RoomStore, RateLimiter, verifyHello, processPostHelloMessage, type DeviceAttachment }` from `"./logic"`.
- In the constructor: `this.roomStore = new RoomStore(store.getSql())` (private field) and `this.rateLimiter = new RateLimiter()`.
- First message: REPLACE the manual hello field checks with:
```ts
const res = verifyHello(env, Date.now(), (id) => this.roomStore.getPin(id));
if (!res.ok) { ws.close(res.code, res.reason); return; }
if (res.isNewPin) this.roomStore.setPin(res.deviceId, res.helloPubkey);
const deviceId = res.deviceId;
const role = res.role;
```
  Everything after that (stale-socket eviction, presence fan-out, outbox drain) stays, except the drain becomes `this.roomStore.drainOutbox(deviceId)` — capped at DRAIN_MAX, fixing the unbounded drain.
- Post-hello messages: REPLACE the inline `delivery_ack` / routing / outbox block with:
```ts
const attachment: DeviceAttachment = { deviceId: currentDeviceId, role: currentRole };
const findTarget = (targetId: string) => {
  const targetWs = this.onlineSockets.get(targetId);
  return targetWs && targetWs.readyState === WebSocket.OPEN
    ? { send: (data: string) => targetWs.send(data) }
    : null;
};
const outcome = processPostHelloMessage(rawText, attachment, this.roomStore, this.rateLimiter, findTarget, Date.now());
if (outcome.closeCode) ws.close(outcome.closeCode, outcome.closeReason);
```
  (Keep `currentDeviceId`/`currentRole` tracking as today; `processPostHelloMessage` now owns sender-binding, id validation, owned-ack deletes, TTL/cap pruning, and rate limiting. The `updateLastSeen` call inside it replaces the manual one — remove the old manual call to avoid double writes.)
- Presence broadcast on socket close: unchanged.
- Add an idle-reap method:
```ts
reapIdle(now: number = Date.now()): void {
  for (const [deviceId, ws] of this.onlineSockets) {
    const lastSeen = this.roomStore.getDeviceLastSeen(deviceId);
    if (lastSeen !== null && now - lastSeen > 600_000) {
      try { ws.close(1001, "idle timeout"); } catch { /* ignore */ }
    }
  }
  this.roomStore.pruneExpired(now);
}
```

**5. `apps/relay/src/index.ts`** —
- `new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })` — the explicit cap the audit asked for.
- `const reapTimer = setInterval(() => relay.reapIdle(), 60_000); reapTimer.unref();` and `clearInterval(reapTimer)` in both the SIGINT and SIGTERM handlers.

## TESTS

**A. Update `apps/mobile/test/relay-smoke.mjs`** — hellos must now be SIGNED (unsigned hellos are closed with 4401). Build each hello exactly like the phone does: `sign(utf8(canonicalJson({ id, ts, from, deviceId, role, helloPubkey })))` with noble ed25519 (follow the pattern `apps/cloud-relay/test/relay-v2-test.mjs` uses), with `to: "relay"` on the envelope. Keep the four steps and their assertions otherwise identical.

**B. New `apps/relay/test/relay-hardening-test.mjs`** — plain Node, spawns the real relay server on a test port (follow relay-smoke.mjs's spawn pattern), noble keypairs per device, then:
- STEP 1 (unsigned hello rejected): connect with a legacy hello (no `helloPubkey`/`helloSignature`) → socket closed with code 4401.
- STEP 2 (squatting blocked): signed hello from device X pins key K1; second connection claiming device X with a different key K2 (validly signed by K2) → closed with code 4401 and reason `device key changed`.
- STEP 3 (stale hello): signed hello with `ts` 121 seconds old → closed with code 4401.
- STEP 4 (sender binding): authed as device A, send an envelope with `from: "device-B"` → socket closed with code 4400.
- STEP 5 (empty id never stored): authed as A, send to offline device B with `id: ""` → B connects later, drains nothing for that message.
- STEP 6 (ack ownership): A sends a message to offline B (valid id); a THIRD authed device C sends `delivery_ack` for that id → row kept (B drains it on connect); B then acks → row deleted (second drain is empty).
- Print PASS/FAIL per step, kill the spawned server, exit 0 iff all pass. (TTL/cap are already covered against the shared `RoomStore` by the cloud relay's tests — do not re-test them here.)

## SCOPE — DO NOT DO

- No protocol changes. No phone-app changes. No changes to `apps/cloud-relay` (the copy direction is one-way). No new root dependencies. No `as any`, no Buffer. Presence semantics stay exactly as they are today (global device list, not room-scoped — that is the LAN relay's existing behavior).

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/relay && npm install` → exit 0
2. `cd apps/relay && npx tsc --noEmit` → zero errors
3. `npx eslint apps/relay` (from repo root) → zero errors
4. `node apps/relay/test/relay-hardening-test.mjs` → all six steps PASS
5. `node apps/mobile/test/relay-smoke.mjs` → all four steps PASS (updated signed hellos)
6. `diff apps/cloud-relay/src/logic.ts apps/relay/src/logic.ts && diff apps/cloud-relay/src/canonical.ts apps/relay/src/canonical.ts && diff apps/cloud-relay/src/base64.ts apps/relay/src/base64.ts` → no output (byte-identical)

## RETURN FOR REVIEW (paste all four)

1. The `relay.ts` diff (or the full file if the diff is hard to read)
2. The `store.ts` diff
3. The FULL terminal output of acceptance commands 1–6
4. Confirmation that `grep -n "saveOutbox\|getOutboxForDevice\|deleteOutbox(" apps/relay/src/*.ts` shows no remaining callers of the deleted methods
