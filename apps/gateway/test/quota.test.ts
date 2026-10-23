// test/quota.test.ts
import { describe, it, expect, vi } from "vitest";
import { checkQuota } from "../src/quota";
import { createTestEnv } from "./mocks";
import worker from "../src/index";
import { sha256Hex } from "../src/auth";

describe("quota module", () => {
  it("allows requests when used tokens are below budget", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const now = new Date("2026-10-14T12:00:00Z");

    mockD1.insertUsage("user_1", "deepseek-chat", 200, 300, "2026-10-10T00:00:00Z", 0);

    const status = await checkQuota(env.DB, "user_1", env, now);
    expect(status.allowed).toBe(true);
    expect(status.tokensUsed).toBe(500);
    expect(status.tokenBudget).toBe(1000);
    expect(status.error).toBe("ok");
    expect(status.resetAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("blocks requests when used tokens meet or exceed budget", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const now = new Date("2026-10-14T12:00:00Z");

    mockD1.insertUsage("user_1", "deepseek-chat", 500, 500, "2026-10-10T00:00:00Z", 0);

    const status = await checkQuota(env.DB, "user_1", env, now);
    expect(status.allowed).toBe(false);
    expect(status.tokensUsed).toBe(1000);
    expect(status.tokenBudget).toBe(1000);
    expect(status.error).toBe("exceeded");
  });

  it("fails CLOSED with error 'unavailable' when D1 throws", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const now = new Date("2026-10-14T12:00:00Z");

    mockD1.shouldThrow = true;

    const status = await checkQuota(env.DB, "user_error", env, now);
    expect(status.allowed).toBe(false);
    expect(status.tokensUsed).toBe(0);
    expect(status.error).toBe("unavailable");
  });

  it("returns 429 quota_unavailable and never calls upstream fetch when D1 fails", async () => {
    const { env, mockD1, mockKeysKV } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const rawKey = "44".repeat(32);
    const hash = await sha256Hex(rawKey);
    await mockKeysKV.put(hash, "d1_outage_user");

    mockD1.shouldThrow = true;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(503);

    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("admission_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("respects custom user quota from quotas table", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const now = new Date("2026-10-14T12:00:00Z");

    mockD1.setQuota("vip_user", 5000);
    mockD1.insertUsage("vip_user", "deepseek-chat", 800, 700, "2026-10-10T00:00:00Z", 0);

    const status = await checkQuota(env.DB, "vip_user", env, now);
    expect(status.allowed).toBe(true);
    expect(status.tokensUsed).toBe(1500);
    expect(status.tokenBudget).toBe(5000);
    expect(status.error).toBe("ok");
  });

  it("resets quota on month boundary (Dec 31 to Jan 1)", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });

    // Usage from December
    mockD1.insertUsage("user_1", "deepseek-chat", 600, 600, "2026-12-31T23:59:59Z", 0);

    // Check on Dec 31
    const decDate = new Date("2026-12-31T23:59:59Z");
    const decStatus = await checkQuota(env.DB, "user_1", env, decDate);
    expect(decStatus.allowed).toBe(false);
    expect(decStatus.tokensUsed).toBe(1200);
    expect(decStatus.error).toBe("exceeded");

    // Check on Jan 1: previous month usage does not count against new month
    const janDate = new Date("2027-01-01T00:00:01Z");
    const janStatus = await checkQuota(env.DB, "user_1", env, janDate);
    expect(janStatus.allowed).toBe(true);
    expect(janStatus.tokensUsed).toBe(0);
    expect(janStatus.resetAt).toBe("2027-02-01T00:00:00.000Z");
    expect(janStatus.error).toBe("ok");
  });

  it("isolates quotas per user", async () => {
    const { env, mockD1 } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "1000" });
    const now = new Date("2026-10-14T12:00:00Z");

    mockD1.insertUsage("heavy_user", "deepseek-chat", 600, 500, "2026-10-05T00:00:00Z", 0);
    mockD1.insertUsage("light_user", "deepseek-chat", 50, 50, "2026-10-05T00:00:00Z", 0);

    const heavyStatus = await checkQuota(env.DB, "heavy_user", env, now);
    const lightStatus = await checkQuota(env.DB, "light_user", env, now);

    expect(heavyStatus.allowed).toBe(false);
    expect(heavyStatus.error).toBe("exceeded");
    expect(lightStatus.allowed).toBe(true);
    expect(lightStatus.error).toBe("ok");
  });

  it("returns 429 quota_exceeded and never calls upstream fetch when quota is exceeded", async () => {
    const { env, mockD1, mockKeysKV } = createTestEnv({ DEFAULT_MONTHLY_TOKENS: "500" });
    const rawKey = "11".repeat(32);
    const hash = await sha256Hex(rawKey);
    await mockKeysKV.put(hash, "budget_user");

    // Pre-fill usage to exceed budget
    mockD1.insertUsage("budget_user", "deepseek-chat", 300, 300, new Date().toISOString(), 0);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(429);

    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("quota_exceeded");
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
