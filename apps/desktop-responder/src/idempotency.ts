import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface IdempotencyEntry<T = unknown> {
  status: "in-flight" | "done";
  result?: T;
  at: number;
}

export interface IdempotencyLogOptions {
  storagePath?: string;
  maxEntries?: number;
  ttlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class IdempotencyLog {
  private entries = new Map<string, IdempotencyEntry>();
  private inFlightPromises = new Map<string, Promise<unknown>>();
  private storagePath?: string;
  private maxEntries: number;
  private ttlMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IdempotencyLogOptions = {}) {
    this.storagePath = opts.storagePath;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Validates that an idempotency key is non-empty and <= 128 characters.
   */
  public static validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Idempotency key must be a non-empty string");
    }
    if (key.length > 128) {
      throw new Error("Idempotency key exceeds 128 characters");
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Invalid reserved idempotency key");
    }
  }

  /**
   * Initializes the idempotency log by loading persisted entries from disk if configured.
   */
  public async init(): Promise<void> {
    if (!this.storagePath) return;

    try {
      const data = await fs.readFile(this.storagePath, "utf-8");
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const now = Date.now();
        for (const [key, val] of Object.entries(obj)) {
          if (val && typeof val === "object" && !Array.isArray(val)) {
            const entry = val as Partial<IdempotencyEntry>;
            if (
              entry.status === "done" &&
              typeof entry.at === "number" &&
              now - entry.at <= this.ttlMs
            ) {
              this.entries.set(key, {
                status: "done",
                result: entry.result,
                at: entry.at,
              });
            }
          }
        }
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
    this.evict();
  }

  /**
   * Executes a task with idempotency protection.
   * - If already done: immediately returns the stored result without calling `fn`.
   * - If in-flight: awaits the existing task and returns its result without calling `fn`.
   * - If miss: executes `fn()`, stores the result, and returns it.
   */
  public async execute<T>(
    key: string,
    fn: () => Promise<T>,
    onError?: (err: unknown) => T,
  ): Promise<{ result: T; wasDuplicate: boolean }> {
    IdempotencyLog.validateKey(key);
    this.evict();

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.status === "done") {
        // Refresh LRU position
        this.entries.delete(key);
        this.entries.set(key, existing);
        return { result: existing.result as T, wasDuplicate: true };
      }

      if (existing.status === "in-flight") {
        const inFlight = this.inFlightPromises.get(key);
        if (inFlight) {
          const res = (await inFlight) as T;
          return { result: res, wasDuplicate: true };
        }
      }
    }

    // Miss: create in-flight entry
    const entry: IdempotencyEntry<T> = {
      status: "in-flight",
      at: Date.now(),
    };
    this.entries.set(key, entry as IdempotencyEntry);

    let resolvePromise!: (val: T) => void;
    let rejectPromise!: (err: unknown) => void;
    const taskPromise = new Promise<T>((res, rej) => {
      resolvePromise = res;
      rejectPromise = rej;
    });
    // Prevent unhandled rejection when no duplicate caller is awaiting taskPromise
    taskPromise.catch(() => {});
    this.inFlightPromises.set(key, taskPromise);

    this.enforceCapacity();

    try {
      const result = await fn();
      entry.status = "done";
      entry.result = result;
      entry.at = Date.now();

      // Refresh LRU position
      this.entries.delete(key);
      this.entries.set(key, entry as IdempotencyEntry);
      this.inFlightPromises.delete(key);

      resolvePromise(result);
      this.schedulePersist();
      return { result, wasDuplicate: false };
    } catch (err) {
      if (onError) {
        const result = onError(err);
        entry.status = "done";
        entry.result = result;
        entry.at = Date.now();

        // Refresh LRU position
        this.entries.delete(key);
        this.entries.set(key, entry as IdempotencyEntry);
        this.inFlightPromises.delete(key);

        resolvePromise(result);
        this.schedulePersist();
        return { result, wasDuplicate: false };
      }

      this.entries.delete(key);
      this.inFlightPromises.delete(key);
      rejectPromise(err);
      throw err;
    }
  }

  /**
   * Retrieves an entry if present and not expired.
   */
  public get(key: string): IdempotencyEntry | undefined {
    this.evict();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Returns current count of entries.
   */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * Clears all stored entries (e.g. on revocation or for tests).
   */
  public async clear(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.entries.clear();
    this.inFlightPromises.clear();
    if (this.storagePath) {
      try {
        await fs.unlink(this.storagePath);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  /**
   * Evicts expired entries.
   */
  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.at > this.ttlMs) {
        this.entries.delete(key);
        this.inFlightPromises.delete(key);
      }
    }
  }

  /**
   * Enforces LRU capacity limit.
   */
  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
        this.inFlightPromises.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private schedulePersist(): void {
    if (!this.storagePath) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistNow();
    }, 100);
  }

  public async persistNow(): Promise<void> {
    if (!this.storagePath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const obj: Record<string, IdempotencyEntry> = Object.create(null) as Record<
      string,
      IdempotencyEntry
    >;
    for (const [k, v] of this.entries.entries()) {
      if (v.status === "done") {
        obj[k] = v;
      }
    }
    try {
      await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
      await fs.writeFile(this.storagePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch {
      // Ignore write errors in background persist
    }
  }
}
