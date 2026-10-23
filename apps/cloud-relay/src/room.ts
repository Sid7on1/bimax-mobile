/// <reference types="@cloudflare/workers-types" />
// eslint-disable-next-line import/no-unresolved
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import {
  RoomStore,
  RateLimiter,
  verifyHello,
  buildPresence,
  isOversize,
  processPostHelloMessage,
  type Sql,
  type DeviceAttachment,
} from "./logic";

interface AdmissionAttachment extends DeviceAttachment {
  helloPubkey: string;
  identified: boolean;
  connectedAt: number;
}

function identified(ws: WebSocket): AdmissionAttachment | null {
  const att = ws.deserializeAttachment() as AdmissionAttachment | null;
  return att?.identified ? att : null;
}

export class Room extends DurableObject<Env> {
  private store: RoomStore;
  private rateLimiter = new RateLimiter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = {
      exec: (query: string, ...params: unknown[]) => ({
        rows: this.ctx.storage.sql.exec(query, ...params).toArray() as Record<string, unknown>[],
      }),
    };
    this.store = new RoomStore(sql);
  }

  async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get("X-Bimax-Device"),
      role = request.headers.get("X-Bimax-Role"),
      helloPubkey = request.headers.get("X-Bimax-Hello-Key");
    if (!deviceId || !helloPubkey || (role !== "desktop" && role !== "mobile"))
      return new Response("Admission required", { status: 401 });
    const now = Date.now();
    for (const existing of this.ctx.getWebSockets()) {
      const att = existing.deserializeAttachment() as AdmissionAttachment | null;
      if (att && !att.identified && now - att.connectedAt >= 10_000) {
        existing.close(4401, "hello deadline");
      }
    }
    if (this.ctx.getWebSockets().length >= 4)
      return new Response("Room connection limit", { status: 429 });
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      deviceId,
      role,
      helloPubkey,
      identified: false,
      connectedAt: now,
    });
    const currentAlarm = await this.ctx.storage.getAlarm();
    const deadlineAlarm = now + 10_000;
    if (currentAlarm === null || currentAlarm > deadlineAlarm) {
      await this.ctx.storage.setAlarm(deadlineAlarm);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (isOversize(rawText)) {
      ws.close(1009, "message too large");
      return;
    }

    const attachment = ws.deserializeAttachment() as AdmissionAttachment | null;
    const now = Date.now();

    if (!attachment?.identified) {
      if (!attachment || now - attachment.connectedAt > 10_000) {
        ws.close(4401, "hello deadline");
        return;
      }
      let env: unknown;
      try {
        env = JSON.parse(rawText);
      } catch {
        ws.close(4400, "invalid json");
        return;
      }

      // The account-owned gateway device record authorizes the signing key, including explicit re-registration.
      const res = verifyHello(env, now, () => attachment.helloPubkey);
      if (!res.ok) {
        ws.close(res.code, res.reason);
        return;
      }

      if (res.deviceId !== attachment.deviceId || res.role !== attachment.role) {
        ws.close(4401, "ticket identity mismatch");
        return;
      }
      if (!this.store.acceptHello(res.deviceId, (env as { id: string }).id, now)) {
        ws.close(4401, "hello replay");
        return;
      }
      if (!this.store.getPin(res.deviceId) && this.store.getDevices().length >= 8) {
        ws.close(4429, "room device limit");
        return;
      }
      this.store.setPin(res.deviceId, res.helloPubkey);

      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && identified(other)?.deviceId === res.deviceId) {
          other.close(1000, "stale session eviction");
        }
      }

      ws.serializeAttachment({
        deviceId: res.deviceId,
        role: res.role,
        helloPubkey: res.helloPubkey,
        identified: true,
        connectedAt: now,
      });
      this.store.upsertDevice(res.deviceId, res.role, now);

      const devices = this.store.getDevices();
      const onlineIds = new Set(
        this.ctx
          .getWebSockets()
          .map((s) => identified(s)?.deviceId)
          .filter(Boolean),
      );
      for (const dev of devices) {
        if (dev.deviceId !== res.deviceId) {
          ws.send(
            buildPresence(
              res.deviceId,
              dev.deviceId,
              dev.role,
              onlineIds.has(dev.deviceId) ? "online" : "offline",
              dev.lastSeen,
              now,
            ),
          );
        }
      }

      for (const other of this.ctx.getWebSockets()) {
        const otherAtt = other !== ws ? identified(other) : null;
        if (otherAtt)
          other.send(buildPresence(otherAtt.deviceId, res.deviceId, res.role, "online", now, now));
      }

      for (const msg of this.store.drainOutbox(res.deviceId)) ws.send(msg);

      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    const findTarget = (targetId: string) =>
      this.ctx.getWebSockets().find((s) => identified(s)?.deviceId === targetId) ?? null;

    const outcome = processPostHelloMessage(
      rawText,
      attachment,
      this.store,
      this.rateLimiter,
      findTarget,
      now,
    );
    if (outcome.closeCode) ws.close(outcome.closeCode, outcome.closeReason);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = identified(ws);
    if (!attachment) return;

    const remaining = this.ctx
      .getWebSockets()
      .some((s) => s !== ws && identified(s)?.deviceId === attachment.deviceId);

    if (!remaining) {
      const now = Date.now();
      this.store.updateLastSeen(attachment.deviceId, now);
      for (const other of this.ctx.getWebSockets()) {
        const otherAtt = other !== ws ? identified(other) : null;
        if (otherAtt)
          other.send(
            buildPresence(
              otherAtt.deviceId,
              attachment.deviceId,
              attachment.role,
              "offline",
              now,
              now,
            ),
          );
      }
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.store.pruneExpired(now);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as AdmissionAttachment | null;
      if (att && !att.identified) {
        if (now - att.connectedAt >= 10_000) ws.close(4401, "hello deadline");
        continue;
      }
      if (att) {
        const lastSeen = this.store.getDeviceLastSeen(att.deviceId);
        if (lastSeen !== null && now - lastSeen > 600_000) ws.close(1001, "idle timeout");
      }
    }
    const pending = this.store.hasPending();
    if (this.ctx.getWebSockets().length || pending)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    else await this.ctx.storage.deleteAlarm();
  }
}
