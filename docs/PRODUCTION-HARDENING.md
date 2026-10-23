**Production hardening — protocol 2, updated 16 October 2026**

The repository now contains fixes and regression coverage for all three October audit rounds. See [the 16 October remediation matrix](SECURITY-REMEDIATION-2026-10-16.md) for individual findings and remaining integration requirements. Deployments must apply database migrations and supply real environment configuration before the new gateway admits traffic. Live D1 migrations 0001–0005 are now applied after backup/restore verification. Worker code and coordinated client releases remain undeployed. See [current release status](RELEASE-STATUS-2026-10-16.md).

**Local verification**

Use Node 24.15.0 (`.nvmrc`), then `npm_config_build_from_source=true npm ci` and `npm run check`. `npm test` runs all suites sequentially with deadlines, including the audit regression checks. Worker runtime checks use `npm run test:platform`. Both Workers can also be bundled using their deployment dry-run commands; these do not publish anything.

The completed local gate passes TypeScript, ESLint, 47 gateway tests, all eight mobile suites, LAN/cloud relay suites, 13 desktop integration cases, the original audit checks and seven Round 3 security regression groups, and D1/Durable Object runtime checks. Android and iOS Hermes bundle exports also pass. The follow-up gate is retained in `artifacts/audit/verification-release-followup-2026-10-16.log`; earlier regression/native-export logs remain preserved. These exports are not signed native release builds or device tests.

Expo SDK 57 requires Reanimated 4.5.1 and Worklets 0.10.1. The workspace declares and overrides those exact versions to prevent optional peers from installing incompatible copies. CI checks the resolved tree before running the test gate.

**Coordinated protocol upgrade**

Upgrade the phone, desktop responder, LAN relay, and cloud relay together. Protocol 2 rejects protocol 1 hellos. Pairing binds the approval-signing key, device identifiers, pairing ref, timestamp, and Noise keys inside the authenticated transcript. A persisted replay cache protects msg1 across desktop restarts. Hello signatures now include protocolVersion, and room tickets bind the signing key. Empty prologues are hashed correctly. Transport packets carry an explicit nonce; encrypted application frames use `fver: 2`. File chunks are limited to 32 KiB so encoded frames fit the Noise limit. Existing old-format pairings may need to be removed and re-created. Do not roll back just one component.

Old unowned chat history is encrypted under a separate recovery namespace and is not opened by signed-in accounts. Unowned legacy device credentials are removed, requiring re-pairing. Each account gets separate encrypted databases, identity keys, and desktop trust. Importing legacy history still requires an explicit ownership decision; it is never assigned to whichever account signs in first.

**Gateway schema and admission**

Apply `apps/gateway/migrations/0001_baseline.sql`, `0002_production_admission.sql`, `0003_atomic_budget_totals.sql`, `0004_security_lifecycle.sql`, and `0005_billing_reconciliation_audit.sql` through Wrangler's D1 migration mechanism. From `apps/gateway`, use `npx wrangler d1 migrations apply bimax_gateway --local` for local setup. Production uses the same command with `--remote` against the intended environment after backup and staging verification. `schema.sql` is the full fresh test schema, not a substitute for the migration history.

Configure each environment with:

- `SUPABASE_URL`, for the expected issuer and cached JWKS. JWTs require issuer, audience `authenticated`, subject, issued-at, and expiry.
- Provider secrets for the allowlisted models.
- `MODEL_PRICES_JSON`: a map of model ID to `{ "input": ..., "output": ... }`. Values are integer **micro-USD per million tokens**, taken from your current provider contract. No real provider prices are guessed or hardcoded.
- `GLOBAL_MONTHLY_MICROUSD`: an explicit global monthly spending ceiling in micro-USD.
- `MAX_OUTPUT_TOKENS`: defaults to 2048 and is capped at 4096 by validation.
- `ALLOWED_ORIGINS`: comma-separated exact origins if you enable browser access. Native clients do not need a browser CORS origin.
- `RELAY_TICKET_SECRET`: the same randomly generated secret of at least 32 characters in the gateway and cloud relay, stored as Worker secrets.

The operator or billing integration must explicitly provision `entitlements(user_id,status,expires_at,monthly_microusd)`. Only active, unexpired records admit requests. Optional `quotas(user_id,monthly_tokens)` override the token ceiling. Missing entitlement never grants a trial automatically. Payment-provider webhooks are outside this workspace; connect them to this gate with idempotent updates before selling subscriptions.

Rate limiting uses an atomic D1 write keyed to the account, with an indexed cleanup/recovery cron every five minutes. Each generation reserves both its conservative token bound and monetary cost in one conditional write; budget totals are maintained transactionally by triggers, including global spend. Each account admits at most two recent pending generations. Completed requests settle once using the reservation's original price snapshot and accounting month. Definitive provider rejection before generation settles at zero. Cancellation, missing usage, network ambiguity, and provider 5xx outcomes finalize an explicitly estimated conservative charge, releasing concurrency slots while awaiting verified reconciliation. Failed writes retain the reservation; a scheduled recovery finalizes expired pending rows. Verified overages are recorded at actual cost and logged; they no longer pause all accounts on a single mismatch. `/ready` returns 503 if required configuration/schema is missing or billing is paused.

Historical usage has no reliable price snapshot; migrations preserve its token counts and recorded monetary cost. Reconcile historical provider spend before treating the global ceiling as a complete pre-migration monthly statement.

