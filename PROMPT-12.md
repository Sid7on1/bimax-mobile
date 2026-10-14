# Bimax Mobile — Prompt #12: Cloudflare relay v2 (Workers + Durable Objects)

Copy everything below the line into Antigravity as one prompt.

---

Background: the phone currently talks to the Node `ws` relay (`apps/relay`) — fine on LAN, useless off-network. This prompt builds the internet relay on Cloudflare Workers + Durable Objects: both phone and laptop make OUTBOUND `wss://` connections, so no inbound laptop port is ever exposed and there is no NAT/firewall configuration. The wire protocol does NOT change. The Node relay is untouched (it stays for LAN mode; its hardening is the next prompt). Encrypted payloads stay opaque — the relay never parses or logs message contents.

## Design (build exactly this)

New `apps/cloud-relay/` package, fully separate from `apps/relay`:

```
apps/cloud-relay/
  package.json        — dependencies: @noble/curves, @noble/hashes (pure JS, Workers-safe).
                        devDependencies: wrangler, @cloudflare/workers-types, better-sqlite3 (tests only), typescript.
  tsconfig.json       — strict: true, types: ["@cloudflare/workers-types"], no Buffer, no `as any`.
  wrangler.toml       — name = "bimax-relay", main = "src/index.ts", compatibility_date = "2026-10-01",
                        [[durable_objects.bindings]] name = "ROOM", class_name = "Room",
                        [[migrations]] tag = "v1", new_sqlite_classes = ["Room"]
  src/index.ts        — worker entry: route /room/:roomId, export Room
  src/room.ts         — Durable Object class Room: hibernation WebSocket handlers. Thin adapter, under ~120 lines.
  src/logic.ts        — ALL real logic (hello verification, routing, outbox SQL, presence, limits) behind a
                        minimal Sql interface so it is unit-testable in Node.
  src/canonical.ts    — canonicalJson with byte-identical semantics to apps/mobile/lib/crypto/keys.ts:
                        recursively sort object keys, no whitespace, arrays keep order,
                        undefined object values skipped, undefined array items become null,
                        throws on an undefined root.
  src/base64.ts       — base64ToBytes / bytesToBase64 built on atob/btoa (Workers-safe, no Buffer).
  test/relay-v2-test.mjs — plain-Node acceptance test (same tmpdir-compile pattern as the other test files;
                        for noble imports, follow the pattern crypto-test.mjs uses).
```

**Rooms.** One Durable Object per pair. Both devices dial `wss://<worker-host>/room/<desktopDeviceId>`. The worker validates the path against `^\/room\/([A-Za-z0-9_-]{1,128})$` (else 404), requires the `Upgrade: websocket` header (else 400), then `env.ROOM.idFromName("room:" + roomId)` and forwards. `room.ts` `fetch()` creates a `WebSocketPair`, calls `state.acceptWebSocket(server)`, returns the 101 response. No shared global state — rooms are fully isolated. Env type: `interface Env { ROOM: DurableObjectNamespace }`.

