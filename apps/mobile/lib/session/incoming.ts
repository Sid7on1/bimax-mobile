import type {
  Envelope,
  MessageKind,
  ToolApprovalRequest,
  AgentStatus,
  AgentSessionInfo,
  MacWorkspace,
  SessionList,
  CommandResult,
  KillResult,
  ChatToken,
  ChatDone,
  FileAccept,
  FileReject,
  FileReceived,
  FileError,
} from "@bimax/protocol";

export function isAllowedUnauthenticatedKind(kind: MessageKind): boolean {
  return kind === "encrypted" || kind === "pairing_grant" || kind === "presence";
}

export function parseAgentStatusPayload(payload: unknown): AgentStatus | null {
  const s = payload as AgentStatus | null | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    (s.state !== "idle" &&
      s.state !== "working" &&
      s.state !== "waiting_approval" &&
      s.state !== "error")
  ) {
    return null;
  }
  return {
    state: s.state,
    sessionId: typeof s.sessionId === "string" ? s.sessionId.slice(0, 100) : undefined,
    taskSummary: typeof s.taskSummary === "string" ? s.taskSummary.slice(0, 200) : undefined,
    updatedAt:
      typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now(),
  };
}

export function parseWorkspace(value: unknown): MacWorkspace | null {
  const item = value as MacWorkspace;
  return item &&
    /^w-[a-f0-9]{64}$/.test(item.id) &&
    typeof item.name === "string" &&
    typeof item.location === "string"
    ? { id: item.id, name: item.name.slice(0, 80), location: item.location.slice(0, 160) }
    : null;
}
export function parseSessionListPayload(payload: unknown): AgentSessionInfo[] | null {
  const listPayload = payload as SessionList | null | undefined;
  if (!listPayload || !Array.isArray(listPayload.sessions)) {
    return null;
  }
  const valid: AgentSessionInfo[] = [];
  for (const item of listPayload.sessions) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.sessionId === "string" &&
      item.sessionId.length > 0 &&
      typeof item.title === "string" &&
      (item.status === "idle" ||
        item.status === "working" ||
        item.status === "waiting_approval" ||
        item.status === "error")
    ) {
      valid.push({
        sessionId: item.sessionId.slice(0, 100),
        title: item.title.slice(0, 200),
        status: item.status,
        workspace: parseWorkspace(item.workspace) ?? undefined,
        startedAt:
          typeof item.startedAt === "number" && Number.isFinite(item.startedAt)
            ? item.startedAt
            : Date.now(),
      });
      if (valid.length >= 50) break;
    }
  }
  return valid;
}

export function parseCommandResultPayload(payload: unknown): {
  idempotencyKey: string;
  status: "acked" | "failed";
  summary?: string;
} | null {
  const r = payload as CommandResult | null | undefined;
  if (!r || typeof r !== "object" || typeof r.idempotencyKey !== "string" || !r.idempotencyKey) {
    return null;
  }
  return {
    idempotencyKey: r.idempotencyKey,
    status: r.ok ? "acked" : "failed",
    summary: typeof r.summary === "string" ? r.summary.slice(0, 300) : undefined,
  };
}

export function parseKillResultPayload(payload: unknown): KillResult | null {
  const k = payload as KillResult | null | undefined;
  if (
    !k ||
    typeof k !== "object" ||
    typeof k.idempotencyKey !== "string" ||
    k.idempotencyKey.length === 0 ||
    typeof k.ok !== "boolean"
  ) {
    return null;
  }
  return {
    idempotencyKey: k.idempotencyKey,
    ok: k.ok,
    detail: typeof k.detail === "string" ? k.detail.slice(0, 300) : undefined,
    at: typeof k.at === "number" && Number.isFinite(k.at) ? k.at : Date.now(),
  };
}

export function parseChatTokenPayload(payload: unknown): ChatToken | null {
  const t = payload as ChatToken | null | undefined;
  if (
    !t ||
    typeof t !== "object" ||
    typeof t.idempotencyKey !== "string" ||
    !t.idempotencyKey ||
    typeof t.seq !== "number" ||
    !Number.isInteger(t.seq) ||
    t.seq < 0 ||
    typeof t.token !== "string"
  ) {
    return null;
  }
  return {
    idempotencyKey: t.idempotencyKey,
    seq: t.seq,
    token: t.token,
  };
}

