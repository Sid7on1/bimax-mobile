import { validateRelayUrl } from "./relay-url";
import { WebSocket } from "ws";
import type { Envelope, MessageKind, DeviceHello } from "@bimax/protocol";
import { canonicalJson, ed25519Sign } from "./crypto/keys";
import { bytesToBase64 } from "./crypto/base64";
import type { Identity } from "./identity";

export type ClientStatus = "offline" | "connecting" | "online" | "reconnecting";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  readyState: number;
}

export type WsConstructor = new (url: string) => WebSocketLike;

export interface RelayClientOptions {
  authorizeUrl?: (url: string) => Promise<string>;
  relayUrl: string; // Base URL, e.g. "ws://127.0.0.1:8787" or "wss://relay.example.com"
  identity: Identity;
  wsImpl?: WsConstructor;
  onMessage: (env: Envelope<MessageKind, unknown>) => void | Promise<void>;
  onStatus?: (status: ClientStatus) => void;
  autoConnect?: boolean;
}

const MAX_OUTBOX_SIZE = 500;

export class RelayClient {
  private authorizeUrl?: (url: string) => Promise<string>;
  private generation = 0;
  private relayUrl: string;
  private identity: Identity;
  private wsImpl: WsConstructor;
  private onMessageCallback: (env: Envelope<MessageKind, unknown>) => void | Promise<void>;
  private onStatusCallback?: (status: ClientStatus) => void;

  private _status: ClientStatus = "offline";
  private ws: WebSocketLike | null = null;
  private outbox: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private isExplicitClose = false;

  constructor(opts: RelayClientOptions) {
    validateRelayUrl(opts.relayUrl);
    this.relayUrl = opts.relayUrl;
    this.authorizeUrl = opts.authorizeUrl;
    this.identity = opts.identity;
    this.wsImpl = opts.wsImpl ?? (WebSocket as unknown as WsConstructor);
    this.onMessageCallback = opts.onMessage;
    this.onStatusCallback = opts.onStatus;

    if (opts.autoConnect) {
      this.connect();
    }
  }

  public get status(): ClientStatus {
    return this._status;
  }

  private setStatus(newStatus: ClientStatus): void {
    if (this._status !== newStatus) {
      this._status = newStatus;
      this.onStatusCallback?.(newStatus);
    }
  }

