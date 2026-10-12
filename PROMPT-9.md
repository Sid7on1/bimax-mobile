# Bimax Mobile — Prompt #9: remote-control surface

Copy everything below the line into Antigravity as one prompt.

---

You are building the remote-control surface of the Bimax mobile companion app — the point where the pipe becomes a product. Context: Prompts #1–8 + Fixes #1–2 built transport, Noise_IK pairing, biometric approvals, and E2E sealed framing (protocol v1.3). The phone can pair and approve/deny. It cannot yet see what the agent is doing, tell it what to do, or stop it. After this prompt it can do all three.

PROTOCOL v1.4 — apply these exact changes to packages/protocol/src/index.ts:
1. Add to the `MessageKind` union: `"agent_status" | "session_list_request" | "session_list" | "command_request" | "command_result" | "kill_request"`.
2. Add these interfaces (place them after the EncryptedPayload section):
```ts
export type AgentState = "idle" | "working" | "waiting_approval" | "error";

export interface AgentStatus {
  state: AgentState;
  sessionId?: string;
  taskSummary?: string; // short human-readable summary, never secrets
  updatedAt: number;
}

export interface AgentSessionInfo {
  sessionId: string;
  title: string;
  status: AgentState;
  startedAt: number;
}

export interface SessionList {
  sessions: AgentSessionInfo[];
}

export interface CommandRequest {
  instruction: string;
  idempotencyKey: string; // phone-generated; desktop dedupes on this
  sentAt: number;
}

export interface CommandResult {
  idempotencyKey: string;
  ok: boolean;
  summary: string; // short result summary, never secrets
}

export interface KillRequest {
  reason?: string;
  sentAt: number;
}
```
3. Update the version comment at the top from v1.3 to v1.4 and note the change.

STACK (exact): TypeScript strict, Expo Router, React Native StyleSheet. ZERO new dependencies. No Buffer, no `as any`.

TASK:
1. **Protocol**: the v1.4 changes above. This is the ONLY protocol change.
2. **`apps/mobile/lib/session/provider.tsx`** — add remote-control state and methods:
   - New state: `agentStatus: AgentStatus | null` (null until first status arrives), `remoteSessions: AgentSessionInfo[]`, `commandLog: CommandLogEntry[]` where
   ```ts
   export interface CommandLogEntry {
     idempotencyKey: string;
     instruction: string;
     status: "sent" | "acked" | "failed";
     summary?: string;
     at: number;
   }
   ```
   Cap the log at 20 entries (drop oldest).
   - Add to `RelayContextValue`: `agentStatus`, `remoteSessions`, `commandLog`, `sendInstruction(instruction: string): void`, `requestSessionList(): void`, `sendKill(reason?: string): void`.
   - Add a `requireDesktopId()` helper: returns `trustedRef.current.deviceId`, throws `"No trusted desktop configured"` if missing. Use it in all three new methods (and keep approve/deny as they are).
   - `sendInstruction(instruction)`: trim; throw on empty or longer than 4000 chars. Build `CommandRequest { instruction, idempotencyKey: "cmd-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36), sentAt: Date.now() }`. Append `{... , status: "sent", at: Date.now()}` to commandLog. Send via `sendEncrypted(desktopId, "command_request", req)`.
   - `requestSessionList()`: `sendEncrypted(desktopId, "session_list_request", {})`.
   - `sendKill(reason?)`: `sendEncrypted(desktopId, "kill_request", { reason, sentAt: Date.now() })`.
   - `handleIncoming` new branches (these arrive decrypted through the existing `encrypted` re-dispatch — add them alongside the other kind branches):
     - `agent_status`: accept only if `payload.state` is one of the four AgentState values; sanitize strings (slice taskSummary to 200 chars); `setAgentStatus(...)`. Ignore malformed silently.
     - `session_list`: accept only if `payload.sessions` is an array; keep entries with string sessionId/title and valid status; cap at 50; `setRemoteSessions(...)`. Ignore malformed silently.
     - `command_result`: if `payload.idempotencyKey` is a string, update the matching commandLog entry to `acked`/`failed` with summary sliced to 300 chars. Ignore unknown keys silently.
   - All three new kinds go through `sendEncrypted` — the plaintext allowlist is UNCHANGED (hello, presence, delivery_ack, pairing_request, pairing_grant, encrypted).
