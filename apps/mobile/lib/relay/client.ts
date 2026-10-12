import type { Envelope, MessageKind, DeviceHello, DeliveryAck, DeviceRole } from "@bimax/protocol";
import { canonicalJson } from "../crypto/keys";
import { bytesToBase64 } from "../crypto/base64";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (ev: { data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (ev: { data?: unknown }) => void,
  ): void;
}

export type WsImpl = new (url: string) => WebSocketLike;
export type ClientStatus = "connecting" | "online" | "reconnecting" | "offline";

export interface RelayClientOptions {
  url: string; // e.g. "ws://127.0.0.1:8787"
  deviceId: string;
  role: DeviceRole;
  wsImpl: WsImpl;
  helloSigner?: {
    pubkeyB64: string;
    sign: (msg: Uint8Array) => Promise<Uint8Array>;
  };
  onMessage: (env: Envelope<MessageKind, unknown>) => void;
  onStatus?: (s: ClientStatus) => void;
}

export class RelayClient {
  private opts: RelayClientOptions;
  private _status: ClientStatus = "offline";
  // v1: in-memory outbox. App kill loses queued items; user resends. SQLite outbox is a later layer.
  private outbox: Envelope<MessageKind, unknown>[] = [];
  private ws: WebSocketLike | null = null;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isExplicitClose = false;
  private cleanupListeners: (() => void) | null = null;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
  }

  get status(): ClientStatus {
    return this._status;
  }

  private setStatus(newStatus: ClientStatus): void {
    if (this._status !== newStatus) {
      this._status = newStatus;
      this.opts.onStatus?.(newStatus);
    }
  }

  private randomId(): string {
    return "m-" + Math.random().toString(36).slice(2);
  }

  private cleanupCurrentSocket(): void {
    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  connect(): void {
    this.isExplicitClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupCurrentSocket();
    this.setStatus("connecting");

    const socket = new this.opts.wsImpl(this.opts.url);
    this.ws = socket;
    let disconnected = false;

    const onOpen = async () => {
      if (this.ws !== socket) return;
      this.setStatus("online");
      this.backoffMs = 1000;

      const id = this.randomId();
      const ts = Date.now();
      const from = this.opts.deviceId;
      const role = this.opts.role;

      let helloPayload:
        | DeviceHello
        | (Omit<DeviceHello, "helloPubkey" | "helloSignature"> & {
            helloPubkey?: string;
            helloSignature?: string;
          });

      if (this.opts.helloSigner) {
        try {
          const signer = this.opts.helloSigner;
          const canonical = canonicalJson({
            id,
            ts,
            from,
            deviceId: from,
            role,
            helloPubkey: signer.pubkeyB64,
          });
          const utf8Bytes = new TextEncoder().encode(canonical);
          const sig = await signer.sign(utf8Bytes);
          helloPayload = {
            deviceId: from,
            role,
            protocolVersion: 1,
            helloPubkey: signer.pubkeyB64,
            helloSignature: bytesToBase64(sig),
          };
        } catch {
          return;
        }
      } else {
        helloPayload = {
          deviceId: from,
          role,
          protocolVersion: 1,
        };
      }

      if (this.ws !== socket) return;

      const helloEnv: Envelope<"hello", typeof helloPayload> = {
        v: 1,
        id,
        ts,
        from,
        to: "relay",
        kind: "hello",
        payload: helloPayload,
      };

      try {
        socket.send(JSON.stringify(helloEnv));
      } catch {
        // write error will trigger close/error listener
      }

      // Drain outbox FIFO
      const queued = this.outbox.slice();
      this.outbox = [];
      for (let i = 0; i < queued.length; i++) {
        try {
          socket.send(JSON.stringify(queued[i]));
        } catch {
          // If sending fails, push remaining items back to outbox and stop draining
          this.outbox = queued.slice(i).concat(this.outbox);
          break;
        }
      }
    };

    const onMessage = (ev: { data?: unknown }) => {
      if (this.ws !== socket) return;

      let raw: string;
      if (typeof ev.data === "string") {
        raw = ev.data;
      } else if (
        ev.data != null &&
        typeof (ev.data as { toString?: unknown }).toString === "function"
      ) {
        raw = (ev.data as { toString: () => string }).toString();
      } else {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // silently ignore unparsable payloads
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const env = parsed as Record<string, unknown>;
      if (
        typeof env.kind !== "string" ||
        typeof env.id !== "string"
      ) {
        return; // silently ignore envelopes missing string kind/id
      }

      if (env.kind !== "delivery_ack") {
        const ackEnv: Envelope<"delivery_ack", DeliveryAck> = {
          v: 1,
          id: this.randomId(),
          ts: Date.now(),
          from: this.opts.deviceId,
          to: "relay",
          kind: "delivery_ack",
          payload: { id: env.id },
        };
        try {
          socket.send(JSON.stringify(ackEnv));
        } catch {
          // ignore
        }
      }

      this.opts.onMessage(env as unknown as Envelope<MessageKind, unknown>);
    };

    const handleDisconnect = () => {
      if (disconnected) return;
      disconnected = true;

      if (this.cleanupListeners) {
        this.cleanupListeners();
        this.cleanupListeners = null;
      }

      if (this.ws === socket) {
        this.ws = null;
      }

      if (this.isExplicitClose) {
        this.setStatus("offline");
        return;
      }

      this.setStatus("reconnecting");

      const currentBackoff = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      const jitter = 0.8 + Math.random() * 0.4; // ±20% jitter
      const delay = Math.round(currentBackoff * jitter);

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };

    const onClose = () => handleDisconnect();
    const onError = () => handleDisconnect();

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    this.cleanupListeners = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
  }

  send(env: Envelope<MessageKind, unknown>): void {
    // v1: in-memory outbox. App kill loses queued items; user resends. SQLite outbox is a later layer.
    if (this._status === "online" && this.ws) {
      try {
        this.ws.send(JSON.stringify(env));
        return;
      } catch {
        // socket write threw, fall through to outbox queue
      }
    }
    this.outbox.push(env);
  }

  close(): void {
    this.isExplicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupCurrentSocket();
    this.setStatus("offline");
  }
}
