// test/streaming.test.ts
import { describe, it, expect } from "vitest";
import { extractUsageFromSSE } from "../src/index";

describe("streaming and SSE tee module", () => {
  it("extracts prompt_tokens and completion_tokens from the usage SSE chunk and passes data unaltered", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const chunks = [
      `data: {"id":"chat-1","choices":[{"delta":{"content":"Hello"}}]}\n\n`,
      `data: {"id":"chat-1","choices":[{"delta":{"content":" world"}}]}\n\n`,
      `data: {"id":"chat-1","choices":[],"usage":{"prompt_tokens":14,"completion_tokens":28,"total_tokens":42}}\n\n`,
      `data: [DONE]\n\n`,
    ];

    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const [clientStream, usageStream] = sourceStream.tee();

    // 1. Verify usage extraction from usageStream
    const usageInfo = await extractUsageFromSSE(usageStream);
    expect(usageInfo.promptTokens).toBe(14);
    expect(usageInfo.completionTokens).toBe(28);
    expect(usageInfo.usageMissing).toBe(false);

    // 2. Verify clientStream receives the exact raw bytes unaltered
    const reader = clientStream.getReader();
    let accumulatedText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulatedText += decoder.decode(value, { stream: true });
    }

    const expectedText = chunks.join("");
    expect(accumulatedText).toBe(expectedText);
  });

  it("extracts usage from trailing buffer when the final chunk has no trailing newlines", async () => {
    const encoder = new TextEncoder();
    // Final chunk has NO trailing newline or \n\n
    const chunks = [
      `data: {"id":"chat-trailing","choices":[{"delta":{"content":"Hi"}}]}\n\n`,
      `data: {"id":"chat-trailing","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":18,"total_tokens":30}}`,
    ];

    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const usageInfo = await extractUsageFromSSE(sourceStream);
    expect(usageInfo.promptTokens).toBe(12);
    expect(usageInfo.completionTokens).toBe(18);
    expect(usageInfo.usageMissing).toBe(false);
  });

  it("flags usageMissing as true when the stream ends without a usage object", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      `data: {"id":"chat-2","choices":[{"delta":{"content":"Partial"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ];

    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const usageInfo = await extractUsageFromSSE(sourceStream);
    expect(usageInfo.promptTokens).toBe(0);
    expect(usageInfo.completionTokens).toBe(0);
    expect(usageInfo.usageMissing).toBe(true);
  });
});
