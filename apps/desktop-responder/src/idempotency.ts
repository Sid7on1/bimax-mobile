import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface IdempotencyEntry<T = unknown> {
  status: "in-flight" | "done" | "unknown";
  result?: T;
  binding?: string;
  at: number;
}
export interface IdempotencyLogOptions {
  storagePath?: string;
  maxEntries?: number;
  ttlMs?: number;
}
export class OperationOutcomeUnknownError extends Error {
  constructor() {
    super(
      "Operation outcome is unknown after interruption; reconcile with the engine before retrying",
    );
  }
}

/** A write-ahead journal. Interrupted effects are never automatically replayed. */
export class IdempotencyLog {
  private entries = new Map<string, IdempotencyEntry>();
  private inFlightPromises = new Map<string, Promise<unknown>>();
  private persistence: Promise<void> = Promise.resolve();
  private storagePath?: string;
  private maxEntries: number;
  private ttlMs: number;
  constructor(opts: IdempotencyLogOptions = {}) {
    this.storagePath = opts.storagePath;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.ttlMs = opts.ttlMs ?? 8 * 24 * 3600_000;
  }
  static validateKey(key: string): void {
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 128 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw new Error("Invalid idempotency key");
  }
  async init(): Promise<void> {
    if (!this.storagePath) return;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.storagePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Corrupt operation journal");
      for (const [key, value] of Object.entries(parsed)) {
        IdempotencyLog.validateKey(key);
        const entry = value as IdempotencyEntry;
        if (
          !entry ||
          !["done", "in-flight", "unknown"].includes(entry.status) ||
          !Number.isFinite(entry.at)
        )
          throw new Error("Corrupt operation journal entry");
        this.entries.set(key, {
          ...entry,
          status: entry.status === "in-flight" ? "unknown" : entry.status,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.evict();
  }
  async execute<T>(
    key: string,
    fn: () => Promise<T>,
    onError?: (err: unknown) => T,
    binding?: string,
  ): Promise<{ result: T; wasDuplicate: boolean }> {
    IdempotencyLog.validateKey(key);
    this.evict();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.binding !== binding)
        throw new Error("Idempotency key reused for a different operation");
      if (existing.status === "done") return { result: existing.result as T, wasDuplicate: true };
      const task = this.inFlightPromises.get(key);
      if (task) return { result: (await task) as T, wasDuplicate: true };
      throw new OperationOutcomeUnknownError();
    }
    // Never evict protection for recent or in-flight effects to admit more work.
    if (this.entries.size >= this.maxEntries)
      throw new Error("Operation journal capacity exhausted");
    const entry: IdempotencyEntry = { status: "in-flight", binding, at: Date.now() };
    this.entries.set(key, entry);
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const task = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void task.catch(() => {});
    this.inFlightPromises.set(key, task);
    try {
      // This must complete successfully BEFORE any engine side effect.
      await this.persistNow();
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        if (!onError) {
          entry.status = "unknown";
          await this.persistNow();
          throw err;
        }
        result = onError(err);
      }
      entry.status = "done";
      entry.result = result;
      entry.at = Date.now();
      try {
        await this.persistNow();
      } catch (err) {
        entry.status = "unknown";
        delete entry.result;
        throw err;
      }
      resolve(result);
      return { result, wasDuplicate: false };
    } catch (err) {
      if (entry.status === "in-flight") entry.status = "unknown";
      reject(err);
      throw err;
    } finally {
      this.inFlightPromises.delete(key);
    }
  }
  get(key: string): IdempotencyEntry | undefined {
    this.evict();
    return this.entries.get(key);
  }
  get size(): number {
    return this.entries.size;
  }
  /** Local host only: supply a result verified against the engine's durable effect history.
   * Never delete unknown effects merely to free capacity or automatically execute them again.
   */
  async reconcileUnknown<T>(
    key: string,
    expectedBinding: string | undefined,
    verifiedResult: T,
  ): Promise<void> {
    IdempotencyLog.validateKey(key);
    const entry = this.entries.get(key);
    if (
      !entry ||
      entry.status !== "unknown" ||
      entry.binding !== expectedBinding ||
      this.inFlightPromises.has(key)
    )
      throw new Error("Unknown operation or binding mismatch");
    const before = { ...entry };
    entry.status = "done";
    entry.result = verifiedResult;
    entry.at = Date.now();
    try {
      await this.persistNow();
    } catch (err) {
      this.entries.set(key, before);
      throw err;
    }
  }
  async clear(): Promise<void> {
    if (this.inFlightPromises.size)
      throw new Error("Cannot clear journal while operations are in flight");
    this.entries.clear();
    await this.persistNow();
  }
  private evict(): void {
    for (const [key, entry] of this.entries) {
      // Unknown effects require explicit reconciliation, regardless of age.
      if (entry.status === "done" && Date.now() - entry.at > this.ttlMs) this.entries.delete(key);
    }
  }
  persistNow(): Promise<void> {
    if (!this.storagePath) return Promise.resolve();
    const file = this.storagePath;
    const write = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      const handle = await fs.open(temp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(Object.fromEntries(this.entries)), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
      const dir = await fs.open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    };
    const pending = this.persistence.then(write);
    this.persistence = pending.catch(() => {});
    return pending;
  }
}
