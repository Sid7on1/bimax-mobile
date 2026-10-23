import type {
  AgentStatus,
  AgentSessionInfo,
  CommandResult,
  KillResult,
  ToolApprovalRequest,
} from "@bimax/protocol";
import type { EnginePort, ApprovalVerdict } from "./engine-port";

export class FakeEngine implements EnginePort {
  public instructionExecutionCount = 0;
  public chatExecutionCount = 0;
  public killExecutionCount = 0;
  public attachFileExecutionCount = 0;

  public attachedFiles: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  }[] = [];

  public resolutions: {
    approvalId: string;
    verdict: ApprovalVerdict;
    denyReason?: "not_me" | "mistake";
  }[] = [];

  private currentStatus: AgentStatus = {
    state: "idle",
    updatedAt: Date.now(),
  };

  private sessions: AgentSessionInfo[] = [
    {
      sessionId: "session-fake-1",
      title: "Default Test Session",
      status: "idle",
      startedAt: Date.now(),
    },
  ];

  public chatScript: string[] = ["Hello", " ", "from", " ", "FakeEngine!"];
  public taskDurationMs = 0;
  public midTurnApprovalReq: ToolApprovalRequest | null = null;

  private approvalListeners: ((req: ToolApprovalRequest) => void)[] = [];
  private statusListeners: ((status: AgentStatus) => void)[] = [];
  private pendingApprovalWaits = new Map<string, (verdict: ApprovalVerdict) => void>();

  private isTaskRunning = false;
  private abortController: AbortController | null = null;
  private clockFn: () => number = () => Date.now();

  public setClock(fn: () => number): void {
    this.clockFn = fn;
  }

  public now(): number {
    return this.clockFn();
  }

  public async getStatus(): Promise<AgentStatus> {
    return this.currentStatus;
  }

  public setStatus(status: AgentStatus): void {
    this.currentStatus = status;
    for (const cb of this.statusListeners) {
      cb(status);
    }
  }

  public async listSessions(): Promise<AgentSessionInfo[]> {
    return this.sessions;
  }

  public setSessions(sessions: AgentSessionInfo[]): void {
    this.sessions = sessions;
  }

  public shouldFailInstruction = false;
  public instructionFailureError = "Engine simulated failure";

  public async sendInstruction(input: {
    idempotencyKey: string;
    instruction: string;
  }): Promise<CommandResult> {
    this.instructionExecutionCount++;
    this.isTaskRunning = true;
    this.abortController = new AbortController();

    if (this.shouldFailInstruction) {
      this.isTaskRunning = false;
      this.abortController = null;
      throw new Error(this.instructionFailureError);
    }

    if (this.taskDurationMs > 0) {
      await this.sleepOrAbort(this.taskDurationMs, this.abortController.signal);
    }

    this.isTaskRunning = false;
    this.abortController = null;

    return {
      idempotencyKey: input.idempotencyKey,
      ok: true,
      summary: `Instruction executed: ${input.instruction}`,
    };
  }

  public async chat(
    input: {
      idempotencyKey: string;
      sessionId?: string;
      text: string;
      fileIds?: string[];
    },
    onToken: (token: string) => void,
  ): Promise<{ sessionId: string }> {
    this.chatExecutionCount++;
    this.isTaskRunning = true;
    this.abortController = new AbortController();

    const sessionId = input.sessionId ?? "session-fake-1";

    // If configured with a mid-turn approval, emit it and suspend turn until resolved
    if (this.midTurnApprovalReq) {
      const req = this.midTurnApprovalReq;
      this.midTurnApprovalReq = null;
      this.emitApproval(req);
      const verdict = await this.waitForApproval(req.approvalId);
      if (verdict === "denied") {
        this.isTaskRunning = false;
        this.abortController = null;
        throw new Error("Tool approval was denied");
      }
    }

    // Stream canned tokens
    for (const token of this.chatScript) {
      if (this.abortController?.signal.aborted) {
        break;
      }
      onToken(token);
    }

    if (this.taskDurationMs > 0) {
      await this.sleepOrAbort(this.taskDurationMs, this.abortController.signal);
    }

    this.isTaskRunning = false;
    this.abortController = null;

    return { sessionId };
  }

  public async kill(input: { idempotencyKey: string; reason?: string }): Promise<KillResult> {
    this.killExecutionCount++;
    const wasRunning = this.isTaskRunning;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isTaskRunning = false;

    return {
      idempotencyKey: input.idempotencyKey,
      ok: true,
      detail: wasRunning ? "stopped after current step" : "nothing running",
      at: this.now(),
    };
  }

  public async attachFile(input: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  }): Promise<void> {
    this.attachFileExecutionCount++;
    this.attachedFiles.push(input);
  }

  public onApprovalRequest(cb: (req: ToolApprovalRequest) => void): void {
    this.approvalListeners.push(cb);
  }

  public onStatusChanged(cb: (status: AgentStatus) => void): void {
    this.statusListeners.push(cb);
  }

  public emitApproval(req: ToolApprovalRequest): void {
    for (const cb of this.approvalListeners) {
      cb(req);
    }
  }

  public resolveApproval(
    approvalId: string,
    verdict: ApprovalVerdict,
    denyReason?: "not_me" | "mistake",
  ): void {
    this.resolutions.push({ approvalId, verdict, denyReason });
    const pendingCb = this.pendingApprovalWaits.get(approvalId);
    if (pendingCb) {
      this.pendingApprovalWaits.delete(approvalId);
      pendingCb(verdict);
    }
  }

  private waitForApproval(approvalId: string): Promise<ApprovalVerdict> {
    return new Promise<ApprovalVerdict>((res) => {
      this.pendingApprovalWaits.set(approvalId, res);
    });
  }

  private async sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
