import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestEnv } from "./mocks";
import { reserve, settle, reconcileUsage, finalizeExpired } from "../src/admission";
import { mintRelayTicket, removeRelayRoom } from "../src/relay-ticket";
import { validateChat } from "../src/validation";
import { sha256Hex } from "../src/auth";
import worker from "../src/index";
import { sanitizeRequestBody } from "../src/providers";

const req = {
  model: "deepseek-chat",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 100,
};
const helloPubkey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
afterEach(() => vi.unstubAllGlobals());
describe("Round 3 gateway lifecycle", () => {
  it("caps legacy sanitizer callers and strips completion multipliers and alternate output limits", () => {
    expect(() => sanitizeRequestBody({ ...req, max_tokens: 128000, n: 10 })).toThrow(/max_tokens/);
    const clean = sanitizeRequestBody({ ...req, n: 10, max_completion_tokens: 128000 });
    expect(clean.n).toBeUndefined();
    expect(clean.max_completion_tokens).toBeUndefined();
    expect(clean.max_tokens).toBe(100);
  });
  it("enforces spending limits through the actual HTTP endpoint before provider dispatch", async () => {
    const { env, mockD1, mockKeysKV } = createTestEnv();
    const token = "12".repeat(32);
    await mockKeysKV.put(await sha256Hex(token), "spending-test");
    const upstream = vi.fn(async (_url: unknown, _init: RequestInit) =>
      Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    vi.stubGlobal("fetch", upstream);
    const request = (extra: object) =>
      worker.fetch(
        new Request("https://gateway.test/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...req, ...extra }),
        }),
        env,
      );
    expect((await request({ max_tokens: 128000, n: 10 })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(mockD1.usageRows).toHaveLength(0);
    expect((await request({ n: 10, max_completion_tokens: 128000 })).status).toBe(200);
    const sent = JSON.parse(String(upstream.mock.calls[0][1].body));
    expect(sent.max_tokens).toBe(100);
    expect(sent.n).toBeUndefined();
    expect(sent.max_completion_tokens).toBeUndefined();
  });
  it("normalizes model casing and rejects malformed tool structures before reserving", () => {
    const { env } = createTestEnv();
    expect(validateChat({ ...req, model: " DeepSeek-Chat " }, env).model).toBe("deepseek-chat");
    for (const extra of [
      { tools: [null] },
      { tool_choice: 123 },
      { tools: [{ type: "function", function: { name: "bad name" } }] },
      { tools: [], tool_choice: "required" },
      { parallel_tool_calls: "yes" },
    ])
      expect(() => validateChat({ ...req, ...extra }, env)).toThrow();
    expect(
      validateChat(
        {
          ...req,
          tools: [
            { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
          ],
          tool_choice: { type: "function", function: { name: "lookup" } },
        },
        env,
      ),
    ).toBeTruthy();
  });
  it("releases a definitive rejected request and its concurrency slot exactly once", async () => {
    const { env, mockD1 } = createTestEnv();
    mockD1.provision("user");
    const reservation = (await reserve(env, "user", req))!;
    const rejected = { promptTokens: 0, completionTokens: 0, usageMissing: false, rejected: true };
    await settle(env, reservation, rejected);
    await settle(env, reservation, rejected);
    expect(mockD1.usageRows).toHaveLength(1);
    expect(
      mockD1.sqlite
        .prepare("SELECT tokens,microusd FROM budget_totals WHERE user_id='user'")
        .get() as any,
    ).toEqual({ tokens: 0, microusd: 0 });
    expect(await reserve(env, "user", req)).toBeTruthy();
  });
  it("finalizes unknown usage, recovers terminated requests, and reconciles totals atomically", async () => {
    const { env, mockD1 } = createTestEnv();
    mockD1.provision("user");
    const first = (await reserve(env, "user", req))!;
    await settle(env, first, { promptTokens: 0, completionTokens: 0, usageMissing: true });
    const second = (await reserve(env, "user", req))!;
    mockD1.sqlite
      .prepare("UPDATE reservations SET created_at=? WHERE request_id=?")
      .run(new Date(Date.now() - 240000).toISOString(), second.id);
    await finalizeExpired(env);
    expect(
      mockD1.sqlite.prepare("SELECT * FROM reservations WHERE status='pending'").all(),
    ).toHaveLength(0);
    await reconcileUsage(env, first.id, 10, 5, { providerRequestId: "provider-1", operator: "test-operator", reason: "Provider billing export", evidenceSha256: "a".repeat(64) });
    await reconcileUsage(env, first.id, 10, 5, { providerRequestId: "provider-1", operator: "test-operator", reason: "Provider billing export", evidenceSha256: "a".repeat(64) });
    expect(
      mockD1.sqlite
        .prepare("SELECT tokens,microusd FROM budget_totals WHERE user_id='user'")
        .get() as any,
    ).toEqual({ tokens: second.tokens + 15, microusd: second.cost + 20 });
    expect(mockD1.usageRows.filter((r) => r.usage_missing)).toHaveLength(1);
  });
  it("records real overages without globally pausing unrelated tenants", async () => {
    const { env, mockD1 } = createTestEnv();
    mockD1.provision("user");
    const reservation = (await reserve(env, "user", req))!;
    await settle(env, reservation, {
      promptTokens: reservation.tokens + 1,
      completionTokens: 1,
      usageMissing: false,
    });
    expect((mockD1.sqlite.prepare("SELECT paused FROM billing_control").get() as any).paused).toBe(
      0,
    );
    expect(mockD1.usageRows[0].prompt_tokens).toBe(reservation.tokens + 1);
  });
  it("rejects malformed tools before provider dispatch and releases upstream 400s", async () => {
    const { env, mockD1, mockKeysKV } = createTestEnv();
    const token = "ef".repeat(32);
    await mockKeysKV.put(await sha256Hex(token), "user");
    const upstream = vi.fn(async () => new Response("private provider error", { status: 400 }));
    vi.stubGlobal("fetch", upstream);
    const request = (extra: object) =>
      worker.fetch(
        new Request("https://gateway.test/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...req, ...extra }),
        }),
        env,
      );
    expect((await request({ tools: [null] })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect((await request({})).status).toBe(502);
    expect(mockD1.usageRows[0].cost_microusd).toBe(0);
    expect(
      mockD1.sqlite.prepare("SELECT * FROM reservations WHERE status='pending'").all(),
    ).toHaveLength(0);
  });
  it("permits explicit room replacement while preserving ownership and key binding", async () => {
    const { env, mockD1 } = createTestEnv({
      RELAY_TICKET_SECRET: "test-only-room-secret-at-least-32-bytes",
    });
    mockD1.provision("a");
    mockD1.provision("b");
    const ticket = (user: string, id: string, key = helloPubkey) =>
      mintRelayTicket(env, user, { roomId: id, deviceId: id, role: "desktop", helloPubkey: key });
    for (let i = 0; i < 5; i++) await ticket("a", `desk-${i}`);
    await expect(ticket("a", "replacement")).rejects.toThrow();
    await removeRelayRoom(env, "b", "desk-0");
    await expect(ticket("a", "replacement")).rejects.toThrow();
    await expect(
      ticket("a", "desk-0", "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="),
    ).rejects.toThrow("key changed");
    await removeRelayRoom(env, "a", "desk-0");
    expect(await ticket("a", "replacement")).toBeTruthy();
    expect(mockD1.sqlite.prepare("SELECT * FROM relay_rooms WHERE user_id='a'").all()).toHaveLength(
      5,
    );
  });
});
