import { transcriptOperation, type WireState } from "./bridge";
/** At most one bridge write per display frame, always using the latest complete state. */
export class TranscriptDelivery {
  private pending: WireState | undefined;
  private sent: WireState | undefined;
  private frame: number | undefined;
  private disposed = false;
  constructor(
    private send: (operation: NonNullable<ReturnType<typeof transcriptOperation>>) => void,
    private schedule: (run: () => void) => number = (run) => requestAnimationFrame(run),
    private cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}
  push(state: WireState) {
    if (this.disposed) return;
    this.pending = state;
    if (this.frame !== undefined) return;
    this.frame = this.schedule(() => {
      this.frame = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (this.disposed || !next) return;
      const operation = transcriptOperation(this.sent, next);
      if (operation) {
        this.send(operation);
        this.sent = next;
      }
    });
  }
  reset() {
    if (this.frame !== undefined) this.cancel(this.frame);
    this.frame = undefined;
    this.pending = undefined;
    this.sent = undefined;
  }
  dispose() {
    this.reset();
    this.disposed = true;
  }
}