3. **`apps/mobile/app/index.tsx`** — rewrite wholesale as the home screen. Read `pair.tsx` and `approvals.tsx` first and match their visual language (dark, clean). Layout:
   - Header: relay connection status + desktop agent state badge (from `agentStatus`; show "unknown" until first status).
   - If there is no trusted desktop (derive: `status === "idle"` and no sessions — or simply always show when agentStatus is null and status is idle): a card prompting to pair, with a button navigating to `/pair`.
   - If `pendingApprovals.length > 0`: a banner button navigating to `/approvals` ("N approvals waiting").
   - Agent status card: state, taskSummary, "updated Xs ago".
   - Sessions section: `remoteSessions` list (title, status badge, started time); Refresh button → `requestSessionList()`; auto-request once on mount.
   - Instruction composer: multiline TextInput + Send button → `sendInstruction`; show errors (empty, too long, not connected) in a small error line, not an alert.
   - Command log: recent entries with status icon (sent … / acked ✓ / failed ✗) and summary.
   - Kill button: prominent red, at the bottom. MUST confirm: `Alert.alert("Kill agent?", "This immediately stops the desktop agent.", [{text:"Cancel", style:"cancel"}, {text:"Kill", style:"destructive", onPress: () => sendKill("user requested from phone")}])`.
4. **TEST** — `apps/mobile/test/control-test.mjs` (plain Node, same compile-to-tmpdir pattern as e2e-test.mjs; compile framing.ts, session.ts, noise.ts, keys.ts, base64.ts, pairing.ts):
   - Establish two Noise sessions in-process (initiator + responder) and wrap them as `{peerDeviceId, handshakeHash, establishedAt, encrypt, decrypt}` adapters, exactly like e2e-test does.
   - STEP 1 (command roundtrip): phone seals a `command_request` → desktop opens → assert instruction + idempotencyKey survive; desktop seals `command_result` → phone opens → assert ok/summary. PASS/FAIL.
   - STEP 2 (status + sessions): `agent_status` and `session_list` (with 2 sessions) roundtrip through seal/open. PASS/FAIL.
   - STEP 3 (kill): `kill_request` roundtrip; then tamper the outer `to` header → open THROWS (bound-header binding holds for the new kinds). PASS/FAIL.
   - STEP 4 (duplicate command): open the same `command_request` envelope twice → second returns `{duplicate:true}` without throwing. PASS/FAIL.
   - STEP 5 (large instruction): 4KB instruction string roundtrips intact. PASS/FAIL.
   - Print PASS/FAIL per step, delete tmpdir, exit 0 iff all pass.

SCOPE — DO NOT DO:
- No push notifications. No risk tiers, no diff summaries (the desktop produces those later; the phone just renders). No secret firewall on the input. No biometric changes. No changes to apps/relay, the relay client, crypto, or framing files. The ONLY protocol change is v1.4 above. Do not persist agentStatus/remoteSessions/commandLog anywhere.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/control-test.mjs` → all five steps PASS
5. Regression: `node apps/mobile/test/pairing-test.mjs && node apps/mobile/test/approvals-test.mjs && node apps/mobile/test/e2e-test.mjs` → all steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/session, apps/mobile/app, apps/mobile/test
2. The protocol v1.4 diff
3. The new provider methods (`sendInstruction`, `requestSessionList`, `sendKill`, `requireDesktopId`) and the three new `handleIncoming` branches
4. The FULL text of apps/mobile/app/index.tsx
5. The FULL terminal output of acceptance commands 1–5
