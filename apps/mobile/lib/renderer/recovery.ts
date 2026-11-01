export type RendererFault = "content-process-ended" | "render-process-ended" | "load-failed" | "ready-timeout";
/** Renderer-local lifetime. Never touches pairing, transport, the outbox or model requests. */
export class RendererRecovery {
  generation = 0;
  private attempts: number[] = [];
  private failedGeneration = -1;
  readonly events: { code: RendererFault; at: number }[] = [];
  constructor(private now: () => number = Date.now) {}
  fail(generation: number, code: RendererFault): boolean {
    if (generation !== this.generation || this.failedGeneration === generation) return false;
    this.failedGeneration = generation;
    const at = this.now();
    this.events.push({ code, at });
    if (this.events.length > 32) this.events.shift();
    this.attempts = this.attempts.filter(time => at - time < 60_000);
    if (this.attempts.length >= 2) return false;
    this.attempts.push(at);
    this.generation++;
    return true;
  }
  retry(): number {
    this.attempts = [];
    this.failedGeneration = -1;
    return ++this.generation;
  }
}
