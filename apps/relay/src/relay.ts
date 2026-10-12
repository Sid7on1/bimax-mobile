import type { Envelope, DeviceHello, DeliveryAck, Presence, DeviceRole } from "@bimax/protocol";
import { WebSocket } from "ws";
import type { RelayStore } from "./store";

const PROTOCOL_VERSION = 1;

export class Relay {
  private store: RelayStore;
  private onlineSockets = new Map<string, WebSocket>();
  private socketToDevice = new Map<WebSocket, { deviceId: string; role: DeviceRole }>();

  constructor(store: RelayStore) {
    this.store = store;
  }

  isDeviceOnline(deviceId: string): boolean {
    const ws = this.onlineSockets.get(deviceId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  handleConnection(ws: WebSocket): void {
    let isIdentified = false;
    let currentDeviceId: string | null = null;

    ws.on("message", (data: Buffer | string) => {
      const rawText = typeof data === "string" ? data : data.toString("utf8");

      let env: Envelope<string, unknown>;
      try {
        env = JSON.parse(rawText);
      } catch {
        if (!isIdentified) {
          ws.close();
        }
        return;
      }

      if (!env || typeof env !== "object") {
        if (!isIdentified) {
          ws.close();
        }
        return;
      }

      // 1. FIRST message must be hello
      if (!isIdentified) {
        if (env.kind !== "hello" || !env.payload || typeof env.payload !== "object") {
          ws.close();
          return;
        }

        const hello = env.payload as DeviceHello;
        if (
          hello.protocolVersion !== PROTOCOL_VERSION ||
          typeof hello.deviceId !== "string" ||
          !hello.deviceId ||
          (hello.role !== "desktop" && hello.role !== "mobile")
        ) {
          ws.close();
          return;
        }

        isIdentified = true;
        const deviceId = hello.deviceId;
        const role = hello.role as DeviceRole;
        currentDeviceId = deviceId;
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
          const presEnv: Envelope<"presence", Presence> = {
            v: PROTOCOL_VERSION,
            id: `pres-${now}-${Math.random().toString(36).slice(2, 9)}`,
            ts: now,
            from: "relay",
            to: deviceId,
            kind: "presence",
            payload: {
              deviceId: other.device_id,
              role: other.role as DeviceRole,
              status: isOtherOnline ? "online" : "offline",
              lastSeen: other.last_seen,
            },
          };

          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify(presEnv));
            } catch {
              // ignore
            }
          }
        }

        // Notify other currently online devices that this device is now online
        const onlinePresEnv: Envelope<"presence", Presence> = {
          v: PROTOCOL_VERSION,
          id: `pres-${now}-${Math.random().toString(36).slice(2, 9)}`,
          ts: now,
          from: "relay",
          to: "",
          kind: "presence",
          payload: {
            deviceId,
            role,
            status: "online",
            lastSeen: now,
          },
        };

        for (const [otherId, otherWs] of this.onlineSockets.entries()) {
          if (otherId !== deviceId && otherWs.readyState === WebSocket.OPEN) {
            try {
              otherWs.send(JSON.stringify({ ...onlinePresEnv, to: otherId }));
            } catch {
              // ignore
            }
          }
        }

        // Drain that device's outbox rows in created_at order over the new socket
        const pending = this.store.getOutboxForDevice(deviceId);
        for (const row of pending) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(row.envelope);
            } catch {
              break;
            }
          }
        }

        return;
      }

      // 2. Subsequent messages
      const now = Date.now();
      if (currentDeviceId) {
        this.store.updateLastSeen(currentDeviceId, now);
      }

      // Handle delivery_ack
      if (env.kind === "delivery_ack") {
        const ack = env.payload as DeliveryAck;
        if (ack && typeof ack.id === "string") {
          this.store.deleteOutbox(ack.id);
        }

        if (env.to === "relay") {
          return;
        }
      }

      const targetDeviceId = env.to;
      if (!targetDeviceId || targetDeviceId === "relay") {
        return;
      }

      // Route by `to`
      const targetWs = this.onlineSockets.get(targetDeviceId);
      let delivered = false;

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        try {
          targetWs.send(rawText);
          delivered = true;
        } catch {
          delivered = false;
        }
      }

      if (!delivered) {
        this.store.saveOutbox(env.id, targetDeviceId, rawText, now);
      }
    });

    ws.on("close", () => {
      const info = this.socketToDevice.get(ws);
      if (!info) return;

      this.socketToDevice.delete(ws);

      if (this.onlineSockets.get(info.deviceId) === ws) {
        this.onlineSockets.delete(info.deviceId);
        const now = Date.now();
        this.store.updateLastSeen(info.deviceId, now);

        const offlinePresEnv: Envelope<"presence", Presence> = {
          v: PROTOCOL_VERSION,
          id: `pres-${now}-${Math.random().toString(36).slice(2, 9)}`,
          ts: now,
          from: "relay",
          to: "",
          kind: "presence",
          payload: {
            deviceId: info.deviceId,
            role: info.role,
            status: "offline",
            lastSeen: now,
          },
        };

        for (const [otherId, otherWs] of this.onlineSockets.entries()) {
          if (otherWs.readyState === WebSocket.OPEN) {
            try {
              otherWs.send(JSON.stringify({ ...offlinePresEnv, to: otherId }));
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
}
