# Bimax Cross-Device Chat Sync — Design (v0.2 "Memory")

E2E-encrypted chat history sync across phone, laptop, and future devices.
The server stores ciphertext it cannot read. D1 never sees plaintext — the current
privacy property is preserved, not weakened.

---

## 0. What the research says (Oct 2026)

Surveyed before designing. The industry has converged on two patterns; we pick
the simpler one deliberately.

| System | Multi-device pattern | Notes |
|---|---|---|
| **WhatsApp** (companion mode, up to 4 devices) | Each device has its own identity keys. Sender runs X3DH + Double Ratchet **per recipient device** and submits one ciphertext per device; server persists per-device blobs, deletes on ACK. Each device connects independently; history syncs on linking. | Proven at billions scale. Per-device fan-out is the workhorse. |
| **Signal** (Sesame) | Per-device sessions + per-device server mailboxes. Sender encrypts a separate copy per device **including its own other devices**. Server refuses sends when the device list changed (stale-list protection). Secure Backups (Sep 2025): zero-knowledge E2E cloud backup under a 64-char recovery key. | Sesame paper notes the naive "server mailbox" design is not post-compromise secure without extra verification on device registration. |
| **MLS (RFC 9420)** | IETF standard (2023). Google Messages + Apple Messages rolled out MLS E2EE over RCS in May 2026; Discord adopted it for E2E voice/video in 2026; Matrix is migrating. TS implementations exist (MLS-TS, ts-mls). | Built for **large groups** with epoch agreement, ratchet trees, KeyPackages. Massive machinery for a 2–4-device append-mostly log. |
| **Post-quantum** | Apple PQ3 (iMessage, ML-KEM hybrid *inside* the ratchet, formally analyzed USENIX 2025). Signal PQXDH. Cloudflare: hybrid PQ TLS 1.3 across its edge. Google: full PQ migration deadline 2029. | Direction is clear (hybrid ML-KEM), but stable React Native PQ libraries don't exist yet. |

**Decision: the WhatsApp/Signal pattern, not MLS.** Our sync is 1 user, 2–5 devices,
append-mostly chat — not a 50,000-member group. MLS's epoch/commit agreement and
Delivery Service ordering requirements buy us nothing and cost a second crypto
stack to audit. We use a shared History Encryption Key (HEK) + per-device server
mailboxes, exactly the shape both WhatsApp and Signal proved. MLS gets revisited
if Bimax ever does team/shared workspaces.

**Post-quantum stance for v1: algorithm agility, not PQ.** Ship classical
(X25519 / XChaCha20-Poly1305 / Ed25519) via libsodium-compatible primitives.
Every envelope carries an `alg` field so hybrid ML-KEM slots in later without a
format break. Transport already gets hybrid PQ free (Cloudflare edge negotiates
it). Revisit when a stable, audited ML-KEM lands for React Native.

---

## 1. Goals / non-goals

**Goals**
- Chat history identical on all of a user's devices, synced within seconds.
- Server (Cloudflare/D1) learns nothing about content. Ciphertext only.
- New device onboards via the existing pairing ceremony (QR → Noise IK → code).
- Losing one device doesn't lose history; revoking one device is one tap.
- Works with the pieces we already have: Noise pipe, JWT auth, per-account
  encrypted SQLite, relay-ticket pattern.

**Non-goals (v1)**
- MLS. Post-quantum key exchange. Media/attachment sync (text first).
- Passphrase recovery / Secure-Backup-style SVR (explicitly deferred — §8).
- Per-conversation keys (one HEK per account; finer granularity is v2).
- Key transparency log (worthwhile, later).

---

## 2. Key hierarchy

```
                    ┌─────────────────────────┐
                    │  Account identity (JWT) │  Supabase — who you are
                    └────────────┬────────────┘
                                 │ enrolls devices
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  ┌───────────┐           ┌───────────┐           ┌───────────┐
  │ Device A  │           │ Device B  │           │ Device C  │
  │ (phone)   │           │ (laptop)  │           │ (tablet)  │
  └─────┬─────┘           └─────┬─────┘           └─────┬─────┘
        │ Noise static keys     │ (existing pairing)    │
        │ (auth) + hello        │                       │
        │ Ed25519 (signing)     │                       │
        └───────────────────────┴───────────────────────┘
                                 │ HEK shared over the
                                 │ Noise E2E pipe at pairing
                    ┌────────────▼────────────┐
                    │  HEK_v — 256-bit key    │
                    │  XChaCha20-Poly1305     │  encrypts ALL envelopes
                    │  versioned (v1, v2…)    │  rotation on revoke
                    └─────────────────────────┘
```

