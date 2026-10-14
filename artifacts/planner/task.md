# Task Checklist: FIX-19 Expo SDK 53 -> 57 Upgrade in apps/mobile

- [/] Phase 1: Dependency Upgrade & Reconciliation <!-- id: 0 -->
  - [x] Check expo latest version (confirmed SDK 57.0.29) <!-- id: 1 -->
  - [ ] Run `npx expo install expo@latest` and `npx expo install --check` in `apps/mobile` <!-- id: 2 -->
  - [ ] Fix all dependency mismatches and install compatible peer dependencies <!-- id: 3 -->
- [ ] Phase 2: Codebase Audit & Deprecations Fix <!-- id: 4 -->
  - [ ] Run `npx tsc --noEmit` across root and `apps/mobile` to identify breaking changes <!-- id: 5 -->
  - [ ] Audit and fix deprecated APIs in `apps/mobile` (e.g. SQLite, Camera, DocumentPicker, Router) <!-- id: 6 -->
  - [ ] Verify PROMPT-18 features (login, chat UI, renderer, composer, SQLite, gateway JWT bridge) remain fully intact <!-- id: 7 -->
- [ ] Phase 3: Verification & Scope Checks <!-- id: 8 -->
  - [ ] Run `npx expo install --check` in `apps/mobile` -> 0 mismatches <!-- id: 9 -->
  - [ ] Run `npx tsc --noEmit` -> clean <!-- id: 10 -->
  - [ ] Verify gateway tests: `cd apps/gateway && npm test` -> 27/27 green <!-- id: 11 -->
  - [ ] Verify trust plane libs are untouched/unbroken <!-- id: 12 -->
- [ ] Phase 4: Final Summary & Return Items <!-- id: 13 -->
  - [ ] Document final SDK version, terminal output, breaking changes fixed, PROMPT-18 confirmation <!-- id: 14 -->
EOF
