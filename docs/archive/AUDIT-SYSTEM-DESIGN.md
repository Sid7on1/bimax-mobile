# Bimax Security Audit System — High-Level & Low-Level Design

The audit system is the machine that produces prompts like `AUDIT-2.md`, runs audit rounds, deduplicates findings across rounds, and turns them into verified fixes. This doc is its design.

---

# PART 1 — HIGH-LEVEL DESIGN

## 1.1 Purpose

Find every security bug in the Bimax codebase **once** — no duplicates across rounds, no missed components, increasing depth each round — and convert findings into verified fixes. The system exists because one-off audits rot: findings get re-reported, fixed bugs get re-found, and nobody verifies the fix worked.

## 1.2 Actors

| Actor | Role |
|---|---|
| **Sid** | Requests audit rounds, sets scope, approves fix order. Never audits directly. |
| **Orchestrator (Muse)** | Builds round prompts from the methodology library + findings registry, fans out specialist agents, deduplicates, synthesizes reports, updates the registry. |
| **Audit agents** | Execute one round prompt each (e.g., mobile/MASVS, gateway/API, responder/STRIDE). Stateless — they know only what's in their prompt. |
| **Fix agents** | Take one finding, write the fix, re-run the PoC. Separate from audit agents. |
| **Verifier** | Re-checks fixed findings against current code. Can be the orchestrator or a fresh agent. |

## 1.3 Components

```
┌─────────┐   audit request   ┌──────────────┐
│   Sid   │ ───────────────▶ │ Orchestrator │
└─────────┘                  │    (Muse)    │
                             └──────┬───────┘
                    builds prompt from │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌───────────────┐          ┌─────────────────┐          ┌──────────────────┐
│  Methodology  │          │  Known-Findings │          │  Scope + Attack  │
│    Library    │          │    Registry     │          │    Playbook      │
│ OWASP WSTG /  │          │ F01–F15         │          │ component file   │
│ MASVS / API / │          │ BMA-01–28       │          │ lists + specific │
│ LLM Top 10,   │          │ AUD2-001…       │          │ attack techniques│
│ NIST 800-115, │          │ (status: open / │          │ to attempt       │
│ STRIDE, CWE   │          │  fixed / verified)│        └────────┬─────────┘
└───────┬───────┘          └────────┬────────┘                   │
        └──────────────────────────┼────────────────────────────┘
                                     ▼
                          ┌──────────────────┐
                          │  Round Prompt    │
                          │  (AUDIT-N.md)    │
                          └────────┬─────────┘
                         fan-out   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────────┐
│ Audit agent:  │        │ Audit agent:  │        │ Audit agent:      │
│ Mobile/MASVS  │        │ Gateway/API   │        │ Responder+Relays  │
└───────┬───────┘        └───────┬───────┘        └─────────┬─────────┘
        └──────────────────────────┼──────────────────────────┘
                              findings ▼
                     ┌────────────────────────┐
                     │  Dedup & Synthesis     │
                     │  - normalize IDs       │
                     │  - dedup vs registry   │
                     │  - severity ranking    │
                     │  - chain detection     │
                     └───────────┬────────────┘
                                 ▼
              ┌─────────────────────────────────┐
              │ Report → artifacts/audit/*.md   │
              │ Registry ← new IDs, statuses    │
              └───────────────┬─────────────────┘
                              ▼
              ┌─────────────────────────────────┐
              │ Fix pipeline (FIX-N.md) →       │
              │ fix → re-run PoC → verified     │
              └─────────────────────────────────┘
```

**Why this shape:**

- **Methodology library is separate from prompts** so new frameworks (e.g., a future OWASP Agentic AI Top 10) get added once and flow into every future round.
- **The registry is the duplicate shield.** Agents are stateless; the registry is the system's memory. Every finding ever filed lives there with a status. A round prompt embeds the registry's one-line summaries — that's what stops re-reporting.
- **Fan-out by component, not by framework.** One agent owns mobile end-to-end (all frameworks applied to it) rather than one agent doing "all crypto everywhere." Component ownership finds chains; framework ownership finds checklists.
- **Fix agents are separate from audit agents.** The agent that found the bug is the worst person to verify the fix — it already believes its own mental model.

