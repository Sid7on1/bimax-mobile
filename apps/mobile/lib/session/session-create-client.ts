import type { SessionCreateResult } from "@bimax/protocol";
/** Explicit user intent; no automatic replay after a lost connection or timeout. */
export class SessionCreateClient {
  private pending = new Map<
    string,
    {
      workspaceId: string;
      resolve: (id: string) => void;
      reject: (e: Error) => void;
      dispose: () => void;
    }
  >();
  constructor(private timeoutMs = 15000) {}
  create(
    requestId: string,
    workspaceId: string,
    send: (request: { requestId: string; workspaceId: string; sentAt: number }) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.pending.size >= 4 || this.pending.has(requestId))
      return Promise.reject(Error("A chat is already being created"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(requestId);
        dispose();
        reject(Error("Creation interrupted. Check Mac chats; Retry uses the same request."));
      };
      const timer = setTimeout(abort, this.timeoutMs);
      const dispose = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(requestId, { workspaceId, resolve, reject, dispose });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        send({ requestId, workspaceId, sentAt: Date.now() });
      } catch {
        abort();
      }
    });
  }
  handle(value: unknown) {
    const result = value as SessionCreateResult;
    if (!result || typeof result.requestId !== "string" || typeof result.ok !== "boolean") return;
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.workspaceId !== result.workspaceId) return;
    if (
      result.ok &&
      (typeof result.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.sessionId))
    )
      return;
    this.pending.delete(result.requestId);
    pending.dispose();
    if (result.ok) pending.resolve(result.sessionId!);
    else
      pending.reject(
        Error(
          typeof result.error === "string"
            ? result.error.slice(0, 200)
            : "Could not create Mac chat",
        ),
      );
  }
  clear() {
    for (const item of this.pending.values()) {
      item.dispose();
      item.reject(Error("Connection changed. Check Mac chats; Retry uses the same request."));
    }
    this.pending.clear();
  }
}