**Hello auth.** The cloud relay REQUIRES signed hellos (the phone always signs since Prompt #10); unsigned/legacy hellos are closed, not downgraded. The first message on every socket MUST be a hello envelope, else `close(4400)`. Verify in this order, closing on the first failure:
1. `env.v === 1`, `env.kind === "hello"`, `env.to === "relay"`.
2. Payload: `protocolVersion === 1`; `deviceId` a non-empty string (max 128 chars); `role` is `"desktop"` or `"mobile"`; `env.from === deviceId`.
3. `|Date.now() - env.ts| <= 120000`, else `close(4401, "stale hello")`.
4. `helloPubkey` / `helloSignature` are non-empty base64; pubkey decodes to 32 bytes, signature to 64 bytes; else `close(4401, "bad hello shape")`.
5. `msg = utf8(canonicalJson({ id: env.id, ts: env.ts, from: env.from, deviceId, role, helloPubkey }))`; `ed25519.verify(sig, msg, pubkey)` must be true, else `close(4401, "bad hello signature")`. (This is exactly what the phone signs — see PROMPT-10 — so verification must reconstruct this object precisely.)
6. TOFU pinning: `SELECT pubkey FROM pins WHERE device_id = ?`. No row → insert the pin. Mismatch → `close(4401, "device key changed")`. Match → continue.

On success: `ws.serializeAttachment({ deviceId, role })`; stale-socket eviction — close any existing socket carrying this deviceId's tag (same semantics as the Node relay); `INSERT OR REPLACE` the device row with `last_seen = now`; send presence (below); drain the outbox (below); schedule the 60-second alarm if none is set.

**Sender binding.** Every post-hello message must have `env.from === attachment.deviceId`, else `close(4400)`. (The Node relay never bound `env.from` — do not repeat that.)

**Routing** (same semantics as the Node relay, room-scoped): find the target socket for `env.to` among this room's sockets; if open, forward the raw text; otherwise store in the outbox. Drop (do not store, do not forward) messages with missing/empty `env.to`, or `env.to === "relay"` (except `delivery_ack`, handled below). Validate `env.id` is a non-empty string (max 128 chars) BEFORE storing anything — this kills the NULL-ID outbox poison from the audit.

**Presence.** Same envelope shapes as the Node relay (`from: "relay"`, kind `"presence"`). On hello: send this device the online/offline status of every OTHER device in the room's `devices` table; broadcast an "online" presence to the others. On socket close: if it was the current socket for that device, broadcast "offline".

**Outbox** (Durable Object SQLite via `state.storage.sql`):
```sql
CREATE TABLE IF NOT EXISTS outbox(
  id TEXT PRIMARY KEY,
  to_device TEXT NOT NULL,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_to ON outbox(to_device, created_at);
CREATE TABLE IF NOT EXISTS pins(device_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, role TEXT NOT NULL, last_seen INTEGER NOT NULL);
```
Constants: `OUTBOX_TTL_MS = 7 * 24 * 3600 * 1000`, `OUTBOX_MAX_PER_DEVICE = 500`, `DRAIN_MAX = 500`. Expose them as constructor parameters with these defaults so tests can shrink them. On every save: delete rows older than the TTL, then if this device's row count exceeds the cap, delete the oldest excess. Drain on hello in `created_at` order, at most DRAIN_MAX rows, sent as raw text. `delivery_ack`: delete the row ONLY when the ack envelope's `from` equals the row's `to_device` — an ack from any other device is ignored (ownership check the Node relay lacked).

**Limits.**
- `MAX_ENVELOPE_BYTES = 256 * 1024`: measure with `new TextEncoder().encode(message).length` BEFORE `JSON.parse`; oversize → `close(1009)`.
- Rate limit: 30 messages/second per device, in-memory sliding window (document in a comment that hibernation may reset it — best-effort); on exceed → `close(4429, "rate limited")`.
- Idle reap: `state.storage.setAlarm(Date.now() + 60_000)` after the first hello (re-arm at the end of every alarm run). The alarm closes sockets for devices with `now - last_seen > 600_000` (`close(1001)`) and prunes expired outbox rows.

**Testability.** `logic.ts` must not import `cloudflare:workers` or touch `state` directly: define `interface Sql { exec(sql: string, ...params: unknown[]): { rows: Record<string, unknown>[] } }` and implement `RoomStore` against it; `room.ts` adapts `state.storage.sql` (whose cursor has `toArray()`). Pure functions: `verifyHello(env: unknown, nowMs: number, getPin: (id: string) => string | null): { ok: true; deviceId: string; role: string } | { ok: false; code: number; reason: string }`, `buildPresence(...)`, `isOversize(...)`. The test adapts better-sqlite3 to the `Sql` interface in ~20 lines.

## TEST — `apps/cloud-relay/test/relay-v2-test.mjs`

Plain Node, tmpdir-compile `src/*.ts` (excluding `room.ts` if its `cloudflare:workers` import breaks CJS compile — compile `logic.ts`, `canonical.ts`, `base64.ts`; stub the `Sql` interface with better-sqlite3):
- STEP 1 (canonical JSON): `canonicalJson({ b: 1, a: { d: 4, c: 3 }, e: null })` deep-equals `'{"a":{"c":3,"d":4},"b":1,"e":null}'`; undefined object values skipped; undefined array items become null; throws on undefined root.
- STEP 2 (hello verify): build a hello exactly like the phone does — `sign(utf8(canonicalJson({ id, ts, from, deviceId, role, helloPubkey })))` with noble ed25519 — `verifyHello` returns ok. Then: ts tampered by 1 → reject; wrong public key → reject; ts 121 seconds old → reject; missing `helloSignature` → reject; `env.from !== deviceId` → reject.
- STEP 3 (TOFU): first hello pins the pubkey; same deviceId with a different pubkey → reject; same pubkey → ok.
- STEP 4 (sender binding + validation): message with `from` different from the authed device → rejected; envelope with empty `id` → rejected before storage; envelope with empty `to` → dropped, nothing stored.
- STEP 5 (outbox): save three rows for an offline device → retrieved in `created_at` order; insert a row older than the TTL → pruned on the next save; with small test constants (cap 3), saving a 4th row trims the oldest; `delivery_ack` from a DIFFERENT device → row kept; ack from the owning device → row deleted.
- STEP 6 (limits + config): a 257 KB message → rejected as oversize; `wrangler.toml` exists, declares `class_name = "Room"`, a `[[durable_objects.bindings]]` named `ROOM`, and a v1 migration with `new_sqlite_classes = ["Room"]`.
- Print PASS/FAIL per step, delete tmpdir, exit 0 iff all pass.

## SCOPE — DO NOT DO

- Do NOT run `wrangler deploy` or `wrangler login` — deployment needs Sid's Cloudflare account; he does it manually. Do not create any Cloudflare resources.
- No protocol changes. No phone-app changes. No changes to `apps/relay` (its hardening is the next prompt). No new root dependencies — everything new lives inside `apps/cloud-relay`. No `as any`, no Buffer. The relay must never parse or log message payloads — only envelope routing fields.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/cloud-relay && npm install` → exit 0
2. `cd apps/cloud-relay && npx tsc --noEmit` → zero errors
3. `npx eslint apps/cloud-relay` (from repo root) → zero errors
4. `node apps/cloud-relay/test/relay-v2-test.mjs` → all six steps PASS
5. Regression: `node apps/mobile/test/relay-smoke.mjs` → all four steps PASS (Node relay untouched)

## RETURN FOR REVIEW (paste all four)

1. The file tree of `apps/cloud-relay`
2. `src/room.ts` and `src/logic.ts` in full
3. `wrangler.toml`
4. The FULL terminal output of acceptance commands 1–5

---

Reviewer note: after Sid runs `npx wrangler login && npx wrangler deploy` inside `apps/cloud-relay`, the worker URL becomes the `relayUrl` the desktop puts in its QR code and the phone stores in its trusted record — no code changes needed for that.