| Key | Purpose | Lives | Never touches |
|---|---|---|---|
| Supabase JWT | Account identity to the gateway | Memory only | Disk (short-lived) |
| Device Noise static (X25519) | Pairing pipe + pairwise HEK wrapping | SecureStore / 0600 file | Server, other devices' disks |
| Device hello key (Ed25519) | **Signs every sync envelope** — server verifies authenticity without reading content | SecureStore / 0600 file | Server plaintext (pubkey only) |
| **HEK_v** (256-bit symmetric) | Encrypts all history envelopes | SecureStore / 0600 file, **shared across the user's devices** | Server, in any form |

The mobile `storage-crypto` per-account key and the HEK are the **same key**.
The column encryption that just landed *is* the v1 HEK — no second key to manage.
Desktop stores it in the identity file (after the BMA-05 `0o600` fix).

---

## 3. Envelope format (what's stored in D1)

```jsonc
{
  "v": 1,
  "alg": "xchacha20poly1305-hek-v1",   // agility hook for PQ later
  "envelope_id": "uuid-v4 (CSPRNG)",
  "account_id_hash": "sha256(account_id) hex", // server routes, never learns the account
  "device_id": "dev-…",
  "key_version": 3,
  "seq": 42,                              // per-device monotonic; server enforces
  "kind": "message | tombstone | key-rotation | device-announce",
  "created_at": 1729000000000,
  "sig": "base64 Ed25519 sig over canonical(envelope minus sig/ciphertext)",
  "nonce": "base64 24B",
  "ciphertext": "base64"                  // XChaCha20-Poly1305(HEK_v, plaintext)
}
```

Plaintext per kind:

- **message**: `{msg_id, conversation_id, role, content, reasoning?, model,
  created_at, updated_at}`. `msg_id` = UUID v4 from CSPRNG (also fixes the
  BMA-11 ID-predictability class).
- **tombstone**: `{msg_id, conversation_id, deleted_at}`. Deletes propagate as
  data, not as absence — this is what makes multi-device delete work.
- **key-rotation**: `{new_key_version, wrapped_keys: [{device_id,
  x25519_wrapped_hek}]}` — one entry per *remaining* device. See §6.
- **device-announce**: `{device_id, device_pubkey, enrolled_at}` — lets clients
  render "your devices" without trusting the server's word alone.

---

## 4. Server storage (D1) — new tables, migration 0005

```sql
CREATE TABLE sync_devices (
  account_id_hash TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  device_pubkey   TEXT NOT NULL,   -- hello Ed25519 pubkey; verifies envelope sigs
  enrolled_at     TEXT NOT NULL,
  revoked_at      TEXT,            -- NULL = active
  PRIMARY KEY (account_id_hash, device_id)
);

CREATE TABLE sync_envelopes (
  account_id_hash TEXT NOT NULL,
  envelope_id     TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK(kind IN ('message','tombstone','key-rotation','device-announce')),
  key_version     INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  ciphertext      BLOB NOT NULL,   -- includes nonce; server never decrypts
  UNIQUE (account_id_hash, device_id, seq)
);
CREATE INDEX idx_sync_fetch ON sync_envelopes(account_id_hash, created_at, envelope_id);
```

**What the server verifies on upload** (authenticity without content access):
1. JWT valid → derive `account_id_hash`; device in `sync_devices`, `revoked_at IS NULL`.
2. `seq` > last seen seq for (account, device) — monotonic, kills replays.
3. Ed25519 `sig` verifies under the enrolled `device_pubkey`.
4. Size caps: ≤100 envelopes/batch, each ≤64 KB (text-first).

