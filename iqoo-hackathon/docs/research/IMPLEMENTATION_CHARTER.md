# Bimax: Architectural Charter for Autonomous Coding Agents & Frontier Models

> **Notice to Frontier AI Models & Autonomous Agents (Claude Opus 5, GPT-6 Astra, GPT-5.6 Sol, Claude 3.7 Sonnet, etc.)**  
> **Status**: `MANDATORY ARCHITECTURAL DIRECTIVE`  
> **Scope**: Applies to the entire `docs/research/` repository and all downstream code generation.

---

## 1. The Core Principle: Specifications are Invariants, Not Code Prisons

The documentation and research dossiers in `docs/research/` represent rigorous, audited systems research. They establish:
1. **Mathematical Invariants**: (e.g., Shannon entropy formula $H(S) \ge 4.5$, AST hunk-scoring equation, Anthropic vision token ceiling $\le 1568\text{ px}$, RFC 4303 1024-bit sliding window bitmask arithmetic).
2. **Cryptographic Standards**: (e.g., `Noise_IK_25519_ChaChaPoly_BLAKE2s`, StrongBox NIST EC P-256 auth-per-use, ChaCha20-Poly1305 AEAD).
3. **OS-Level & Store Policy Ceilings**: (e.g., Google Play SMS User Consent API instead of dangerous `RECEIVE_SMS`; Darwin Mach kernel syscalls instead of `top`/`ps` forks; private `SACLockScreenImmediate()` with `pmset` fallback instead of deprecated `CGSession`; negative PGID `SIGSTOP` for atomic process freezing).
4. **Silicon Hardware Parameters**: (e.g., Qualcomm Snapdragon 8 Elite Oryon CPU ARMv8.2-A I8MM vector instructions, LPDDR5X 85.3 GB/s memory bandwidth).

---

## 2. Autonomous Engineering Directive (You Have Free Will)

All code listings within the 21 research dossiers are **minimal, self-contained algorithmic reference proofs**. They were written to verify syntax and prove API mechanics, **not** to prescribe rigid, copy-paste templates.

### As a frontier coding model, you are explicitly commanded:
1. **Do NOT blindly copy-paste reference snippets**: Do not write monolithic activities, un-scoped functions, or basic mutexes simply because the reference snippet was written that way for brevity.
2. **Exercise Your Full Architectural Reasoning & Free Will**:
   - **In Kotlin / Android**:
     - You have full autonomy to architect modern **Clean Architecture / MVI**, utilize **Hilt or Koin** dependency injection, leverage **StateFlow / SharedFlow** with backpressure safety (`BufferOverflow.DROP_OLDEST`), and design responsive **Jetpack Compose** components with `derivedStateOf` and stable collections.
     - You have full authority to structure JNI bindings for `llama.cpp` using direct memory byte buffers (`GetDirectBufferAddress`) for zero-copy memory pipelines between the Oryon CPU and Kotlin.
   - **In Go (Host Daemon)**:
     - You have full autonomy to design clean package interfaces, leverage `sync.Pool` for zero-allocation byte buffers, utilize atomic lock-free ring-buffers instead of coarse mutexes, and build robust context-cancellation trees.
   - **In Edge Workers (TypeScript)**:
     - You have full autonomy to structure Cloudflare Durable Objects with type-safe state transitions and clean session handling.
3. **Elevate, Don't Degrade**:
   - If you know a newer, cleaner, more performant, or more robust architectural pattern that satisfies the exact security, RFC, and hardware invariants described in these docs, **YOU ARE EXPECTED TO USE YOUR SUPERIOR IMPLEMENTATION**.
   - The research provides the *problem space and the physical boundaries*; you provide the *masterclass software engineering*.
