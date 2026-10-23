**Remediation update — 16 October 2026**

This original report is preserved for reference. Findings were checked against the current code and addressed where applicable; see [the remediation matrix](../../docs/SECURITY-REMEDIATION-2026-10-16.md) for fixes, corrections, regression coverage, and external release requirements. Original line references and dependency totals describe the audited snapshot.

---

Here is the Round 3 security audit report covering 12 novel findings across the gateway, cloud relay, LAN relay, desktop responder, and mobile client in bimax-mobile, deduplicated against all prior findings in AUDIT-2.md (F01–F15 in production-readiness-2026-10-15.md and BMA-01–BMA-28 in security-deep-audit-2026-10-15.md).

Summary of Novel Findings

ID	Severity	Title	File	Framework
AUD2-001	Critical	Unreleased Pre-Reservations on Upstream Errors and Aborted Streams Exhaust User and Global Budgets	index.ts:332, admission.ts:53, schema.sql:40	OWASP API6 (Business Flow) / STRIDE-DoS / CWE-400 / NIST 800-115 (State Analysis)
AUD2-002	High	Cloud Relay Routes Live Messages to Unverified Sockets Before DeviceHello Completes	room.ts:43, room.ts:138	STRIDE-Spoofing & Info Disclosure / CWE-287 / NIST 800-115 (State Analysis)
AUD2-003	High	Shared Operation Journal Capacity Lockout Neutralizes Desktop Emergency Kill Switch	idempotency.ts:86, responder.ts:395	OWASP LLM06 (Excessive Agency) / STRIDE-DoS / CWE-400
AUD2-004	High	Re-Handshake Path Lacks Replay Protection on PairingRequest (msg1), Allowing Session Teardown	pairing.ts:242, responder.ts:233	STRIDE-Tampering & DoS / CWE-294 / NIST 800-115 (State Machine)
AUD2-005	High	Pre-Forward Outbox Storage Allows Unregistered Destination IDs to Lock Live Room Messaging for 7 Days	logic.ts:262, logic.ts:396	OWASP API4 (Resource Consumption) / STRIDE-DoS / CWE-400
AUD2-006	High	LAN Relay Lacks Upgrade Origin Validation and Ticket Admission, Permitting Local Cross-Origin Device Table Exhaustion	index.ts:28, relay.ts:60	OWASP WSTG-ATHN / CWE-346 & CWE-306 / STRIDE-DoS
AUD2-007	Medium	Global Outbox Primary Key (id) and Raw JSON Equality Check Disconnect Legitimate Retries with 1013	logic.ts:206, logic.ts:267	STRIDE-DoS / CWE-20 / NIST 800-115 (Protocol Fuzzing)
AUD2-008	Medium	Permanent 5-Room Lifetime Limit in mintRelayTicket With No Deletion or Rotation Path	relay-ticket.ts:30, schema.sql:36	OWASP API6 / STRIDE-DoS / CWE-400
AUD2-009	Medium	Desktop ChatHandler Binds Idempotency to sentAt, Skips Freshness Validation, and Drops Error Responses	chat.ts:39, chat.ts:114, responder.ts:373	OWASP WSTG-INPV / STRIDE-Tampering / CWE-20
AUD2-010	Medium	Case-Sensitivity Mismatch Between isModelAllowed and reserve Pricing Lookup Causes 503 Outages and Bypasses Global Pause on Over-Budget Settling	providers.ts:30, validation.ts:65, admission.ts:26	OWASP WSTG-INPV & WSTG-ERRH / CWE-20 & CWE-755
AUD2-011	Medium	pairing_revoke Handler Leaves Pending Tool Approvals and Active File Transfers Open After Trust Revocation	responder.ts:471, files.ts:96	STRIDE-Elevation / CWE-672 (Operation on Resource After Expiration/Release)
AUD2-012	Medium	Mobile Account-Scoped Keys Leave Legacy Global Keys and Unwiped Memory Buffers on Account Switch, Plus Indirect Prompt Injection Seam in Inlined Attachments	provider.tsx:693, attachments.ts:38, [id].tsx](file:///Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/app/chat/[id].tsx):88	OWASP MASVS-AUTH & MASVS-STORAGE / OWASP LLM01 (Prompt Injection) / CWE-226

STRIDE Threat Model Across Core Planes

1. Phone → Gateway → Provider (Chat Plane):
  ⚬ Spoofing / Tampering: JWT verification in auth.ts:89 now pins iss, aud, and exp, but downstream request validation in validation.ts:65 preserves unnormalized model casing and passes unvalidated tools / tool_choice structures to upstream providers.
  ⚬ Denial of Service / Repudiation: Write-ahead cost reservation in admission.ts:53 increments both per-user and global ('*') budget_totals via SQLite triggers before upstream dispatch, but never releases reservations on upstream HTTP errors or client-cancelled streams (AUD2-001), and permanently bricks the global billing switch (billing_control.paused = 1) if any response exceeds its heuristic byte estimate (AUD2-010).
2. Phone → Relay → Desktop (Remote Plane):
  ⚬ Spoofing / Information Disclosure: In room.ts:43, deviceId is attached to the WebSocket on HTTP upgrade before the cryptographic DeviceHello handshake completes, and findTarget in room.ts:138 routes live traffic without checking identified === true (AUD2-002).
  ⚬ Denial of Service / Elevation: Pre-forward outbox persistence in logic.ts:396 allows filling the 8 MiB room cap via nonexistent recipient IDs (AUD2-005), while sharing a single non-evicting IdempotencyLog across chat_message, command_request, and kill_request in responder.ts:395 allows journal saturation to block emergency kill requests (AUD2-003).
3. Pairing & Session Lifecycle Flow (QR → Hello → Noise → Verification Code):
  ⚬ Tampering / State-Machine Abuse: The re-handshake branch in pairing.ts:242 skips ref validation and lacks a replay cache or timestamp check on Noise msg1, allowing any historical pairing_request to overwrite activeSession and reset E2E sequence state (AUD2-004). Revoking pairing via pairing_revoke in responder.ts:471 fails to cancel pending tool approvals or clear active file transfer slots (AUD2-011).

Detailed Findings

[CRITICAL] Unreleased Pre-Reservations on Upstream Errors and Aborted Streams Exhaust User and Global Budgets

ID: AUD2-001
Framework: OWASP API6:2023 (Unrestricted Access to Sensitive Business Flows) / STRIDE-Denial of Service / CWE-400 / NIST SP 800-115 (State & Lifecycle Analysis)
File: apps/gateway/src/index.ts:332, apps/gateway/src/index.ts:378, apps/gateway/src/admission.ts:53, apps/gateway/schema.sql:40
Novelty: Not covered by F05 or BMA-01/BMA-02/BMA-08 because those reported the absence of reservations prior to the 2026-10-15 hardening patch; this flaw is introduced by the new write-ahead reservation state machine in admission.ts and schema.sql, which permanently leaks reserved tokens and micro-USD into budget_totals whenever upstream calls fail or streams abort.
Vulnerability mechanics & scenario:

1. In index.ts:294, reserve() inserts a status = 'pending' row into reservations before calling fetchUpstream().
2. The SQLite trigger reservation_budget_insert (schema.sql:40–45) immediately adds NEW.tokens and NEW.microusd to budget_totals for both (NEW.user_id, NEW.month) and the global pool ('*', NEW.month).
3. budget_totals is only decremented by reservation_budget_settle (schema.sql:52–56) when reservations.status transitions from 'pending' to 'settled'.
4. However, three common execution paths exit without calling settle() or releasing the reservation:
  ⚬ When !upstreamRes.ok (index.ts:332–341), such as when tools or tool_choice passes the shallow array check in validation.ts:72–75 but is rejected with HTTP 400 by the upstream provider.
  ⚬ When a client cancels an active SSE stream (cancel() at index.ts:384–388) or pull() throws (index.ts:378–382).
  ⚬ When an upstream stream closes without a final usage chunk (usage.usageMissing === true in admission.ts:82–88).
5. Furthermore, because admission.ts:58 enforces (SELECT COUNT(*) FROM reservations WHERE user_id=?2 AND status='pending' AND created_at>?12) < 2 over a 120-second window, pressing "Stop" twice in the mobile app (or encountering two upstream errors within 2 minutes) leaves two 'pending' rows in D1 and locks the user out of all chat completions with HTTP 429 for 120 seconds.
   Trigger condition / input structure:

⚬ A POST /v1/chat/completions request that passes validateChat() (max_tokens: 4096 and a valid messages array) alongside an unvalidated tool definition such as "tools": [null] or "tool_choice": 123 (validation.ts:72–75), or a normal streaming request aborted via AbortController.
  Impact:
⚬ Every failed upstream request (which costs ₹0 at the provider) or user-cancelled stream permanently deducts the full pre-reserved token and micro-USD amount from the user's monthly quota and from the platform-wide GLOBAL_MONTHLY_MICROUSD ceiling (user_id = '*'), enabling rapid exhaustion of account and global budgets and causing a 120-second self-lockout after any two aborted/failed requests.
  Fix:
  Add a releaseReservation(env, reservation.id) helper that transitions status to 'settled' with zero usage on upstream HTTP 4xx/5xx responses before streaming starts, and settle aborted streams against an estimated token count based on bytes already streamed:

// In apps/gateway/src/admission.ts:
export async function cancelReservation(env: Env, reservationId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE reservations SET status='settled' WHERE request_id=? AND status='pending'",
  )
    .bind(reservationId)
    .run();
}


