import { LiveConversations } from "./live";
import { HistoryService } from "./history";
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
  CloudRelayGrant,
} from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { canonicalJson, ed25519Sign, sha256Bytes } from "./crypto/keys";
import { generateDeviceId, type Identity } from "./identity";
import { RelayClient, type WsConstructor } from "./relay-client";
import { PairingManager, type TrustedPhoneRecord } from "./pairing";
import { E2ERegistry } from "./e2e";
import { ApprovalsGate, type SecurityEvent } from "./approvals";
import { IdempotencyLog } from "./idempotency";
import { FilePipeline } from "./files";
import { SessionCreation } from "./session-create";
import { ChatHandler } from "./chat";
import type { HostControls, RemoteOperation } from "./host-controls";

export interface ResponderOptions {
  identity: Identity;
  enginePort: EnginePort;
  relayUrl: string;
  lanRelayUrl?: string;
  onCloudGrant?: (grant: CloudRelayGrant) => Promise<void>;
  authorizeRelayUrl?: (url: string) => Promise<string>;
  dataDir?: string;
  wsImpl?: WsConstructor;
  hostControls: HostControls;
  enablePqPairing?: boolean;
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
  private sessionCreation: SessionCreation;

  public unknownInnerKindCount = 0;
  public cryptoFailureCount = 0;

  private dataDir: string;
  private securityLogPath: string;
  private hostControls: HostControls;
  private remoteEpoch = new AbortController();
  public readonly history: HistoryService;
  public readonly live: LiveConversations;
  private unwatchEngine?: () => void;
  private lastStatusPush = "";
  private lastListPush = "";
  private statusPushEpoch = 0;
  private cloudClient?: RelayClient;
  private cloudRelayUrl?:string;
  private activeRoute?: RelayClient;
  private onlinePeers = new Map<RelayClient,Set<string>>();
  private onCloudGrant?: ResponderOptions['onCloudGrant'];
  private cloudSetupSession?: object;


