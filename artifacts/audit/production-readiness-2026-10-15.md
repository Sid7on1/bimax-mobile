**Bimax repository audit — 15 October 2026**

**Verdict: promising prototype; not ready for a paid public launch.** The main component boundaries are sensible. The biggest weaknesses are enforcing trust at every entry point, controlling provider spend, and recovering safely across disconnects and process crashes. Several strong guarantees in the architecture document exceed what the implementation provides.

My judgment scores are architectural direction **7/10**, implementation quality **6/10**, and production readiness **3/10**. These are qualitative assessments against the intended paid AI and desktop-control product, not measured reliability percentages. A supervised demo is reasonable. An external alpha should follow the high-priority fixes below.

**Scope and limits**

Reviewed the mobile application, shared protocol, gateway, both relays, desktop responder, configurations, test harnesses, and architecture/deployment documentation in this workspace. The hackathon material is primarily research and planning; it does not establish implemented production capabilities. This directory has no Git metadata, so this audit cannot establish a commit SHA, tracked-secret history, or prior changes.

Ran local tests, static checks, dependency auditing, targeted reproductions, and Worker deployment dry runs. No live deployment, paid provider request, user-account action, or production load test was performed. Actual iOS/Android release behavior, Cloudflare hibernation behavior, Supabase project settings, and the real desktop engine outside this workspace remain unverified. Application source was not changed; test scripts regenerated relay build output, and audit artifacts were added.

**What is good**

- The gateway, relay, and desktop execution adapter have separate responsibilities. This is a good basis for the product; a microservice rewrite is unnecessary.
- `EnginePort` limits the responder's direct access to the engine. That boundary is worth keeping.
- The desktop approval gate binds decisions to the stored request, verifies against the pinned signing key, checks session/time constraints, and consumes approvals once. The tested content-swap and bad-signature cases are useful.
- Encryption framing binds message IDs and sender/recipient fields. There is a real Noise test vector, not only round-trip testing.
- File reception verifies declared size, sequencing, and SHA-256 and stores under a generated file ID. The traversal and corruption tests pass.
- Provider URLs are server-controlled, model selection is allowlisted, and quota reads fail closed on database errors.
- Strict TypeScript and the broad desktop integration harness are valuable foundations.

**Verification results**

| Check | Observed result |
| --- | --- |
| Root TypeScript check | Pass |
| Gateway and desktop workspace typechecks; cloud relay typecheck | Pass |
| Gateway tests | 27/27 pass |
| Desktop responder integration | 13/13 cases pass using Node 24 |
| Cloud relay logic suite | All 6 steps pass using Node 24; does not exercise the actual Durable Object runtime |
| Mobile Noise, crypto, E2E, control, hello-auth suites | Pass |
| Mobile relay smoke | All 4 steps pass |
| LAN relay hardening | All 6 steps pass |
| Mobile approvals suite | Fails at duplicate approval ID assertion; later steps are not reached |
| Mobile pairing suite | Hangs at its first step; stopped after observing unsigned clients being rejected by the hardened relay |
| Root lint | Fails: 17 errors and 20 warnings; errors are in generated `.wrangler` output |
| Source-only lint | 0 errors, 16 warnings |
| Gateway and cloud relay deployment dry runs | Both bundle successfully; no deployment performed |
| `npm audit` | 40 flagged package entries: 2 critical, 24 high, 14 moderate; exploitability needs triage |

Default shell Node was 22.13.1; the installed SQLite native module targets ABI 137, while Node 22 expects ABI 127. The already-installed Node 24.15.0 matches and allows the SQLite-backed suites to run. This is a reproducibility/configuration issue, not evidence that the integration cases fail on a correctly installed runtime.

**High-priority findings — fix before external users**

**F01 — The mobile dispatcher accepts plaintext application messages.**

Evidence: [incoming handler](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/session/provider.tsx:164), [approval/status branches](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/session/provider.tsx:288), and [relay callback](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/relay/client.ts:231).

The same handler receives raw relay envelopes and recursively receives decrypted application frames. After the `encrypted` branch, raw `approval_request`, `agent_status`, `session_list`, `command_result`, and `kill_result` envelopes enter the application branches without requiring decryption or a trusted sender. The relay routes messages from other self-identified clients; sender binding alone does not authorize them as the paired desktop.

