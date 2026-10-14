import type { ChatMessage, ChatToken, ChatDone } from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { IdempotencyLog } from "./idempotency";

export interface ChatHandlerOptions {
  enginePort: EnginePort;
  idempotency: IdempotencyLog;
  sendToken: (token: ChatToken) => void;
  sendDone: (done: ChatDone) => void;
  maxBufferBytes?: number;
}

const MAX_TEXT_LENGTH = 32 * 1024; // 32 KB
const DEFAULT_MAX_TOKEN_BUFFER = 1024 * 1024; // 1 MB

export class ChatHandler {
  private enginePort: EnginePort;
  private idempotency: IdempotencyLog;
  private sendToken: (token: ChatToken) => void;
  private sendDone: (done: ChatDone) => void;
  private maxBufferBytes: number;

  constructor(opts: ChatHandlerOptions) {
    this.enginePort = opts.enginePort;
    this.idempotency = opts.idempotency;
    this.sendToken = opts.sendToken;
    this.sendDone = opts.sendDone;
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_TOKEN_BUFFER;
  }

  /**
   * Handles an incoming chat_message frame per contract §9.
   */
  public async handleMessage(msg: ChatMessage): Promise<ChatDone> {
    if (!msg || typeof msg !== "object") {
      throw new Error("Chat message must be an object");
    }

    IdempotencyLog.validateKey(msg.idempotencyKey);

    const hasText = typeof msg.text === "string" && msg.text.trim().length > 0;
    const hasFiles = Array.isArray(msg.fileIds) && msg.fileIds.length > 0;

    if (!hasText && !hasFiles) {
      const errDone: ChatDone = {
        idempotencyKey: msg.idempotencyKey,
        sessionId: msg.sessionId ?? "",
        ok: false,
        error: "Empty text with no fileIds is rejected",
        at: Date.now(),
      };
      this.sendDone(errDone);
      return errDone;
    }

    if (typeof msg.text === "string" && msg.text.length > MAX_TEXT_LENGTH) {
      const errDone: ChatDone = {
        idempotencyKey: msg.idempotencyKey,
        sessionId: msg.sessionId ?? "",
        ok: false,
        error: `Text exceeds maximum allowed size of 32 KB (${msg.text.length} chars)`,
        at: Date.now(),
      };
      this.sendDone(errDone);
      return errDone;
    }

    const { result: done } = await this.idempotency.execute<ChatDone>(
      msg.idempotencyKey,
      async () => {
        let seq = 0;
        let bufferedBytes = 0;

        const onToken = (token: string) => {
          const tokenLen = new TextEncoder().encode(token).length;
          if (bufferedBytes + tokenLen <= this.maxBufferBytes) {
            bufferedBytes += tokenLen;
            this.sendToken({
              idempotencyKey: msg.idempotencyKey,
              seq: seq++,
              token,
            });
          }
        };

        try {
          const res = await this.enginePort.chat(
            {
              idempotencyKey: msg.idempotencyKey,
              sessionId: msg.sessionId,
              text: msg.text,
              fileIds: msg.fileIds,
            },
            onToken,
          );

          return {
            idempotencyKey: msg.idempotencyKey,
            sessionId: res.sessionId,
            ok: true,
            at: Date.now(),
          };
        } catch (err) {
          return {
            idempotencyKey: msg.idempotencyKey,
            sessionId: msg.sessionId ?? "",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          };
        }
      },
    );

    // Send completion frame
    this.sendDone(done);
    return done;
  }
}
