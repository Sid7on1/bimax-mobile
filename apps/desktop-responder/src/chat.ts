import type { ChatMessage, ChatToken, ChatDone } from "@bimax/protocol";
import type { EnginePort } from "./engine-port";
import { canonicalJson } from "./crypto/keys";
import { IdempotencyLog } from "./idempotency";

export interface ChatHandlerOptions {
  enginePort: EnginePort;
  idempotency: IdempotencyLog;
  sendToken: (token: ChatToken) => void;
  sendDone: (done: ChatDone) => void;
  maxBufferBytes?: number;
  shouldStreamTokens?: (msg: ChatMessage) => boolean;
  authorize: (msg: ChatMessage, peer: string) => Promise<void>;
}

const MAX_TEXT_LENGTH = 32 * 1024; // 32 KB
const DEFAULT_MAX_TOKEN_BUFFER = 1024 * 1024; // 1 MB

export class ChatHandler {
  private enginePort: EnginePort;
  private idempotency: IdempotencyLog;
  private sendToken: (token: ChatToken) => void;
  private sendDone: (done: ChatDone) => void;
  private maxBufferBytes: number;
  private shouldStreamTokens?: ChatHandlerOptions["shouldStreamTokens"];
  private authorize: ChatHandlerOptions["authorize"];

  constructor(opts: ChatHandlerOptions) {
    this.authorize = opts.authorize;
    this.shouldStreamTokens=opts.shouldStreamTokens;
    this.enginePort = opts.enginePort;
    this.idempotency = opts.idempotency;
    this.sendToken = opts.sendToken;
    this.sendDone = opts.sendDone;
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_TOKEN_BUFFER;
  }

  /**
   * Handles an incoming chat_message frame per contract §9.
   */
  public async handleMessage(msg: ChatMessage, peer = ""): Promise<ChatDone> {
    if (!msg || typeof msg !== "object") {
      throw new Error("Chat message must be an object");
    }

    try {
      IdempotencyLog.validateKey(msg.idempotencyKey);
      if (
        typeof msg.text !== "string" ||
        new TextEncoder().encode(msg.text).length > MAX_TEXT_LENGTH ||
        !Number.isSafeInteger(msg.sentAt) ||
        Math.abs(Date.now() - msg.sentAt) > 120_000 ||
        (msg.sessionId !== undefined &&
          (typeof msg.sessionId !== "string" || msg.sessionId.length > 128)) ||
        (msg.fileIds !== undefined &&
          (!Array.isArray(msg.fileIds) ||
            msg.fileIds.length > 16 ||
            !msg.fileIds.every((id) => typeof id === "string" && /^f-[0-9a-f]{32}$/.test(id)))) ||
        (!msg.text.trim() && !msg.fileIds?.length)
      )
        throw new Error("Invalid chat request");

      const { result: done } = await this.idempotency.execute<ChatDone>(
        msg.idempotencyKey,
        async () => {
          await this.authorize(msg, peer);
          const streamTokens=this.shouldStreamTokens?.(msg)!==false;
          let seq = 0;
          let bufferedBytes = 0;

          let pendingText = "";
          let truncated = false;
          const flush = () => {
            if (!pendingText) return;
            let end = Math.min(8192, pendingText.length);
            if (end < pendingText.length) {
              const code = pendingText.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) end -= 1;
            }
            const token = pendingText.slice(0, end);
            pendingText = pendingText.slice(end);
            this.sendToken({ idempotencyKey: msg.idempotencyKey, seq: seq++, token });
          };
          // Coalesce provider tokens so streaming and its ACKs fit relay rate limits.
          const timer = streamTokens ? setInterval(flush, 100) : undefined;
          const onToken = (token: string) => {
            if(!streamTokens)return;
            const size = new TextEncoder().encode(token).length;
            if (bufferedBytes + size > this.maxBufferBytes) {
              truncated = true;
              return;
            }
            bufferedBytes += size;
            pendingText += token;
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

            clearInterval(timer);
            while (pendingText) {
              flush();
              if (pendingText) await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return {
              idempotencyKey: msg.idempotencyKey,
              sessionId: res.sessionId,
              ok: !truncated,
              error: truncated ? "Response exceeded remote stream limit" : undefined,
              at: Date.now(),
            };
          } catch {
            return {
              idempotencyKey: msg.idempotencyKey,
              sessionId: msg.sessionId ?? "",
              ok: false,
              error: "Desktop chat failed; check the desktop",
              at: Date.now(),
            };
          } finally {
            clearInterval(timer);
          }
        },
        undefined,
        canonicalJson({
          peer,
          kind: "chat_message",
          text: msg.text,
          sessionId: msg.sessionId,
          fileIds: msg.fileIds,
        }),
      );

      // Send completion frame
      this.sendDone(done);
      return done;
    } catch {
      const done: ChatDone = {
        idempotencyKey: typeof msg.idempotencyKey === "string" ? msg.idempotencyKey : "",
        sessionId: typeof msg.sessionId === "string" ? msg.sessionId : "",
        ok: false,
        error: "Chat request rejected or outcome unknown; check desktop before retrying",
        at: Date.now(),
      };
      this.sendDone(done);
      return done;
    }
  }
}