Reproduction: the actual callback was extracted from its TypeScript AST and invoked with plaintext envelopes from `untrusted-attacker`. Both the forged status and forged approval were accepted. This proves the handler behavior; it is not a rendered-device UI test.

Impact: fabricated approval prompts, false command/kill acknowledgments, misleading agent status, and UI denial of service. This does **not** demonstrate bypassing the desktop's signed request-binding gate or unauthenticated engine execution.

Fix: separate the transport handler from the authenticated application dispatcher. Only successful E2E opens from the verified desktop may reach application handlers. Allow plaintext only for narrowly validated transport and pairing kinds. Add tests that inject each sensitive kind directly over the relay and verify rejection.

**F02 — Local data and remote trust are not scoped to the signed-in account.**

Evidence: [chat schema and queries](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/chat-store.ts:23), [sign-out](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/app/index.tsx:66), [provider mounting](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/app/_layout.tsx:51), and [global trust key](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/crypto/secure-store.ts:13).

The chat database has no account owner column or account filter. Signing out only ends the Supabase session and changes the route. The same `RelayProvider` remains mounted, and desktop trust and device keys use global SecureStore names. A second account on the same installation will read the same conversation list and inherit the same configured remote relationship.

Fix: define account ownership for conversations and device trust, scope storage accordingly, and reset account-sensitive provider state on account changes. Decide explicitly whether pairing is device-wide or account-specific; the UI must make that policy clear. Verify account A → sign out → account B cannot see A's history or silently inherit A's desktop permissions.

**F03 — Authentication grants a default quota without a subscription entitlement check.**

Evidence: [gateway admission path](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/index.ts:182), [quota fallback](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/quota.ts:52), and [schema](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/schema.sql:1).

A valid user token goes directly to rate/quota checks. If there is no quota row, the user receives the default 4,000,000-token budget. There is no active subscription, trial allocation, suspension, or payment-state gate in this workspace. Reproduction with a new user and no quota entry returns `allowed: true`.

Fix: require an explicit entitlement before provider admission, with separately bounded trials if desired. Make payment/webhook updates idempotent and keep entitlement state distinct from usage accounting. The absence of a quota record should not silently authorize paid provider spend.

**F04 — The gateway rate limiter loses concurrent increments and is keyed to rotating credentials.**

Evidence: [read/increment/write](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/ratelimit.ts:47), [JWT-derived key hash](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/auth.ts:93).

Reproduction: 100 simultaneous checks with a limit of 30 all passed; the mock KV ended with a counter of `1`. This reproduces the application race even without distributed caching. JWT refreshes also produce new limiter keys for the same user. KV errors deliberately fail open.

Cloudflare documents that KV lacks atomic read/write transactions and has a one-write-per-second limit for the same key. The current design requires more frequent writes during bursts. Use a stable user identity and a serialized/atomic limiter, with additional coarse abuse limits where appropriate. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/).

**F05 — Quota and metering do not provide a hard spending bound.**

Evidence: [quota check](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/quota.ts:39), [request sanitization](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/providers.ts:79), [stream metering](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/index.ts:293), and [metering failures](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/metering.ts:24).

Quota checks happen before generation, but no tokens or money are reserved. There is no enforced output-token maximum or check that the requested work fits the remaining allocation. Reproduction: 100 concurrent requests were admitted against a 100-token budget; at 15 tokens each that would consume 1,500 tokens. Even a single request can exceed a small remaining balance.

Missing provider usage is recorded as zero, and failed usage inserts are logged and discarded. Quota reads can therefore remain successful while real provider spend is absent from the ledger. The ledger records token counts but no price snapshot or currency cost, so an equal token cap across different models and input/output mixes is not a fixed monetary allocation.

Fix: atomically reserve a conservative maximum cost before provider dispatch, enforce request/output limits, then settle actual usage against a unique request ID. Keep reservations or conservative charges when final usage is unavailable, and reconcile later. Add a global provider-spend circuit breaker. Treat the current token cap as a soft fairness limit until this is implemented.

**F06 — Idempotency does not survive the crash window it claims to cover.**

Evidence: [engine call before persistence](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/idempotency.ts:118), [100 ms deferred save](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/idempotency.ts:246), and [persisting only completed entries](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/idempotency.ts:265).

