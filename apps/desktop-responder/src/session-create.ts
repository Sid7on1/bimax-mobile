import type { SessionCreateRequest, SessionCreateResult } from "@bimax/protocol";
import { canonicalJson } from "./crypto/keys";
import { IdempotencyLog } from "./idempotency";
/** Capture and re-check exact secure-session authority after every asynchronous admission. */
export class SessionCreation {
  constructor(
    private options: {
      context(): { peer: string; session: object } | null;
      authorize(): Promise<void>;
      create(workspaceId: string): Promise<{ sessionId: string }>;
      journal: IdempotencyLog;
    },
  ) {}
  async handle(value: unknown, peer: string): Promise<SessionCreateResult | null> {
    const raw = value as SessionCreateRequest;
    const request = raw && {
      requestId: raw.requestId,
      workspaceId: raw.workspaceId,
      sentAt: raw.sentAt,
    };
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !/^create-[a-f0-9]{32}$/.test(request.requestId) ||
      typeof request.workspaceId !== "string" ||
      !/^w-[a-f0-9]{64}$/.test(request.workspaceId) ||
      !Number.isSafeInteger(request.sentAt) ||
      Math.abs(Date.now() - request.sentAt) > 120000
    )
      return null;
    const captured = this.options.context();
    const valid = () => {
      const now = this.options.context();
      return (
        captured &&
        now?.peer === peer &&
        now.peer === captured.peer &&
        now.session === captured.session
      );
    };
    if (!valid()) return null;
    const base = { requestId: request.requestId, workspaceId: request.workspaceId };
    try {
      await this.options.authorize();
      if (!valid()) return null;
      const { result } = await this.options.journal.execute<SessionCreateResult>(
        request.requestId,
        async () => {
          if (!valid()) throw Error("Secure session retired");
          try {
            const created = await this.options.create(request.workspaceId);
            return { ...base, ok: true, sessionId: created.sessionId };
          } catch {
            return {
              ...base,
              ok: false,
              error:
                "Could not create a chat in that folder. Refresh folders or check Bimax on your Mac.",
            };
          }
        },
        undefined,
        canonicalJson({ kind: "session_create", peer, workspaceId: request.workspaceId }),
      );
      return valid() ? result : null;
    } catch {
      return valid()
        ? {
            ...base,
            ok: false,
            error: "Creation outcome is unknown. Check Mac chats before starting another chat.",
          }
        : null;
    }
  }
}
