**Security remediation — 16 October 2026**

This update covers the twelve Round 3 findings and the outstanding BMA findings in the earlier deep audit. Both reports are preserved under `artifacts/audit/`. Changes are local; no production service, account, or device has been modified. The original audit scores describe an earlier snapshot.

**Round 3 dispositions**

| Finding | Implemented behavior |
| --- | --- |
| AUD2-001 | Definitive pre-generation rejection releases allocation through a zero-usage settlement. Cancellation, network ambiguity, missing usage, and provider 5xx outcomes finalize a conservative estimated charge, release the concurrency slot, and remain reconcilable against verified provider records. A five-minute scheduled recovery finalizes interrupted pending requests using an indexed lookup. |
| AUD2-002 | Cloud routing, presence, replacement, and close handling use identified sockets only. A real Durable Object regression covers a pre-hello socket with the same device ID. |
| AUD2-003 | Valid emergency stop bypasses the execution journal. `emergencyStop()` also works locally without a relay. Unknown journal entries have an explicit local reconciliation API, preserving protection against automatic re-execution. |
| AUD2-004 | Signed Noise msg1 proof includes a two-minute freshness window. A persisted bounded ephemeral replay cache rejects re-delivery, including after a restart, before changing the active session. |
| AUD2-005 | Unknown destinations cannot allocate outbox space. Destination queues are bounded separately and expire after two minutes. A full queue cannot block best-effort delivery to a verified live socket; durable logical retries remain at endpoints. |
| AUD2-006 | Browser Origin upgrades are rejected. The LAN relay binds to loopback by default. Binding to the network requires an admission token of at least 32 characters, checked before upgrade. |
| AUD2-007 | Outbox keys include sender, recipient, and ID. Retries compare canonical semantic envelopes, excluding transport timestamps. ACKs include the original sender. Conflicts are rejected without disconnecting legitimate traffic. |
| AUD2-008 | Account-owned room listing and explicit removal allow replacing desktops without a lifetime quota lockout. Last-used timestamps are recorded; active rooms are never silently evicted. |
| AUD2-009 | Desktop chat validates text, file IDs, session ID, and freshness; its binding excludes sentAt and includes the peer. All validation, journal, and authorization failures produce an error completion. |
| AUD2-010 | Models are normalized consistently. Verified provider overages are recorded at actual cost and logged; a single mismatch no longer pauses the entire platform. Subsequent admission still checks total spend. |
| AUD2-011 | Revocation, replacement, and shutdown deny pending approvals, invalidate pending consent, clear transfers, and wipe their buffered chunks. In-progress file finalization checks its revocation generation before attaching to the engine. |
| AUD2-012 | Key buffers and Noise sessions are disposed on account teardown. Legacy global device credentials are removed. Picker cache copies are deleted in finally blocks. Attachments are JSON string data with separate model guidance about untrusted documents. |

The proposed zero-cost cancellation in the report is unsafe when a provider has already generated tokens. A stopped stream is not evidence of zero provider cost. Estimated usage is explicitly marked `usage_missing=1`; `reconcileUsage(env, requestId, promptTokens, completionTokens, evidence)` updates it once using the original price snapshot and transactional budget deltas. This function is for a trusted operator/billing integration and is not exposed to mobile callers. Original token bounds on estimated rows are allocation estimates, not measured prompt-token counts. Neither estimated usage nor unknown engine effects should be deleted simply to regain capacity.

**Earlier BMA dispositions**

| Findings | Disposition |
| --- | --- |
| BMA-01, 02, 03, 07, 08 | Server-side output caps, parameter allowlisting, bounded JSON/history, atomic cost/token admission, and tool structure validation. Invalid definitions are rejected before reserving or dispatching. |
| BMA-04, 12, 25 | QR parsing, saved trust, and both socket clients enforce WSS for public hosts. WS is limited to literal loopback/RFC1918 addresses and localhost. QR Noise keys must decode to 32 bytes. |
| BMA-05 | Production identity uses the OS encryption adapter. Existing development identity files are tightened to 0600; private data directories and logs use restrictive modes. |
| BMA-06, 16, 22 | A mandatory injected `HostControls` adapter provides local consent and session visibility before commands, chat, or engine file attachment. Instructions are privately audited before dispatch. Local stop bypasses transport and journal availability. The external desktop host now wires native consent, a banner/menu indicator and local Stop; installed phone/engine qualification remains open. A string blocklist is not treated as a sandbox. |
| BMA-09 | Production social login requires an HTTPS callback configured for verified iOS Universal Links/Android App Links. Without configuration the production build offers email sign-in. Development may use the existing PKCE custom scheme. Domain ownership and association files must be deployed by the operator. |
| BMA-10 | Message content, reasoning, conversation titles, and command bodies use authenticated XChaCha20-Poly1305 encryption with account keys in SecureStore. Existing account databases are migrated transactionally, with secure-delete, VACUUM, and WAL truncation. Unowned legacy history is encrypted under a separate recovery namespace and is never assigned to an account. Android app backups are disabled. IDs, model names, roles, and timestamps remain metadata. |
| BMA-11 | Pairing, transport, command/kill, attachment, conversation, and message IDs use secure random bytes. Non-security reconnect jitter may still use Math.random. |
| BMA-13 | Ingestion accepts local file copies only and reads at most 200 KiB plus one byte from the file handle. Picker-reported size is not trusted as the read bound. |
| BMA-14 | Transport queues are bounded; durable encrypted operations use the account outbox. Ciphertext is not replayed into a future Noise session. |
| BMA-15 | Cloud tickets bind a gateway-registered signing key, preventing URL-only first-use pin poisoning. Account owners can remove and re-register rooms. LAN operators have a local, backed-up registration reset command; network admission is required for LAN exposure. |
| BMA-17 | Documented architectural limitation: relays can observe routing, presence, timing, volume, and sizes. Content encryption does not conceal traffic patterns. No anonymity guarantee is made. |
| BMA-18 | CI compiles native SQLite from source. Production installation must do the same or independently verify native binaries. SQLite is a real dependency of the cloud relay's local regression tests; it is not bundled into the Worker. |
| BMA-19 | The nonce is an AEAD input: changing it invalidates authentication. A regression verifies that altered nonce headers are rejected without advancing receive state. A relay can already drop packets; padding cannot eliminate that capability. |
| BMA-20, 21 | Both approval and denial request strong biometrics. Chat UI displays controlled errors rather than raw exceptions. Emergency stop remains available without an approval prompt. |
| BMA-23, 24 | Engine-visible filenames lose path components and control/reserved characters. HTML/SVG MIME types are rejected; declared PDF/raster image formats are checked against signatures. File sniffing is not a general malware detector; adapters must treat attachments as data. |
| BMA-26, 27, 28 | Direct trust setter removed; hello signatures include protocolVersion; protocol workspace versions are fixed at 0.1.0. |

