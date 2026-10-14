import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  Envelope,
  MessageKind,
  PairingRequest,
  EncryptedPayload,
  CommandRequest,
  CommandResult,
  KillRequest,
  KillResult,
  ChatMessage,
  ChatToken,
  ChatDone,
  FileOffer,
  FileChunk,
  FileDone,
  ApprovalDecision,
  ToolApprovalRequest,
  AgentStatus,
  SessionList,
} from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { generateDeviceId, type Identity } from "./identity";
import { RelayClient, type WsConstructor } from "./relay-client";
import { PairingManager, type TrustedPhoneRecord } from "./pairing";
import { E2ERegistry } from "./e2e";
import { ApprovalsGate, type SecurityEvent } from "./approvals";
import { IdempotencyLog } from "./idempotency";
import { FilePipeline } from "./files";
import { ChatHandler } from "./chat";

export interface ResponderOptions {
  identity: Identity;
  enginePort: EnginePort;
  relayUrl: string;
  lanRelayUrl?: string;
  dataDir?: string;
  wsImpl?: WsConstructor;
}

export class Responder {
  public identity: Identity;
  public enginePort: EnginePort;
  public relayClient: RelayClient;
  public pairingManager: PairingManager;
  public e2e: E2ERegistry;
  public approvalsGate: ApprovalsGate;
  public idempotency: IdempotencyLog;
  public filePipeline: FilePipeline;
  public chatHandler: ChatHandler;

  public unknownInnerKindCount = 0;
  public cryptoFailureCount = 0;

  private dataDir: string;
  private securityLogPath: string;

  constructor(opts: ResponderOptions) {
    this.identity = opts.identity;
    this.enginePort = opts.enginePort;
    this.dataDir = opts.dataDir ?? path.join(process.cwd(), ".responder-data");
    this.securityLogPath = path.join(this.dataDir, "security.log.jsonl");

    const inboxDir = path.join(this.dataDir, "inbox");
    const idempotencyPath = path.join(this.dataDir, "idempotency.json");
    const pairingStorePath = path.join(this.dataDir, "trusted-phone.json");

    this.e2e = new E2ERegistry();
    this.idempotency = new IdempotencyLog({ storagePath: idempotencyPath });
    this.filePipeline = new FilePipeline({ inboxDir, enginePort: this.enginePort });

    this.pairingManager = new PairingManager({
      identity: this.identity,
      relayUrl: opts.relayUrl,
      lanRelayUrl: opts.lanRelayUrl,
      storePath: pairingStorePath,
    });

    this.approvalsGate = new ApprovalsGate({
      enginePort: this.enginePort,
      getPinnedPhoneHelloPubkey: () => {
        return this.pairingManager.getTrustedPhone()?.phoneHelloPubkeyB64 ?? null;
      },
      onSecurityEvent: (event) => {
        void this.logSecurityEvent(event);
      },
    });

    this.chatHandler = new ChatHandler({
      enginePort: this.enginePort,
      idempotency: this.idempotency,
      sendToken: (token: ChatToken) => {
        this.sendEncrypted("chat_token", token);
      },
      sendDone: (done: ChatDone) => {
        this.sendEncrypted("chat_done", done);
      },
    });

    this.relayClient = new RelayClient({
      relayUrl: opts.relayUrl,
      identity: this.identity,
      wsImpl: opts.wsImpl,
      onMessage: (env) => {
        void this.handleRelayMessage(env);
      },
    });

    // Proactive engine listeners
    this.enginePort.onApprovalRequest((req: ToolApprovalRequest) => {
      const stored = this.approvalsGate.registerRequest(req);
      this.sendEncrypted("approval_request", stored);
    });

    this.enginePort.onStatusChanged((status: AgentStatus) => {
      this.sendEncrypted("agent_status", status);
    });
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.idempotency.init();
    await this.filePipeline.init();
    await this.pairingManager.init();
    this.relayClient.connect();
  }

  public async stop(): Promise<void> {
    this.relayClient.close();
    this.pairingManager.destroy();
    this.approvalsGate.destroy();
    await this.idempotency.persistNow();
  }

  /**
   * Confirms a candidate pairing after human verification-code comparison.
   * Resets E2E state for the peer (contract §5: fresh session keys => fresh
   * replay space). The future ~/Bimax adapter MUST call this — not
   * pairingManager.confirmPairing directly.
   */
  public async confirmTrustedPhone(
    code: string,
    phoneHelloPubkeyB64?: string,
  ): Promise<TrustedPhoneRecord> {
    const record = await this.pairingManager.confirmPairing(code, phoneHelloPubkeyB64);
    this.e2e.resetPeer(record.phoneDeviceId);
    return record;
  }

