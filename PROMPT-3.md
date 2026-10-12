# Bimax Mobile — Prompt #3: Mobile relay client

Copy everything below the line into Antigravity as one prompt.

---

You are building the mobile relay client for Bimax. Context: Bimax mobile is a companion remote. Prompt #1 built the app scaffold and protocol; Prompt #2 built the relay server (apps/relay: Node + ws + SQLite, hello handshake, routing by `to`, offline outbox with ack-based drain, presence). Now the app needs its side of the connection: a relay client that connects, survives network drops, and queues outbound messages while offline. Do not recreate the scaffold or the relay.

STACK (exact): TypeScript strict, ZERO new dependencies — not even devDependencies. The client is pure TypeScript with no React Native imports (stays testable in plain Node). The WebSocket implementation is injected: the app will pass the global WebSocket, the smoke test passes the repo's existing `ws` package.

TASK:
1. Create apps/mobile/lib/relay/ with exactly three files:
   - client.ts — the RelayClient class (exact behavior in section 2)
   - useRelay.ts — thin React hook wrapping RelayClient (exact API in section 3)
   - index.ts — barrel file: `export * from "./client";` and `export * from "./useRelay";`

2. BEHAVIOR — RelayClient. Exact TypeScript surface:

```ts
import type { Envelope, MessageKind, DeviceHello, DeliveryAck, DeviceRole } from "@bimax/protocol";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
}

export type WsImpl = new (url: string) => WebSocketLike;
export type ClientStatus = "connecting" | "online" | "reconnecting" | "offline";

export interface RelayClientOptions {
  url: string; // e.g. "ws://127.0.0.1:8787"
  deviceId: string;
  role: DeviceRole;
  wsImpl: WsImpl;
  onMessage: (env: Envelope<MessageKind, unknown>) => void;
  onStatus?: (s: ClientStatus) => void;
}
```

   - `connect()`: set status "connecting"; create `new wsImpl(url)`. On "open": send `Envelope<"hello", DeviceHello>` with `{ v: 1, id: <random>, ts: Date.now(), from: deviceId, to: "relay", kind: "hello", payload: { deviceId, role, protocolVersion: 1 } }`; set status "online"; reset backoff to 1s; drain the outbox FIFO (send each queued envelope in order, then clear).
   - On "message": parse JSON; silently ignore unparsable payloads or envelopes missing string `kind`/`id`. If `kind !== "delivery_ack"`: immediately send `Envelope<"delivery_ack", DeliveryAck>` `{ to: env.from, kind: "delivery_ack", payload: { id: env.id } }` (auto-ack keeps the relay's outbox clean). Then call `onMessage(env)`.
   - `send(env)`: if socket is open → `socket.send(JSON.stringify(env))`; else → push to the in-memory outbox array. Add a code comment: `// v1: in-memory outbox. App kill loses queued items; user resends. SQLite outbox is a later layer.`
   - On "close" or "error": if `close()` was explicitly called → status "offline", stop. Otherwise status "reconnecting" and schedule reconnect with exponential backoff: 1s, 2s, 4s, … capped at 30s, ±20% jitter. Reconnect = run `connect()` again (fresh hello each time).
   - `close()`: cancel any pending reconnect timer, close the socket, status "offline". Calling `connect()` after `close()` must work (fresh start).
   - Random ids: `"m-" + Math.random().toString(36).slice(2)` — no new dependencies.
   - Attach listeners with addEventListener and detach them on close/reconnect (no listener leaks across reconnects).

3. `useRelay.ts` — exact API:

```ts
import { useEffect, useRef, useState, useCallback } from "react";

export function useRelay(opts: {
  url: string;
  deviceId: string;
  role: DeviceRole;
  enabled: boolean;
  onMessage?: (env: Envelope<MessageKind, unknown>) => void;
}): { status: ClientStatus; send: (env: Envelope<MessageKind, unknown>) => void };
```

   Creates exactly ONE RelayClient inside a useEffect keyed on `[url, deviceId, role, enabled]`; passes the global `WebSocket` as `wsImpl`; keeps the latest `onMessage` in a ref (no stale closures); cleanup calls `client.close()`. Must be safe under React StrictMode double-effect (create → cleanup → create works because close()+connect() are idempotent). When `enabled` is false, no client is created and status is "offline".

4. SMOKE TEST — `apps/mobile/test/relay-smoke.mjs` (plain Node, no new dependencies):
   - At start, compile the client: run `npx tsc apps/mobile/lib/relay/client.ts --outDir <tmpdir>/client-dist --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck` via child_process (fail fast if it errors), then `require()` the compiled `client.js`.
   - Spawn the relay: build it first if needed (`npx tsc -p apps/relay/tsconfig.json`), then spawn `node apps/relay/dist/index.js` with PORT=18788 and DB_PATH=<tmpdir>/smoke.db; wait for `GET http://127.0.0.1:18788/health` → `{ok:true}` (fail after 10s).
   - STEP 1 (hello + presence): client A connects as deviceId "desktop-1", role "desktop"; client B connects as "mobile-1", role "mobile" (wsImpl = `require("ws")`). Assert B's onMessage received a `presence` envelope for "desktop-1" with status "online". PASS/FAIL.
   - STEP 2 (live delivery): A sends `Envelope<"session_list", SessionList>` to B (use a minimal valid payload). Assert B's onMessage received it with the same id. PASS/FAIL.
   - STEP 3 (offline queue + drain + ack, no duplicate): B.close(). A sends a second envelope (different id) to B. Wait 1s, assert B got nothing. Create B2 (same deviceId "mobile-1") and connect → assert B2 receives the queued envelope. B2 auto-acks (built into the client). Then B2.close(); create B3 (same deviceId), connect → assert B3 receives NOTHING within 1s (proves the ack deleted the row). PASS/FAIL.
   - STEP 4 (auto-reconnect): kill the relay child process → assert A's status becomes "reconnecting" within 5s. Restart the relay on the same port → assert A's status returns to "online" within 40s (backoff cap is 30s). PASS/FAIL.
   - Print PASS/FAIL per step, kill all children, delete tmpdir, exit 0 only if all pass.
   - NOTE: `useRelay.ts` is not covered by this script (it needs React); it is covered by `tsc --noEmit` + `eslint`.

SCOPE — DO NOT DO:
- No UI changes. No pairing, no crypto, no QR, no expo-sqlite.
- No new dependencies of any kind. Do not touch apps/relay or packages/protocol.
- Do not add a tsconfig for the lib; the compile flags in the smoke script are the build.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/relay-smoke.mjs` → all four steps PASS

RETURN FOR REVIEW (paste all four):
1. The file tree of apps/mobile/lib/relay and apps/mobile/test
2. The FULL text of apps/mobile/lib/relay/client.ts
3. The FULL output of the smoke test
4. The terminal output of acceptance commands 1–3
