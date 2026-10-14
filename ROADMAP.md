# Bimax — Product Roadmap

Written 2026-10-15. Organized by what the user gets.
Rule: no visual polish until the product is undeniably good. UI redesign is last.

---

## Today: v0.1 "First Breath" (done)
Login, streaming chat, history on the phone, model picker. It works.

---

## v0.2 "Memory" — a mind that never forgets
**The upgrade:** the AI remembers everything that matters, finds it instantly, and gets smarter about you over time. Best-in-class RAG, not a toy.

- **Sync everywhere** — every conversation in the cloud (Supabase Postgres). New device, full history. Offline-first on the phone.
- **Semantic recall** — it doesn't keyword-match, it *understands*. Ask "what did we decide about the launch?" and it finds the decision from three weeks ago.
- **Hybrid retrieval** — vector search + keyword search + reranking, combined. The same rigor as the desktop engine's retrieval, rebuilt for mobile.
- **Smart chunking** — conversations split by topic shifts, not dumb token windows. Each memory is coherent.
- **Entity memory** — it tracks people, projects, decisions, preferences as first-class things, not buried text.
- **Recency-weighted** — recent context ranks higher, but important old memories never get lost.
- **User model** — a living profile: who you are, how you work, what you care about. Every new chat starts knowing you.
- **Long-chat summarization** — thousand-message threads compress into lossless summaries automatically.
- **Memory controls** — see everything it remembers, edit it, delete it. Your mind, your rules.

---

## v0.3 "Instant" — fast under any load
**The upgrade:** replies start in under a second, and the system doesn't flinch when a thousand people ask at once.

- **Sub-second replies** — speed-first providers (Groq), intelligent model routing. Measured, not hoped.
- **Survives spikes** — request queues with priorities, per-provider circuit breakers, automatic failover when a provider slows down or dies.
- **Graceful under pressure** — when overloaded: fallback models kick in, common answers served from cache, interactive requests jump the queue. It degrades elegantly, never dies.
- **Upstream rate-limit armor** — smart request shaping so providers never throttle us at the worst moment.
- **Measured everything** — time-to-first-token tracked on every request, per provider, per model. We optimize what we measure.
- **Feels alive** — instant feedback on every tap. No dead screens, ever.

---

## v0.4 "Remote" — chat that ACTs
**The upgrade:** your phone drives your laptop.
- **Pair in seconds** — scan, confirm, connected. Encrypted end to end.
- **Tell it what to do** — "organize my downloads", "start the dev server". It runs it on your laptop.
- **Approve anything sensitive** — every risky action asks first, showing exactly what it will do.
- **Kill switch** — one tap stops everything, anywhere.

---

## v0.5 "Knowledge" — it reads your world
**The upgrade:** point it at anything, it understands.
- **Documents** — PDF, Word, Excel, PowerPoint, plain text. Drop a file in chat, ask questions.
- **Vision** — photos, screenshots, camera. Show it what you see.
- **Voice** — voice notes transcribed and understood.
- **Web search** — real-time information, not frozen training data.
- **Code repos** — point at GitHub, ask anything about the codebase. Architecture, bugs, "where is X handled?".
- **Deep research** — multi-step investigations: it searches, reads, synthesizes, cites.

---

## v0.6 "Connected" — your tools, inside chat
**The upgrade:** the AI acts in your other apps.
- **GitHub** — read repos, check PRs, file issues from chat.
- **Google Drive** — find and summarize your docs.
- **Notion** — read and update pages.
- **Gmail** — summarize threads, draft replies.
- **Calendar** — what's next, schedule things.

---

## v1.0 "Launch" — beautiful and public
**The upgrade:** it looks as good as it is, and anyone can install it.
- **Full visual redesign** — every screen rethought. The "better than ChatGPT" bar, finally.
- **Android APK** — direct download.
- **Play Store** — search, install, auto-update.
- **Push notifications** — replies and approvals on the lock screen.
- **Subscriptions** — the ₹200 plan, paid in-app.

---

## Status
- [x] v0.1 — live on Sid's iPhone via Expo Go
- [ ] v0.2 — not started
- [ ] v0.3 — not started
- [ ] v0.4 — not started
- [ ] v0.5 — not started
- [ ] v0.6 — not started
- [ ] v1.0 — not started
