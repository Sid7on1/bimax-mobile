import type {
  RemoteConversation,
  SessionWatchRequest,
  SessionWatchStatus,
  SessionUpdate,
} from "@bimax/protocol";
interface Context {
  peer: string;
  session: object;
}
interface Watch {
  id: string;
  sessionId: string;
  context: Context;
  baseline?: RemoteConversation;
  ready: boolean;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  dirty: boolean;
}
const validId = (v: unknown) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const textPatch = (before: string, after: string) =>
  before === after
    ? undefined
    : after.startsWith(before)
      ? { append: after.slice(before.length) }
      : { set: after };
export function conversationUpdate(
  watchId: string,
  before: RemoteConversation,
  after: RemoteConversation,
): SessionUpdate {
  const patch: NonNullable<SessionUpdate["patch"]> = {
    title: after.title,
    status: after.status,
    updatedAt: after.updatedAt,
    streaming: textPatch(before.streaming, after.streaming),
    thinking: textPatch(before.thinking, after.thinking),
  };
  if (before.messages !== after.messages) {
    let from = 0;
    while (
      from < before.messages.length &&
      from < after.messages.length &&
      JSON.stringify(before.messages[from]) === JSON.stringify(after.messages[from])
    )
      from++;
    if (from !== before.messages.length || from !== after.messages.length)
      patch.messages = { from, values: after.messages.slice(from) };
  }
  const event: SessionUpdate = {
    watchId,
    sessionId: after.sessionId,
    baseRevision: before.revision!,
    revision: after.revision!,
    patch,
  };
  if (Buffer.byteLength(JSON.stringify(event)) > 24 * 1024)
    return {
      watchId,
      sessionId: after.sessionId,
      baseRevision: before.revision!,
      revision: after.revision!,
      resync: true,
    };
  return event;
}
/** One selected live view, paused until its exact paginated baseline has been acknowledged. */
export class LiveConversations {
  private watch?: Watch;
  private epoch = 0;
  constructor(
    private ports: {
      context: () => Context | null;
      authorize: (sessionId: string) => Promise<void>;
      read: (id: string) => Promise<RemoteConversation>;
      send: (event: SessionUpdate) => void;
    },
  ) {}
  clear(): void {
    this.epoch++;
    clearTimeout(this.watch?.timer);
    this.watch = undefined;
  }
  isWatching(id: string): boolean {
    return this.watch?.sessionId === id && this.current(this.watch);
  }
  private current(w: Watch): boolean {
    const c = this.ports.context();
    return this.watch === w && c?.peer === w.context.peer && c.session === w.context.session;
  }
  async request(raw: unknown, peer: string): Promise<SessionWatchStatus | null> {
    const r = raw as SessionWatchRequest;
    if (
      !r ||
      !validId(r.watchId) ||
      !validId(r.sessionId) ||
      !["start", "ready", "stop"].includes(r.action)
    )
      return null;
    const fail = () => ({
      watchId: r.watchId,
      sessionId: r.sessionId,
      ok: false,
      error: "Live connection unavailable. Reconnect and try again.",
    });
    const c = this.ports.context();
    if (!c || c.peer !== peer) return fail();
    if (r.action === "start") {
      const epoch = this.epoch;
      await this.ports.authorize(r.sessionId);
      const current = this.ports.context();
      if (epoch !== this.epoch || current?.peer !== peer || current.session !== c.session)
        return fail();
      this.clear();
      this.watch = {
        id: r.watchId,
        sessionId: r.sessionId,
        context: c,
        ready: false,
        busy: false,
        dirty: false,
      };
    } else {
      const w = this.watch;
      if (!w || w.id !== r.watchId || w.sessionId !== r.sessionId || !this.current(w))
        return fail();
      if (r.action === "stop") this.clear();
      else {
        if (!w.baseline || !Number.isSafeInteger(r.revision) || r.revision !== w.baseline.revision)
          return fail();
        w.ready = true;
        this.changed(w.sessionId);
      }
    }
    return { watchId: r.watchId, sessionId: r.sessionId, ok: true };
  }
  capture(watchId: string | undefined, snapshot: RemoteConversation, context: Context): void {
    if (!watchId) return;
    const w = this.watch;
    if (
      !w ||
      w.id !== watchId ||
      w.sessionId !== snapshot.sessionId ||
      w.context.peer !== context.peer ||
      w.context.session !== context.session ||
      !this.current(w) ||
      !Number.isSafeInteger(snapshot.revision)
    )
      throw Error("Live baseline changed");
    w.ready = false;
    clearTimeout(w.timer);
    w.timer = undefined;
    w.baseline = snapshot;
    w.dirty = true;
  }
  changed(id: string): void {
    const w = this.watch;
    if (!w || id !== w.sessionId || !w.ready || !this.current(w)) return;
    w.dirty = true;
    if (!w.busy && !w.timer) w.timer = setTimeout(() => void this.flush(w), 100);
  }
  private async flush(w: Watch): Promise<void> {
    w.timer = undefined;
    if (!this.current(w) || !w.ready || !w.baseline) return;
    w.busy = true;
    w.dirty = false;
    try {
      const next = await this.ports.read(w.sessionId);
      if (!this.current(w) || !w.ready || !w.baseline) return;
      if (!Number.isSafeInteger(next.revision) || next.revision! < w.baseline.revision!)
        throw Error("Invalid revision");
      if (next.revision !== w.baseline.revision) {
        const update = conversationUpdate(w.id, w.baseline, next);
        this.ports.send(update);
        w.baseline = next;
        if (update.resync) w.ready = false;
      }
    } catch {
      if (this.current(w)) {
        this.ports.send({
          watchId: w.id,
          sessionId: w.sessionId,
          baseRevision: w.baseline?.revision ?? 0,
          revision: w.baseline?.revision ?? 0,
          resync: true,
        });
        w.ready = false;
      }
    } finally {
      w.busy = false;
      if (w.dirty && w.ready && this.current(w)) this.changed(w.sessionId);
    }
  }
}
