import { randomUUID } from "node:crypto";
import type {
  SessionHistoryRequest,
  SessionHistoryChunk,
  RemoteConversation,
} from "@bimax/protocol";

export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
export const HISTORY_CHUNK_BYTES = 16 * 1024;
interface Context {
  peer: string;
  session: object;
}
interface Snapshot {
  context: Context;
  sessionId: string;
  watchId?: string;
  data: Buffer;
  expires: number;
}
/** Bounded immutable transfer; a cursor confers no authority outside its original Noise session. */
export class HistoryService {
  private snapshots = new Map<string, Snapshot>();
  private grants = new WeakMap<object, Set<string>>();
  private pending = 0;
  private epoch = 0;
  private lastRequest = 0;
  constructor(
    private readonly ports: {
      context: () => Context | null;
      title: (id: string) => Promise<string | null>;
      authorize: (id: string, title: string) => Promise<void>;
      read: (id: string) => Promise<RemoteConversation>;
      capture?: (
        watchId: string | undefined,
        snapshot: RemoteConversation,
        context: Context,
      ) => void;
    },
  ) {}
  clear(): void {
    this.epoch++;
    this.snapshots.clear();
    this.grants = new WeakMap();
  }
  async handle(raw: unknown, peer: string): Promise<SessionHistoryChunk | null> {
    const req = raw as SessionHistoryRequest;
    if (
      !req ||
      typeof req.requestId !== "string" ||
      !/^[\w-]{1,128}$/.test(req.requestId) ||
      typeof req.sessionId !== "string" ||
      !/^[\w-]{1,100}$/.test(req.sessionId) ||
      (req.watchId !== undefined &&
        (typeof req.watchId !== "string" || !/^[\w-]{1,128}$/.test(req.watchId))) ||
      (req.cursor !== undefined && (typeof req.cursor !== "string" || req.cursor.length > 128))
    )
      return null;
    const fail = (): SessionHistoryChunk => ({
      requestId: req.requestId,
      sessionId: req.sessionId,
      ok: false,
      error: "Conversation unavailable. Reconnect and try again.",
    });
    const context = this.ports.context(),
      epoch = this.epoch;
    if (!context || context.peer !== peer || this.pending >= 2) return fail();
    const current = () => {
      const now = this.ports.context();
      return epoch === this.epoch && now?.peer === peer && now.session === context.session;
    };
    // A single client transfer is sequential; cap abusive repeated allocations without delaying chunks.
    for (const [key, value] of this.snapshots)
      if (value.expires <= Date.now()) this.snapshots.delete(key);
    this.pending++;
    try {
      let id: string, offset: number, snapshot: Snapshot;
      if (req.cursor !== undefined) {
        const match = /^([a-f0-9-]{36}):(\d{1,8})$/.exec(req.cursor);
        if (!match) return fail();
        id = match[1];
        offset = Number(match[2]);
        const stored = this.snapshots.get(id);
        if (
          !stored ||
          stored.context.peer !== peer ||
          stored.context.session !== context.session ||
          stored.sessionId !== req.sessionId ||
          stored.watchId !== req.watchId ||
          offset % HISTORY_CHUNK_BYTES ||
          offset >= stored.data.length
        )
          return fail();
        snapshot = stored;
      } else {
        if (Date.now() - this.lastRequest < 100) return fail();
        this.lastRequest = Date.now();
        const title = await this.ports.title(req.sessionId);
        if (!title || !current()) return fail();
        let allowed = this.grants.get(context.session);
        if (!allowed?.has(req.sessionId)) {
          await this.ports.authorize(req.sessionId, title);
          if (!current()) return fail();
          if (!allowed) {
            allowed = new Set();
            this.grants.set(context.session, allowed);
          }
          allowed.add(req.sessionId);
        }
        const conversation = await this.ports.read(req.sessionId);
        if (!current() || conversation.sessionId !== req.sessionId) return fail();
        const serialized = JSON.stringify(conversation);
        if (serialized.length > MAX_HISTORY_BYTES) return fail();
        const data = Buffer.from(serialized);
        if (data.length > MAX_HISTORY_BYTES) return fail();
        this.ports.capture?.(req.watchId, conversation, context);
        id = randomUUID();
        offset = 0;
        snapshot = {
          context,
          sessionId: req.sessionId,
          watchId: req.watchId,
          data,
          expires: Date.now() + 120_000,
        };
        while (this.snapshots.size >= 2) this.snapshots.delete(this.snapshots.keys().next().value!);
        this.snapshots.set(id, snapshot);
      }
      if (!current()) return fail();
      const end = Math.min(offset + HISTORY_CHUNK_BYTES, snapshot.data.length);
      return {
        requestId: req.requestId,
        sessionId: req.sessionId,
        ok: true,
        snapshotId: id,
        offset,
        totalBytes: snapshot.data.length,
        data: snapshot.data.subarray(offset, end).toString("base64"),
        nextCursor: end < snapshot.data.length ? `${id}:${end}` : undefined,
      };
    } catch {
      return fail();
    } finally {
      this.pending--;
    }
  }
}
