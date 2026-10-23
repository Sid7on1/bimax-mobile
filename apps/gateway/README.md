# Bimax gateway

An OpenAI-compatible chat endpoint with explicit account entitlements, atomic account rate limiting, per-request token/cost reservations, transactional usage settlement, a global spending ceiling, cancellation, and room-admission tickets.

See [production hardening](../../docs/PRODUCTION-HARDENING.md) for configuration, migrations, accounting units, and deployment requirements. Provider prices must come from the actual provider contract and are configured through `MODEL_PRICES_JSON`; no fixed subscription margin is assumed from an old blended-token price.

Use Node 24.15.0 and run `npm test --workspace apps/gateway`. The gateway suite uses SQLite to exercise the actual atomic admission/settlement SQL. `npm run test:platform` from the workspace root additionally exercises Cloudflare's local Workers runtime. `npm run deploy --workspace apps/gateway` is a dry run; `deploy:live` publishes and is an explicit operational action.

`GET /health` reports process liveness. `GET /ready` checks production admission configuration and the billing circuit. `GET /v1/usage` requires account authentication. `POST /v1/relay-ticket` issues an expiring device/room ticket only for an active entitled account that owns the room. Chat generations require the same entitlement plus available token and monetary budgets.

Production follow-up: live D1 migrations 0001–0005 are applied. See [current release status](../../docs/RELEASE-STATUS-2026-10-16.md) and [operator billing reconciliation](../../docs/BILLING-RECONCILIATION.md). Worker rollout remains pending real admission configuration.
