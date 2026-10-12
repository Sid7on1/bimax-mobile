# iQOO Hackathon Research — imported

Imported 2026-10-13 from `~/Desktop/BimaxApk` (Sid's iQOO Hackathon 2026 repo)
into `bimax-mobile/iqoo-hackathon/`. Verbatim copy — nothing edited.

Contents:
- `research_papers/` — 7 research papers (01 master architecture, 02 SoC
  inference, 03 agent safety, 04 diff compression, 05 secret detection,
  06 Noise_IK verification, 07 vision economics)
- `docs/research/` — architecture, implementation charter, verification
  matrix, phone/hardware capabilities, pitch strategy, academic prompts,
  and Subsystem-1..6 dossiers
- `*.pdf` — 4 top-level PDFs (team control-plane spec, hackathon rules,
  architecture blueprint, edge-AI assessment)
- `figma_plugin/` — pitch-deck generator (hackathon packaging, no product value)
- `README.md` — the original BimaxApk readme

Reconciliation with bimax-mobile (2026-10-12):
- ADOPTED: formal Noise_IK pairing handshake, zero-open-ports rule,
  biometric-per-use signing with enrollment invalidation
- REJECTED: native Kotlin (kills iOS), Cloudflare edge (complexity without
  scale), on-device SLM (Snapdragon-gated)

Deep-read feature extraction: `~/workspace/bimax-mobile/iqoo-deep-read/REPORT.md`
(on the agent VM, not in this repo).

Note: every dossier's "VERIFIED: PASS" stamp is the author's own mark,
not independent verification. Treat benchmark numbers as directional.