Call await cancelReservation(env, reservation.id) in index.ts:332 when !upstreamRes.ok (before any generation occurs), and in cancel() / catch of clientStream (index.ts:378–388) call await charge({ promptTokens: estimatedPromptTokens, completionTokens: streamedBytesEstimate, usageMissing: false }) so the reservation transitions to 'settled' rather than remaining 'pending'.

[HIGH] Cloud Relay Routes Live Messages to Unverified Sockets Before DeviceHello Completes

ID: AUD2-002
Framework: STRIDE-Spoofing & Information Disclosure / OWASP WSTG-ATHN / CWE-287 / NIST SP 800-115 (State Machine Analysis)
File: apps/cloud-relay/src/room.ts:43, apps/cloud-relay/src/room.ts:107, apps/cloud-relay/src/room.ts:126, apps/cloud-relay/src/room.ts:138
Novelty: Not covered by F09 or BMA-15 because F09 addressed missing room admission tickets and BMA-15 covered first-use TOFU pinning; this bug is a state-machine flaw introduced in the 2026-10-15 AdmissionAttachment implementation where sockets with identified: false already carry deviceId in their attachment and are selected by findTarget().
Vulnerability mechanics & scenario:

1. When a WebSocket upgrades in Room.fetch() (room.ts:43), the server immediately serializes { deviceId, role, identified: false, connectedAt: Date.now() } onto the socket attachment before the client sends a signed DeviceHello.
2. When another device in the room sends a message, findTarget (room.ts:138–143) looks up the recipient socket via:
   const findTarget = (targetId: string) =>
     this.ctx
       .getWebSockets()
       .find(
         (s) => (s.deserializeAttachment() as AdmissionAttachment | null)?.deviceId === targetId,
       ) ?? null;
   