## 1.4 Round lifecycle (state machine)

```
PLANNED ──▶ PROMPTED ──▶ AUDITING ──▶ SYNTHESIZING ──▶ REPORTED
                                                        │
              ┌─────────────────────────────────────────┘
              ▼
           FIXING ──▶ VERIFYING ──▶ VERIFIED ──▶ (next round) PLANNED
              │           │
              │           └─ PoC still reproduces → back to FIXING
              └─ fix breaks build/tests → back to FIXING
```

- A round is **REPORTED** when the report file lands in `artifacts/audit/` and the registry has the new IDs.
- A finding is **VERIFIED** only when its PoC is re-run against fixed code and fails to reproduce. "Fix written" ≠ verified.
- Rounds never modify the registry's old entries — they append new IDs and update statuses. History is immutable.

## 1.5 Design principles

1. **Evidence or it didn't happen.** Every finding needs file:line + malicious input. Opinions are not findings.
2. **Novelty is enforced, not hoped for.** The duplicate shield + novelty justification field make re-reporting structurally difficult.
3. **Attack, don't just read.** Each round's playbook must contain active techniques (fuzzing, state-machine abuse, chaining). Code reading alone plateaus after round 2.
4. **Severity is impact × likelihood, stated explicitly.** No "this feels high."
5. **The registry is append-only.** Old findings are never edited — statuses change, history doesn't.

---

# PART 2 — LOW-LEVEL DESIGN

## 2.1 Finding schema (the unit of the system)

Every finding, in every round, has exactly these fields:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique ID per §2.2. The primary key. |
| `title` | string | One-line, specific. Bad: "auth issue". Good: "No max_tokens cap lets clients dictate output spend". |
| `severity` | Critical \| High \| Medium \| Low | Per §2.5 rubric. |
| `framework` | string | Which methodology found it (e.g., `WSTG-INPV`, `MASVS-STORAGE`, `STRIDE-Spoofing`, `CWE-400`). Forces framework coverage. |
| `file` | string | `path/to/file.ts:LINE`. Exact. |
| `component` | mobile \| gateway \| responder \| relay \| protocol \| config \| supply-chain | For fan-out accounting and the "one finding per component" acceptance gate. |
| `novelty` | string | "Not covered by F__/BMA-__ because ___." One sentence. Rejected if empty. |
| `attack_scenario` | string | Who attacks, prerequisites, step-by-step. |
| `poc` | string | The actual malicious input, or precise reasoning why input can't be shown. |
| `impact` | string | What the attacker gains. INR cost if spend-related. |
| `fix` | string | Concrete code/config change, not advice. |
| `status` | open \| fixing \| fixed \| verified \| wontfix | Lifecycle state. |
| `round` | string | Which round filed it (`round-1`, `round-2`, `round-3`…). |
| `date` | string | Filing date. |

## 2.2 ID scheme

```
Round 1 (ChatGPT):        F01, F02, … F15
Round 2 (Muse deep):      BMA-01 … BMA-28   (BMA = Bimax Audit)
Round 3 (AUDIT-2 prompt): AUD2-001, AUD2-002, …
Round N:                  AUD{N}-001, …
```

- IDs are never reused, never renumbered. If AUD2-007 turns out to be a duplicate of BMA-14, AUD2-007 is marked `duplicate-of: BMA-14` — the ID stays reserved so references don't rot.
- Prefix encodes the round; suffix is sequential within the round.

## 2.3 Dedup algorithm (decision tree)

For each candidate finding from an agent, walk this tree **in order**:

```
1. Same file:line AND same root cause as a registry entry?
   → DUPLICATE. Cite existing ID. Drop.

2. Different file:line, same root cause?
   (e.g., "no TLS enforcement" on mobile relay client AND responder relay client)
   → NEW finding, same class. Mark `class-of: <existing ID>`, cross-reference both.
   Rationale: the fix is per-location; one entry would leave the other unfixed.

3. Same file, different root cause?
   → NEW finding. (e.g., unbounded outbox AND predictable IDs in the same file are separate bugs.)

4. Combines ≥2 known findings into a new impact?
   (e.g., malicious-QR relay + plaintext dispatcher = injected fake approvals)
   → NEW finding. Mark `chains: [ID1, ID2]`. This is the highest-value output of later rounds.

5. Matches a registry entry marked "likely remediated" or old?
   → VERIFY against current code first. If still present: NEW finding referencing the old
     ID (`regression-of: <ID>`). If fixed: update old entry status, file nothing.

6. None of the above?
   → NEW finding. Assign next sequential ID.
```

**Worked example (real):** Round 2's mobile agent found "no TLS enforcement" at `apps/mobile/lib/relay/client.ts:24`; the responder agent found the same class at `apps/desktop-responder/src/relay-client.ts`. Step 2 → two findings (BMA-12, BMA-25), cross-referenced. One entry would have left one side unfixed.

## 2.4 Prompt anatomy (why each section exists)

| Section | Purpose | What breaks if removed |
|---|---|---|
| Background | Calibrates the agent: "you are round 3, not round 1" | Agent re-does basic recon, wastes budget |
| Known findings | The duplicate shield | 50% duplicates |
| Objective | Quantifiable target (min 10 novel) | Agent stops at 3 easy ones |
| Methodology | Forces named-framework coverage | Agent tests by vibes, misses whole classes |
| Scope | Exact file lists | Scope creep on one component, neglect of another |
| Attack playbook | Pushes from reading → attacking | Round-3 findings look like round-1 findings |
| Rules | Evidence standards | "Might be an issue in auth" with no file |
| Output format | Machine-checkable structure | Unparseable prose, manual extraction |
| Acceptance | Pass/fail gates | Can't tell a good round from a bad one |

**Prompt assembly order matters:** Background → Known → Objective → Methodology → Scope → Playbook → Rules → Format → Acceptance. Each section narrows the agent's freedom; by Acceptance it has exactly one way to succeed.

## 2.5 Severity rubric (impact × likelihood)

**Impact axis:**

| Level | Meaning | Example |
|---|---|---|
| Critical | Full system compromise or unbounded fund drain | RCE on laptop, provider-key theft, account takeover at scale |
| High | Significant compromise with realistic prerequisites | Single-user fund drain (~₹3,000/burst), desktop impersonation, silent RCE needing one key |
| Medium | Limited impact or unlikely prerequisites | DoS requiring network position, PII leak needing physical access |
| Low | Hygiene / defense-in-depth | Missing security headers, verbose errors |

**Likelihood axis:**

| Level | Meaning |
|---|---|
| High | Unauthenticated remote, or trivially achievable |
| Medium | Needs authenticated session or one user interaction (scan QR, click link) |
| Low | Needs physical access, multiple preconditions, or admin mistakes |

**Matrix (impact × likelihood → severity):**

|  | Likelihood: High | Medium | Low |
|---|---|---|---|
| **Impact: Critical** | Critical | Critical | High |
| **Impact: High** | Critical | High | Medium |
| **Impact: Medium** | High | Medium | Low |
| **Impact: Low** | Medium | Low | Low |

**Worked example:** BMA-01 (no max_tokens cap): impact High (fund drain ~₹306/burst) × likelihood High (any authenticated user) → **Critical** by matrix. It was filed as High — the matrix says the auditors were conservative by one notch. Future rounds use the matrix, not gut feel.

**Spend-to-INR conversion (for gateway findings):** always express fund-drain impact in INR. Working rates: DeepSeek ~₹8.5/1M input tokens, ~₹25/1M output tokens. State the rate and date; recompute per round.

## 2.6 Methodology library (the reusable core)