JSON encoding prevents attachment text from changing the serialized message structure. It does not prove that a model will ignore malicious prose. Desktop host consent and engine tool restrictions remain independent controls. JavaScript strings and copies retained by native modules cannot be reliably zeroed; explicit wiping is best effort for owned byte buffers.

**Configuration and migration**

1. D1 migrations through `0005_billing_reconciliation_audit.sql` are applied live and verified after backup/restore checks. Migration 0004 adds room timestamps, room device keys, and reconciliation triggers. Upgrade phone, desktop, gateway, and relays together: signed hello and pairing proof fields, ACK identity, and key-bound tickets changed.
2. `HostControls` is now wired in the actual desktop host. Verify its installed phone/engine journey. `setRemoteSessionActive(true, peer)` must visibly indicate remote access and expose `Responder.emergencyStop()`. `authorize(operation, signal)` must obtain local consent or apply an explicit host-configured unattended allowlist. Aborted signals must cancel pending dialogs. Do not delegate this decision to model output. The responder fails closed when controls are absent or reject an operation.
3. For network LAN use, configure `RELAY_HOST` and `RELAY_ADMISSION_TOKEN`; include `?lanToken=...` in the advertised LAN URL. Treat the token as a secret and rotate it if disclosed. Loopback mode is intended for local development. Stop the relay before `node scripts/reset-lan-device.mjs <relay.db> <device-id>`; the command saves a private database backup before removing that registration.
4. Use authenticated `GET /v1/relay-rooms` to list registrations and `DELETE /v1/relay-rooms/<room-id>` to remove an obsolete room. Removal frees capacity and prevents future ticket minting. Already-issued tickets last at most sixty seconds; existing sockets must be closed separately if immediate disconnection is required. Re-registering keys requires the owning account. Remove pairing trust on the desktop when revoking a phone.
5. Set `EXPO_PUBLIC_AUTH_REDIRECT_URL=https://<your-owned-domain>/auth/callback` for verified social login. Register that exact redirect in Supabase/provider settings. Serve `/.well-known/apple-app-site-association` for the real Apple team ID and bundle ID, and `/.well-known/assetlinks.json` for the actual Android signing certificate. The build config adds associated domains and autoVerify intent filters. An export does not prove OS verification or domain ownership.
6. Install native SQLite using `npm_config_build_from_source=true npm ci` on supported build hosts. CI sets this flag. SQLite was also built from source locally using the installed Command Line Tools (`DEVELOPER_DIR=/Library/Developer/CommandLineTools`) without changing Xcode configuration. Physical-device migration, biometric, verified-link, background/reconnect, and actual engine cancellation tests remain release acceptance work.

The relay queue schema migrates to `outbox_v3`, dropping legacy queued ciphertext rather than replaying it into new sessions. Normal commands/approvals recover from endpoint logical outboxes. Old unowned identity keys are deliberately removed; re-pairing is required. Unowned chat history remains preserved in encrypted form. Prior cloud backups cannot be retroactively sanitized by this code.

**Verification and remaining limitations**

Run Node 24.15.0 and `npm run check`. The gate includes gateway admission/lifecycle tests, all mobile and relay suites, desktop integration, both audit CJS scripts, and real D1/Durable Object runtime tests. Native exports validate the JavaScript bundles; they do not replace signed native builds and physical-device acceptance.

Dependency scanning still reports upstream advisories. UUID is pinned to a patched compatible CommonJS release, with the Xcode consumer checked locally. The final scan contains 21 entries: 18 high, 3 moderate, and zero critical. The currently published braces/node-forge versions remain affected, and the patched URI decoder changes module format relative to Expo's query-string consumer. Public native deep links are bounded and validated before that decoder. Do not mistake mitigations or a successful bundle for complete reachability analysis; keep dependency review as a release item.

Deployment instructions and the earlier requirements remain in [PRODUCTION-HARDENING.md](PRODUCTION-HARDENING.md). No production-readiness certification is implied.

Release follow-up: live D1 migrations 0001–0005 are verified; audited operator reconciliation and native desktop controls are now implemented. Worker rollout, physical devices, OAuth associations and historical billing reconciliation remain pending. See [release status](RELEASE-STATUS-2026-10-16.md) and [billing workflow](BILLING-RECONCILIATION.md).
