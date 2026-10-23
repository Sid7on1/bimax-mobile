import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalJson } from "./canonical";
import { base64ToBytes } from "./base64";

export interface Sql {
  exec(sql: string, ...params: unknown[]): { rows: Record<string, unknown>[] };
}

export const OUTBOX_TTL_MS = 120 * 1000;
export const OUTBOX_MAX_PER_DEVICE = 500;
export const DRAIN_MAX = 500;
export const MAX_ENVELOPE_BYTES = 256 * 1024;

export function isOversize(
  message: string | Uint8Array,
  maxBytes: number = MAX_ENVELOPE_BYTES,
): boolean {
  const byteLength =
    typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
  return byteLength > maxBytes;
}

export function buildPresence(
  toDeviceId: string,
  subjectDeviceId: string,
  role: string,
  status: "online" | "offline",
  lastSeen: number,
  nowMs: number = Date.now(),
): string {
  const env = {
    v: 2,
    id: `pres-${nowMs}-${Math.random().toString(36).slice(2, 9)}`,
    ts: nowMs,
    from: "relay",
    to: toDeviceId,
    kind: "presence",
    payload: {
      deviceId: subjectDeviceId,
      role,
      status,
      lastSeen,
    },
  };
  return JSON.stringify(env);
}

export type VerifyHelloResult =
  | {
      ok: true;
      deviceId: string;
      role: "desktop" | "mobile";
      helloPubkey: string;
      isNewPin: boolean;
    }
  | {
      ok: false;
      code: number;
      reason: string;
    };

export function verifyHello(
  env: unknown,
  nowMs: number,
  getPin: (id: string) => string | null,
): VerifyHelloResult {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, code: 4400, reason: "invalid hello envelope" };
  }

  const rawEnv = env as Record<string, unknown>;

  // 1. env.v === 2, env.kind === "hello", env.to === "relay"
  if (rawEnv.v !== 2 || rawEnv.kind !== "hello" || rawEnv.to !== "relay") {
    return { ok: false, code: 4400, reason: "invalid hello envelope" };
  }
  if (typeof rawEnv.id !== "string" || !rawEnv.id || rawEnv.id.length > 128) {
    return { ok: false, code: 4400, reason: "invalid hello id" };
  }
  if (typeof rawEnv.ts !== "number" || !Number.isFinite(rawEnv.ts)) {
    return { ok: false, code: 4400, reason: "invalid hello ts" };
  }

  // 2. Payload: protocolVersion === 2; deviceId a non-empty string (max 128 chars); role is "desktop" or "mobile"; env.from === deviceId
  if (!rawEnv.payload || typeof rawEnv.payload !== "object" || Array.isArray(rawEnv.payload)) {
    return { ok: false, code: 4400, reason: "invalid hello payload" };
  }
  const payload = rawEnv.payload as Record<string, unknown>;

  if (payload.protocolVersion !== 2) {
    return { ok: false, code: 4400, reason: "unsupported protocol version" };
  }
  if (typeof payload.deviceId !== "string" || !payload.deviceId || payload.deviceId.length > 128) {
    return { ok: false, code: 4400, reason: "invalid deviceId" };
  }
  if (payload.role !== "desktop" && payload.role !== "mobile") {
    return { ok: false, code: 4400, reason: "invalid role" };
  }
  if (rawEnv.from !== payload.deviceId) {
    return { ok: false, code: 4400, reason: "from mismatch" };
  }

  // 3. |Date.now() - env.ts| <= 120000, else close(4401, "stale hello")
  if (Math.abs(nowMs - rawEnv.ts) > 120000) {
    return { ok: false, code: 4401, reason: "stale hello" };
  }

  // 4. helloPubkey / helloSignature are non-empty base64; pubkey decodes to 32 bytes, signature to 64 bytes; else close(4401, "bad hello shape")
  if (
    typeof payload.helloPubkey !== "string" ||
    !payload.helloPubkey ||
    typeof payload.helloSignature !== "string" ||
    !payload.helloSignature
  ) {
    return { ok: false, code: 4401, reason: "bad hello shape" };
  }

  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = base64ToBytes(payload.helloPubkey);
    sigBytes = base64ToBytes(payload.helloSignature);
  } catch {
    return { ok: false, code: 4401, reason: "bad hello shape" };
  }

  if (pubkeyBytes.length !== 32 || sigBytes.length !== 64) {
    return { ok: false, code: 4401, reason: "bad hello shape" };
  }

  // 5. msg = utf8(canonicalJson({ id: env.id, ts: env.ts, from: env.from, deviceId, role, helloPubkey })); ed25519.verify(sig, msg, pubkey) must be true, else close(4401, "bad hello signature")
  const expectedMsg = canonicalJson({
    id: rawEnv.id,
    ts: rawEnv.ts,
    from: rawEnv.from,
    deviceId: payload.deviceId,
    role: payload.role,
    helloPubkey: payload.helloPubkey,
    protocolVersion: payload.protocolVersion,
  });
  const msgBytes = new TextEncoder().encode(expectedMsg);

  let signatureValid = false;
  try {
    signatureValid = ed25519.verify(sigBytes, msgBytes, pubkeyBytes);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, code: 4401, reason: "bad hello signature" };
  }

  // 6. TOFU pinning: SELECT pubkey FROM pins WHERE device_id = ?. No row -> insert pin. Mismatch -> close(4401, "device key changed"). Match -> continue.
  const existingPin = getPin(payload.deviceId);
  if (existingPin !== null && existingPin !== payload.helloPubkey) {
    return { ok: false, code: 4401, reason: "device key changed" };
  }

  return {
    ok: true,
    deviceId: payload.deviceId,
    role: payload.role as "desktop" | "mobile",
    helloPubkey: payload.helloPubkey,
    isNewPin: existingPin === null,
  };
}

