import type { DeviceRole } from "@bimax/protocol";
import { WebSocket } from "ws";
import type { RelayStore } from "./store";
import {
  RoomStore,
  RateLimiter,
  verifyHello,
  buildPresence,
  processPostHelloMessage,
  type DeviceAttachment,
} from "./logic";

export class Relay {
  private store: RelayStore;
  private roomStore: RoomStore;
  private rateLimiter = new RateLimiter();
  private onlineSockets = new Map<string, WebSocket>();
  private socketToDevice = new Map<WebSocket, { deviceId: string; role: DeviceRole }>();

  constructor(store: RelayStore) {
    this.store = store;
    this.roomStore = new RoomStore(store.getSql());
  }

  isDeviceOnline(deviceId: string): boolean {
    const ws = this.onlineSockets.get(deviceId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  handleConnection(ws: WebSocket): void {
    const helloDeadline = setTimeout(() => ws.close(4401, "hello deadline"), 10_000);
    (helloDeadline as unknown as NodeJS.Timeout).unref();
    ws.once("close", () => clearTimeout(helloDeadline));
    let isIdentified = false;
    let currentDeviceId: string | null = null;
    let currentRole: DeviceRole | null = null;

    ws.on("message", (data: Buffer | string) => {
      const rawText = typeof data === "string" ? data : data.toString("utf8");

      // 1. FIRST message must be hello
      if (!isIdentified) {
        let env: unknown;
        try {
          env = JSON.parse(rawText);
        } catch {
          ws.close(4400, "invalid json");
          return;
        }

        const res = verifyHello(env, Date.now(), (id) => this.roomStore.getPin(id));
        if (!res.ok) {
          ws.close(res.code, res.reason);
          return;
        }

        if (!this.roomStore.acceptHello(res.deviceId, (env as { id: string }).id, Date.now())) {
          ws.close(4401, "hello replay");
          return;
        }
        if (res.isNewPin && this.store.getAllDevices().length >= 16) {
          ws.close(4429, "device limit");
          return;
        }
        clearTimeout(helloDeadline);
        if (res.isNewPin) this.roomStore.setPin(res.deviceId, res.helloPubkey);
        const deviceId = res.deviceId;
        const role = res.role;

        isIdentified = true;
        currentDeviceId = deviceId;
        currentRole = role;
        const now = Date.now();

        // Stale session eviction:
        const existingWs = this.onlineSockets.get(deviceId);
        if (existingWs && existingWs !== ws) {
          this.socketToDevice.delete(existingWs);
          try {
            existingWs.close();
          } catch {
            // ignore
          }
        }

        this.onlineSockets.set(deviceId, ws);
        this.socketToDevice.set(ws, { deviceId, role });

        // Record device and last_seen
        this.store.recordDevice(deviceId, role, now);

        // Send presence for every OTHER known device
        const otherDevices = this.store.getOtherDevices(deviceId);
        for (const other of otherDevices) {
          const isOtherOnline = this.isDeviceOnline(other.device_id);
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(
                buildPresence(
                  deviceId,
                  other.device_id,
                  other.role,
                  isOtherOnline ? "online" : "offline",
                  other.last_seen,
                  now,
                ),
              );
            } catch {
              // ignore
            }
          }
        }

        // Notify other currently online devices that this device is now online
        for (const [otherId, otherWs] of this.onlineSockets.entries()) {
          if (otherId !== deviceId && otherWs.readyState === WebSocket.OPEN) {
            try {
              otherWs.send(buildPresence(otherId, deviceId, role, "online", now, now));
            } catch {
              // ignore
            }
          }
        }

        // Drain that device's outbox rows in created_at order over the new socket
        const pending = this.roomStore.drainOutbox(deviceId);
        for (const row of pending) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(row);
            } catch {
              break;
            }
          }
        }

        return;
      }

      // 2. Subsequent messages
      if (!currentDeviceId || !currentRole) return;
      const attachment: DeviceAttachment = { deviceId: currentDeviceId, role: currentRole };
      const findTarget = (targetId: string) => {
        const targetWs = this.onlineSockets.get(targetId);
        return targetWs && targetWs.readyState === WebSocket.OPEN
          ? { send: (data: string) => targetWs.send(data) }
          : null;
      };
      const outcome = processPostHelloMessage(
        rawText,
        attachment,
        this.roomStore,
        this.rateLimiter,
        findTarget,
        Date.now(),
      );
      if (outcome.closeCode) ws.close(outcome.closeCode, outcome.closeReason);
    });

    ws.on("close", () => {
      const info = this.socketToDevice.get(ws);
      if (!info) return;

      this.socketToDevice.delete(ws);

      if (this.onlineSockets.get(info.deviceId) === ws) {
        this.onlineSockets.delete(info.deviceId);
        const now = Date.now();
        this.store.updateLastSeen(info.deviceId, now);

        for (const [otherId, otherWs] of this.onlineSockets.entries()) {
          if (otherWs.readyState === WebSocket.OPEN) {
            try {
              otherWs.send(buildPresence(otherId, info.deviceId, info.role, "offline", now, now));
            } catch {
              // ignore
            }
          }
        }
      }
    });

    ws.on("error", () => {
      // socket error
    });
  }

  reapIdle(now: number = Date.now()): void {
    for (const [deviceId, ws] of this.onlineSockets) {
      const lastSeen = this.roomStore.getDeviceLastSeen(deviceId);
      if (lastSeen !== null && now - lastSeen > 600_000) {
        try {
          ws.close(1001, "idle timeout");
        } catch {
          /* ignore */
        }
      }
    }
    this.roomStore.pruneExpired(now);
  }
}