**Metadata the server inevitably learns** (documented limitation, same class as
BMA-17): envelope counts, sizes, timing, device list. Content stays opaque.
Mitigation later: fixed-size envelope padding.

**Retention:** envelopes are the durable history — kept until the account wipes
them (`clear-cloud-history` op deletes all rows for the account). No TTL in v1;
text is tiny.

---

## 5. Sync protocol (gateway endpoints, JWT-authed)

| Endpoint | Purpose |
|---|---|
| `POST /v1/sync/enroll` | Register a device. Body: `{device_id, device_pubkey, ticket}`. The ticket is signed by an **existing** device (reuse the `relay-ticket.ts` pattern); the very first device bootstraps with the account JWT alone. |
| `POST /v1/sync/upload` | Batch-upload envelopes (≤100). Server runs the §4 checks, stores, returns accepted/rejected per envelope. |
| `GET /v1/sync/fetch?since=<cursor>&limit=500` | Returns others' envelopes after cursor. Cursor is opaque server-issued `(created_at, envelope_id)`; client persists it in SQLite. |
| `GET /v1/sync/devices` | Active + revoked device list, for the "your devices" UI. |
| `POST /v1/sync/revoke` | `{device_id, sig}` — sig must come from a **different** active device (no self-revoke-by-attacker; unlinking your own device uses the local "remove this device" path + a rotation). Triggers §6 rotation. |
| `POST /v1/sync/wipe` | Delete all envelopes + devices for the account. Fresh start / "forget me". |