// Rate limit: 30 messages/second per device, in-memory sliding window.
// Note: Durable Object hibernation may reset this in-memory state between wakeups (best-effort).
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly timestamps = new Map<string, number[]>();

  constructor(limit = 30, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(deviceId: string, nowMs: number = Date.now()): boolean {
    let list = this.timestamps.get(deviceId);
    if (!list) {
      list = [];
      this.timestamps.set(deviceId, list);
    }
    const cutoff = nowMs - this.windowMs;
    list = list.filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.timestamps.set(deviceId, list);
      return false;
    }
    list.push(nowMs);
    this.timestamps.set(deviceId, list);
    return true;
  }

  clear(deviceId?: string): void {
    if (deviceId) {
      this.timestamps.delete(deviceId);
    } else {
      this.timestamps.clear();
    }
  }
}

export interface RoomStoreOptions {
  outboxTtlMs?: number;
  outboxMaxPerDevice?: number;
  drainMax?: number;
}

export class RoomStore {
  private sql: Sql;
  readonly outboxTtlMs: number;
  readonly outboxMaxPerDevice: number;
  readonly drainMax: number;

  constructor(sql: Sql, options?: RoomStoreOptions) {
    this.sql = sql;
    this.outboxTtlMs = options?.outboxTtlMs ?? OUTBOX_TTL_MS;
    this.outboxMaxPerDevice = options?.outboxMaxPerDevice ?? OUTBOX_MAX_PER_DEVICE;
    this.drainMax = options?.drainMax ?? DRAIN_MAX;
    this.initTables();
  }

