# Bimax Mobile — FIX-19: upgrade Expo SDK 53 → 57

Copy everything below the line into Antigravity as one prompt.

---

## Background

The project (`apps/mobile`) is on Expo SDK 53. The iOS Expo Go app only supports the latest SDK (57), so the app cannot be opened on Sid's iPhone for testing. Upgrade the project to SDK 57.

## Exact work

1. Run the Expo SDK upgrade: `npx expo install expo@latest` then `npx expo install --check` inside `apps/mobile`. Fix every dependency mismatch it reports.
2. Fix all breaking changes from the upgrade: run `npx tsc --noEmit` and fix every type error; update any deprecated API usage (expo-router, expo-sqlite, expo-secure-store, expo-auth-session APIs that changed between 53 and 57).
3. Re-run the full gateway test suite (`cd ../gateway && npm test`) — must stay 27/27 green. The upgrade must not touch `apps/gateway/` source, but verify nothing broke.
4. Boot check: `npx expo start` must start Metro with no bundler errors and no fatal dependency warnings.
5. Verify the PROMPT-18 feature set still compiles and is intact: login screen, chat list, chat view, Message renderer, Composer, SQLite store, gateway client, Supabase JWT bridge. Do not remove or regress any of it.

## SCOPE — DO NOT DO

- Do NOT touch the trust plane (`lib/crypto`, `lib/e2e`, `lib/relay`, `lib/session`, `app/pair.tsx`, `app/approvals.tsx`) except for mechanical API-rename fixes if the SDK upgrade forces them. No behavior changes.
- Do NOT touch `apps/gateway/` source or tests.
- Do NOT downgrade anything to satisfy the old SDK. Move forward to 57.
- Commit no secrets.

## Acceptance commands

```
cd apps/mobile && npx tsc --noEmit && npx expo install --check
cd ../gateway && npm test
```

`--check` must report no mismatches, tsc clean, 27/27 tests green.

## RETURN FOR REVIEW

1. The exact SDK version landed on (`expo --version` / package.json).
2. Full terminal output of the acceptance commands.
3. A list of every breaking change you had to fix (file + what changed and why).
4. Explicit confirmation the PROMPT-18 screens and gateway bridge are intact.
