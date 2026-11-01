import type {
  RemoteConversation,
  SessionUpdate,
  SessionWatchRequest,
  SessionWatchStatus,
} from "@bimax/protocol";
import { randomId } from "../crypto/keys";
import { HistoryClient, parseRemoteConversation } from "./history-client";
type Send = (kind: "session_watch" | "session_history_request", body: unknown) => void;
interface Watch {
  id: string;
  sessionId: string;
  phase: "waiting" | "loading" | "live";
  controller: AbortController;
  send: Send;
  onUpdate: (s: RemoteConversation) => void;
  onError: (e: Error) => void;
  snapshot?: RemoteConversation;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
}
export function applyConversationUpdate(
  before: RemoteConversation,
  event: SessionUpdate,
): RemoteConversation {
  if (
    event.sessionId !== before.sessionId ||
    event.baseRevision !== before.revision ||
    !Number.isSafeInteger(event.revision) ||
    event.revision <= event.baseRevision ||
    !event.patch
  )
    throw Error("Conversation changed; resynchronizing");
  const p = event.patch;
  const text = (previous: string, patch: typeof p.streaming) => {
    if (!patch) return previous;
    if ("append" in patch && typeof patch.append === "string") return previous + patch.append;
    if ("set" in patch && typeof patch.set === "string") return patch.set;
    throw Error("Invalid text update");
  };
  let messages = before.messages;
  if (p.messages) {
    const { from, values } = p.messages;
    if (
      !Number.isSafeInteger(from) ||
      from < 0 ||
      from > messages.length ||
      !Array.isArray(values) ||
      values.length > 4000
    )
      throw Error("Invalid message update");
    messages = [...messages.slice(0, from), ...values];
  }
  const next = {
    ...before,
    messages,
    title: p.title,
    status: p.status,
    updatedAt: p.updatedAt,
    revision: event.revision,
    streaming: text(before.streaming, p.streaming),
    thinking: text(before.thinking, p.thinking),
  };
  if (next.streaming.length + next.thinking.length > 3 * 1024 * 1024)
    throw Error("Live response exceeds phone limit");
  return parseRemoteConversation(next, before.sessionId);
}
/** Snapshot first, then ordered pushed revisions. A gap replaces the subscription and baseline. */
export class LiveConversationClient {
  private current?: Watch;
  constructor(
    private history: HistoryClient,
    private makeId = () => randomId("watch"),
  ) {}
  watch(
    sessionId: string,
    send: Send,
    onUpdate: Watch["onUpdate"],
    onError: Watch["onError"],
    signal?: AbortSignal,
  ): () => void {
    this.clear();
    const w: Watch = {
      id: this.makeId(),
      sessionId,
      phase: "waiting",
      controller: new AbortController(),
      send,
      onUpdate,
      onError,
      removeAbort: () => {},
    };
    this.current = w;
    const abort = () => this.close(w);
    signal?.addEventListener("abort", abort, { once: true });
    w.removeAbort = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) {
      this.close(w);
      return () => {};
    }
    this.start(w);
    return () => this.close(w);
  }
  clear(): void {
    if (this.current) this.close(this.current);
  }
  private close(w: Watch): void {
    clearTimeout(w.timer);
    w.controller.abort();
    w.removeAbort();
    if (this.current !== w) return;
    this.current = undefined;
    try {
      w.send("session_watch", { action: "stop", watchId: w.id, sessionId: w.sessionId });
    } catch {}
  }
  private fail(w: Watch, message: string): void {
    if (this.current !== w) return;
    this.close(w);
    w.onError(new Error(message));
  }
  private start(w: Watch): void {
    if (this.current !== w) return;
    w.phase = "waiting";
    w.timer = setTimeout(
      () => this.fail(w, "Live chat did not connect. Update Bimax on the Mac and reconnect."),
      10000,
    );
    try {
      w.send("session_watch", {
        action: "start",
        watchId: w.id,
        sessionId: w.sessionId,
      } satisfies SessionWatchRequest);
    } catch {
      this.fail(w, "Mac connection unavailable");
    }
  }
  status(value: unknown): void {
    const r = value as SessionWatchStatus,
      w = this.current;
    if (!w || !r || r.watchId !== w.id || r.sessionId !== w.sessionId) return;
    if (r.ok !== true) {
      this.fail(w, "Live chat could not connect. Reconnect and try again.");
      return;
    }
    if (w.phase !== "waiting") return;
    clearTimeout(w.timer);
    w.phase = "loading";
    const controller = w.controller,
      id = w.id;
    void this.history
      .read(
        w.sessionId,
        (request) => w.send("session_history_request", request),
        controller.signal,
        id,
      )
      .then((snapshot) => {
        if (this.current !== w || controller !== w.controller || controller.signal.aborted) return;
        if (!Number.isSafeInteger(snapshot.revision))
          throw Error("This Mac build does not support live conversations");
        w.snapshot = snapshot;
        w.phase = "live";
        w.onUpdate(snapshot);
        w.send("session_watch", {
          action: "ready",
          watchId: w.id,
          sessionId: w.sessionId,
          revision: snapshot.revision,
        } satisfies SessionWatchRequest);
      })
      .catch((e) => {
        if (this.current === w && controller === w.controller && !controller.signal.aborted)
          this.fail(w, e instanceof Error ? e.message : "History could not load");
      });
  }
  update(value: unknown): void {
    const e = value as SessionUpdate,
      w = this.current;
    if (
      !w ||
      !e ||
      e.watchId !== w.id ||
      e.sessionId !== w.sessionId ||
      w.phase !== "live" ||
      !w.snapshot
    )
      return;
    if (!e.resync && Number.isSafeInteger(e.revision) && e.revision <= w.snapshot.revision!) return;
    try {
      if (e.resync) throw Error("resync");
      w.snapshot = applyConversationUpdate(w.snapshot, e);
      w.onUpdate(w.snapshot);
    } catch {
      w.controller.abort();
      try {
        w.send("session_watch", { action: "stop", watchId: w.id, sessionId: w.sessionId });
      } catch {}
      w.id = this.makeId();
      w.phase = "waiting";
      w.controller = new AbortController();
      clearTimeout(w.timer);
      w.timer = setTimeout(() => this.start(w), 250);
    }
  }
}