**Client sync loop** (mobile `lib/sync/`, desktop equivalent):
1. On app start, on push ping, and every 60s: `fetch` since cursor.
2. For each envelope: check `key_version` ∈ known keys → decrypt → apply:
   - `message` → upsert into local `messages` (idempotent on `msg_id`).
   - `tombstone` → delete local row + record tombstone (so it isn't resurrected by a later fetch).
   - `key-rotation` → unwrap our entry with our Noise static key, store HEK_{v+1}.
3. Advance cursor only after durable local apply (crash-safe).
4. Upload path: local writes go to an outbox table first (bounded — BMA-14
   already demands the cap), uploader drains it in batches.

**Backfill:** on first sync enable, each device uploads its existing local
messages as envelopes preserving original `created_at`. History merges by
`msg_id`; duplicates are impossible by construction.

---

## 6. Key distribution, rotation, revocation

**New device joins** (during the existing pairing ceremony):
1. QR → Noise IK → verification code (unchanged — BMA-04's URL validation applies).
2. Over the established E2E pipe, existing device sends `key_share {hek_v,
   key_version}`. The pipe is already authenticated; no extra wrapping needed.
3. New device stores HEK in SecureStore / 0600 file, enrolls via
   `POST /v1/sync/enroll` with a ticket from the existing device, then fetches
   history since genesis.

**Rotation** (revoke, or scheduled every 90 days, or manual "rotate keys"):
- An active device generates HEK_{v+1} (CSPRNG), then for **each remaining
  device** wraps it under that device's Noise static X25519 key and uploads one
  `key-rotation` envelope per device (WhatsApp-style per-device fan-out; N ≤ 5
  so this is trivial).
- **Why pairwise, not "encrypt under old HEK":** the revoked device knows the
  old HEK — wrapping the new key in the old one hands it straight to the
  attacker. This is the single most important subtlety in the design.
- Devices keep old HEK versions locally (decrypting old envelopes); new
  messages use the newest.

**Revocation honesty:** a revoked device keeps ciphertext it already synced —
revocation can't unsee, same as Signal/WhatsApp. What revocation *does*: the
device's JWT/device entry is dead (no more fetch/upload — server enforces via
`revoked_at`), and all future content uses a key it never receives. Say this in
the UI: "This device will no longer receive new messages. Messages it already
had remain on it."

---

## 7. Conflict resolution (no CRDTs)

Chat is append-mostly, so deterministic rules suffice:

| Case | Rule |
|---|---|
| Two devices write different messages | Both kept. Order by `(created_at, msg_id)` — deterministic everywhere. |
| Same `msg_id` edited on two devices | Last-writer-wins by `(updated_at, device_id)` lexicographic tiebreak. |
| Edit vs delete | Tombstone wins if `tombstone.deleted_at > edit.updated_at`, else the edit stands. |
| Conversation title | Same LWW rule as edits. |
| Same `seq` from one device twice | Server rejects (`UNIQUE(account, device, seq)`); client regenerates. |

No CRDT library, no merge UI, no "conflicted copy" concept. Rationale: a
commutative object-set merge doesn't solve message ordering anyway — total order
by timestamp+ID is the correct primitive for a chat log.

---

## 8. Recovery: the "lost all devices" case

**v1: explicit non-recovery.** If every device is gone, the HEK is gone and the
ciphertext in D1 is permanent noise. Onboarding says so in one line:
*"Lose all your devices and your history is unrecoverable — even by us."*
This is the Signal Desktop model, and it's the honest price of true E2E.

**v2 (later):** Signal-Secure-Backup-style opt-in — HEK wrapped by
Argon2id(passphrase) into a blob in R2, or a 64-character recovery key shown
once at setup. Never SMS/email recovery (SIM-swap kills it).

---

## 9. Threat model

| Adversary | Protected? | How |
|---|---|---|
| Curious/compromised Cloudflare (reads D1) | ✅ | Ciphertext only; account IDs hashed. |
| Network attacker (MITM) | ✅ | TLS + envelope signatures; content E2E. |
| Thief with one unlocked device | ⚠️ Partial | Gets that device's plaintext (unavoidable); cannot forge as other devices (no their keys); revoke + rotate contains it. |
| Revoked device | ✅ forward | New HEK via pairwise wrap; server blocks its fetch/upload. Old synced data retained (documented). |
| Malicious server serving stale device list (Sesame attack) | ✅ | Sender encrypts per-device only for enrolled devices; `GET /devices` cross-checked against `device-announce` envelopes clients wrote themselves. |
| Attacker enrolling a rogue device | ✅ | Enrollment needs a ticket signed by an existing device (or the account JWT for device #1). |
| Metadata analysis (who chats when) | ❌ | Documented limitation; padding later. |
| Compromised endpoint (malware on laptop) | ❌ | Out of scope — no sync design survives the endpoint. |
| Quantum adversary, harvest-now-decrypt-later | ⚠️ | `alg` agility field reserved; transport PQ via Cloudflare edge; HEK PQ wrap in v2. |

---

## 10. Build order

1. **D1 migration 0005** — `sync_devices`, `sync_envelopes` (§4).
2. **Gateway endpoints** — enroll/upload/fetch/devices/revoke/wipe (§5) + §4 upload checks.
3. **Key-share over Noise pipe** — new `key_share` message kind in
   mobile `lib/crypto/pairing.ts` + desktop `pairing.ts`.
4. **Mobile sync engine** — `lib/sync/` (outbox, fetch loop, apply, cursor).
5. **Desktop sync engine** — mirror of (4) against the responder's store.
6. **Backfill** — upload existing local history on first enable.
7. **UI** — "your devices" list, revoke button, rotation indicator, the
   one-line no-recovery notice.
8. **Tests** — the adversarial battery: rogue enroll rejected, revoked device
   can't fetch, replayed seq rejected, rotation unreadable by revoked device
   (simulate with its old HEK), tombstone propagation, offline-then-catch-up.

---

## 11. Open questions for Sid

1. **Device limit:** WhatsApp allows 4 companions. Propose **5 total** — enough for phone + laptop + tablet + spare, small enough that pairwise rotation stays trivial.
2. **Retention:** v1 says keep-forever-until-wipe. OK, or do you want a 1-year rolling TTL?
3. **Recovery stance:** confirm v1 = no recovery, honest copy. (The alternative is building SVR-style backup now — real work.)
4. **Media:** text-only sync for v1, attachments follow in v0.5 Knowledge? (Attachments are the size problem — syncing them E2E means an encrypted blob store, likely R2.)

---

*Research: MLS RFC 9420 (IETF); WhatsApp companion-mode architecture; Signal Sesame + Secure Backups (Sep 2025); Apple PQ3 / Signal PQXDH / Cloudflare hybrid-PQ TLS. Design: Oct 2026.*