  constructor(opts: ResponderOptions) {
    if (!opts.hostControls) throw new Error("Desktop host controls are required");
    this.hostControls = opts.hostControls;
    this.onCloudGrant=opts.onCloudGrant;
    this.identity = opts.identity;
    this.enginePort = opts.enginePort;
    this.dataDir = opts.dataDir ?? path.join(process.cwd(), ".responder-data");
    this.securityLogPath = path.join(this.dataDir, "security.log.jsonl");

    const inboxDir = path.join(this.dataDir, "inbox");
    const idempotencyPath = path.join(this.dataDir, "idempotency.json");
    const pairingStorePath = path.join(this.dataDir, "trusted-phone.json");

    this.e2e = new E2ERegistry();
    this.idempotency = new IdempotencyLog({ storagePath: idempotencyPath });
    this.filePipeline = new FilePipeline({
      inboxDir,
      enginePort: this.enginePort,
      authorizeFile: (name) =>
        this.authorizeRemote({
          kind: "file",
          peer: this.pairingManager.getTrustedPhone()?.phoneDeviceId ?? "",
          text: name,
        }),
    });

    this.pairingManager = new PairingManager({
      identity: this.identity,
      relayUrl: opts.relayUrl,
      lanRelayUrl: opts.lanRelayUrl,
      storePath: pairingStorePath,
      enablePqPairing: opts.enablePqPairing,
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

    this.sessionCreation = new SessionCreation({
      context: () => {
        const peer=this.pairingManager.getTrustedPhone()?.phoneDeviceId, session=this.pairingManager.getActiveSession();
        return peer && session && !this.remoteEpoch.signal.aborted ? {peer,session} : null;
      },
      authorize: () => this.authorizeRemote({kind:"chat",peer:this.pairingManager.getTrustedPhone()?.phoneDeviceId??"",text:"Create a new conversation in the selected folder"}),
      create: async id => {if(!this.enginePort.createSession)throw Error("Update Bimax on your Mac");return this.enginePort.createSession(id);},
      journal: this.idempotency,
    });
    this.chatHandler = new ChatHandler({
      enginePort: this.enginePort,
      idempotency: this.idempotency,
      authorize: (msg, peer) => this.authorizeRemote({ kind: "chat", peer, text: msg.text }),
      shouldStreamTokens: msg => !msg.sessionId || !this.live?.isWatching(msg.sessionId),
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
      authorizeUrl: opts.authorizeRelayUrl,
      onMessage: (env) => this.handleRelayMessage(env),
      onStatus: status => { if (status !== 'online' && (!this.activeRoute || this.activeRoute===this.relayClient)) { this.live?.clear(); this.history?.clear(); void this.hostControls.setRemoteSessionActive(false).catch(() => {}); } },
    });

    this.live = new LiveConversations({
      context: () => {
        const peer = this.pairingManager.getTrustedPhone()?.phoneDeviceId;
        const session = this.pairingManager.getActiveSession();
        return peer && session && (this.activeRoute??this.relayClient).status === 'online' && !this.remoteEpoch.signal.aborted ? {peer,session} : null;
      },
      authorize: async (id) => this.authorizeRemote({kind:'history',peer:this.pairingManager.getTrustedPhone()?.phoneDeviceId ?? '',text:`Follow conversation ${id}`}),
      read: async id => { if(!this.enginePort.getSessionHistory)throw Error('Live history unsupported');return this.enginePort.getSessionHistory(id); },
      send: update => this.sendEncrypted('session_update',update),
    });
    this.unwatchEngine = this.enginePort.onSessionChanged?.(id => this.live.changed(id));
    this.history = new HistoryService({
      context: () => {
        const peer = this.pairingManager.getTrustedPhone()?.phoneDeviceId;
        const session = this.pairingManager.getActiveSession();
        return peer && session && !this.remoteEpoch.signal.aborted ? { peer, session } : null;
      },
      title: async id => (await this.enginePort.listSessions()).find(item => item.sessionId === id)?.title ?? null,
      authorize: async (_id, title) => this.authorizeRemote({ kind: "history", peer: this.pairingManager.getTrustedPhone()?.phoneDeviceId ?? "", text: `Read this conversation on your phone: ${title.slice(0, 200)}` }),
      capture: (watchId, snapshot, context) => this.live.capture(watchId, snapshot, context),
      read: async id => {
        if (!this.enginePort.getSessionHistory) throw new Error("History unsupported");
        return this.enginePort.getSessionHistory(id);
      },
    });

    // Proactive engine listeners
    this.enginePort.onApprovalRequest((req: ToolApprovalRequest) => {
      const stored = this.approvalsGate.registerRequest(req);
      this.sendEncrypted("approval_request", stored);
    });

    this.enginePort.onStatusChanged((status: AgentStatus) => {
      const key=JSON.stringify([status.state,status.sessionId,status.taskSummary]);
      if(key!==this.lastStatusPush){this.lastStatusPush=key;this.sendEncrypted('agent_status',status);}
      const epoch=++this.statusPushEpoch;
      void this.enginePort.listSessions().then(sessions=>{if(epoch!==this.statusPushEpoch)return;const key=JSON.stringify(sessions);if(key!==this.lastListPush){this.lastListPush=key;this.sendEncrypted('session_list',{sessions});}}).catch(()=>{});
    });
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    await fs.chmod(this.securityLogPath, 0o600).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    await this.idempotency.init();
    await this.filePipeline.init();
    await this.pairingManager.init();
    this.relayClient.connect();
  }

  public get cloudStatus(): string {return this.cloudClient?.status??'offline';}
  public get phoneConnected(): boolean {
    const peer=this.pairingManager.getTrustedPhone()?.phoneDeviceId,route=this.activeRoute??this.relayClient;
    return !!peer&&!!this.pairingManager.getActiveSession()&&route.status==='online'&&!!this.onlinePeers.get(route)?.has(peer);
  }
  public connectCloud(relayUrl:string,authorizeUrl:(url:string)=>Promise<string>):void{
    if(this.cloudClient && this.cloudRelayUrl===relayUrl)return;
    this.cloudClient?.close();
    this.cloudRelayUrl=relayUrl;
    const cloud:RelayClient=new RelayClient({relayUrl,identity:this.identity,authorizeUrl,onMessage:env=>this.handleRelayMessage(env,cloud),onStatus:status=>{
      if(status!=='online'){this.onlinePeers.delete(cloud);if(this.activeRoute===cloud){this.live.clear();this.history.clear();void this.hostControls.setRemoteSessionActive(false).catch(()=>{});}}
    }});this.cloudClient=cloud;cloud.connect();
  }

  public async stop(): Promise<void> {
    this.unwatchEngine?.();
    this.cancelRemoteResources();
    await this.hostControls.setRemoteSessionActive(false).catch(() => {});
    this.relayClient.close();
    this.cloudClient?.close();
    this.cloudClient=undefined;
    this.activeRoute=undefined;
    this.onlinePeers.clear();
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
    const record = await this.pairingManager.confirmReplaceTrustedPhone(code, phoneHelloPubkeyB64);
    if (prevPhoneId && prevPhoneId !== record.phoneDeviceId) {
      this.e2e.clearPeer(prevPhoneId);
    }
    this.approvalsGate.cancelForSession();
    this.cancelRemoteResources();
    await this.hostControls.setRemoteSessionActive(false).catch(() => {});
    // Preserve durable operation history across trust changes.
    this.e2e.resetPeer(record.phoneDeviceId);
    return record;
  }

  /**
   * Encrypts and sends an application message to the active trusted phone.
   */
  public sendEncrypted(innerKind: MessageKind, body: unknown): boolean {
    const session = this.pairingManager.getActiveSession();
    const trusted = this.pairingManager.getTrustedPhone();
    if (!session || !trusted || session.peerDeviceId !== trusted.phoneDeviceId) {
      return false;
    }

    const id = "e-" + generateDeviceId().slice(0, 16) + "-" + Date.now().toString(36);
    const ts = Date.now();
    const from = this.identity.deviceId;
    const to = trusted.phoneDeviceId;

    try {
      const ciphertext = this.e2e.seal(session, innerKind, body, { id, from, to });
      const env: Envelope<"encrypted", EncryptedPayload> = {
        v: 2,
        id,
        ts,
        from,
        to,
        kind: "encrypted",
        payload: { ciphertext },
      };
      (this.activeRoute??this.relayClient).send(env);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Main incoming envelope dispatcher.
   */
  private async handleRelayMessage(env: Envelope<MessageKind, unknown>, route=this.relayClient): Promise<void> {
    if (!env || typeof env !== "object" || env.v !== 2 || env.to !== this.identity.deviceId) return;

    if(env.kind==='presence' && env.from==='relay'){
      const p=env.payload as {deviceId?:string;status?:string};
      if(typeof p?.deviceId==='string' && ['online','offline'].includes(p.status??'')){
        const peers=this.onlinePeers.get(route)??new Set<string>();if(p.status==='online')peers.add(p.deviceId);else peers.delete(p.deviceId);this.onlinePeers.set(route,peers);
      }
      return;
    }
    if (env.kind === "pairing_prekey_request") {
      const request = env.payload as { ref?: string; pqPrekeyId?: string } | null;
      if (typeof request?.ref !== "string" || typeof request.pqPrekeyId !== "string") return;
      const prekey = this.pairingManager.getPublicPrekey(request.pqPrekeyId, request.ref);
      if (prekey)
        route.send({
          v: 2,
          id: "prekey-" + generateDeviceId(),
          ts: Date.now(),
          from: this.identity.deviceId,
          to: env.from,
          kind: "pairing_prekey",
          payload: { ...prekey, requestId: env.id },
        });
      return;
    }

    if (env.kind === "pairing_request") {
      const res = await this.pairingManager.handlePairingRequest(
        env as Envelope<"pairing_request", PairingRequest>,
      );
      if (res) {
        this.live.clear();this.history.clear();
        route.send(res.grantEnv);
      }
      return;
    }

    if (env.kind === "encrypted") {
      const confirmation = this.pairingManager.confirmTransport(
        env as Envelope<"encrypted", EncryptedPayload>,
      );
      if (confirmation !== "unrelated") {
        if (confirmation === "confirmed") { this.e2e.resetPeer(env.from);this.activeRoute=route; }
        return;
      }
      await this.handleEncryptedMessage(env as Envelope<"encrypted", EncryptedPayload>,route);
      return;
    }

    // Delivery acks, presence, and other unencrypted envelopes are handled or ignored safely
  }

  /**
   * Handles encrypted envelopes.
   */
  private async handleEncryptedMessage(
    env: Envelope<"encrypted", EncryptedPayload>,
    route=this.relayClient,
  ): Promise<void> {
    const trusted = this.pairingManager.getTrustedPhone();
    const session = this.pairingManager.getActiveSession();

    // Authorization boundaries (§6): frame MUST be from trusted phone with active Noise session
    if (
      !trusted ||
      !session ||
      session.peerDeviceId !== trusted.phoneDeviceId ||
      env.from !== trusted.phoneDeviceId
    ) {
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
      this.pairingManager.setActiveSession(null);
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

    this.activeRoute=route;
    await this.dispatchInnerFrame(openResult.innerKind, openResult.body, env);
  }

  private offerCloudRegistration(force=false):void {
    if(!this.onCloudGrant || !this.pairingManager.getActiveSession())return;
    if(!force && this.cloudSetupSession===this.pairingManager.getActiveSession())return;
    this.cloudSetupSession=this.pairingManager.getActiveSession()??undefined;
            const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
            const proof={action:'register',at:Date.now(),deviceId:this.identity.deviceId,helloPubkey:this.identity.helloPubkeyB64,nonce:Buffer.from(bytes).toString('hex'),roomId:Buffer.from(sha256Bytes(new TextEncoder().encode(this.identity.helloPubkeyB64))).toString('hex')};
            this.sendEncrypted('cloud_setup',{...proof,signature:Buffer.from(ed25519Sign(this.identity.helloKeypair.privateKey,new TextEncoder().encode(canonicalJson(proof)))).toString('base64')});
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
      case 'cloud_setup': {
        if(!this.onCloudGrant)return;
        if((body as {action?:string})?.action==='request'){this.offerCloudRegistration(true);break;}
        const grant=body as CloudRelayGrant;
        if(!grant||grant.action!=='grant'||grant.deviceId!==this.identity.deviceId)return;
        try{await this.onCloudGrant(grant);this.sendEncrypted('cloud_setup',{action:'ready',relayUrl:grant.relayUrl});}
        catch{this.sendEncrypted('cloud_setup',{action:'error',message:'Outside-network connection could not be enabled. Try reconnecting.'});}
        break;
      }
      case "command_request": {
        const req = body as CommandRequest;
        if (
          !req ||
          typeof req.instruction !== "string" ||
          !req.instruction.trim() ||
          req.instruction.length > 4000 ||
          !Number.isFinite(req.sentAt) ||
          Math.abs(Date.now() - req.sentAt) > 120_000
        )
          return;
        try {
          const { result: cmdRes } = await this.idempotency.execute<CommandResult>(
            req.idempotencyKey,
            async () => {
              await this.authorizeRemote({
                kind: "command",
                peer: outer.from,
                text: req.instruction,
              });
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
            canonicalJson({
              peer: outer.from,
              kind: innerKind,
              instruction: "instruction" in req ? req.instruction : undefined,
              reason: "reason" in req ? req.reason : undefined,
            }),
          );
          this.sendEncrypted("command_result", cmdRes);
        } catch {
          // Pre-execution failure (e.g. invalid idempotency key): no log entry exists.
          this.sendEncrypted("command_result", {
            idempotencyKey: typeof req.idempotencyKey === "string" ? req.idempotencyKey : "",
            ok: false,
            summary: "Request rejected or outcome unknown; check desktop before retrying",
          });
        }
        break;
      }

      case "chat_message": {
        const msg = body as ChatMessage;
        if (!msg || typeof msg !== "object") return;
        try {
          await this.chatHandler.handleMessage(msg, outer.from);
        } catch {
          this.sendEncrypted("chat_done", {
            idempotencyKey: typeof msg.idempotencyKey === "string" ? msg.idempotencyKey : "",
            sessionId: typeof msg.sessionId === "string" ? msg.sessionId : "",
            ok: false,
            error: "Chat request rejected",
            at: Date.now(),
          });
        }
        break;
      }

      case "kill_request": {
        const req = body as KillRequest;
        if (
          !req ||
          !Number.isFinite(req.sentAt) ||
          Math.abs(Date.now() - req.sentAt) > 30_000 ||
          (req.reason !== undefined && (typeof req.reason !== "string" || req.reason.length > 500))
        )
          return;
        // Contract §11: Any approval pending for a killed session is auto-resolved as denied
        this.approvalsGate.cancelForSession();

        try {
          IdempotencyLog.validateKey(req.idempotencyKey);
          // Stopping is an idempotent safety operation; journal availability must never gate it.
          const killRes = await this.emergencyStop(req.reason, req.idempotencyKey);
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
        const accepted = this.approvalsGate.handleDecision(decision);
        if (decision && typeof decision.approvalId === "string")
          this.sendEncrypted("approval_result", { approvalId: decision.approvalId, accepted });
        break;
      }

      case "session_watch": {
        try { const result=await this.live.request(body,outer.from);if(result)this.sendEncrypted('session_watch_status',result); }
        catch { const r=body as {watchId?:string;sessionId?:string};if(r?.watchId&&r?.sessionId)this.sendEncrypted('session_watch_status',{watchId:r.watchId,sessionId:r.sessionId,ok:false,error:'Live connection unavailable'}); }
        break;
      }
      case "session_history_request": {
        const result = await this.history.handle(body, outer.from);
        if (result) this.sendEncrypted("session_history_chunk", result);
        break;
      }
      case "session_create_request": {
        const result = await this.sessionCreation.handle(body, outer.from);
        if(result)this.sendEncrypted("session_create_result",result);
        break;
      }
      case "session_list_request": {
        try {
          const sessions = await this.enginePort.listSessions();
          const list: SessionList = { sessions, workspaces: await this.enginePort.listWorkspaces?.(), canCreateSessions: !!this.enginePort.createSession };
          this.sendEncrypted("session_list", list);
          this.offerCloudRegistration();
          for (const request of this.approvalsGate.getPendingRequests().slice(0, 8))
            this.sendEncrypted("approval_request", request);
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
        this.cancelRemoteResources();
        await this.hostControls.setRemoteSessionActive(false).catch(() => {});
        await this.pairingManager.revokeTrustedPhone();
        this.e2e.clearPeer(outer.from);
        // Preserve durable operation history across trust changes.
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

  private cancelRemoteResources(): void {
    this.live.clear();
    this.history.clear();
    this.remoteEpoch.abort();
    this.remoteEpoch = new AbortController();
    this.approvalsGate.cancelForSession();
    this.filePipeline.clearAll();
  }

  public async emergencyStop(
    reason = "local_user_stop",
    idempotencyKey = "local-" + generateDeviceId(),
  ): Promise<KillResult> {
    this.cancelRemoteResources();
    // Call kill before UI/log I/O so a broken banner or full disk cannot prevent stopping.
    const result = await this.enginePort.kill({ idempotencyKey, reason });
    await this.hostControls.setRemoteSessionActive(false).catch(() => {});
    await this.logSecurityEvent({ type: "emergency_stop", detail: { reason }, at: Date.now() });
    return result;
  }

  /** Desktop trust revocation must also invalidate pending approvals and encrypted sessions. */
  public async revokeTrustedPhone(): Promise<string | null> {
    await this.emergencyStop("local_pairing_revoked");
    const previous = await this.pairingManager.revokeTrustedPhone();
    if (previous) this.e2e.clearPeer(previous);
    return previous;
  }

  private async authorizeRemote(operation: RemoteOperation): Promise<void> {
    const signal = this.remoteEpoch.signal;
    if (
      operation.peer !== this.pairingManager.getTrustedPhone()?.phoneDeviceId ||
      !this.pairingManager.getActiveSession()
    )
      throw new Error("Remote session is not trusted");
    await this.hostControls.setRemoteSessionActive(true, operation.peer);
    const allowed = await this.hostControls.authorize(operation, signal);
    if (
      !allowed ||
      signal.aborted ||
      operation.peer !== this.pairingManager.getTrustedPhone()?.phoneDeviceId
    )
      throw new Error("Paired-phone access is no longer authorized");
    // Instruction audit must succeed before dispatch. No raw instruction appears in mobile errors.
    await fs.appendFile(
      this.securityLogPath,
      JSON.stringify({ type: "remote_operation", operation, at: Date.now() }) + "\n",
      { mode: 0o600 },
    );
    if (signal.aborted) throw new Error("Remote authorization was revoked");
  }

  public async logSecurityEvent(event: SecurityEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.securityLogPath), { recursive: true });
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(this.securityLogPath, line, { encoding: "utf-8", mode: 0o600 });
    } catch {
      // Do not throw on logging failure
    }
  }
}
