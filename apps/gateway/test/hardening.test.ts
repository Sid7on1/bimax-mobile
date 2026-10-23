import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createTestEnv } from "./mocks";
import { checkRateLimit } from "../src/ratelimit";
import { checkQuota } from "../src/quota";
import { reserve, settle, reconcileUsage } from "../src/admission";
import { verifyAuth, sha256Hex } from "../src/auth";
import { mintRelayTicket } from "../src/relay-ticket";
import worker from "../src/index";
const input = {
  model: "deepseek-chat",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 100,
};
afterEach(() => vi.unstubAllGlobals());
describe("production admission regressions", () => {
  it("serializes 100 concurrent requests to exactly 30 admissions", async () => {
    const { env } = createTestEnv();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => checkRateLimit("same-user", env)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
  });
  it("does not grant default allocation to unprovisioned or suspended accounts", async () => {
    const { env, mockD1 } = createTestEnv();
    expect((await checkQuota(env.DB, "unknown", env)).allowed).toBe(false);
    mockD1.provision("suspended");
    mockD1.sqlite
      .prepare("UPDATE entitlements SET status='suspended' WHERE user_id='suspended'")
      .run();
    expect(await reserve(env, "suspended", input)).toBeNull();
  });
  it("bounds all concurrent reservations by tokens and currency, including global spend", async () => {
    const { env, mockD1 } = createTestEnv({ GLOBAL_MONTHLY_MICROUSD: "5000" });
    mockD1.setQuota("a", 6000);
    mockD1.setQuota("b", 6000);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => reserve(env, i % 2 ? "a" : "b", input)),
    );
    expect(results.some(Boolean)).toBe(true);
    expect(results.some((result) => result === null)).toBe(true);
    const rows = mockD1.sqlite
      .prepare("SELECT SUM(microusd) AS cost,SUM(tokens) AS tokens FROM reservations")
      .get() as { cost: number; tokens: number };
    expect(rows.cost).toBeLessThanOrEqual(5000);
    expect(rows.tokens).toBeLessThanOrEqual(12000);
  });
  it("finalizes unknown usage conservatively, reconciles verified usage, and fails closed on writes", async () => {
    const { env, mockD1 } = createTestEnv();
    mockD1.provision("user");
    const reservation = (await reserve(env, "user", input))!;
    await settle(env, reservation, { promptTokens: 0, completionTokens: 0, usageMissing: true });
    expect(mockD1.usageRows).toHaveLength(1);
    expect(mockD1.usageRows[0].usage_missing).toBe(1);
    mockD1.shouldThrow = true;
    await expect(
      settle(env, reservation, { promptTokens: 10, completionTokens: 5, usageMissing: false }),
    ).rejects.toThrow();
    mockD1.shouldThrow = false;
    expect((mockD1.sqlite.prepare("SELECT status FROM reservations").get() as any).status).toBe(
      "settled",
    );
    await settle(env, reservation, { promptTokens: 10, completionTokens: 5, usageMissing: false });
    await settle(env, reservation, { promptTokens: 10, completionTokens: 5, usageMissing: false });
    expect(mockD1.usageRows).toHaveLength(1);
    await reconcileUsage(env, reservation.id, 10, 5, { providerRequestId: "provider-1", operator: "test-operator", reason: "Provider billing export", evidenceSha256: "a".repeat(64) });
    expect(mockD1.usageRows[0].cost_microusd).toBe(20);
  });
  it("rejects validly signed JWTs with wrong issuer/audience or missing expiration", async () => {
    const key = await generateKeyPair("RS256");
    const jwk = await exportJWK(key.publicKey);
    const { env } = createTestEnv({ TEST_JWKS: { keys: [jwk] } });
    for (const claims of [
      { iss: "wrong", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 60 },
      {
        iss: "https://test-project.supabase.co/auth/v1",
        aud: "wrong",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      { iss: "https://test-project.supabase.co/auth/v1", aud: "authenticated" },
    ]) {
      const jwt = await new SignJWT({ ...claims, sub: "user", iat: Math.floor(Date.now() / 1000) })
        .setProtectedHeader({ alg: "RS256" })
        .sign(key.privateKey);
      expect(
        await verifyAuth(
          new Request("https://test.invalid", { headers: { Authorization: `Bearer ${jwt}` } }),
          env,
        ),
      ).toBeNull();
    }
  });
  it("rejects cross-account room tickets", async () => {
    const { env, mockD1 } = createTestEnv({
      RELAY_TICKET_SECRET: "test-only-room-secret-at-least-32-bytes",
    });
    mockD1.provision("a");
    mockD1.provision("b");
    expect(
      await mintRelayTicket(env, "a", {
        roomId: "desktop-a",
        deviceId: "desktop-a",
        role: "desktop",
        helloPubkey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      }),
    ).toBeTruthy();
    await expect(
      mintRelayTicket(env, "b", {
        roomId: "desktop-a",
        deviceId: "phone-b",
        role: "mobile",
        helloPubkey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      }),
    ).rejects.toThrow("not owned");
    expect(
      await mintRelayTicket(env, "a", {
        roomId: "desktop-a",
        deviceId: "phone-a",
        role: "mobile",
        helloPubkey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      }),
    ).toBeTruthy();
  });
  it("returns 400 for null JSON without dispatching to the provider", async () => {
    const { env, mockKeysKV } = createTestEnv();
    const key = "ab".repeat(32);
    await mockKeysKV.put(await sha256Hex(key), "user");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await worker.fetch(
      new Request("https://test.invalid/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: "null",
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("aborts upstream generation when the response consumer cancels", async () => {
    const { env, mockKeysKV, mockD1 } = createTestEnv();
    const key = "cd".repeat(32);
    await mockKeysKV.put(await sha256Hex(key), "user");
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        upstreamSignal = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
            },
          }),
        );
      }),
    );
    const response = await worker.fetch(
      new Request("https://test.invalid/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...input, stream: true }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    await response.body!.cancel();
    expect(upstreamSignal!.aborted).toBe(true);
    expect(mockD1.usageRows).toHaveLength(1);
    expect(mockD1.usageRows[0].usage_missing).toBe(1);
    expect((mockD1.sqlite.prepare("SELECT status FROM reservations").get() as any).status).toBe(
      "settled",
    );
  });
});
