/// <reference types="@cloudflare/workers-types" />
// eslint-disable-next-line import/no-unresolved
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import {
  RoomStore, RateLimiter, verifyHello, buildPresence, isOversize,
  processPostHelloMessage, type Sql, type DeviceAttachment,
} from "./logic";

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

  async fetch(_request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (isOversize(rawText)) {
      ws.close(1009, "message too large");
      return;
    }

    const attachment = ws.deserializeAttachment() as DeviceAttachment | null;
    const now = Date.now();

    if (!attachment) {
      let env: unknown;
      try { env = JSON.parse(rawText); } catch { ws.close(4400, "invalid json"); return; }

      const res = verifyHello(env, now, (id) => this.store.getPin(id));
      if (!res.ok) { ws.close(res.code, res.reason); return; }

      if (res.isNewPin) this.store.setPin(res.deviceId, res.helloPubkey);

      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && (other.deserializeAttachment() as DeviceAttachment | null)?.deviceId === res.deviceId) {
          other.close(1000, "stale session eviction");
        }
      }

      ws.serializeAttachment({ deviceId: res.deviceId, role: res.role });
      this.store.upsertDevice(res.deviceId, res.role, now);

      const devices = this.store.getDevices();
      const onlineIds = new Set(
        this.ctx.getWebSockets().map((s) => (s.deserializeAttachment() as DeviceAttachment | null)?.deviceId).filter(Boolean),
      );
      for (const dev of devices) {
        if (dev.deviceId !== res.deviceId) {
          ws.send(buildPresence(res.deviceId, dev.deviceId, dev.role, onlineIds.has(dev.deviceId) ? "online" : "offline", dev.lastSeen, now));
        }
      }

      for (const other of this.ctx.getWebSockets()) {
        const otherAtt = other !== ws ? (other.deserializeAttachment() as DeviceAttachment | null) : null;
        if (otherAtt) other.send(buildPresence(otherAtt.deviceId, res.deviceId, res.role, "online", now, now));
      }

      for (const msg of this.store.drainOutbox(res.deviceId)) ws.send(msg);

      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    const findTarget = (targetId: string) =>
      this.ctx.getWebSockets().find((s) => (s.deserializeAttachment() as DeviceAttachment | null)?.deviceId === targetId) ?? null;

    const outcome = processPostHelloMessage(rawText, attachment, this.store, this.rateLimiter, findTarget, now);
    if (outcome.closeCode) ws.close(outcome.closeCode, outcome.closeReason);
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as DeviceAttachment | null;
    if (!attachment) return;

    const remaining = this.ctx.getWebSockets().some((s) =>
      s !== ws && (s.deserializeAttachment() as DeviceAttachment | null)?.deviceId === attachment.deviceId,
    );

    if (!remaining) {
      const now = Date.now();
      this.store.updateLastSeen(attachment.deviceId, now);
      for (const other of this.ctx.getWebSockets()) {
        const otherAtt = other !== ws ? (other.deserializeAttachment() as DeviceAttachment | null) : null;
        if (otherAtt) other.send(buildPresence(otherAtt.deviceId, attachment.deviceId, attachment.role, "offline", now, now));
      }
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.store.pruneExpired(now);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as DeviceAttachment | null;
      if (att) {
        const lastSeen = this.store.getDeviceLastSeen(att.deviceId);
        if (lastSeen !== null && now - lastSeen > 600_000) ws.close(1001, "idle timeout");
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}