  private initTables(): void {
    // Protocol 2 clients retry logical actions; old ciphertext must not be migrated across sessions.
    this.sql.exec("DROP TABLE IF EXISTS outbox");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hello_replays(device_id TEXT NOT NULL,id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,id))",
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox_v3(
  id TEXT NOT NULL,
  from_device TEXT NOT NULL,
  to_device TEXT NOT NULL,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(from_device,to_device,id)
)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_outbox_v3_to ON outbox_v3(to_device, created_at)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS pins(device_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY, role TEXT NOT NULL, last_seen INTEGER NOT NULL)`,
    );
  }

  acceptHello(deviceId: string, id: string, now: number): boolean {
    this.sql.exec("DELETE FROM hello_replays WHERE expires_at<?", now);
    if (
      Number(this.sql.exec("SELECT COUNT(*) AS cnt FROM hello_replays").rows[0]?.cnt ?? 0) >= 1024
    )
      return false;
    const row = this.sql.exec(
      "INSERT OR IGNORE INTO hello_replays(device_id,id,expires_at) VALUES (?,?,?) RETURNING id",
      deviceId,
      id,
      now + 120_000,
    );
    return row.rows.length === 1;
  }

  getPin(deviceId: string): string | null {
    const res = this.sql.exec("SELECT pubkey FROM pins WHERE device_id = ?", deviceId);
    if (res.rows.length === 0) return null;
    return typeof res.rows[0].pubkey === "string" ? res.rows[0].pubkey : null;
  }

  setPin(deviceId: string, pubkey: string): void {
    this.sql.exec("INSERT OR REPLACE INTO pins(device_id, pubkey) VALUES (?, ?)", deviceId, pubkey);
  }

  upsertDevice(deviceId: string, role: string, lastSeen: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO devices(device_id, role, last_seen) VALUES (?, ?, ?)",
      deviceId,
      role,
      lastSeen,
    );
  }

  updateLastSeen(deviceId: string, lastSeen: number): void {
    this.sql.exec("UPDATE devices SET last_seen = ? WHERE device_id = ?", lastSeen, deviceId);
  }

  getDeviceLastSeen(deviceId: string): number | null {
    const res = this.sql.exec("SELECT last_seen FROM devices WHERE device_id = ?", deviceId);
    if (res.rows.length === 0) return null;
    return typeof res.rows[0].last_seen === "number"
      ? res.rows[0].last_seen
      : Number(res.rows[0].last_seen);
  }

  getDevices(): { deviceId: string; role: "desktop" | "mobile"; lastSeen: number }[] {
    const res = this.sql.exec("SELECT device_id, role, last_seen FROM devices");
    return res.rows.map((r) => ({
      deviceId: String(r.device_id),
      role: r.role === "desktop" ? "desktop" : "mobile",
      lastSeen: Number(r.last_seen),
    }));
  }

  saveOutbox(id: string, toDevice: string, envelope: string, nowMs: number): void {
    const cutoff = nowMs - this.outboxTtlMs;
    this.sql.exec("DELETE FROM outbox_v3 WHERE created_at < ?", cutoff);
    const parsed = JSON.parse(envelope);
    const fromDevice = String(parsed.from);
    const identity = canonicalJson({
      v: parsed.v,
      id: parsed.id,
      from: parsed.from,
      to: parsed.to,
      kind: parsed.kind,
      payload: parsed.payload,
    });
    const size = this.sql.exec(
      "SELECT COALESCE(SUM(length(CAST(envelope AS BLOB))),0) AS bytes FROM outbox_v3",
    ).rows[0];
    const count = this.sql.exec(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(length(CAST(envelope AS BLOB))),0) AS bytes FROM outbox_v3 WHERE to_device=?",
      toDevice,
    ).rows[0];
    const existing = this.sql.exec(
      "SELECT envelope FROM outbox_v3 WHERE from_device=? AND to_device=? AND id=?",
      fromDevice,
      toDevice,
      id,
    ).rows[0];
    if (existing) {
      const old = JSON.parse(String(existing.envelope));
      if (
        canonicalJson({
          v: old.v,
          id: old.id,
          from: old.from,
          to: old.to,
          kind: old.kind,
          payload: old.payload,
        }) !== identity
      )
        throw new Error("Envelope ID collision");
      return;
    }
    if (
      Number(size?.bytes ?? 0) + new TextEncoder().encode(envelope).length > 8 * 1024 * 1024 ||
      Number(count?.bytes ?? 0) + new TextEncoder().encode(envelope).length > 2 * 1024 * 1024 ||
      Number(count?.cnt ?? 0) >= this.outboxMaxPerDevice
    )
      throw new Error("Outbox capacity");

    this.sql.exec(
      "INSERT OR IGNORE INTO outbox_v3(id, from_device,to_device, envelope, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      fromDevice,
      toDevice,
      envelope,
      nowMs,
    );
  }

  drainOutbox(toDevice: string): string[] {
    const res = this.sql.exec(
      "SELECT envelope FROM outbox_v3 WHERE to_device = ? ORDER BY created_at ASC LIMIT ?",
      toDevice,
      this.drainMax,
    );
    return res.rows.map((r) => String(r.envelope));
  }

  deleteOutboxIfOwner(id: string, fromDevice: string, originalSender?: string): void {
    if (originalSender)
      this.sql.exec(
        "DELETE FROM outbox_v3 WHERE id=? AND to_device=? AND from_device=?",
        id,
        fromDevice,
        originalSender,
      );
    else if (
      Number(
        this.sql.exec(
          "SELECT COUNT(*) AS cnt FROM outbox_v3 WHERE id=? AND to_device=?",
          id,
          fromDevice,
        ).rows[0]?.cnt,
      ) === 1
    )
      this.sql.exec("DELETE FROM outbox_v3 WHERE id=? AND to_device=?", id, fromDevice);
  }

  hasPending(): boolean {
    return Number(this.sql.exec("SELECT COUNT(*) AS cnt FROM outbox_v3").rows[0]?.cnt ?? 0) > 0;
  }

  pruneExpired(nowMs: number): void {
    const cutoff = nowMs - this.outboxTtlMs;
    this.sql.exec("DELETE FROM outbox_v3 WHERE created_at < ?", cutoff);
  }
}

export interface DeviceAttachment {
  deviceId: string;
  role: "desktop" | "mobile";
}

export interface ProcessMessageResult {
  ok: boolean;
  action:
    | "forwarded"
    | "stored"
    | "dropped"
    | "acked"
    | "rate_limited"
    | "bad_json"
    | "sender_mismatch"
    | "invalid_id_not_stored";
  closeCode?: number;
  closeReason?: string;
}

export function processPostHelloMessage(
  rawText: string,
  attachment: DeviceAttachment,
  store: RoomStore,
  rateLimiter: RateLimiter,
  findTargetSocket: (deviceId: string) => { send(data: string): void } | null,
  nowMs: number = Date.now(),
): ProcessMessageResult {
  if (!rateLimiter.check(attachment.deviceId, nowMs)) {
    return {
      ok: false,
      action: "rate_limited",
      closeCode: 4429,
      closeReason: "rate limited",
    };
  }

  let env: Record<string, unknown>;
  try {
    env = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return { ok: false, action: "bad_json" };
  }

  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, action: "bad_json" };
  }

  if (
    env.v !== 2 ||
    ![
      "encrypted",
      "pairing_request",
      "pairing_grant",
      "pairing_prekey_request",
      "pairing_prekey",
      "delivery_ack",
    ].includes(String(env.kind))
  )
    return { ok: false, action: "dropped" };

  if (env.from !== attachment.deviceId) {
    return {
      ok: false,
      action: "sender_mismatch",
      closeCode: 4400,
      closeReason: "sender mismatch",
    };
  }

  store.updateLastSeen(attachment.deviceId, nowMs);

  if (env.kind === "delivery_ack") {
    const ackPayload = env.payload as Record<string, unknown> | undefined;
    const ackId =
      typeof ackPayload?.id === "string"
        ? ackPayload.id
        : typeof ackPayload?.ackId === "string"
          ? ackPayload.ackId
          : null;
    if (ackId) {
      store.deleteOutboxIfOwner(
        ackId,
        attachment.deviceId,
        typeof ackPayload?.fromDevice === "string" ? ackPayload.fromDevice : undefined,
      );
    }
    if (env.to === "relay") {
      return { ok: true, action: "acked" };
    }
  }

  const targetDeviceId = typeof env.to === "string" ? env.to : "";
  if (!targetDeviceId || targetDeviceId === "relay") {
    return { ok: true, action: "dropped" };
  }

  if (typeof env.id !== "string" || !env.id || env.id.length > 128)
    return { ok: false, action: "invalid_id_not_stored" };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetDeviceId)) return { ok: false, action: "dropped" };
  if (!store.getPin(targetDeviceId)) return { ok: false, action: "dropped" };
  const targetWs = findTargetSocket(targetDeviceId);
  if (targetWs) {
    try {
      targetWs.send(rawText);
      return { ok: true, action: "forwarded" };
    } catch {
      // socket send failed, fall through to offline outbox_v3
    }
  }

  try {
    store.saveOutbox(env.id, targetDeviceId, rawText, nowMs);
    return { ok: true, action: "stored" };
  } catch {
    return { ok: false, action: "dropped" };
  }
}
