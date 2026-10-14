// test/allowlist.test.ts
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { sanitizeRequestBody, fetchUpstream } from "../src/providers";
import { createTestEnv } from "./mocks";
import { sha256Hex } from "../src/auth";

describe("allowlist and sanitization module", () => {
  it("rejects disallowed models with 400 and never invokes upstream fetch", async () => {
    const { env, mockKeysKV } = createTestEnv({
      ALLOWED_MODELS: "deepseek-chat,qwen-plus",
    });

    const rawKey = "22".repeat(32);
    const hash = await sha256Hex(rawKey);
    await mockKeysKV.put(hash, "test_user");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o", // Not in allowlist
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("strips client-supplied base_url and api_key fields before forwarding", () => {
    const maliciousInput = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      base_url: "https://attacker.example.com",
      baseUrl: "https://attacker.example.com",
      api_key: "sk-stolen-key",
      apiKey: "sk-stolen-key",
      headers: { "X-Custom": "injected" },
      authorization: "Bearer stolen",
      temperature: 0.7,
      stream: true,
    };

    const sanitized = sanitizeRequestBody(maliciousInput);

    expect((sanitized as unknown as Record<string, unknown>).base_url).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).baseUrl).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).api_key).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).headers).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).authorization).toBeUndefined();

    // Legitimate options preserved
    expect(sanitized.model).toBe("deepseek-chat");
    expect(sanitized.temperature).toBe(0.7);
    expect(sanitized.stream).toBe(true);
    expect(sanitized.stream_options?.include_usage).toBe(true);
  });

  it("routes NIM model with slash to NVIDIA integrate URL with NVIDIA_API_KEY", async () => {
    const { env } = createTestEnv({
      ALLOWED_MODELS: "deepseek-chat,qwen-plus,qwen-turbo,meta/llama-3.1-8b-instruct",
      NVIDIA_API_KEY: "nvapi-test-secret-key-123",
      MOCK_UPSTREAM: undefined,
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "nim-1", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const reqPayload = {
      model: "meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "hi" }],
    };

    const res = await fetchUpstream(reqPayload, env);
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(calledInit.headers["Authorization"]).toBe("Bearer nvapi-test-secret-key-123");

    vi.unstubAllGlobals();
  });

  it("routes slash-less model to DeepSeek URL preserving prefix check ordering", async () => {
    const { env } = createTestEnv({
      ALLOWED_MODELS: "deepseek-chat,qwen-plus,qwen-turbo,meta/llama-3.1-8b-instruct",
      DEEPSEEK_API_KEY: "sk-deepseek-test-key",
      MOCK_UPSTREAM: undefined,
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ds-1", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const reqPayload = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello deepseek" }],
    };

    const res = await fetchUpstream(reqPayload, env);
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(calledInit.headers["Authorization"]).toBe("Bearer sk-deepseek-test-key");

    vi.unstubAllGlobals();
  });
});
