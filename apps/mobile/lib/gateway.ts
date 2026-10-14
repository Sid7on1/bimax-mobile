// lib/gateway.ts
import { supabase } from "./supabase";

export const DEFAULT_GATEWAY_URL = "https://bimax-gateway.sid7vish.workers.dev";

export function getGatewayUrl(): string {
  return process.env.EXPO_PUBLIC_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

export interface ChatMessageParam {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessageParam[];
  signal?: AbortSignal;
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
}

export interface UsageInfo {
  tokensUsed: number;
  tokenBudget: number;
  resetAt: string;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getUsage(): Promise<UsageInfo | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(`${getGatewayUrl()}/v1/usage`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageInfo;
  } catch (_err) {
    return null;
  }
}

export async function streamChat(options: StreamChatOptions): Promise<{
  fullContent: string;
  fullReasoning: string;
  stopped: boolean;
}> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("User not authenticated");
  }

  const response = await fetch(`${getGatewayUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    let errMessage = `Gateway error: HTTP ${response.status}`;
    try {
      const errJson = (await response.json()) as { error?: { message?: string } };
      if (errJson.error?.message) {
        errMessage = errJson.error.message;
      }
    } catch {
      // ignore
    }
    throw new Error(errMessage);
  }

  if (!response.body) {
    throw new Error("No response body received from gateway");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoning = "";
  let stopped = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        if (trimmed === "data: [DONE]") return { fullContent, fullReasoning, stopped: false };

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const parsed = JSON.parse(jsonStr) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
              };
            }>;
          };

          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            const contentChunk = delta.content || "";
            const reasoningChunk = delta.reasoning_content || delta.reasoning || "";

            if (contentChunk) fullContent += contentChunk;
            if (reasoningChunk) fullReasoning += reasoningChunk;

            if (contentChunk || reasoningChunk) {
              options.onDelta?.({
                content: contentChunk || undefined,
                reasoning: reasoningChunk || undefined,
              });
            }
          }
        } catch {
          // ignore chunk parse errors
        }
      }
    }
  } catch (err) {
    if (options.signal?.aborted) {
      stopped = true;
      return { fullContent, fullReasoning, stopped: true };
    }
    throw err;
  }

  return { fullContent, fullReasoning, stopped };
}