| Framework | Version | Applied to | What it catches that others miss |
|---|---|---|---|
| OWASP WSTG | v4.2 | Gateway | Input-validation edge cases, error-path leaks |
| OWASP MASVS/MASTG | v2.0 | Mobile | Storage/crypto/auth/platform mobile-specifics |
| OWASP API Top 10 | 2023 | Gateway | Business-logic abuse, resource consumption |
| OWASP LLM Top 10 | 2025 | Gateway, future memory | Prompt injection via retrieved context, excessive agency |
| NIST SP 800-115 | — | All | Phase discipline: plan → discover → attack → report |
| STRIDE | — | All (per data flow) | Threats by category before code reading starts |
| CWE Top 25 | 2026 list | All | Checklist completeness — "checked, not found" is a result |
| PTES | — | Process | Pre-engagement scoping, post-exploitation depth |

**Adding a framework:** append a row, write the "applied to" and "what it catches" columns, and it flows into the next round prompt automatically. Never edit a round prompt to add a framework ad hoc.

## 2.7 Report structure (every round)

```
# <Round name> — Findings
Date: YYYY-MM-DD

## Executive summary
  - counts by severity, top 3 by risk, one-line each
  - "good news" section: what was verified clean (with method)

## Findings (by severity, Critical → Low)
  - full schema per §2.1 for each

## Informational
  - non-findings worth recording (dead deps, hygiene)

## Explicitly cleared
  - "checked X, not found" — with the check performed, not just the claim
  - THIS is what makes the next round's agents trust prior work

## Corrections to prior audits
  - remediated findings, mis-scoped findings, with current-code evidence

## Fix priority
  - ordered list with rationale (exploitability × blast radius × fix cost)
```

**The "Explicitly cleared" section is load-bearing.** It's the only thing that lets round N+1 skip re-checking what round N cleared. A clearance without the check method is worthless — "no SQLi" must say "all queries use .bind()/parameterized, grepped for string interpolation in SQL."

## 2.8 File layout

```
bimax-mobile/
├── AUDIT-2.md                    # round prompts (root: they drive the repo)
├── AUDIT-3.md                    # …
├── AUDIT-SYSTEM-DESIGN.md        # this file
└── artifacts/audit/
    ├── production-readiness-2026-10-15.md   # round 1 report
    ├── reproduce-findings.cjs               # round 1 PoC scripts
    ├── security-deep-audit-2026-10-15.md    # round 2 report
    └── audit-3-findings-YYYY-MM-DD.md       # round N reports
```

- Prompts at root (they're the control plane). Reports under `artifacts/audit/` (they're evidence).
- Naming: `audit-{N}-findings-{date}.md`. Never `final-audit-v2-FINAL.md`.

## 2.9 Fix pipeline (FIX-N.md anatomy)

Each High/Critical finding gets a fix prompt with:

1. **The finding restated** (ID, file:line, PoC) — the fix agent must reproduce first.
2. **Reproduce step (mandatory):** run the PoC against current code, confirm it triggers. No reproduce → no fix (prevents fixing the wrong thing).
3. **The fix** — exact change, exact file, exact lines.
4. **Re-run the PoC** — must now fail to reproduce.
5. **Regression check** — existing tests for that component must still pass.
6. **Registry update** — status `fixed`, awaiting verifier.

**Verifier step (separate agent):** takes the FIX report, re-runs the PoC independently, checks the diff doesn't break adjacent behavior, marks `verified`. Only `verified` findings close.

## 2.10 Anti-patterns (learned)

- **Don't let the audit agent fix.** Finder and fixer must be different agents (or different passes). §1.3.
- **Don't file without PoC.** "Might be vulnerable" findings waste fix cycles.
- **Don't round severity by feel.** Use the matrix (§2.5).
- **Don't trust "checked, not found" without method.** §2.7.
- **Don't run round N+1 before round N's Highs are at least `fixing`.** Otherwise the new round re-finds what the old round already filed but nobody fixed — technically novel to the agent, noise to you.

---

*End of design. The system is currently at: round 3 PROMPTED (AUDIT-2.md written, awaiting execution).* 