In-flight records exist only in memory. Completed results are saved later using a direct JSON file write, and write failures are swallowed. A crash after an external effect but before the deferred save loses the deduplication record. Reproduction: an immediate new log instance using the same path executed a completed key again; total effect executions were `2`. Persisting while a task was in flight also left no recoverable record.

The key is not bound to operation kind or payload, and capacity eviction can remove in-flight entries. The retention policy is 24 hours, while relay storage retains messages for 7 days; the logical retry policy needs an explicit common horizon. Old ciphertext after a fresh handshake cannot simply be replayed, so this retention mismatch is not itself a demonstrated cross-session replay exploit.

Fix: use a durable operation journal before engine dispatch, record operation kind and payload hash, and coordinate deduplication with the engine's actual side effects. Recover interrupted work as an explicit unknown/reconciliation state rather than blindly rerunning it. A journal alone cannot guarantee exactly-once external effects unless the engine also supports reconciliation or idempotency. Persist atomically and surface durability failures.

**F07 — Delivery, encryption counters, and reconnect behavior are inconsistent.**

Evidence: [live-forward-before-storage](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/logic.ts:391), [ACK before handling](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/relay/client.ts:214), [implicit receive nonce](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/crypto/noise.ts:522), [desktop queue eviction](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/relay-client.ts:152), [status callback](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/session/provider.tsx:428), and [initial re-handshake](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/session/provider.tsx:812).

Live sends are not retained until acknowledgment. Clients ACK before decryption, validation, or durable processing. Queues hold ciphertext tied to session keys and nonce order; the desktop drops the oldest entry when full. Noise transport here increments an implicit receive nonce and cannot skip a lost ciphertext. Reproduction: dropping transport packet 0 makes packet 1 fail authentication.

The mobile provider initiates a re-handshake during initial setup, but its reconnect status callback only updates status. A desktop process restart loses its active Noise session; the still-running phone does not automatically establish a new one. Crypto errors are silently ignored on the phone, and the desktop clears the session without triggering coordinated recovery. A healthy WebSocket can therefore coexist with an unusable application channel.

Commands and kill requests also carry `sentAt`, but the responder does not enforce freshness. Queued actions can execute later against a different task context.

Fix: document delivery semantics at each layer. Keep a durable logical operation outbox, establish the authenticated session before draining it, and encrypt under the current session. Use session/epoch identifiers and an explicit application acknowledgment/result protocol. Store live messages when reliability requires it; acknowledge durable acceptance, not just receipt of arbitrary JSON. Re-handshake automatically when a peer loses state. Give control actions authenticated deadlines and bounded queues.

**F08 — Normal pairing cannot discover the approval-signing key required for confirmation.**

Evidence: [phone request](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/session/session.ts:90), [cloud presence](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/logic.ts:19), [desktop key requirement](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/pairing.ts:346), [integration test supplying a key separately](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/test/integration-test.mjs:366), and [test-only extra hello](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/test/integration-test.mjs:1030).

The normal signed hello is addressed to the relay and is not forwarded to the desktop. Presence messages omit its public key. The phone's pairing request does not carry a signing key either. Consequently `confirmTrustedPhone(code)` has no signing key to pin. Reproduced over real loopback sockets using the phone stack and responder: confirmation throws `Missing phone hello pubkey for trust record`.

The passing integration test either supplies the key explicitly or sends an additional targeted hello that the production phone does not send. Receiving a plaintext signing-key announcement also does not cryptographically bind that key to the Noise identity verified by the human.

Fix: exchange the signing key and device identity inside the authenticated pairing transcript, verify proof of possession, and make confirmation a complete two-sided state transition. Test exactly the production messages without passing keys through the test harness. Keep candidate sessions separate from trusted application sessions until verification finishes.

**F09 — Cloud relay resource admission is not controlled.**

Evidence: [arbitrary room allocation](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/index.ts:25), [socket acceptance](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/room.ts:24), [self-signed first-use identity](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/logic.ts:148), [per-destination outbox limit](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/logic.ts:273), and [unconditional recurring alarm](/Users/vishsiddharth/Desktop/bimax-mobile/apps/cloud-relay/src/room.ts:106).

