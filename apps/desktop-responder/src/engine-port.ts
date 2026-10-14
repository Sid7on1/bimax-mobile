import type {
  AgentStatus,
  AgentSessionInfo,
  CommandResult,
  KillResult,
  ToolApprovalRequest,
} from "@bimax/protocol";

export type ApprovalVerdict = "approved" | "denied";

export interface EnginePort {
  /** Current agent state for the status card. */
  getStatus(): Promise<AgentStatus>;
  /** Sessions the phone may display/switch between. */
  listSessions(): Promise<AgentSessionInfo[]>;
  /** Fire-and-forget instruction; idempotent via idempotencyKey (§8). */
  sendInstruction(input: {
    idempotencyKey: string;
    instruction: string;
  }): Promise<CommandResult>;
  /** Conversational turn; streams tokens via onToken (§9). */
  chat(
    input: {
      idempotencyKey: string;
      sessionId?: string;
      text: string;
      fileIds?: string[];
    },
    onToken: (token: string) => void,
  ): Promise<{ sessionId: string }>;
  /** Cancel the running task (§11). */
  kill(input: { idempotencyKey: string; reason?: string }): Promise<KillResult>;
  /** Register a verified-received file for later reference (§10). */
  attachFile(input: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  }): Promise<void>;
  /** Engine → responder: a tool needs user approval (§7). */
  onApprovalRequest(cb: (req: ToolApprovalRequest) => void): void;
  /** Engine → responder: status changed (proactive push). */
  onStatusChanged(cb: (status: AgentStatus) => void): void;
  /** Responder → engine: deliver a VERIFIED approval decision. */
  resolveApproval(
    approvalId: string,
    verdict: ApprovalVerdict,
    denyReason?: "not_me" | "mistake",
  ): void;
}
