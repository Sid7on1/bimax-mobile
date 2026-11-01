import type {
  RemoteConversation,
  SessionHistoryChunk,
  SessionHistoryRequest,
} from "@bimax/protocol";
import { randomId } from "../crypto/keys";
import { base64ToBytes } from "../crypto/base64";
const MAX = 4 * 1024 * 1024;
interface Pending {
  id: string;
  sessionId: string;
  watchId?: string;
  snapshotId?: string;
  total?: number;
  offset: number;
  chunks: Uint8Array[];
  resolve: (value: RemoteConversation) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  continuation?: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
  send: (request: SessionHistoryRequest) => void;
}
export function parseRemoteConversation(value: unknown, sessionId: string): RemoteConversation {
  const v = value as RemoteConversation;
  if (
    !v ||
    v.sessionId !== sessionId ||
    typeof v.title !== "string" ||
    v.title.length > 1000 ||
    !Array.isArray(v.messages) ||
    v.messages.length > 4000 ||
    !["idle", "working", "waiting_approval", "error"].includes(v.status) ||
    typeof v.streaming !== "string" ||
    typeof v.thinking !== "string" ||
    !Number.isFinite(v.updatedAt)
  )
    throw new Error("Invalid conversation response");
  const seen = new Set<string>();
  for (const m of v.messages) {
    if (
      !m ||
      typeof m.id !== "string" ||
      m.id.length > 200 ||
      seen.has(m.id) ||
      !["user", "assistant", "system", "tool"].includes(m.role) ||
      typeof m.content !== "string" ||
      (m.reasoning !== undefined && typeof m.reasoning !== "string")
    )
      throw new Error("Invalid conversation message");
    seen.add(m.id);
  }
  return v;
}
/** One immutable bounded snapshot at a time per request. History is never written to phone SQL. */
export class HistoryClient {
  private pending = new Map<string, Pending>();
  private nextContinuationAt=0;
  constructor(private readonly makeId = () => randomId("history")) {}
  read(
    sessionId: string,
    send: Pending["send"],
    signal?: AbortSignal,
    watchId?: string,
  ): Promise<RemoteConversation> {
    if (!/^[\w-]{1,100}$/.test(sessionId) || signal?.aborted)
      return Promise.reject(new Error("History request cancelled"));
    if (this.pending.size >= 2)
      return Promise.reject(new Error("Another conversation is still loading"));
    const id = this.makeId();
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(id, "History request cancelled");
      const p: Pending = {
        id,
        sessionId,
        watchId,
        resolve,
        reject,
        offset: 0,
        chunks: [],
        send,
        timer: setTimeout(
          () =>
            this.fail(
              id,
              "History timed out. Reconnect to your Mac, then retry.",
            ),
          120_000,
        ),
        removeAbort: () => signal?.removeEventListener("abort", abort),
      };
      this.pending.set(id, p);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        send({ requestId: id, sessionId, watchId });
      } catch {
        this.fail(id, "Mac connection unavailable");
      }
    });
  }
  clear(message = "Mac connection interrupted"): void {
    for (const id of [...this.pending.keys()]) this.fail(id, message);
  }
  private retire(p: Pending): void {
    clearTimeout(p.timer);
    clearTimeout(p.continuation);
    p.removeAbort();
    this.pending.delete(p.id);
  }
  private fail(id: string, message: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.retire(p);
    p.reject(new Error(message));
  }
  handle(value: unknown): void {
    const c = value as SessionHistoryChunk,
      p = c && this.pending.get(c.requestId);
    if (!p) return;
    if (c.sessionId !== p.sessionId || c.ok !== true) {
      this.fail(
        p.id,
        c.sessionId === p.sessionId && typeof c.error === "string"
          ? c.error.slice(0, 300)
          : "Invalid conversation response",
      );
      return;
    }
    try {
      if (
        typeof c.snapshotId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(c.snapshotId) ||
        (p.snapshotId && c.snapshotId !== p.snapshotId) ||
        c.offset !== p.offset ||
        !Number.isSafeInteger(c.totalBytes) ||
        c.totalBytes! <= 0 ||
        c.totalBytes! > MAX ||
        (p.total && c.totalBytes !== p.total) ||
        typeof c.data !== "string" ||
        c.data.length > 22000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(c.data)
      )
        throw new Error("Invalid history chunk");
      const bytes = base64ToBytes(c.data);
      if (!bytes.length || bytes.length > 16384 || p.offset + bytes.length > c.totalBytes!)
        throw new Error("Invalid history size");
      p.snapshotId = c.snapshotId;
      p.total = c.totalBytes;
      p.chunks.push(bytes);
      p.offset += bytes.length;
      if (p.offset === p.total) {
        if (c.nextCursor !== undefined) throw new Error("Invalid final cursor");
        const all = new Uint8Array(p.total);
        let offset = 0;
        for (const b of p.chunks) {
          all.set(b, offset);
          offset += b.length;
        }
        const conversation = parseRemoteConversation(
          JSON.parse(new TextDecoder().decode(all)),
          p.sessionId,
        );
        this.retire(p);
        p.resolve(conversation);
      } else {
        if (c.nextCursor !== `${p.snapshotId}:${p.offset}`)
          throw new Error("Invalid continuation cursor");
        // Share an 8-request/second continuation budget across the two bounded reads.
        // Each response also emits delivery acknowledgments; an unpaced LAN transfer
        // otherwise trips the relay's 30-frame/second limit and drops the Noise session.
        const at=Math.max(Date.now()+125,this.nextContinuationAt);this.nextContinuationAt=at+125;
        p.continuation=setTimeout(()=>{
          if(this.pending.get(p.id)!==p)return;
          try{p.send({requestId:p.id,sessionId:p.sessionId,watchId:p.watchId,cursor:c.nextCursor});}
          catch{this.fail(p.id,'Mac connection unavailable');}
        },at-Date.now());
      }
    } catch {
      this.fail(p.id, "Conversation transfer failed. Please retry.");
    }
  }
}
