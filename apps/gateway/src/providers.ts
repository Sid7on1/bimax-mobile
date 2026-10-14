// src/providers.ts
import type { Env } from "./auth";

export const DEFAULT_ALLOWED_MODELS = "deepseek-chat,qwen-plus,qwen-turbo";

export const UPSTREAM_ENDPOINTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/chat/completions",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
};

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export function parseAllowedModels(envAllowed?: string): string[] {
  const raw = envAllowed || DEFAULT_ALLOWED_MODELS;
  return raw
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length > 0);
}

export function isModelAllowed(model: string, allowedModels: string[]): boolean {
  return allowedModels.includes(model.toLowerCase());
}

export interface UpstreamConfig {
  provider: "deepseek" | "qwen" | "nvidia";
  url: string;
  apiKey: string;
}

export function resolveUpstream(model: string, env: Env): UpstreamConfig {
  // NIM model ids always look like org/model (e.g. meta/llama-3.1-8b-instruct)
  // Check includes("/") FIRST before prefix checks so e.g. deepseek-ai/deepseek-r1 routes to NIM
  if (model.includes("/")) {
    const apiKey = env.NVIDIA_API_KEY || "";
    return {
      provider: "nvidia",
      url: UPSTREAM_ENDPOINTS.nvidia,
      apiKey,
    };
  }

  const lower = model.toLowerCase();
  if (lower.startsWith("deepseek")) {
    const apiKey = env.DEEPSEEK_API_KEY || "";
    return {
      provider: "deepseek",
      url: UPSTREAM_ENDPOINTS.deepseek,
      apiKey,
    };
  }

  if (lower.startsWith("qwen")) {
    const apiKey = env.QWEN_API_KEY || "";
    return {
      provider: "qwen",
      url: UPSTREAM_ENDPOINTS.qwen,
      apiKey,
    };
  }

  throw new Error(`Unsupported model provider for model: ${model}`);
}

/**
 * Sanitizes the request payload, stripping client-supplied URLs and keys,
 * and ensuring stream_options.include_usage is present when streaming.
 */
export function sanitizeRequestBody(body: Record<string, unknown>): ChatCompletionRequest {
  const {
    base_url: _b1,
    baseUrl: _b2,
    api_key: _k1,
    apiKey: _k2,
    headers: _h,
    authorization: _a,
    ...clean
  } = body;

  const req = clean as unknown as ChatCompletionRequest;

  if (req.stream) {
    req.stream_options = {
      ...(req.stream_options ?? {}),
      include_usage: true,
    };
  }

  return req;
}

/**
 * Mock upstream response generator for local testing and smoke tests.
 */
export function createMockUpstreamResponse(req: ChatCompletionRequest): Response {
  if (req.stream) {
    const encoder = new TextEncoder();
    const id = `chatcmpl-mock-${Date.now()}`;
    const chunks = [
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, delta: { content: " world!" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const jsonBody = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello world!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  return new Response(JSON.stringify(jsonBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Dispatches the chat completion request to the resolved upstream provider.
 */
export async function fetchUpstream(
  req: ChatCompletionRequest,
  env: Env,
): Promise<Response> {
  if (
    env.MOCK_UPSTREAM === "1" ||
    (typeof process !== "undefined" &&
      (process.env as Record<string, string | undefined>)?.MOCK_UPSTREAM === "1")
  ) {
    return createMockUpstreamResponse(req);
  }

  const upstream = resolveUpstream(req.model, env);
  if (!upstream.apiKey) {
    console.error(`[upstream] ${upstream.provider} failed: missing API key`);
    return new Response(
      JSON.stringify({
        error: {
          message: `Provider API key not configured for ${upstream.provider}`,
          type: "upstream_error",
          code: "missing_provider_key",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(req),
    });
  } catch (err) {
    console.error(`[upstream] ${upstream.provider} failed: network error`);
    return new Response(
      JSON.stringify({
        error: {
          message: "Upstream provider network error",
          type: "upstream_error",
          code: "bad_gateway",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!upstreamRes.ok) {
    console.error(`[upstream] ${upstream.provider} failed: HTTP ${upstreamRes.status}`);
    return new Response(
      JSON.stringify({
        error: {
          message: "Upstream provider error",
          type: "upstream_error",
          code: "bad_gateway",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  return upstreamRes;
}