export function parseChatDonePayload(payload: unknown): ChatDone | null {
  const d = payload as ChatDone | null | undefined;
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.idempotencyKey !== "string" ||
    !d.idempotencyKey ||
    typeof d.sessionId !== "string" ||
    typeof d.ok !== "boolean"
  ) {
    return null;
  }
  return {
    idempotencyKey: d.idempotencyKey,
    sessionId: d.sessionId.slice(0, 128),
    ok: d.ok,
    error: typeof d.error === "string" ? d.error.slice(0, 300) : undefined,
    at: typeof d.at === "number" && Number.isFinite(d.at) ? d.at : Date.now(),
  };
}

export function parseFileAcceptPayload(payload: unknown): FileAccept | null {
  const a = payload as FileAccept | null | undefined;
  if (!a || typeof a !== "object" || typeof a.transferId !== "string" || !a.transferId) {
    return null;
  }
  return { transferId: a.transferId };
}

export function parseFileRejectPayload(payload: unknown): FileReject | null {
  const r = payload as FileReject | null | undefined;
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.transferId !== "string" ||
    !r.transferId ||
    typeof r.reason !== "string"
  ) {
    return null;
  }
  return { transferId: r.transferId, reason: r.reason.slice(0, 300) };
}

export function parseFileReceivedPayload(payload: unknown): FileReceived | null {
  const r = payload as FileReceived | null | undefined;
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.transferId !== "string" ||
    !r.transferId ||
    typeof r.fileId !== "string" ||
    !r.fileId
  ) {
    return null;
  }
  return { transferId: r.transferId, fileId: r.fileId };
}

export function parseFileErrorPayload(payload: unknown): FileError | null {
  const e = payload as FileError | null | undefined;
  if (
    !e ||
    typeof e !== "object" ||
    typeof e.transferId !== "string" ||
    !e.transferId ||
    typeof e.code !== "string" ||
    typeof e.message !== "string"
  ) {
    return null;
  }
  return {
    transferId: e.transferId,
    code: e.code.slice(0, 64),
    message: e.message.slice(0, 300),
  };
}

export interface IncomingEnvelopeContext {
  owner: string;
  isActiveAccount: (owner: string) => boolean;
  deviceId: string;
  trustedDesktopId?: string;
  onPresence?: (deviceId: string, status: string) => void;
  onEncrypted?: (env: Envelope<MessageKind, unknown>) => void;
  onPairingGrant?: (env: Envelope<MessageKind, unknown>) => void;
  onApprovalRequest?: (req: ToolApprovalRequest) => void;
  onApprovalResult?: (approvalId: string, accepted: boolean) => void;
  onAgentStatus?: (status: AgentStatus) => void;
  onCloudSetup?: (payload: unknown) => void;
  onSessionUpdate?: (payload: unknown) => void;
  onWatchStatus?: (payload: unknown) => void;
  onHistoryChunk?: (payload: unknown) => void;
  onSessionCreated?: (value: unknown) => void;
  onWorkspaces?: (workspaces: MacWorkspace[], supported: boolean) => void;
  onSessionList?: (sessions: AgentSessionInfo[]) => void;
  onCommandResult?: (res: {
    idempotencyKey: string;
    status: "acked" | "failed";
    summary?: string;
  }) => void;
  onKillResult?: (res: KillResult) => void;
  onChatToken?: (token: ChatToken) => void;
  onChatDone?: (done: ChatDone) => void;
  onFileAccept?: (accept: FileAccept) => void;
  onFileReject?: (reject: FileReject) => void;
  onFileReceived?: (received: FileReceived) => void;
  onFileError?: (err: FileError) => void;
}

/**
 * Validates envelope authentication boundaries and dispatches verified frames.
 * Raw unauthenticated application frames (such as forged `agent_status` or
 * `approval_request` envelopes) are strictly rejected before reaching handlers.
 */