  private randomId(prefix: string): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b !== undefined) hex += b.toString(16).padStart(2, "0");
    }
    return `${prefix}-${hex}-${Date.now().toString(36)}`;
  }

  /**
   * Constructs the room WebSocket URL: `/room/<desktopDeviceId>`.
   */
  public getRoomUrl(): string {
    const url = new URL(this.relayUrl);
    if (!url.pathname.includes("/room/"))
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/room/${this.identity.deviceId}`;
    return url.toString();
  }

  public connect(): void {
    this.isExplicitClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupCurrentSocket();
    this.setStatus("connecting");

    const targetUrl = this.getRoomUrl();
    const generation = ++this.generation;
    void (async () => {
      if (targetUrl.startsWith("wss:") && !this.authorizeUrl)
        throw new Error("Cloud relay requires admission");
      const authorized = this.authorizeUrl ? await this.authorizeUrl(targetUrl) : targetUrl;
      if (generation !== this.generation || this.isExplicitClose) return;
      let socket: WebSocketLike;
      try {
        socket = new this.wsImpl(authorized);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this.ws = socket;

      socket.on("open", () => {
        if (this.ws !== socket) return;
        this.handleSocketOpen(socket);
      });

      socket.on("message", (raw: unknown) => {
        if (this.ws !== socket) return;
        this.handleSocketMessage(raw);
      });

      socket.on("close", () => {
        if (this.ws !== socket) return;
        this.handleSocketDisconnect();
      });

      socket.on("error", () => {
        if (this.ws !== socket) return;
        this.handleSocketDisconnect();
      });
    })().catch(() => {
      if (generation === this.generation && !this.isExplicitClose) this.scheduleReconnect();
    });
  }

  public close(): void {
    this.isExplicitClose = true;
    this.generation++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupCurrentSocket();
    this.setStatus("offline");
  }

  public send(env: Envelope<string, unknown>): void {
    const data = JSON.stringify(env);
    if (this.ws && this._status === "online" && this.ws.readyState === 1) {
      try {
        this.ws.send(data);
        return;
      } catch {
        // Fall back to queueing
      }
    }
    // Application results are recovered by replaying the durable logical request.
    if (env.kind === "encrypted") throw new Error("No live encrypted channel");
    if (this.outbox.length >= MAX_OUTBOX_SIZE) throw new Error("Transport outbox full");
    this.outbox.push(data);
  }

  private handleSocketOpen(socket: WebSocketLike): void {
    // Contract §3: first message MUST be a SIGNED hello constructed EXACTLY like the phone's.
    const id = this.randomId("h");
    const ts = Date.now();
    const from = this.identity.deviceId;
    const role = "desktop";
    const helloPubkey = this.identity.helloPubkeyB64;

    const canonicalToSign = canonicalJson({
      id,
      ts,
      from,
      deviceId: from,
      role,
      helloPubkey,
      protocolVersion: 2,
    });

    const utf8Bytes = new TextEncoder().encode(canonicalToSign);
    const sig = ed25519Sign(this.identity.helloKeypair.privateKey, utf8Bytes);
    const helloSignature = bytesToBase64(sig);

    const helloEnvelope: Envelope<"hello", DeviceHello> = {
      v: 2,
      id,
      ts,
      from,
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: from,
        role: "desktop",
        protocolVersion: 2,
        helloPubkey,
        helloSignature,
      },
    };

    try {
      socket.send(JSON.stringify(helloEnvelope));
      this.setStatus("online");
      this.backoffMs = 1000;

      // Drain outbox safely without losing an item if send throws mid-drain
      while (this.outbox.length > 0) {
        const item = this.outbox[0];
        if (item !== undefined) {
          socket.send(item);
        }
        this.outbox.shift();
      }
    } catch {
      this.handleSocketDisconnect();
    }
  }

  private handleSocketMessage(raw: unknown): void {
    let str: string;
    if (typeof raw === "string") {
      str = raw;
    } else if (raw instanceof Uint8Array) {
      str = new TextDecoder().decode(raw);
    } else if (raw && typeof (raw as { toString: () => string }).toString === "function") {
      str = (raw as { toString: () => string }).toString();
    } else {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch {
      return;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const env = parsed as Envelope<MessageKind, unknown>;
      if (typeof env.kind === "string" && typeof env.from === "string") {
        void Promise.resolve(this.onMessageCallback(env))
          .then(() => {
            if (
              env.kind !== "delivery_ack" &&
              env.kind !== "presence" &&
              typeof env.id === "string" &&
              env.id.length > 0 &&
              this.ws &&
              this.ws.readyState === 1
            ) {
              const ackEnv = {
                v: 2,
                id: this.randomId("ack"),
                ts: Date.now(),
                from: this.identity.deviceId,
                to: "relay",
                kind: "delivery_ack",
                payload: { id: env.id, fromDevice: env.from },
              };
              try {
                this.ws.send(JSON.stringify(ackEnv));
              } catch {
                // ignore ack send failure
              }
            }
          })
          .catch(() => {
            /* No acknowledgement: durable request can be retried. */
          });
      }
    }
  }

  private handleSocketDisconnect(): void {
    this.cleanupCurrentSocket();
    if (!this.isExplicitClose) {
      this.scheduleReconnect();
    } else {
      this.setStatus("offline");
    }
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    if (this.reconnectTimer) return;

    // Exponential backoff with jitter: 1s -> 30s
    const jitter = Math.random() * 500;
    const delay = Math.min(this.backoffMs + jitter, 30_000);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 30_000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private cleanupCurrentSocket(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
