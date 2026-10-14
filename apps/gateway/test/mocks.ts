// test/mocks.ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../src/auth";

export class MockKV {
  public store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export interface MockUsageRow {
  id: number;
  user_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
  usage_missing: number;
}

export interface MockQuotaRow {
  user_id: string;
  monthly_tokens: number;
}

export class MockD1 {
  public usageRows: MockUsageRow[] = [];
  public quotaRows: Map<string, number> = new Map();
  public shouldThrow = false;
  private autoId = 1;

  prepare(query: string): D1PreparedStatement {
    return new MockPreparedStatement(this, query) as unknown as D1PreparedStatement;
  }

  insertUsage(
    userId: string,
    model: string,
    prompt: number,
    completion: number,
    createdAt: string,
    missing: number,
  ): void {
    this.usageRows.push({
      id: this.autoId++,
      user_id: userId,
      model,
      prompt_tokens: prompt,
      completion_tokens: completion,
      created_at: createdAt,
      usage_missing: missing,
    });
  }

  setQuota(userId: string, tokens: number): void {
    this.quotaRows.set(userId, tokens);
  }

  getMonthlyUsage(userId: string, sinceISO: string): number {
    return this.usageRows
      .filter((r) => r.user_id === userId && r.created_at >= sinceISO)
      .reduce((sum, r) => sum + r.prompt_tokens + r.completion_tokens, 0);
  }
}

export class MockPreparedStatement {
  private db: MockD1;
  private query: string;
  private params: unknown[] = [];

  constructor(db: MockD1, query: string) {
    this.db = db;
    this.query = query.trim();
  }

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    if (this.db.shouldThrow) {
      throw new Error("D1 query failure simulation");
    }

    const q = this.query.toUpperCase();

    if (q.startsWith("SELECT MONTHLY_TOKENS FROM QUOTAS")) {
      const userId = this.params[0] as string;
      const tokens = this.db.quotaRows.get(userId);
      if (tokens !== undefined) {
        return { monthly_tokens: tokens } as unknown as T;
      }
      return null;
    }

    if (q.includes("SUM(PROMPT_TOKENS + COMPLETION_TOKENS)")) {
      const userId = this.params[0] as string;
      const since = this.params[1] as string;
      const total = this.db.getMonthlyUsage(userId, since);
      return { total } as unknown as T;
    }

    return null;
  }

  async run(): Promise<{ success: boolean }> {
    if (this.db.shouldThrow) {
      throw new Error("D1 run failure simulation");
    }

    const q = this.query.toUpperCase();
    if (q.startsWith("INSERT INTO USAGE")) {
      const [userId, model, prompt, completion, createdAt, missing] = this.params;
      this.db.insertUsage(
        String(userId),
        String(model),
        Number(prompt),
        Number(completion),
        String(createdAt),
        Number(missing),
      );
      return { success: true };
    }
    return { success: true };
  }
}

export function createTestEnv(overrides: Partial<Env> = {}): {
  env: Env;
  mockD1: MockD1;
  mockKeysKV: MockKV;
  mockRatelimitKV: MockKV;
} {
  const mockD1 = new MockD1();
  const mockKeysKV = new MockKV();
  const mockRatelimitKV = new MockKV();

  const env: Env = {
    DB: mockD1 as unknown as D1Database,
    GATEWAY_KEYS: mockKeysKV as unknown as KVNamespace,
    GATEWAY_RATELIMIT: mockRatelimitKV as unknown as KVNamespace,
    ALLOWED_MODELS: "deepseek-chat,qwen-plus,qwen-turbo",
    DEFAULT_MONTHLY_TOKENS: "4000000",
    RATE_LIMIT_PER_MIN: "30",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    QWEN_API_KEY: "test-qwen-key",
    NVIDIA_API_KEY: "test-nvidia-key",
    ...overrides,
  };

  return { env, mockD1, mockKeysKV, mockRatelimitKV };
}
