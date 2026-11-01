import { URL } from "node:url";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { Env } from "../src/auth";
export class MockKV {
  store = new Map<string, { value: string; expiresAt?: number }>();
  constructor(private onPut?: (value: string) => void) {}
  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    return item && (!item.expiresAt || Date.now() < item.expiresAt) ? item.value : null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
    this.onPut?.(value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
export class MockD1 {
  readonly sqlite = new Database(":memory:");
  shouldThrow = false;
  constructor(private defaultTokens = 4_000_000) {
    this.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  }
  get usageRows(): any[] {
    return this.sqlite.prepare("SELECT * FROM usage").all();
  }
  prepare(query: string): any {
    const db = this;
    let values: unknown[] = [];
    const execute = () => {
      if (db.shouldThrow) throw new Error("D1 query failure simulation");
      return db.sqlite.prepare(query.replace(/\?\d+/g, "?"));
    };
    const bindings = () =>
      query.includes("?1")
        ? [...query.matchAll(/\?(\d+)/g)].map((match) => values[Number(match[1]) - 1])
        : values;
    return {
      bind(...args: unknown[]) {
        values = args;
        return this;
      },
      async first(column?: string) {
        const row = execute().get(...bindings()) as Record<string, unknown> | undefined;
        return column ? (row?.[column] ?? null) : (row ?? null);
      },
      async run() {
        const info = execute().run(...bindings());
        return { success: true, meta: { changes: info.changes } };
      },
      async all() {
        return { success: true, results: execute().all(...bindings()) };
      },
      sync() {
        const statement = execute();
        return statement.reader ? statement.all(...bindings()) : statement.run(...bindings());
      },
    };
  }
  async batch(statements: any[]): Promise<any[]> {
    return this.sqlite.transaction(() => statements.map((statement) => statement.sync()))();
  }
  provision(user: string): void {
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO entitlements VALUES (?,'active','2099-01-01T00:00:00.000Z',1000000000)",
      )
      .run(user);
  }
  insertUsage(
    user: string,
    model: string,
    prompt: number,
    completion: number,
    createdAt: string,
    missing: number,
  ): void {
    this.provision(user);
    this.sqlite
      .prepare(
        "INSERT INTO usage(user_id,model,prompt_tokens,completion_tokens,created_at,usage_missing) VALUES (?,?,?,?,?,?)",
      )
      .run(user, model, prompt, completion, createdAt, missing);
  }
  setQuota(user: string, tokens: number): void {
    this.provision(user);
    this.sqlite.prepare("INSERT OR REPLACE INTO quotas VALUES (?,?)").run(user, tokens);
  }
  getMonthlyUsage(user: string, since: string): number {
    return (
      this.sqlite
        .prepare(
          "SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) as total FROM usage WHERE user_id=? AND created_at>=?",
        )
        .get(user, since) as { total: number }
    ).total;
  }
}
export function createTestEnv(overrides: Partial<Env> = {}) {
  const mockD1 = new MockD1(Number(overrides.DEFAULT_MONTHLY_TOKENS ?? 4000000));
  // Provisioning a test API credential explicitly provisions its test entitlement.
  const mockKeysKV = new MockKV((user) => mockD1.provision(user));
  const mockRatelimitKV = new MockKV();
  const env: Env = {
    DB: mockD1 as unknown as D1Database,
    GATEWAY_KEYS: mockKeysKV as unknown as KVNamespace,
    GATEWAY_RATELIMIT: mockRatelimitKV as unknown as KVNamespace,
    SUPABASE_URL: "https://test-project.supabase.co",
    ALLOWED_MODELS: "deepseek-chat,qwen-plus,qwen-turbo",
    DEFAULT_MONTHLY_TOKENS: "4000000",
    RATE_LIMIT_PER_MIN: "30",
    MODEL_PRICES_JSON: JSON.stringify(
      Object.fromEntries(
        ["deepseek-chat", "qwen-plus", "qwen-turbo", "openai/gpt-oss-20b"].map((model) => [
          model,
          { input: 1000000, output: 2000000 },
        ]),
      ),
    ),
    GLOBAL_MONTHLY_MICROUSD: "10000000000",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    QWEN_API_KEY: "test-qwen-key",
    NVIDIA_API_KEY: "test-nvidia-key",
    ...overrides,
  };
  return { env, mockD1, mockKeysKV, mockRatelimitKV };
}
