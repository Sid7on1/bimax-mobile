import type { ChatCompletionRequest } from "./providers";
import type { Env } from "./auth";
export async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new Error("Request exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Request must be an object");
  return body as Record<string, unknown>;
}
export function validateChat(
  body: Record<string, unknown>,
  env: Pick<Env, "MAX_OUTPUT_TOKENS">,
): ChatCompletionRequest {
  // Bound schema nesting before later JSON.stringify/recursive library processing.
  const pending: [unknown, number][] = [[body, 0]];
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (++nodes > 16000 || depth > 24) throw new Error("Request structure is too complex");
    if (value && typeof value === "object")
      for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  if (typeof body.model !== "string" || !body.model.trim()) throw new Error("Invalid model");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200)
    throw new Error("messages must contain 1–200 messages");
  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      (typeof message.content !== "string" &&
        !(
          message.role === "assistant" &&
          message.content === null &&
          Array.isArray(message.tool_calls)
        ))
    )
      throw new Error("Invalid message role or content");
    if (typeof message.content === "string" && message.content.length > 200 * 1024)
      throw new Error("Message content is too large");
    if (message.tool_calls !== undefined) {
      if (
        message.role !== "assistant" ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length > 64
      )
        throw new Error("Invalid tool calls");
      for (const call of message.tool_calls)
        if (
          !call ||
          typeof call.id !== "string" ||
          call.id.length > 128 ||
          call.type !== "function" ||
          !call.function ||
          !validName(call.function.name) ||
          typeof call.function.arguments !== "string"
        )
          throw new Error("Invalid tool call");
    }
    if (
      message.role === "tool" &&
      (typeof message.tool_call_id !== "string" || message.tool_call_id.length > 128)
    )
      throw new Error("Invalid tool message");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new Error("stream must be boolean");
  for (const [key, min, max] of [
    ["temperature", 0, 2],
    ["top_p", 0, 1],
  ] as const) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== "number" ||
        !Number.isFinite(body[key]) ||
        body[key] < min ||
        body[key] > max)
    )
      throw new Error(`Invalid ${key}`);
  }
  const configuredCap = Number(env.MAX_OUTPUT_TOKENS ?? 2048);
  if (!Number.isSafeInteger(configuredCap) || configuredCap <= 0)
    throw new Error("Output limit unavailable");
  const cap = Math.min(4096, configuredCap);
  const output = body.max_tokens ?? cap;
  if (!Number.isSafeInteger(output) || Number(output) <= 0 || Number(output) > cap)
    throw new Error(`max_tokens must be between 1 and ${cap}`);
  const clean: Record<string, unknown> = {
    model: body.model.trim().toLowerCase(),
    messages: body.messages,
    stream: body.stream ?? false,
    max_tokens: output,
  };
  for (const key of ["temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls"])
    if (body[key] !== undefined) clean[key] = body[key];
  if (clean.tools !== undefined && (!Array.isArray(clean.tools) || clean.tools.length > 64))
    throw new Error("Invalid tools");
  const toolNames = new Set<string>();
  for (const tool of (clean.tools ?? []) as Record<string, unknown>[]) {
    const fn = tool?.function as Record<string, unknown> | undefined;
    if (
      tool?.type !== "function" ||
      !fn ||
      !validName(fn.name) ||
      toolNames.has(fn.name as string) ||
      (fn.description !== undefined &&
        (typeof fn.description !== "string" || fn.description.length > 8192)) ||
      (fn.parameters !== undefined &&
        (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters))) ||
      (fn.strict !== undefined && typeof fn.strict !== "boolean")
    )
      throw new Error("Invalid tool definition");
    toolNames.add(fn.name as string);
  }
  if (clean.tool_choice !== undefined) {
    const choice = clean.tool_choice as { type?: unknown; function?: { name?: unknown } };
    if (
      !["auto", "none", "required"].includes(String(choice)) &&
      !(choice?.type === "function" && toolNames.has(String(choice.function?.name)))
    )
      throw new Error("Invalid tool_choice");
    if (clean.tool_choice !== "none" && !toolNames.size)
      throw new Error("tool_choice requires tools");
  }
  if (clean.parallel_tool_calls !== undefined && typeof clean.parallel_tool_calls !== "boolean")
    throw new Error("Invalid parallel_tool_calls");
  if (clean.stream) clean.stream_options = { include_usage: true };
  return clean as unknown as ChatCompletionRequest;
}
function validName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(name);
}