  /**
   * Replaces an existing trusted phone with the candidate pairing after human
   * verification-code comparison, cleaning up the previous phone's E2E state,
   * pending approvals, and idempotency log.
   */
  public async confirmReplaceTrustedPhone(
    code: string,
    phoneHelloPubkeyB64?: string,
  ): Promise<TrustedPhoneRecord> {
    const prevPhoneId = this.pairingManager.getTrustedPhone()?.phoneDeviceId;
    const record = await this.pairingManager.confirmReplaceTrustedPhone(
      code,
      phoneHelloPubkeyB64,
    );
    if (prevPhoneId && prevPhoneId !== record.phoneDeviceId) {
      this.e2e.clearPeer(prevPhoneId);
    }
    this.approvalsGate.cancelForSession();
    await this.idempotency.clear();
    this.e2e.resetPeer(record.phoneDeviceId);
    return record;
  }

  /**
   * Encrypts and sends an application message to the active trusted phone.
   */
  public sendEncrypted(innerKind: MessageKind, body: unknown): boolean {
    const session = this.pairingManager.getActiveSession();
    const trusted = this.pairingManager.getTrustedPhone();
    if (!session || !trusted) {
      return false;
    }

    const id = "e-" + generateDeviceId().slice(0, 16) + "-" + Date.now().toString(36);
    const ts = Date.now();
    const from = this.identity.deviceId;
    const to = trusted.phoneDeviceId;

    try {
      const ciphertext = this.e2e.seal(session, innerKind, body, { id, from, to });
      const env: Envelope<"encrypted", EncryptedPayload> = {
        v: 1,
        id,
        ts,
        from,
        to,
        kind: "encrypted",
        payload: { ciphertext },
      };
      this.relayClient.send(env);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Main incoming envelope dispatcher.
   */
  private async handleRelayMessage(env: Envelope<MessageKind, unknown>): Promise<void> {
    if (!env || typeof env !== "object") return;

    if (env.kind === "hello") {
      const payload = env.payload as { helloPubkey?: unknown };
      if (payload && typeof payload.helloPubkey === "string") {
        this.pairingManager.noteHelloPubkey(env.from, payload.helloPubkey);
      }
      return;
    }

    if (env.kind === "presence" && env.from === "relay") {
      const payload = env.payload as { deviceId?: unknown; helloPubkey?: unknown };
      if (
        payload &&
        typeof payload.deviceId === "string" &&
        typeof payload.helloPubkey === "string"
      ) {
        this.pairingManager.noteHelloPubkey(payload.deviceId, payload.helloPubkey);
      }
      return;
    }

    if (env.kind === "pairing_request") {
      const res = this.pairingManager.handlePairingRequest(
        env as Envelope<"pairing_request", PairingRequest>,
      );
      if (res) {
        this.relayClient.send(res.grantEnv);
        if (res.isRehandshake) {
          // Re-handshake path per contract §5: reset E2E state
          this.e2e.resetPeer(res.session.peerDeviceId);
        }
      }
      return;
    }

    if (env.kind === "encrypted") {
      await this.handleEncryptedMessage(env as Envelope<"encrypted", EncryptedPayload>);
      return;
    }

    // Delivery acks, presence, and other unencrypted envelopes are handled or ignored safely
  }

  /**
   * Handles encrypted envelopes.
   */
  private async handleEncryptedMessage(
    env: Envelope<"encrypted", EncryptedPayload>,
  ): Promise<void> {
    const trusted = this.pairingManager.getTrustedPhone();
    const session = this.pairingManager.getActiveSession();

    // Authorization boundaries (§6): frame MUST be from trusted phone with active Noise session
    if (!trusted || !session || env.from !== trusted.phoneDeviceId) {
      await this.logSecurityEvent({
        type: "untrusted_encrypted_frame",
        detail: {
          from: env.from,
          trustedPhone: trusted?.phoneDeviceId,
          hasSession: Boolean(session),
        },
        at: Date.now(),
      });
      return;
    }

    if (!env.payload || typeof env.payload.ciphertext !== "string") {
      return;
    }

    let openResult;
    try {
      openResult = this.e2e.open(session, {
        id: env.id,
        from: env.from,
        to: env.to,
        kind: env.kind,
        ciphertextB64: env.payload.ciphertext,
      });
    } catch (err) {
      // Contract §6: crypto failures → session teardown + security event
      this.cryptoFailureCount++;
      this.pairingManager.setActiveSession(null as unknown as import("./session/session").EstablishedSession);
      await this.logSecurityEvent({
        type: "crypto_failure",
        detail: {
          reason: err instanceof Error ? err.message : String(err),
          from: env.from,
          envelopeId: env.id,
        },
        at: Date.now(),
      });
      return;
    }

    if (openResult.duplicate) {
      // Dropped duplicated outer envelope id
      return;
    }

    await this.dispatchInnerFrame(openResult.innerKind, openResult.body, env);
  }

  /**
   * Dispatches the decrypted inner frame to the appropriate subsystem.
   */
  private async dispatchInnerFrame(
    innerKind: MessageKind,
    body: unknown,
    outer: Envelope<"encrypted", EncryptedPayload>,
  ): Promise<void> {
    switch (innerKind) {
      case "command_request": {
        const req = body as CommandRequest;
        if (!req || typeof req !== "object") return;
        try {
          const { result: cmdRes } = await this.idempotency.execute<CommandResult>(
            req.idempotencyKey,
            async () => {
              return this.enginePort.sendInstruction({
                idempotencyKey: req.idempotencyKey,
                instruction: req.instruction,
              });
            },
            (err) => ({
              idempotencyKey: req.idempotencyKey,
              ok: false,
              summary: err instanceof Error ? err.message : "Engine error",
            }),
          );
          this.sendEncrypted("command_result", cmdRes);
        } catch {
          // Pre-execution failure (e.g. invalid idempotency key): no log entry exists.
          this.sendEncrypted("command_result", {
            idempotencyKey: typeof req.idempotencyKey === "string" ? req.idempotencyKey : "",
            ok: false,
            summary: "Invalid request",
          });
        }
        break;
      }

      case "chat_message": {
        const msg = body as ChatMessage;
        if (!msg || typeof msg !== "object") return;
        try {
          await this.chatHandler.handleMessage(msg);
        } catch {
          // Handled inside chatHandler
        }
        break;
      }

      case "kill_request": {
        const req = body as KillRequest;
        if (!req || typeof req !== "object") return;
        // Contract §11: Any approval pending for a killed session is auto-resolved as denied
        this.approvalsGate.cancelForSession();

        try {
          const { result: killRes } = await this.idempotency.execute<KillResult>(
            req.idempotencyKey,
            async () => {
              return this.enginePort.kill({
                idempotencyKey: req.idempotencyKey,
                reason: req.reason,
              });
            },
            () => ({
              idempotencyKey: req.idempotencyKey,
              ok: false,
              detail: "Failed to abort task",
              at: Date.now(),
            }),
          );
          this.sendEncrypted("kill_result", killRes);
        } catch {
          // Pre-execution failure (e.g. invalid idempotency key): no log entry exists.
          this.sendEncrypted("kill_result", {
            idempotencyKey: typeof req.idempotencyKey === "string" ? req.idempotencyKey : "",
            ok: false,
            detail: "Invalid request",
            at: Date.now(),
          });
        }
        break;
      }

      case "approval_decision": {
        const decision = body as ApprovalDecision;
        this.approvalsGate.handleDecision(decision);
        break;
      }

      case "session_list_request": {
        try {
          const sessions = await this.enginePort.listSessions();
          const list: SessionList = { sessions };
          this.sendEncrypted("session_list", list);
        } catch {
          this.sendEncrypted("session_list", { sessions: [] });
        }
        break;
      }

      case "file_offer": {
        const offer = body as FileOffer;
        const res = this.filePipeline.handleOffer(offer);
        if ("accept" in res) {
          this.sendEncrypted("file_accept", res.accept);
        } else {
          this.sendEncrypted("file_reject", res.reject);
        }
        break;
      }

      case "file_chunk": {
        const chunk = body as FileChunk;
        const res = this.filePipeline.handleChunk(chunk);
        if (res.error) {
          this.sendEncrypted("file_error", res.error);
        }
        break;
      }

      case "file_done": {
        const done = body as FileDone;
        const res = await this.filePipeline.handleDone(done);
        if (res.received) {
          this.sendEncrypted("file_received", res.received);
        } else if (res.error) {
          this.sendEncrypted("file_error", res.error);
        }
        break;
      }

      case "pairing_revoke": {
        // Phone revoked pairing (§4): delete record, tear down session, clear idempotency entries
        await this.pairingManager.revokeTrustedPhone();
        this.e2e.clearPeer(outer.from);
        await this.idempotency.clear();
        await this.logSecurityEvent({
          type: "pairing_revoked_by_phone",
          detail: { phoneDeviceId: outer.from },
          at: Date.now(),
        });
        break;
      }

      default: {
        // Unknown inner kinds ignored and counted (§6)
        this.unknownInnerKindCount++;
        break;
      }
    }
  }

  public async logSecurityEvent(event: SecurityEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.securityLogPath), { recursive: true });
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(this.securityLogPath, line, "utf-8");
    } catch {
      // Do not throw on logging failure
    }
  }
}