**Room admission**

A desktop obtains a 60-second room ticket from `POST /v1/relay-ticket` using its account credential, with `{roomId:deviceId,deviceId,role:"desktop",helloPubkey}`. The gateway atomically claims that room for the account and caps each account at five rooms. The phone must use the same account and request a ticket for the advertised room. Another account cannot claim or join that room. The cloud relay verifies the ticket before allocating its Durable Object, then requires a matching signed hello before routing or presence. Keys are registered by the owning gateway account; URL-only pin poisoning is not sufficient. Tickets are not saved in pairing URLs. Avoid logging URL query strings at proxies or analytics layers.

The mobile client requests these tickets automatically. The desktop host injects `authorizeRelayUrl`; `createRelayAuthorizer(gatewayUrl,getAccessToken,deviceId,helloPubkey)` supplies a helper. Never use provider API keys as account credentials. LAN relay URLs use WS only for literal local addresses. The listener defaults to loopback; binding to the LAN requires a secret admission token. Browser Origin upgrades are rejected. These local-network trust assumptions cannot be treated as a shared Internet relay.

Room resources are bounded: four cloud sockets, eight registered identities, a ten-second hello deadline, replay tracking, and an 8 MiB total relay outbox. Only registered destinations can receive queued data. Each destination has a 2 MiB cap, and ciphertext expires after two minutes. Full queues reject additional offline work; authenticated live delivery can proceed without additional retention. Endpoint logical outboxes own durable retries. The alarm stops when neither sockets nor pending messages remain. Use account-owned GET/DELETE `/v1/relay-rooms` operations to remove obsolete registrations when replacing devices beyond the five-room limit.

**Desktop identity and execution**

`startResponder` requires an injected real `EnginePort`, an OS-backed `IdentityStore`, and `HostControls` for visible remote-session indication and local consent. Commands, chat, and engine file attachment cannot execute without host authorization; no shell-string blocklist is treated as a security boundary. Use `encryptedIdentityStore(path,safeStorage)` after Electron is ready; it refuses unavailable encryption and the insecure `basic_text` backend. Plaintext identity files require explicit `allowInsecureFileIdentity: true` and are for development only. The host at `/Users/vishsiddharth/Bimax` now wires native consent, a visible banner/menu indicator, local Stop, trusted-sender IPC and engine event adapters. Installed phone-to-real-engine qualification remains open; see the release status record.

Commands and chat operations write a private, fsynced journal before dispatch. Results are atomically saved before success is returned. Interrupted operations load as `unknown` and are never automatically rerun. The real engine must reconcile those operation IDs with its own effect history; this implementation does not pretend that journaling alone creates exactly-once external effects. Unknown entries are not automatically evicted; a local host can reconcile verified outcomes with `reconcileUnknown`. Recent journal capacity exhaustion rejects new work safely. Valid emergency stop bypasses the journal, and `emergencyStop()` exposes a local fallback without the relay. Commands are valid for two minutes and kill requests for thirty seconds.

The phone stores pending logical commands, kill requests, and signed approval decisions in its account-specific SQLite outbox. It re-encrypts them after a new session and removes them when an authenticated result arrives. Ciphertext is never silently moved into a future session's send queue. Connection loss or peer restart triggers a fresh handshake. Token streams and status are transient; this implementation does not provide durable full-transcript synchronization with the desktop engine.

**Operations and remaining release checks**

- Monitor gateway `/ready`, relay `/health`, `billing_control`, pending reservation counts/age, journal `unknown` outcomes, and error logs. Request IDs are returned in `X-Request-Id` and match reservation IDs.
- Follow [the operator reconciliation workflow](BILLING-RECONCILIATION.md) to review verified provider records and commit an audited correction; do not delete charged estimates merely to restore availability. Monitor interrupted pending rows and the scheduled recovery path.
- Verify backup/restore and coordinated rollback on staging before changing production. Database and protocol changes require a coordinated client/server release.
- Physical iOS/Android backgrounding, biometrics, OAuth, and the real engine's tool restrictions/cancellation still require device/integration acceptance tests. OAuth now uses PKCE, and approval biometrics request strong authentication. Live D1 was backed up and migrated in this follow-up. No physical phones were tested; a native Electron UI fixture was exercised separately.
- Image/PDF attachments are intentionally unavailable until their content can actually reach the selected model. Small supported text files are ingested; unsupported files are rejected visibly.
- Critical development-tool advisories were removed by upgrading Vitest/Wrangler. Malformed and oversized native deep links are rejected before routing to mitigate the legacy URI decoder path. Remaining Expo/Metro dependency advisories need upstream-compatible remediation and reachability review; do not run forced downgrades to Expo 44 or mix unsupported native-module versions.

The 16 October dependency scan reports 21 advisory entries: 18 high and 3 moderate, with zero critical. UUID is pinned to 11.1.1 and its Xcode consumer is checked locally. The complete machine-readable inventory is `artifacts/audit/dependency-audit-after.json`. This is an outstanding release review item, not a clean dependency bill of health.

See the historical audit under `artifacts/audit/`. Its original observations describe the pre-hardening snapshot; the current `reproduce-findings.cjs` asserts the fixes. The earlier reproduction is preserved as `reproduce-findings.before-hardening.cjs` for historical reference and is not part of the passing test gate.