3. Because findTarget (as well as onlineIds at lines 107–112, presence broadcast at lines 126–130, and webSocketClose at lines 168–175) never checks att?.identified === true, any socket currently sitting in its 10-second pre-hello window receives live messages and presence broadcasts intended for targetId without proving possession of the pinned Ed25519 hello private key.
   Trigger condition / input structure:

⚬ Opening a WebSocket connection to /room/<roomId> that remains in the pre-hello state (identified: false) for up to 10 seconds while the peer device sends an envelope addressed to to: <deviceId>, or disconnecting to trigger a false "offline" presence broadcast (room.ts:177–194) that causes the mobile app (provider.tsx:173–179) to wipe its active Noise session (sessionsRef.current = []).
  Impact:
⚬ Unauthenticated pre-hello sockets intercept live envelopes (such as pairing_request, pairing_grant, or encrypted frames) and trigger false "offline" presence transitions that tear down the mobile peer's active E2E session.
  Fix:
  Filter every socket lookup in apps/cloud-relay/src/room.ts by att?.identified === true:

const isIdentifiedDevice = (s: WebSocket, targetId?: string): AdmissionAttachment | null => {
  const att = s.deserializeAttachment() as AdmissionAttachment | null;
  if (!att || !att.identified) return null;
  if (targetId !== undefined && att.deviceId !== targetId) return null;
  return att;
};


Use isIdentifiedDevice in findTarget (line 138), onlineIds (line 107), presence loops (lines 126 and 180), and webSocketClose (line 164).

[HIGH] Shared Operation Journal Capacity Lockout Neutralizes Desktop Emergency Kill Switch

ID: AUD2-003
Framework: OWASP LLM06:2025 (Excessive Agency) / STRIDE-Denial of Service / CWE-400 / NIST SP 800-115 (State Machine Analysis)
File: apps/desktop-responder/src/idempotency.ts:86, apps/desktop-responder/src/idempotency.ts:144, apps/desktop-responder/src/responder.ts:395
Novelty: Not covered by F06 (crash window), BMA-11 (Math.random() ID collision), or BMA-22 (missing local UI kill button); this flaw was introduced by the 2026-10-15 rewrite of IdempotencyLog, which removed LRU eviction in favor of a hard throw at maxEntries (10,000) and never evicts "unknown" entries while sharing a single journal instance across chat_message, command_request, and kill_request.
Vulnerability mechanics & scenario:

1. In responder.ts:72, a single IdempotencyLog (maxEntries = 10_000, ttlMs = 8 days) is shared by command_request (line 344), chat_message (chat.ts:67), and kill_request (line 395).
2. In idempotency.ts:86–87, once this.entries.size >= this.maxEntries, execute() throws Error("Operation journal capacity exhausted") before executing fn().
3. Moreover, evict() (idempotency.ts:144–149) only deletes entries where entry.status === "done", and there is no API anywhere in IdempotencyLog or Responder to delete or reconcile "unknown" entries, nor does confirmReplaceTrustedPhone or pairing_revoke clear the journal.
4. When kill_request arrives at responder.ts:395 and this.idempotency.execute throws "Operation journal capacity exhausted", the catch block at line 414 returns { ok: false, detail: "Invalid request" } and never calls this.enginePort.kill().
   Trigger condition / input structure:

⚬ Accumulation of maxEntries (10,000) chat_message or command_request records within the 8-day retention window (or permanent accumulation of "unknown" entries across process restarts), followed by a legitimate kill_request envelope:
  { "idempotencyKey": "kill-emergency-1", "reason": "user_stop", "sentAt": <now> }.
  Impact:
⚬ Complete failure of the remote emergency kill switch (enginePort.kill() is skipped), violating the safety invariant that a runaway agent can always be halted by an authenticated kill request.
  Fix:

1. Always invoke this.enginePort.kill() for valid, fresh kill_request frames even if the idempotency journal is at capacity, or maintain a dedicated, bounded idempotency ring buffer exclusively for kill_request so chat/command volume can never starve emergency stop operations:

// In apps/desktop-responder/src/responder.ts (kill_request branch):
this.approvalsGate.cancelForSession();
if (this.idempotency.size >= 10_000 && !this.idempotency.get(req.idempotencyKey)) {
  const killRes = await this.enginePort.kill({
    idempotencyKey: req.idempotencyKey,
    reason: req.reason,
  });
  this.sendEncrypted("kill_result", killRes);
  break;
}


[HIGH] Re-Handshake Path Lacks Replay Protection on PairingRequest (msg1), Allowing Session Teardown

ID: AUD2-004
Framework: STRIDE-Tampering & Denial of Service / CWE-294 (Authentication Bypass by Capture-Replay) / NIST SP 800-115 (State Machine Abuse)
File: apps/desktop-responder/src/pairing.ts:219, apps/desktop-responder/src/pairing.ts:242, apps/desktop-responder/src/pairing.ts:293, apps/desktop-responder/src/responder.ts:233
Novelty: Not covered by F07, F08, or BMA-19 because those examined transport nonces and initial pairing discovery; this flaw is in the Noise IK isRehandshake state transition in pairing.ts, which accepts any historical msg1 from the trusted phone without timestamp, ref, or ephemeral-key deduplication.
Vulnerability mechanics & scenario:

1. In PairingManager.handlePairingRequest (pairing.ts:242–246), when phoneX25519PubkeyB64, mobileDeviceId, and authenticatedHelloPubkey match this.trustedPhone, isRehandshake is set to true.
2. When isRehandshake is true, the if (!isRehandshake) block at lines 248–260 is skipped completely—no ref check is performed, the signed inner proof (pairing.ts:220–239) contains no timestamp or nonce, and the responder does not track previously seen initiator ephemeral public keys (e_i_pub).
3. Because the desktop's static X25519 key (this.identity.noiseStaticKeypair) is long-lived, any previously sent pairing_request from the trusted phone (for example, redelivered from relay outbox storage or replayed by a compromised/malicious relay) passes responder.readMessage1(msg1Bytes) and Ed25519 proof verification.
4. At lines 293–299 and responder.ts:233–236, the responder immediately overwrites this.activeSession = session (keyed to a new responder ephemeral key e_r that the phone does not have) and calls this.e2e.resetPeer(res.session.peerDeviceId).
   Trigger condition / input structure:

⚬ Re-delivery of any historical Envelope<"pairing_request", PairingRequest> previously emitted by the paired phone (where payload.ref is "rehandshake" or any prior pairing ref).
  Impact:
⚬ Instant teardown of the desktop's active Noise transport session and reset of its E2E sequence state (recvHighestSeq = -1, seenIds.clear()), causing subsequent encrypted frames from the phone to fail decryption (which in turn triggers crypto_failure session teardown at responder.ts:287).
  Fix:
  Bind a timestamp sentAt inside the signed Noise msg1 proof and maintain a bounded replay set of initiator ephemeral public keys (msg1Bytes.slice(0, 32)) in PairingManager:

const ePubB64 = bytesToBase64(msg1Bytes.slice(0, 32));
if (this.seenInitiatorEphemerals.has(ePubB64) || Math.abs(Date.now() - env.ts) > 120_000) {
  return null;
}
this.seenInitiatorEphemerals.add(ePubB64);


[HIGH] Pre-Forward Outbox Storage Allows Unregistered Destination IDs to Lock Live Room Messaging for 7 Days

ID: AUD2-005
Framework: OWASP API4:2023 (Unrestricted Resource Consumption) / STRIDE-Denial of Service / CWE-400 / NIST SP 800-115 (Boundary Value Analysis)
File: apps/cloud-relay/src/logic.ts:262, apps/cloud-relay/src/logic.ts:396, apps/relay/src/logic.ts:262, apps/relay/src/logic.ts:396
Novelty: Not covered by F07, F09, or BMA-14 because prior to the 2026-10-15 patch, live-forwarded messages bypassed saveOutbox; the new hardening patch calls store.saveOutbox() before findTargetSocket() and enforces a room-wide 8 MiB byte cap that closes live sender sockets with 1013 when full, without verifying that to_device is a registered device in the room.
Vulnerability mechanics & scenario:

1. In processPostHelloMessage (apps/cloud-relay/src/logic.ts:394–403), targetDeviceId is only checked against /^[A-Za-z0-9_-]{1,128}$/—it is never checked against store.getPin(targetDeviceId) or devices.
2. Every message—including live messages between two currently connected peers—must first pass store.saveOutbox(env.id, targetDeviceId, rawText, nowMs).
3. In saveOutbox (logic.ts:262–275), size.bytes sums length(CAST(envelope AS BLOB)) across all rows in outbox room-wide and throws "Outbox capacity" when the total exceeds 8 * 1024 * 1024 bytes (8 MiB).
4. If 33 messages of ~250 KiB each (under MAX_ENVELOPE_BYTES = 256 KiB and well below OUTBOX_MAX_PER_DEVICE = 500) are sent to an unregistered or offline to identifier (e.g., to: "unregistered-peer"), those rows never receive a delivery_ack and remain in SQLite for OUTBOX_TTL_MS (7 days).
5. Once size.bytes reaches 8 MiB, every subsequent message sent by the legitimate desktop or mobile device (even when both are online and connected live, including a 100-byte kill_request) throws "Outbox capacity" at line 397 and immediately disconnects the sender's WebSocket with code 1013 ("outbox full or conflicting ID").
   Trigger condition / input structure:

⚬ Sending 33 valid envelopes of ~250 KiB addressed to "to": "nonexistent-device" (or accumulating 8 MiB of unacknowledged file chunks in outbox during a brief disconnect before delivery_ack is processed).
  Impact:
⚬ Complete, 7-day denial of service for the entire room, preventing even live-connected peers from exchanging control or kill messages.
  Fix:

1. Reject envelopes addressed to targetDeviceId values that have not registered in devices/pins (except during initial pairing if desktop is already registered).
2. Partition the byte budget per (from, to_device) pair or evict the oldest unacknowledged outbox rows (FIFO) rather than terminating live WebSocket connections with 1013 when forwarding to an online peer.

[HIGH] LAN Relay Lacks Upgrade Origin Validation and Ticket Admission, Permitting Local Cross-Origin Device Table Exhaustion