Any caller can allocate a room and open a socket. A signed hello proves possession of a self-generated key, not membership in the user's room or entitlement to use the service. There is no hello deadline or total connection cap. Outbox limits apply per destination, while callers can supply arbitrarily many destination IDs. Pins/devices persist without a cleanup policy. Once started, a room alarm reschedules every minute even after there is no useful work.

Impact: resource and billing abuse, persistent storage growth, and presence/room pollution. E2E protects content confidentiality but does not bound infrastructure use.

Fix: add an account-bound room capability or narrowly scoped admission ticket, pairing/invitation rules, handshake deadlines, socket/member caps, and total byte/storage budgets. Reject unauthorized or unknown destinations. Remove obsolete state and stop scheduling alarms when no pending expiry/connection work exists. Exercise this in the actual Workers runtime.

**Other material findings**

**F10 — JWT verification omits required claim checks. Priority: medium.** [Verifier](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/auth.ts:89).

The verifier constrains the signature algorithm but does not pin issuer/audience or require expiration. Reproduction using a key in the configured test JWKS accepted a signed JWT with an unexpected issuer/audience and no `exp`. This requires a token signed by a trusted key; it is not an arbitrary unsigned-token bypass. Configure issuer, audience, required claims, and the expected account/session policy. Supabase documents the meaning of issuer and expiration claims in its [JWT reference](https://supabase.com/docs/guides/auth/jwts).

**F11 — The default Noise handshake deviates from the named specification. Priority: medium.** [Initiator initialization](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/crypto/noise.ts:209), [responder initialization](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/crypto/noise.ts:434), and identical desktop copies.

Both implementations skip `MixHash(prologue)` when the prologue is empty, whereas Noise requires that operation even for zero-length input. The known-answer test uses a nonempty prologue, so it misses the production default. A targeted responder amended only to perform that specified initialization cannot authenticate the default initiator's message. This demonstrates an interoperability/conformance failure, not a recovered encryption key. The 64 KiB file chunks also expand to more than 65,535 ciphertext bytes after base64 and JSON framing, exceeding Noise's specified message size. Fix initialization and encoded frame limits, add empty-prologue and size-boundary vectors, and review the shared implementation independently. [Noise specification](https://noiseprotocol.org/noise.html).

**F12 — Runtime validation and cancellation are incomplete. Priority: medium.** [Gateway JSON validation](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/index.ts:230), [command dispatch](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/responder.ts:324), [upstream fetch](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/providers.ts:215), and [stream tee](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/src/index.ts:296).

TypeScript casts do not validate wire data. A JSON `null` gateway body reaches an unguarded property access; command bodies validate only that they are objects before forwarding their instruction. Message roles/content, numeric bounds, and total input budgets need runtime schemas. Provider fetch has no configured deadline or propagated cancellation signal. Because the usage branch continues reading the teed response, stopping on the phone does not guarantee stopping provider generation/spend. Add bounded schemas, input/context limits, deadlines, and cancellation behavior consistent with reservation settlement.

**F13 — Attachment UI promises more than the request sends. Priority: medium.** [Ingestion seam](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/lib/attachments.ts:23), [prompt construction](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/app/chat/[id].tsx:88).

Small text files can be inlined. Images, PDFs, and other files become a textual filename/size reference; their bytes or extracted contents do not reach the model. Users can interpret the attachment chip as a usable upload. Implement the actual modality pipeline or clearly limit the UI to supported inputs. The desktop file protocol is implemented in the responder but is not wired into the current mobile chat screen.

**F14 — Production desktop integration and key storage remain outside this implementation. Priority: release blocker.** [Factory](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/index.ts:28), [identity store](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/identity.ts:64), and [engine contract](/Users/vishsiddharth/Desktop/bimax-mobile/apps/desktop-responder/src/engine-port.ts:11).

Only `FakeEngine` implements `EnginePort` here. The exported factory loads private keys from a plaintext JSON identity file; its comment delegates production key storage to a future adapter. The supplied identity interface allows a proper external adapter, but this workspace does not demonstrate that integration. Before release, verify the real engine's approval enforcement, cancellation, sandbox/tool restrictions, idempotency, subscriptions, and OS keychain storage. Do not infer these capabilities from the fake-engine tests.

**F15 — Delivery and operational controls are unfinished. Priority: medium.** [Root scripts](/Users/vishsiddharth/Desktop/bimax-mobile/package.json:10), [lint ignores](/Users/vishsiddharth/Desktop/bimax-mobile/eslint.config.cjs:6), [mobile app config](/Users/vishsiddharth/Desktop/bimax-mobile/apps/mobile/app.json:1), and [Worker config](/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/wrangler.toml:1).

No CI workflow, single aggregate test gate, runtime pin, mobile release profile, or explicit staging/production separation is present. The gateway default model allowlist includes the model labeled staging in the UI. Root lint includes generated Wrangler output. The approval test expects rejection of an expired ID after it was pruned, disagreeing with current store behavior. The old pairing test uses unsigned clients and waits indefinitely. These are concrete reasons that "all tests green" claims are currently unreliable.

No configured crash reporting, provider-cost alerting, cross-service request IDs, rollback verification, backup/restore drill, or documented operating target is present. Console logging and a local JSONL security file are a start, not demonstrated production operations. The npm audit snapshot includes critical development-tool advisories; do not treat those counts as confirmed production exploits or apply major-version auto-fixes without testing.

Additional maintainability concerns: relay logic, crypto, and framing are copied between apps; security patches must be kept in sync manually. The 890-line mobile provider mixes pairing, crypto, transport, approvals, commands, and React state. Protocol changes described as additive actually introduce required fields while retaining version `1`, with no capability negotiation. The chat database has no migration mechanism, list queries are unbounded, and every chat request resends all history. These choices will make upgrades, long conversations, and recovery progressively harder.

**Recommended system design**

Keep the three existing planes, but strengthen their contracts:

- **Account and spending:** account identity → explicit entitlement → atomic reservation and concurrency admission → provider → durable settlement/reconciliation. Meter input/output with per-model price versions and enforce a global spend bound.
- **Remote control:** authenticated room admission → verified pairing and session establishment → validated application messages → durable operation journal → real engine adapter → explicit results. Store logical operations for retries and bind them to account, device, session/epoch, operation kind, payload, and deadline.
- **Client lifecycle:** account-scoped data/trust, a session state machine with distinct connecting/authenticating/pairing/ready states, automatic recovery, and visible pending/accepted/completed outcomes. WebSocket-open is not application-ready.
- **Shared code:** extract one tested runtime protocol/validation package and one crypto/framing implementation with platform-specific storage and transport adapters. Avoid a proliferation of services; the existing small architecture can support this.

**Fix order and release gates**

1. Close the plaintext dispatcher and account-isolation gaps; complete signing-key pairing. Prove unauthorized messages and account switching cannot cross trust boundaries.
2. Enforce entitlements, stable-user rate/concurrency limits, cost reservations, and durable settlement. Prove parallel requests, dropped streams, and metering-write failures remain within the configured spend bound.
3. Replace the deferred JSON idempotency cache with a durable engine-coordinated operation journal. Resolve delivery/session semantics and stale-action expiry. Prove crash/restart, missing frames, queue overflow, and desktop restarts recover without duplicate side effects or an unusable channel.
4. Finish the real desktop adapter and secure storage; correct Noise conformance and obtain independent review of pairing/crypto integration. Test native mobile lifecycle and biometrics on physical devices.
5. Establish one repeatable CI/release gate, pinned runtime, isolated staging, dependency triage, monitoring, and recovery exercises. Run multi-user load and abuse tests before widening access.

**Reproduction artifacts**

The [reproduction script](/Users/vishsiddharth/Desktop/bimax-mobile/artifacts/audit/reproduce-findings.cjs) imports the actual TypeScript modules and uses local mocks or loopback sockets. It does not contact the configured gateway or Supabase. It prints observations of the current defects; it is not a passing regression suite. Build the LAN relay first and use a Node runtime matching the installed SQLite native module. Its loopback pairing check uses port 18891.

Observed outputs are saved in [reproduction-results.txt](/Users/vishsiddharth/Desktop/bimax-mobile/artifacts/audit/reproduction-results.txt). The full npm advisory inventory is saved in [dependency-audit.json](/Users/vishsiddharth/Desktop/bimax-mobile/artifacts/audit/dependency-audit.json).
