// test/happy-path.test.ts
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/auth";
import { createTestEnv } from "./mocks";

describe("happy path end-to-end", () => {
  it("processes a non-streaming chat request, meters D1 row, and updates /v1/usage", async () => {
    const { env, mockD1, mockKeysKV } = createTestEnv({
      DEFAULT_MONTHLY_TOKENS: "4000000",
    });

    const rawKey = "33".repeat(32); // 64 hex chars
    const keyHash = await sha256Hex(rawKey);
    const userId = "alice_happy_user";
    await mockKeysKV.put(keyHash, userId);

    // Mock upstream fetch response
    const mockUpstreamResponse = {
      id: "chatcmpl-test-123",
      object: "chat.completion",
      created: 1791980000,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi Alice!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockUpstreamResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchStub);

    // 1. Send chat completion request
    const chatReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    const chatRes = await worker.fetch(chatReq, env, {} as ExecutionContext);
    expect(chatRes.status).toBe(200);

    const chatData = (await chatRes.json()) as typeof mockUpstreamResponse;
    expect(chatData.choices[0]?.message.content).toBe("Hi Alice!");

    // 2. Assert mock D1 has exactly one usage row with 10 prompt and 5 completion tokens
    expect(mockD1.usageRows.length).toBe(1);
    const row = mockD1.usageRows[0];
    expect(row?.user_id).toBe(userId);
    expect(row?.model).toBe("deepseek-chat");
    expect(row?.prompt_tokens).toBe(10);
    expect(row?.completion_tokens).toBe(5);
    expect(row?.usage_missing).toBe(0);

    // 3. Assert GET /v1/usage reports tokensUsed: 15
    const usageReq = new Request("http://localhost/v1/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${rawKey}`,
      },
    });

    const usageRes = await worker.fetch(usageReq, env, {} as ExecutionContext);
    expect(usageRes.status).toBe(200);

    const usageData = (await usageRes.json()) as {
      tokensUsed: number;
      tokenBudget: number;
      resetAt: string;
    };
    expect(usageData.tokensUsed).toBe(15);
    expect(usageData.tokenBudget).toBe(4000000);
    expect(usageData.resetAt).toBeDefined();

    vi.unstubAllGlobals();
  });
});