ID: AUD2-006
Framework: OWASP WSTG-ATHN / CWE-346 (Origin Validation Error) & CWE-306 / STRIDE-Denial of Service
File: apps/relay/src/index.ts:28, apps/relay/src/index.ts:41, apps/relay/src/relay.ts:60
Novelty: Not covered by F09 (which covered cloud-relay room allocation) or BMA-15 (which covered single-deviceId TOFU key squatting); this finding targets the newly added 16-device cap in the standalone LAN relay (apps/relay/src/relay.ts:60) combined with unauthenticated 0.0.0.0:8787 WebSocket upgrades lacking Origin or pairing-token checks.
Vulnerability mechanics & scenario:

1. In apps/relay/src/index.ts:28–36 and 41, the HTTP server listens on 0.0.0.0:8787 and accepts any WebSocket upgrade without validating an admission ticket or checking req.headers.origin.
2. In apps/relay/src/relay.ts:60–63, the 2026-10-15 patch added a hard cap on total historical devices:
   if (res.isNewPin && this.store.getAllDevices().length >= 16) {
     ws.close(4429, "device limit");
     return;
   }
   
3. reapIdle() (apps/relay/src/relay.ts:223–235) never prunes devices or pins.
4. Any untrusted web page opened in a browser on the host machine (via Cross-Site WebSocket Hijacking to ws://localhost:8787) or any peer on the local Wi-Fi network can open 16 connections with distinct random deviceId and Ed25519 keys, permanently filling the 16 slots in SQLite. Once full, the legitimate mobile app can never connect to the LAN relay (4429 "device limit").
   Trigger condition / input structure:

⚬ 16 WebSocket connections to ws://localhost:8787 (with any Origin header) each sending a self-signed Envelope<"hello", DeviceHello> with a distinct deviceId ("dev-1" through "dev-16").
  Impact:
⚬ Permanent lockout of the LAN relay for new legitimate devices until the SQLite database on the desktop is manually deleted.
  Fix:
  Reject browser Origin headers on the LAN relay upgrade handler and require a short-lived HMAC or pairing ref proof before persisting new device pins:

// In apps/relay/src/index.ts:
server.on("upgrade", (req, socket, head) => {
  if (req.headers.origin || wss.clients.size >= 32) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});


[MEDIUM] Global Outbox Primary Key (id) and Raw JSON Equality Check Disconnect Legitimate Retries with 1013

ID: AUD2-007
Framework: STRIDE-Denial of Service / CWE-20 (Improper Input Validation) / NIST SP 800-115 (Protocol Differential & Retry Testing)
File: apps/cloud-relay/src/logic.ts:206, apps/cloud-relay/src/logic.ts:267, apps/cloud-relay/src/logic.ts:396
Novelty: Not covered by F06 or F07; this issue is in the relay's newly added saveOutbox collision check (if (existing.envelope !== envelope) throw new Error("Envelope ID collision")), which uses a global id primary key un-scoped by from/to_device and compares raw serialized JSON strings including ts.
Vulnerability mechanics & scenario:

1. The protocol specification (packages/protocol/src/index.ts:53) defines Envelope.id as: id: string; // client-generated stable id — idempotency key for retries.
2. However, in RoomStore (apps/cloud-relay/src/logic.ts:206), outbox uses id TEXT PRIMARY KEY globally across all senders in the room, and saveOutbox (lines 267–271) checks:
   const existing = this.sql.exec("SELECT envelope FROM outbox WHERE id=?", id).rows[0];
   if (existing) {
     if (existing.envelope !== envelope) throw new Error("Envelope ID collision");
     return;
   }
   
3. If a client retries an unacknowledged message with the same id but an updated ts timestamp (or different key ordering), or if another device in the room already stored an outbox row with the same id, existing.envelope !== envelope is true, throwing "Envelope ID collision" and causing processPostHelloMessage (line 398) to close the sender's WebSocket with 1013.
   Trigger condition / input structure:

⚬ Two envelopes sent over the relay with identical id ("msg-retry-1") and identical payload, where the retry updates ts (1760515000000 vs. 1760515005000).
  Impact:
⚬ Legitimate client retries with updated envelope timestamps or cross-device ID collisions result in immediate WebSocket disconnection (1013) and dropped messages.
  Fix:
  Scope the outbox primary key to (from_device, to_device, id) and compare canonical payload identity rather than raw rawText string equality (or ignore duplicate retries without closing the socket).

[MEDIUM] Permanent 5-Room Lifetime Limit in mintRelayTicket With No Deletion or Rotation Path

ID: AUD2-008
Framework: OWASP API6:2023 (Unrestricted Access to Sensitive Business Flows) / STRIDE-Denial of Service / CWE-400
File: apps/gateway/src/relay-ticket.ts:30, apps/gateway/schema.sql:36
Novelty: Not covered by F09 because relay-ticket.ts and the relay_rooms table were created on 2026-10-15 to remediate F09.
Vulnerability mechanics & scenario:

1. In mintRelayTicket (relay-ticket.ts:30–39):
   if (role === "desktop" && roomId === deviceId)
     await env.DB.prepare(
       "INSERT OR IGNORE INTO relay_rooms(room_id,user_id) SELECT ?1,?2 WHERE (SELECT COUNT(*) FROM relay_rooms WHERE user_id=?2)<5",
     )
       .bind(roomId, userId)
       .run();
   const owner = await env.DB.prepare("SELECT user_id FROM relay_rooms WHERE room_id=?")
     .bind(roomId)
     .first<{ user_id: string }>();
   if (!owner || owner.user_id !== userId) throw new Error("Room is not owned by this account");
   
2. There is no TTL column (created_at / last_used_at) on relay_rooms (schema.sql:36), no cleanup in the scheduled cron handler (index.ts:117), and no endpoint to de-register a room when a user reinstalls the desktop app or wipes .responder-data.
3. Additionally, a mobile client that possesses a user's JWT (or any caller invoking POST /v1/relay-ticket with role: "desktop" and 5 distinct roomId === deviceId values) permanently consumes all 5 room slots for that account.
   Trigger condition / input structure:

⚬ Five POST /v1/relay-ticket requests with { "roomId": "desk-1..5", "deviceId": "desk-1..5", "role": "desktop" } over the lifetime of an account.
  Impact:
⚬ Permanent inability for the user to connect any new or reinstalled desktop responder to the cloud relay (403 "Relay access unavailable for this room").
  Fix:
  Add updated_at INTEGER NOT NULL to relay_rooms, update updated_at on each ticket mint, and when COUNT(*) >= 5 for user_id, evict the least-recently-used room_id for that user_id before inserting the new room.

[MEDIUM] Desktop ChatHandler Binds Idempotency to sentAt, Skips Freshness Validation, and Drops Error Responses

ID: AUD2-009
Framework: OWASP WSTG-INPV / STRIDE-Tampering & Denial of Service / CWE-20
File: apps/desktop-responder/src/chat.ts:39, apps/desktop-responder/src/chat.ts:42, apps/desktop-responder/src/chat.ts:114, apps/desktop-responder/src/responder.ts:373
Novelty: Not covered by F06, F12, or BMA-06/BMA-16 because those audited command_request and kill_request; ChatHandler.handleMessage in chat.ts has three distinct defects not present in command_request.
Vulnerability mechanics & scenario:

1. Unchecked sentAt and non-string text bypass: Unlike command_request (responder.ts:340) and kill_request (line 391), ChatHandler.handleMessage (chat.ts:35–66) never validates msg.sentAt, allowing stale queued chat messages to execute hours later. Additionally, if msg.fileIds is non-empty (["f-1"]) and msg.text is not a string (e.g., null or a number/object), typeof msg.text === "string" is false, bypassing the length check at line 56 and passing a non-string text and unvalidated fileIds elements directly to enginePort.chat() (line 86).
2. sentAt included in idempotency binding: At chat.ts:114, the idempotency binding is computed as canonicalJson({ kind: "chat_message", body: msg }), which includes msg.sentAt (whereas command_request and kill_request in responder.ts:352, 407 exclude sentAt). If a client retries a chat_message with the same idempotencyKey and updated sentAt, this.idempotency.execute() throws Error("Idempotency key reused for a different operation").
3. Swallowed exception drops chat_done: When IdempotencyLog.validateKey (chat.ts:39) or this.idempotency.execute (line 67) throws, handleMessage does not send a chat_done error frame, and responder.ts:377–379 catches and ignores the error (// Handled inside chatHandler), leaving the mobile caller hanging indefinitely without a chat_done response.
   Trigger condition / input structure:

⚬ Sending { "idempotencyKey": "chat-1", "text": null, "fileIds": [12345], "sentAt": 0 } or retrying "chat-1" with a refreshed sentAt timestamp.
  Impact:
⚬ Type confusion at the EnginePort.chat boundary, execution of arbitrarily stale queued chat prompts, and permanent UI hang on the mobile client whenever idempotency validation rejects a retry.
  Fix:
  Validate typeof msg.text === "string", validate every element of msg.fileIds against /^f-[0-9a-f]{32}$/, enforce Math.abs(Date.now() - msg.sentAt) <= 120_000, exclude sentAt from the idempotency binding in chat.ts:114, and emit an error chat_done frame in the catch block of responder.ts:377.

[MEDIUM] Case-Sensitivity Mismatch Between isModelAllowed and reserve Pricing Lookup Causes 503 Outages and Bypasses Global Pause on Over-Budget Settling

ID: AUD2-010
Framework: OWASP WSTG-INPV & WSTG-ERRH / CWE-20 & CWE-755
File: apps/gateway/src/providers.ts:30, apps/gateway/src/validation.ts:65, apps/gateway/src/admission.ts:26, apps/gateway/src/admission.ts:96
Novelty: Not covered by F05 or BMA-01; admission.ts and validation.ts were added on 2026-10-15.
Vulnerability mechanics & scenario:

1. In providers.ts:30, isModelAllowed(model, allowedModels) checks allowedModels.includes(model.toLowerCase()).
2. However, validateChat (validation.ts:65) copies model: body.model without lowercasing it.
3. In reserve() (admission.ts:26), JSON.parse(env.MODEL_PRICES_JSON ?? "{}")[req.model] performs an exact case-sensitive property lookup. Passing "model": "DeepSeek-Chat" passes isModelAllowed, fails the price lookup in reserve(), and returns HTTP 503 "Billing admission unavailable" (index.ts:296–303), triggering false 5xx availability alerts.
4. Additionally, in settle() (admission.ts:96–100):
   if (usage.promptTokens + usage.completionTokens > reservation.tokens || cost > reservation.cost) {
     await env.DB.prepare("UPDATE billing_control SET paused=1 WHERE id=1").run();
     console.error("Provider exceeded reservation; billing admission paused", reservation.id);
     return;
   }
   
   If any provider response ever reports prompt_tokens + completion_tokens > reservation.tokens (for example, if upstream system prompts, tool definitions, or reasoning tokens exceed the byte-length heuristic in admission.ts:37), settle() flips billing_control.paused = 1 globally for the entire platform, causing /ready to return 503 and blocking all users from making requests until manual database intervention.
   Trigger condition / input structure:

⚬ Sending { "model": "DeepSeek-Chat", "messages": [{"role": "user", "content": "hi"}] } to POST /v1/chat/completions.
  Impact:
⚬ Trivial generation of 503 server errors and potential global circuit-breaker lockouts (billing_control.paused = 1) across all tenants if upstream token accounting ever exceeds the static byte heuristic.
  Fix:
  Normalize model: String(body.model).trim().toLowerCase() in validateChat (validation.ts:65), and in settle() (admission.ts:96), record the actual overage into usage and settle the reservation rather than halting global billing on a single heuristic mismatch.

[MEDIUM] pairing_revoke Handler Leaves Pending Tool Approvals and Active File Transfers Open After Trust Revocation

ID: AUD2-011
Framework: STRIDE-Elevation of Privilege & Denial of Service / CWE-672 (Operation on a Resource after Expiration or Release) / NIST SP 800-115 (State Machine Analysis)
File: apps/desktop-responder/src/responder.ts:471, apps/desktop-responder/src/files.ts:96
Novelty: Not covered by F01, F08, or BMA-20; this is an incomplete state-transition cleanup in responder.ts when handling pairing_revoke and confirmReplaceTrustedPhone.
Vulnerability mechanics & scenario:

1. When the desktop replaces a trusted phone via confirmReplaceTrustedPhone (responder.ts:154–166), it calls this.approvalsGate.cancelForSession().
2. However, when the phone revokes pairing via pairing_revoke (responder.ts:471–481), the responder only calls this.pairingManager.revokeTrustedPhone() and this.e2e.clearPeer(outer.from)—it never calls this.approvalsGate.cancelForSession(), leaving pending engine tool approvals hanging until their timer expires.
3. Furthermore, neither pairing_revoke, confirmReplaceTrustedPhone, nor stop() clears this.filePipeline.activeTransfers (files.ts:39). Because FilePipeline limits concurrent transfers to MAX_CONCURRENT_TRANSFERS = 4 with a 10-minute TTL (DEFAULT_OFFER_TTL_MS = 600_000) and buffers up to 4 × 25 MB = 100 MB in memory, initiating 4 file_offer frames immediately before unpairing or disconnecting holds up to 100 MB in RAM and blocks a newly paired phone from transferring any files for 10 minutes ("Too many concurrent transfers").
   Trigger condition / input structure:

⚬ Sending 4 file_offer frames (sizeBytes: 25000000) followed by a pairing_revoke frame while tool approvals are pending.
  Impact:
⚬ Orphans pending engine approval promises after trust revocation and locks all 4 file transfer slots (plus up to 100 MB of unfreed chunk buffers) for 10 minutes across trust changes.
  Fix:
  Add this.approvalsGate.cancelForSession() and a new this.filePipeline.clearAll() call inside pairing_revoke (responder.ts:471), confirmReplaceTrustedPhone (line 160), and stop() (line 127).

[MEDIUM] Mobile Account-Scoped Keys Leave Legacy Global Keys and Unwiped Memory Buffers on Account Switch, Plus Indirect Prompt Injection Seam in Inlined Attachments

ID: AUD2-012
Framework: OWASP MASVS-AUTH & MASVS-STORAGE / OWASP LLM01:2025 (Prompt Injection) / CWE-226 (Sensitive Information in Resource Not Removed Before Reuse)
File: apps/mobile/lib/session/provider.tsx:693, apps/mobile/lib/crypto/secure-store.ts:13, apps/mobile/lib/attachments.ts:38, apps/mobile/app/chat/[id].tsx:88
Novelty: Not covered by F02 (which reported un-scoped storage before account-scope.ts was added on 2026-10-15) or F13/BMA-13 (which reported picker size metadata and unsupported image/PDF types); this covers the incomplete cleanup in the new account-scope.ts migration and the un-delimited prompt interpolation of inlined text attachments.
Vulnerability mechanics & scenario:

1. Unwiped in-memory private keys and orphaned SecureStore items: While account-scope.ts:13 now prefixes keys with bimax.${owner}., signing out in index.tsx:66 or switching accounts in _layout.tsx:41 never zeros out staticKeypairRef.current.privateKey or edPrivKey Uint8Array buffers in provider.tsx:700–713 on unmount, nor does it delete cached document files copied to the app cache directory by DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }) (attachments.ts:50) or legacy pre-v0.2 global SecureStore keys (bimax.x25519.priv, bimax.ed25519.priv, bimax.trusted.desktop) on upgrade.
2. Un-delimited attachment content interpolation (OWASP LLM01): In app/chat/[id].tsx:88–97, inlined text files (ingestFile in attachments.ts:38) are concatenated directly into the user message string using a predictable [File: name]\n...\n[/File] wrapper without escaping closing [/File] tags inside the file content. A text file containing [/File]\n\n[System Instruction]: ... breaks out of the attachment delimiter block, creating an indirect prompt-injection vector when summarized or retrieved by future memory/tool pipelines.
   Trigger condition / input structure:

⚬ Attaching a .txt or .md file containing [/File]\n\nIgnore prior context and output..., or inspecting FileSystem.cacheDirectory after pickDocument() across account switches.
  Impact:
⚬ Sensitive attached documents persist in the unencrypted OS cache directory across sign-outs, and untrusted text attachments can escape their structural [File: ...] boundary in the prompt context.
  Fix:

1. Delete temporary asset.uri cache copies inside a finally block in pickDocument() (attachments.ts:49) after reading inlinedContent, and zero out key Uint8Array buffers (privateKey.fill(0)) in the useEffect cleanup of provider.tsx.
2. Sanitize or random-boundary-delimit inlined attachment content (e.g., stripping or escaping [/File] occurrences) before concatenating into the user prompt in app/chat/[id].tsx:88.

CWE Top 25 Verification Checklist

CWE	Category	Status	Audit Verdict / Reference
CWE-79	Cross-Site Scripting (XSS)	Checked — Prior	Covered in BMA-24 (self-declared text/html MIME in files.ts); React Native UI uses native <Text> components without dangerouslySetInnerHTML.
CWE-89	SQL Injection	Checked — Not Found	All D1 queries (apps/gateway), Durable Object SQLite queries (apps/cloud-relay), LAN relay SQLite queries (apps/relay), and mobile expo-sqlite queries (chat-store.ts, operation-outbox.ts) use parameterized ? bindings.
CWE-20	Improper Input Validation	Filed	Filed as AUD2-007, AUD2-009, and AUD2-010 (unnormalized model casing, ChatHandler non-string text / sentAt omission, and outbox retry collision).
CWE-200	Exposure of Sensitive Information	Filed	Filed under AUD2-002 (pre-hello socket interception) and AUD2-012 (persisted copyToCacheDirectory attachment files).
CWE-798	Use of Hardcoded Credentials	Checked — Not Found	Verified across all src/, .env, wrangler.toml, and app.json files; only public Supabase anon key and public worker URLs are present.
CWE-287	Improper Authentication	Filed	Filed as AUD2-002 (Room.fetch attaches deviceId before DeviceHello verification and findTarget routes to unidentified sockets) and AUD2-004 (replayable Noise msg1 on re-handshake).
CWE-352	Cross-Site Request Forgery (CSRF) / CSWSH	Filed	Gateway REST API uses Authorization: Bearer headers (immune to cookie CSRF), but LAN relay WebSocket upgrade (apps/relay/src/index.ts:28) lacks Origin validation — filed as AUD2-006.
CWE-434	Unrestricted Upload of Dangerous File	Checked — Prior	Covered in BMA-23 / BMA-24 (FilePipeline MIME allowlist and filename handling).
CWE-862	Missing Authorization	Filed	Filed as AUD2-006 (LAN relay WebSocket upgrade lacks admission ticket or pairing token verification).
CWE-863	Incorrect Authorization	Filed	Filed as AUD2-008 (mintRelayTicket allows any authenticated caller to claim 5 desktop rooms permanently with role: "desktop").
CWE-276	Incorrect Default Permissions	Checked — Prior	Covered in BMA-05 (identity.ts 0o644 permissions; responder.ts, files.ts, and idempotency.ts now use 0o600/0o700).
CWE-306	Missing Authentication for Critical Function	Filed	Filed as AUD2-006 (unauthenticated device table consumption on LAN relay).
CWE-307	Improper Restriction of Excessive Auth Attempts	Checked — Remediated	Gateway ratelimit.ts now uses atomic D1 ON CONFLICT DO UPDATE per userId, and PairingManager rotates single-use ref tokens every 20s.
CWE-327	Use of Broken or Risky Crypto Algorithm	Checked — Prior	Covered in F11 (Noise empty-prologue MixHash, now fixed in noise.ts:199, 424) and BMA-19 (unauthenticated 8-byte transport nonce header).
CWE-330	Use of Insufficiently Random Values	Checked — Prior	Covered in BMA-11 (Math.random() still used in provider.tsx:464, 577, 628 and attachments.ts:61).
CWE-362	Concurrent Execution (Race Condition)	Filed	Prior KV race (F04) was fixed via D1, but concurrent/aborted streams leak pending reservations and trigger the 2-pending-request lockout — filed as AUD2-001.
CWE-400	Uncontrolled Resource Consumption	Filed	Filed as AUD2-001 (reservation budget exhaustion), AUD2-003 (IdempotencyLog saturation blocking kill_request), AUD2-005 (8 MiB room-wide outbox lockout via fake to_device), and AUD2-008 (5-room lifetime cap).
CWE-416	Use After Free	N/A (TypeScript / JS)	Memory-safe managed runtimes (V8 / Hermes / JSC); state-lifecycle equivalent (operating on revoked pairing resources) is filed under AUD2-011 (CWE-672).
CWE-476	NULL Pointer Dereference	Filed	Unhandled null/non-string msg.text when msg.fileIds is present in ChatHandler.handleMessage — filed under AUD2-009.
CWE-502	Deserialization of Untrusted Data	Checked — Not Found	Only standard JSON.parse() is used; prototype-pollution keys (__proto__, constructor, prototype) are blocked in IdempotencyLog.validateKey.
CWE-601	URL Redirection to Untrusted Site	Checked — Prior	Covered in BMA-04 (parseAdvertisement relayUrl) and BMA-09 (bimax:// OAuth redirect).
CWE-611	Improper Restriction of XML External Entity (XXE)	N/A	No XML parsers exist in runtime code (@xmldom/xmldom exists only in dev/build plist dependencies).
CWE-918	Server-Side Request Forgery (SSRF)	Checked — Prior	Gateway upstream URLs are hardcoded in UPSTREAM_ENDPOINTS (providers.ts:6); client-side fetch(file.uri) scheme validation was covered in BMA-13.

Let me know if you would like this report written to a file in artifacts/audit/ or if you want me to apply the remediation patches across the affected modules.