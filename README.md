# Bimax mobile and remote-control services

The current iPhone staging UI is dark by default, uses plain line icons and offers the configured GPT OSS route. Chat uses Expo's native streaming fetch with bounded waiting, Stop and Retry. The owner confirmed an iPhone answer after reload on 24 October. See [phone connection and current checks](docs/PHONE-PAIRING-EXPO-GO.md). The live gateway is still the older 14 October deployment; current hardened source/admission configuration requires a separate coordinated rollout.

An Expo phone client for standalone AI chat and encrypted control of a desktop agent. The workspace includes a model gateway, LAN/cloud relays, a desktop responder with an injected engine interface, and the shared wire protocol.

Use Node **24.15.0** (`.nvmrc`). Install with `npm_config_build_from_source=true npm ci`, then run `npm run check` for typechecking, linting, and the complete regression gate. Run the phone using `npm start --workspace apps/mobile`. Set its Supabase and gateway public configuration in `apps/mobile/.env`.

**Protocol 2 requires coordinated phone, desktop, and relay updates.** The gateway now fails closed until its database migrations, account entitlements, current model prices, spend ceiling, and room-ticket secret are configured. The real desktop host must inject its engine, secure identity storage, and paired-host authorization/visibility controls.

Read [the Round 3 remediation matrix](docs/SECURITY-REMEDIATION-2026-10-16.md) and [production hardening and deployment requirements](docs/PRODUCTION-HARDENING.md) before deploying. The [historical audit](artifacts/audit/production-readiness-2026-10-15.md) and [current regression checks](artifacts/audit/reproduce-findings.cjs) are kept in the repo. Older `PROMPT-*` and `FIX-*` files describe the implementation history and may refer to superseded protocol or deployment behavior.

Worker dry runs build without publishing: `npm run deploy --workspace apps/gateway`, and `npx wrangler deploy --dry-run` from `apps/cloud-relay`. `npm run test:platform` exercises local Workers/Durable Objects with isolated test databases and credentials.

### Experimental PQ pairing

The optional `enablePqPairing: true` desktop setting enables QR-committed, one-time ML-KEM-768 prekeys feeding Noise IKpsk0, explicit initiator confirmation, and fresh-PQ re-handshakes. PQ is disabled by default pending independent cryptographic review and mobile/browser measurements. See [the wire format, rollout gates and test instructions](docs/security/pq-pairing-v2.md). Run `npm run pq-test` for the PQ regression suite and `npm run benchmark:pairing -- 100` for local p50/p95/p99 crypto measurements.

### Desktop integration qualification — 24 October 2026

The linked Bimax Desktop source build, fourteen-case responder result and actual mobile-signature →
responder → Desktop/ThreadManager approval contract now pass locally. See
[Desktop integration commands and remaining qualification](docs/DESKTOP-INTEGRATION-2026-10-24.md).
Physical-phone/installed-app operation and release remain unqualified.

### iPhone with Expo Go — trusted live connection

Verified pairing now grants ordinary Mac chat access without request-by-request Mac prompts. Selected conversations receive live updates; tool decisions stay on the phone. A separate cloud transport supports away access without model credits. Physical current-build/mobile-data qualification is still pending.

Use [Connect an iPhone using Expo Go](docs/PHONE-PAIRING-EXPO-GO.md). The Mac app now owns an
explicitly enabled LAN relay and QR/code-confirmation Settings flow. This supersedes the earlier
renderer-UI gap above; physical-iPhone confirmation and release still need qualification.
