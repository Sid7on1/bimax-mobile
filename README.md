# Bimax mobile and remote-control services

An Expo phone client for standalone AI chat and encrypted control of a desktop agent. The workspace includes a model gateway, LAN/cloud relays, a desktop responder with an injected engine interface, and the shared wire protocol.

Use Node **24.15.0** (`.nvmrc`). Install with `npm_config_build_from_source=true npm ci`, then run `npm run check` for typechecking, linting, and the complete regression gate. Run the phone using `npm start --workspace apps/mobile`. Set its Supabase and gateway public configuration in `apps/mobile/.env`.

**Protocol 2 requires coordinated phone, desktop, and relay updates.** The gateway now fails closed until its database migrations, account entitlements, current model prices, spend ceiling, and room-ticket secret are configured. The real desktop host must inject its engine, secure identity storage, and local consent/visibility controls.

Read [the Round 3 remediation matrix](docs/SECURITY-REMEDIATION-2026-10-16.md) and [production hardening and deployment requirements](docs/PRODUCTION-HARDENING.md) before deploying. The [historical audit](artifacts/audit/production-readiness-2026-10-15.md) and [current regression checks](artifacts/audit/reproduce-findings.cjs) are kept in the repo. Older `PROMPT-*` and `FIX-*` files describe the implementation history and may refer to superseded protocol or deployment behavior.

Worker dry runs build without publishing: `npm run deploy --workspace apps/gateway`, and `npx wrangler deploy --dry-run` from `apps/cloud-relay`. `npm run test:platform` exercises local Workers/Durable Objects with isolated test databases and credentials.

### Experimental PQ pairing

The optional `enablePqPairing: true` desktop setting enables QR-committed, one-time ML-KEM-768 prekeys feeding Noise IKpsk0, explicit initiator confirmation, and fresh-PQ re-handshakes. PQ is disabled by default pending independent cryptographic review and mobile/browser measurements. See [the wire format, rollout gates and test instructions](docs/security/pq-pairing-v2.md). Run `npm run pq-test` for the PQ regression suite and `npm run benchmark:pairing -- 100` for local p50/p95/p99 crypto measurements.
