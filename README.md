# bimax-mobile

Bimax mobile companion app — the phone controls the desktop agent (it does not run the agent).

**The loop:** Muse (architect) writes the prompts → you paste them into Antigravity → you send the diff back to Muse → Muse reviews → next prompt. Nothing ships without passing review.

**Start here:** open `PROMPT-1.md`, copy the whole prompt, paste it into Antigravity.

**Foundation stack (v1):**
- TypeScript (strict) everywhere — same language as the Bimax engine
- Expo SDK 53 / React Native 0.79 (New Architecture) / Expo Router v4 — one codebase, Android + iOS
- npm workspaces monorepo: `packages/protocol` (architect-owned wire protocol, pure types) + `apps/mobile`
- ESLint (expo config) + Prettier from day one
- Later layers: relay server (Node + SQLite), QR pairing with per-device keys, push approvals, OTA updates

Full architecture reference: the "Bimax Mobile Architecture" page in Muse.
