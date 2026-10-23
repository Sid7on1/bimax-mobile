# Production follow-up, 16 October 2026

Production is not yet qualified. This record supersedes earlier statements that live migrations/backups do not exist. Worker code was not deployed in this follow-up.

| Item | Verified state |
| --- | --- |
| D1 | Two live backups restored into SQLite and checked. Migrations 0001–0005 applied remotely and verified. All 19 historical usage rows retained. |
| Spending validation | The HTTP endpoint already used `validateChat`: oversized `max_tokens` rejected; `n` and `max_completion_tokens` omitted. The unused legacy sanitizer now delegates to it. Added endpoint/helper regressions. Live Worker upgrade is pending. |
| Billing | Operator list/review/apply CLI and atomic audit ledger implemented; synthetic CLI review/apply/repeat verified. Migration 0005 installed live. No real charge changed. Historical provider reconciliation remains open. |
| Desktop | `/Users/vishsiddharth/Bimax` now wires native consent, banner/menu indicator, local Stop, trusted-sender IPC, validated encrypted identity, private data directory and engine token/approval/completion events. Fresh responder declarations generated. Native Electron fixture and focused tests pass; installed phone-to-real-engine journey is unqualified. |
| Rollout | Local protocol-2 regression gate passes. Desktop typecheck/build checked. Gateway/relay deployment and phone release pending. The configured cloud relay Worker was absent during inspection. |
| OAuth | Needs actual domain, Apple Team ID and Android release certificate SHA-256 to complete association files and verify signed builds. |
| Devices | No connected Android device or usable iOS simulator available. Earlier native bundle exports are not device tests. |
| Dependencies | Recorded scan: 21 entries, 18 high / 3 moderate / 0 critical. Gateway production dependency is `jose`; workspace findings include the mobile URI decoder path. Gateway-only triage cannot clear the mobile release. |

Private backups are mode 0600 under ignored `artifacts/private-release/` (directory mode 0700). Public hash/verification receipts are `artifacts/audit/release-migration-receipt-2026-10-16.json` and `billing-migration-receipt-2026-10-16.json`. Keep independently protected backups according to the retention policy; a local export is not a managed backup service.

`npm run check` on Node 24 passed: 47 gateway tests, mobile/relay/desktop regressions, audit CJS checks and real D1/Durable Object fixtures. Log: `artifacts/audit/verification-release-followup-2026-10-16.log`. Desktop evidence: `/Users/vishsiddharth/Bimax/docs/product-reset/99_MOBILE_HOST_CONTROLS.md`. Original audit CJS and Markdown files remain in the repo.

## Remaining release sequence

1. Supply exact provider/model IDs, verified input/output prices and global monthly USD ceiling. Configure micro-USD values, provider secrets and explicit expiring user entitlements. Do not guess financial policy or grant access to existing keys automatically.
2. Configure a shared random relay-ticket secret in gateway/cloud relay. Supply the desktop gateway URL and account credential through host injection or `BIMAX_GATEWAY_URL` / `BIMAX_GATEWAY_ACCOUNT_TOKEN`. Provider keys are not account credentials. Cloud startup without a ticket authorizer refuses. Keep secrets out of source, advertisements and logs.
3. Build the responder before building Bimax. Deploy gateway/relay with protocol-2 phone/desktop releases; check `/ready`, admission and signed hellos. Re-pair old-format devices. Coordinate every component during rollback and preserve database history.
4. Publish/verify association files on the selected HTTPS domain, configure the authentication-provider redirect and build signed native apps with matching identifiers/certificates.
5. On physical iOS/Android, verify sign-in/cancel/wrong-account callbacks; pairing/code mismatch; consent deny/allow; banner; Stop during consent/generation/tool approval and offline; revoke/re-pair; background/relaunch/reconnect without duplicate effects; biometric denial; bounded attachments; account isolation; old-client rejection; provider ambiguity/reconciliation; and update/rollback. Preserve actual end states and failures. Verify full engine cancellation and instruction-target consistency in the installed app.
6. Finish historical provider reconciliation, dependency reachability review and signing/install gates before calling the release production-ready.
