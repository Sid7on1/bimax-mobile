// src/index.ts
import { verifyAuth, type Env } from "./auth";
import {
  parseAllowedModels,
  isModelAllowed,
  sanitizeRequestBody,
  fetchUpstream,
} from "./providers";
import { checkQuota } from "./quota";
import { checkRateLimit } from "./ratelimit";
import { recordUsage } from "./metering";

export { Env };

/**
 * Builds OpenAI-compatible error response.
 */
export function errorResponse(
  message: string,
  status: number,
  type = "invalid_request_error",
  code = "bad_request",
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    },
  );
}

/**
 * CORS handling: reflect request Origin for web/Expo clients with scheme validation.
 * PROMPT-18 note: PROMPT-18 will pin the production Origin allowlist.
 */
export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const isValidOrigin =
    origin && /^(https?:\/\/|exp:\/\/|exps:\/\/)/.test(origin);
  return {
    "Access-Control-Allow-Origin": isValidOrigin ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Reads an SSE byte stream, parses chunks, and extracts the final usage object.
 * Processes trailing buffer data on completion in case the stream was not newline-terminated.
 */
export async function extractUsageFromSSE(
  stream: ReadableStream<Uint8Array>,
): Promise<{ promptTokens: number; completionTokens: number; usageMissing: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let foundUsage = false;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.usage) {
            const u = parsed.usage as Record<string, unknown>;
            promptTokens = Number(u.prompt_tokens) || 0;
            completionTokens = Number(u.completion_tokens) || 0;
            foundUsage = true;
          }
        } catch {
          // Ignore non-JSON data lines
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
      }
    }

    // Process trailing buffer after EOF in case the final chunk lacked trailing newlines
    if (buffer.trim()) {
      processLine(buffer);
    }
  } catch (err) {
    console.warn("[metering] Error while reading SSE stream for usage:", err);
  }

  return {
    promptTokens,
    completionTokens,
    usageMissing: !foundUsage,
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const corsHeaders = getCorsHeaders(request);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    // 2. Health check endpoint (No auth)
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // 3. Usage check endpoint (Auth required)
    if (url.pathname === "/v1/usage" && request.method === "GET") {
      const auth = await verifyAuth(request, env);
      if (!auth) {
        return errorResponse(
          "Invalid or missing Bearer token",
          401,
          "authentication_error",
          "invalid_api_key",
          corsHeaders,
        );
      }

      const quota = await checkQuota(env.DB, auth.userId, env);
      return new Response(
        JSON.stringify({
          tokensUsed: quota.tokensUsed,
          tokenBudget: quota.tokenBudget,
          resetAt: quota.resetAt,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        },
      );
    }

    // 4. Chat Completions endpoint
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      // Step A: Authentication
      const auth = await verifyAuth(request, env);
      if (!auth) {
        return errorResponse(
          "Invalid or missing Bearer token",
          401,
          "authentication_error",
          "invalid_api_key",
          corsHeaders,
        );
      }

      // Step B: Per-minute Rate Limit
      const rateLimit = await checkRateLimit(auth.keyHash, env);
      if (!rateLimit.allowed) {
        return errorResponse(
          "Rate limit exceeded",
          429,
          "requests",
          "rate_limit_exceeded",
          {
            ...corsHeaders,
            "Retry-After": String(rateLimit.retryAfter || 60),
          },
        );
      }

      // Step C: Monthly Quota Enforcement (BEFORE provider call)
      const quota = await checkQuota(env.DB, auth.userId, env);
      if (!quota.allowed) {
        if (quota.error === "unavailable") {
          return errorResponse(
            "Usage check temporarily unavailable — try again shortly",
            429,
            "insufficient_quota",
            "quota_unavailable",
            corsHeaders,
          );
        }
        return errorResponse(
          "Monthly token quota exceeded",
          429,
          "insufficient_quota",
          "quota_exceeded",
          corsHeaders,
        );
      }

      // Step D: Parse and validate JSON body
      let rawBody: Record<string, unknown>;
      try {
        rawBody = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse(
          "Invalid JSON request body",
          400,
          "invalid_request_error",
          "invalid_json",
          corsHeaders,
        );
      }

      if (typeof rawBody.model !== "string" || !rawBody.model) {
        return errorResponse(
          "Missing or invalid 'model' parameter",
          400,
          "invalid_request_error",
          "invalid_model",
          corsHeaders,
        );
      }

      const allowedModels = parseAllowedModels(env.ALLOWED_MODELS);
      if (!isModelAllowed(rawBody.model, allowedModels)) {
        return errorResponse(
          `Model '${rawBody.model}' is not allowed`,
          400,
          "invalid_request_error",
          "model_not_allowed",
          corsHeaders,
        );
      }

      if (!Array.isArray(rawBody.messages) || rawBody.messages.length === 0) {
        return errorResponse(
          "'messages' must be a non-empty array",
          400,
          "invalid_request_error",
          "invalid_messages",
          corsHeaders,
        );
      }

      // Step E: Sanitize request (strip client keys/URLs, inject include_usage if streaming)
      const sanitized = sanitizeRequestBody(rawBody);

      // Step F: Dispatch upstream
      // Note: fetchUpstream pre-scrubs raw upstream failures to a 502 with an OpenAI-shaped body.
      // This branch re-attaches CORS headers before returning the scrubbed error to the client.
      const upstreamRes = await fetchUpstream(sanitized, env);
      if (!upstreamRes.ok) {
        const errJson = await upstreamRes.text();
        return new Response(errJson, {
          status: upstreamRes.status,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      }

      // Step G: Handle Streaming vs Non-streaming
      if (sanitized.stream && upstreamRes.body) {
        // Tee stream: one pipe for client, one for usage extraction
        const [clientStream, usageStream] = upstreamRes.body.tee();

        const writePromise = (async () => {
          const usageInfo = await extractUsageFromSSE(usageStream);
          await recordUsage(env.DB, {
            userId: auth.userId,
            model: sanitized.model,
            promptTokens: usageInfo.promptTokens,
            completionTokens: usageInfo.completionTokens,
            usageMissing: usageInfo.usageMissing,
          });
        })();

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(writePromise);
        } else {
          void writePromise;
        }

        return new Response(clientStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders,
          },
        });
      }

      // Non-streaming response: guarded JSON parse
      let data: Record<string, unknown>;
      try {
        data = (await upstreamRes.json()) as Record<string, unknown>;
      } catch (_err) {
        return errorResponse(
          "Upstream provider error",
          502,
          "upstream_error",
          "bad_gateway",
          corsHeaders,
        );
      }

      const usageObj = data.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;

      const promptTokens = Number(usageObj?.prompt_tokens) || 0;
      const completionTokens = Number(usageObj?.completion_tokens) || 0;
      const usageMissing = !usageObj;

      const writePromise = recordUsage(env.DB, {
        userId: auth.userId,
        model: sanitized.model,
        promptTokens,
        completionTokens,
        usageMissing,
      });

      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(writePromise);
      } else {
        void writePromise;
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    return errorResponse(
      "Not Found",
      404,
      "invalid_request_error",
      "not_found",
      corsHeaders,
    );
  },
};
