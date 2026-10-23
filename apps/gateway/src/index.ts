import { mintRelayTicket, removeRelayRoom } from "./relay-ticket";
// src/index.ts
import { verifyAuth, type Env } from "./auth";
import { parseAllowedModels, isModelAllowed, fetchUpstream } from "./providers";
import { checkQuota } from "./quota";
import { getMinuteBucketUTC, checkRateLimit } from "./ratelimit";
import { reserve, settle, finalizeExpired } from "./admission";
import { readBoundedJson, validateChat } from "./validation";

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
export function getCorsHeaders(request: Request, env?: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const isValidOrigin = origin && (env?.ALLOWED_ORIGINS ?? "").split(",").includes(origin);
  return {
    ...(isValidOrigin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function parseSSEUsageLine(
  line: string,
  requireSafeInteger: boolean,
): { promptTokens: number; completionTokens: number } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") return null;
  const jsonStr = trimmed.slice(5).trim();
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.usage) {
      const u = parsed.usage as Record<string, unknown>;
      if (requireSafeInteger) {
        if (!Number.isSafeInteger(u.prompt_tokens) || !Number.isSafeInteger(u.completion_tokens)) {
          return null;
        }
        return {
          promptTokens: u.prompt_tokens as number,
          completionTokens: u.completion_tokens as number,
        };
      }
      return {
        promptTokens: Number(u.prompt_tokens) || 0,
        completionTokens: Number(u.completion_tokens) || 0,
      };
    }
  } catch {
    // Ignore non-JSON data lines
  }
  return null;
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
    const u = parseSSEUsageLine(line, false);
    if (u) {
      promptTokens = u.promptTokens;
      completionTokens = u.completionTokens;
      foundUsage = true;
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
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(finalizeExpired(env));
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?")
        .bind(getMinuteBucketUTC(new Date(Date.now() - 48 * 3600_000)))
        .run(),
    );
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const corsHeaders = getCorsHeaders(request, env);
    corsHeaders["X-Request-Id"] = crypto.randomUUID();

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/ready" && request.method === "GET") {
      try {
        const prices = JSON.parse(env.MODEL_PRICES_JSON ?? "{}");
        const configured = parseAllowedModels(env.ALLOWED_MODELS).every(
          (model) =>
            prices[model] &&
            Number.isSafeInteger(prices[model].input) &&
            Number.isSafeInteger(prices[model].output),
        );
        const control = await env.DB.prepare(
          "SELECT paused FROM billing_control WHERE id=1",
        ).first<{ paused: number }>();
        await env.DB.prepare("SELECT hello_pubkey FROM relay_devices LIMIT 1").first();
        await env.DB.prepare("SELECT updated_at FROM relay_rooms LIMIT 1").first();
        const ok =
          configured &&
          Number(env.GLOBAL_MONTHLY_MICROUSD) > 0 &&
          !!env.SUPABASE_URL &&
          (env.RELAY_TICKET_SECRET?.length ?? 0) >= 32 &&
          control?.paused === 0;
        return Response.json({ ok }, { status: ok ? 200 : 503 });
      } catch {
        return Response.json({ ok: false }, { status: 503 });
      }
    }
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

    if (url.pathname.startsWith("/v1/relay-rooms") && ["GET", "DELETE"].includes(request.method)) {
      const auth = await verifyAuth(request, env);
      if (!auth)
        return errorResponse(
          "Authentication required",
          401,
          "authentication_error",
          "invalid_api_key",
          corsHeaders,
        );
      const limit = await checkRateLimit(auth.userId, env);
      if (!limit.allowed)
        return errorResponse(
          "Room management unavailable or rate limited",
          limit.unavailable ? 503 : 429,
          "requests",
          limit.unavailable ? "admission_unavailable" : "rate_limit_exceeded",
          corsHeaders,
        );
      try {
        if (request.method === "GET" && url.pathname === "/v1/relay-rooms") {
          const rows = await env.DB.prepare(
            "SELECT room_id,updated_at FROM relay_rooms WHERE user_id=? ORDER BY updated_at DESC",
          )
            .bind(auth.userId)
            .all();
          return Response.json({ rooms: rows.results }, { headers: corsHeaders });
        }
        if (
          request.method === "DELETE" &&
          /^\/v1\/relay-rooms\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)
        ) {
          await removeRelayRoom(env, auth.userId, url.pathname.split("/").pop()!);
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        return errorResponse("Not found", 404, "invalid_request_error", "not_found", corsHeaders);
      } catch {
        return errorResponse(
          "Room management unavailable",
          503,
          "server_error",
          "room_management_unavailable",
          corsHeaders,
        );
      }
    }
    if (url.pathname === "/v1/relay-ticket" && request.method === "POST") {
      const auth = await verifyAuth(request, env);
      if (!auth)
        return errorResponse(
          "Authentication required",
          401,
          "authentication_error",
          "invalid_api_key",
          corsHeaders,
        );
      const limit = await checkRateLimit(auth.userId, env);
      if (!limit.allowed)
        return errorResponse(
          "Admission unavailable or rate limited",
          limit.unavailable ? 503 : 429,
          "requests",
          limit.unavailable ? "admission_unavailable" : "rate_limit_exceeded",
          corsHeaders,
        );
      try {
        const ticket = await mintRelayTicket(env, auth.userId, await readBoundedJson(request));
        return Response.json({ ticket }, { headers: corsHeaders });
      } catch {
        return errorResponse(
          "Relay access unavailable for this room",
          403,
          "permission_error",
          "relay_access_denied",
          corsHeaders,
        );
      }
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
      const rateLimit = await checkRateLimit(auth.userId, env);
      if (!rateLimit.allowed) {
        return errorResponse(
          rateLimit.unavailable ? "Admission temporarily unavailable" : "Rate limit exceeded",
          rateLimit.unavailable ? 503 : 429,
          "requests",
          rateLimit.unavailable ? "admission_unavailable" : "rate_limit_exceeded",
          {
            ...corsHeaders,
            "Retry-After": String(rateLimit.retryAfter || 60),
          },
        );
      }

      // Step C: Parse and validate JSON body (quota, entitlement, and spend limits are atomically enforced in reserve() below)
      let rawBody: Record<string, unknown>;
      try {
        rawBody = await readBoundedJson(request);
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

      // Step D: Sanitize request (strip client keys/URLs, inject include_usage if streaming)
      let sanitized;
      try {
        sanitized = validateChat(rawBody, env);
      } catch (err) {
        return errorResponse(
          err instanceof Error ? err.message : "Invalid request",
          400,
          "invalid_request_error",
          "invalid_body",
          corsHeaders,
        );
      }
      let reservation;
      try {
        reservation = await reserve(env, auth.userId, sanitized, corsHeaders["X-Request-Id"]);
      } catch {
        return errorResponse(
          "Billing admission unavailable",
          503,
          "server_error",
          "admission_unavailable",
          corsHeaders,
        );
      }
      if (!reservation)
        return errorResponse(
          "Request exceeds available allocation",
          429,
          "insufficient_quota",
          "quota_exceeded",
          corsHeaders,
        );
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 120_000);
      const cancel = () => abort.abort();
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) abort.abort();
      const cleanup = () => {
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", cancel);
      };
      // Settlement failures retain the write-ahead reservation and never grant free usage.
      const charge = async (usage: {
        promptTokens: number;
        completionTokens: number;
        usageMissing: boolean;
        rejected?: boolean;
      }) => {
        try {
          await settle(env, reservation, usage);
        } catch {
          console.error("Settlement pending reconciliation", reservation.id);
        }
      };

      // Step F: Dispatch upstream
      // Note: fetchUpstream pre-scrubs raw upstream failures to a 502 with an OpenAI-shaped body.
      // This branch re-attaches CORS headers before returning the scrubbed error to the client.
      let upstreamRes: Response;
      try {
        upstreamRes = await fetchUpstream(sanitized, env, abort.signal);
      } catch {
        await charge({ promptTokens: 0, completionTokens: 0, usageMissing: true });
        cleanup();
        return errorResponse(
          "Provider dispatch unavailable",
          502,
          "upstream_error",
          "bad_gateway",
          corsHeaders,
        );
      }
      if (!upstreamRes.ok) {
        await charge({
          promptTokens: 0,
          completionTokens: 0,
          usageMissing: true,
          rejected: upstreamRes.headers.get("X-Bimax-Not-Generated") === "1",
        });
        cleanup();
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
        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage = { promptTokens: 0, completionTokens: 0, usageMissing: true };
        const consume = (line: string) => {
          const parsedUsage = parseSSEUsageLine(line, true);
          if (parsedUsage) {
            usage = {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              usageMissing: false,
            };
          }
        };
        const clientStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                consume(buffer);
                await charge(usage);
                cleanup();
                controller.close();
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > 1024 * 1024) throw new Error("Upstream SSE event too large");
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              lines.forEach(consume);
              controller.enqueue(value);
            } catch (err) {
              await charge(usage);
              cleanup();
              abort.abort();
              controller.error(err);
            }
          },
          async cancel() {
            await charge(usage);
            cleanup();
            abort.abort();
            await reader.cancel().catch(() => {});
          },
        });

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
        if (!data || typeof data !== "object") throw new Error("Invalid upstream response");
        cleanup();
      } catch {
        await charge({ promptTokens: 0, completionTokens: 0, usageMissing: true });
        cleanup();
        return errorResponse(
          "Upstream provider error",
          502,
          "upstream_error",
          "bad_gateway",
          corsHeaders,
        );
      }

      const usageObj = data.usage as
        { prompt_tokens?: number; completion_tokens?: number } | undefined;

      const promptTokens = Number(usageObj?.prompt_tokens) || 0;
      const completionTokens = Number(usageObj?.completion_tokens) || 0;
      const usageMissing =
        !usageObj ||
        !Number.isSafeInteger(usageObj.prompt_tokens) ||
        !Number.isSafeInteger(usageObj.completion_tokens);

      await charge({ promptTokens, completionTokens, usageMissing });

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    return errorResponse("Not Found", 404, "invalid_request_error", "not_found", corsHeaders);
  },
};