export function dispatchIncomingEnvelope(
  env: Envelope<MessageKind, unknown>,
  ctx: IncomingEnvelopeContext,
  authenticated = false,
): void {
  if (!ctx.isActiveAccount(ctx.owner)) return;
  if (!env || env.v !== 2 || env.to !== ctx.deviceId) return;
  if (!authenticated && !isAllowedUnauthenticatedKind(env.kind)) return;
  if (authenticated && env.from !== ctx.trustedDesktopId) return;

  if (env.kind === "presence" && env.from === "relay") {
    const presence = env.payload as { deviceId?: string; status?: string } | null | undefined;
    if (
      presence &&
      typeof presence.deviceId === "string" &&
      presence.deviceId === ctx.trustedDesktopId &&
      typeof presence.status === "string"
    ) {
      ctx.onPresence?.(presence.deviceId, presence.status);
    }
    return;
  }

  if (env.kind === "encrypted") {
    ctx.onEncrypted?.(env);
    return;
  }

  if (env.kind === "pairing_grant") {
    ctx.onPairingGrant?.(env);
    return;
  }

  switch (env.kind) {
    case "approval_request": {
      ctx.onApprovalRequest?.(env.payload as ToolApprovalRequest);
      break;
    }
    case "approval_result": {
      const result = env.payload as { approvalId?: string; accepted?: boolean } | null | undefined;
      if (typeof result?.approvalId === "string" && typeof result.accepted === "boolean") {
        ctx.onApprovalResult?.(result.approvalId, result.accepted);
      }
      break;
    }
    case "agent_status": {
      const status = parseAgentStatusPayload(env.payload);
      if (status) ctx.onAgentStatus?.(status);
      break;
    }
    case "cloud_setup": {
      ctx.onCloudSetup?.(env.payload);
      break;
    }
    case "session_update": {
      ctx.onSessionUpdate?.(env.payload);
      break;
    }
    case "session_watch_status": {
      ctx.onWatchStatus?.(env.payload);
      break;
    }
    case "session_history_chunk": {
      ctx.onHistoryChunk?.(env.payload);
      break;
    }
    case "session_create_result": {
      ctx.onSessionCreated?.(env.payload);
      return;
    }
    case "session_list": {
      const list = env.payload as SessionList;
      if (list && typeof list.canCreateSessions === "boolean") {
        const workspaces = Array.isArray(list.workspaces)
          ? list.workspaces
              .slice(0, 16)
              .map(parseWorkspace)
              .filter((item): item is MacWorkspace => !!item)
          : [];
        ctx.onWorkspaces?.(workspaces, list.canCreateSessions);
      }
      const sessions = parseSessionListPayload(env.payload);
      if (sessions) ctx.onSessionList?.(sessions);
      break;
    }
    case "command_result": {
      const res = parseCommandResultPayload(env.payload);
      if (res) ctx.onCommandResult?.(res);
      break;
    }
    case "kill_result": {
      const kill = parseKillResultPayload(env.payload);
      if (kill) ctx.onKillResult?.(kill);
      break;
    }
    case "chat_token": {
      const token = parseChatTokenPayload(env.payload);
      if (token) ctx.onChatToken?.(token);
      break;
    }
    case "chat_done": {
      const done = parseChatDonePayload(env.payload);
      if (done) ctx.onChatDone?.(done);
      break;
    }
    case "file_accept": {
      const accept = parseFileAcceptPayload(env.payload);
      if (accept) ctx.onFileAccept?.(accept);
      break;
    }
    case "file_reject": {
      const reject = parseFileRejectPayload(env.payload);
      if (reject) ctx.onFileReject?.(reject);
      break;
    }
    case "file_received": {
      const received = parseFileReceivedPayload(env.payload);
      if (received) ctx.onFileReceived?.(received);
      break;
    }
    case "file_error": {
      const err = parseFileErrorPayload(env.payload);
      if (err) ctx.onFileError?.(err);
      break;
    }
    default:
      break;
  }
}
