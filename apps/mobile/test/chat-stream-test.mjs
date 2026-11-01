import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const root = process.env.BIMAX_CHAT_SOURCE_ROOT || path.resolve("apps/mobile/lib");
const scratch = mkdtempSync(path.join(os.tmpdir(), "bimax-chat-"));
const compile = (file) =>
  ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
writeFileSync(path.join(scratch, "chat-stream.cjs"), compile("chat-stream.ts"));
const { requestChat } = require(path.join(scratch, "chat-stream.cjs"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const options = { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "Hello" }] };
const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\r\n\r\n`;
const answer = chunk({ content: "Ready" }) + "data: [DONE]\n\n";
const deps = (fetchImpl) => ({
  getAccessToken: async () => "test-account-token",
  getGatewayUrl: () => "https://gateway.test",
  fetchImpl,
  timeoutMs: 80,
});
const response = (text) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const boundedTest = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Test failed to settle")), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("native gateway uses Expo streaming fetch rather than React Native's buffered global fetch", async () => {
  let calls = 0;
  const module = { exports: {} };
  const expoFetch = async (_url, init) => {
    calls++;
    assert.equal(init.headers.Accept, "text/event-stream");
    return response(answer);
  };
  runInNewContext(compile("gateway.ts"), {
    exports: module.exports,
    module,
    process: { env: {} },
    fetch: () => {
      assert.fail("Buffered fetch used");
    },
    require: (id) => {
      if (id === "./crypto/keys") return require("@bimax/core/crypto/keys");
      if (id === "expo/fetch") return { fetch: expoFetch };
      if (id === "./chat-stream") return { requestChat };
      if (id === "./supabase")
        return {
          supabase: {
            auth: { getSession: async () => ({ data: { session: { access_token: "fixture" } } }) },
          },
        };
      throw Error(id);
    },
  });
  assert.equal((await module.exports.streamChat(options)).fullContent, "Ready");
  assert.equal(calls, 1);
});
test("fragmented UTF-8 and CRLF preserve answer and separate reasoning", async () => {
  const bytes = new TextEncoder().encode(
    chunk({ reasoning_content: "Thinking" }) + chunk({ content: "Hi 👋 नमस्ते" }) + "data: [DONE]",
  );
  const deltas = [];
  const r = await requestChat(
    { ...options, onDelta: (d) => deltas.push(d) },
    deps(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
              c.close();
            },
          }),
        ),
    ),
  );
  assert.equal(r.fullContent, "Hi 👋 नमस्ते");
  assert.equal(r.fullReasoning, "Thinking");
  assert.equal(deltas.length, 2);
});
test("DONE completes and retires a socket which the provider never closes", async () => {
  let cancelled = false;
  const r = await boundedTest(
    requestChat(
      options,
      deps(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(answer));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    ),
  );
  assert.equal(r.fullContent, "Ready");
  assert.equal(cancelled, true);
});
test("request auth, provider selection, output cap and document trust boundary survive transport refactoring", async () => {
  await requestChat(
    options,
    deps(async (url, init) => {
      assert.equal(url, "https://gateway.test/v1/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer test-account-token");
      const body = JSON.parse(init.body);
      assert.equal(body.model, options.model);
      assert.equal(body.max_tokens, 2048);
      assert.equal(body.stream, true);
      assert.equal(body.messages[0].role, "system");
      assert.match(body.messages[0].content, /untrusted source data/);
      return response(answer);
    }),
  );
  assert.equal(options.messages.length, 1);
});
test("missing session sends no inference request", async () => {
  await assert.rejects(
    requestChat(options, {
      ...deps(() => {
        throw Error("must not fetch");
      }),
      getAccessToken: async () => null,
    }),
    /Sign in/,
  );
});
test("gateway refusal and SSE provider errors remain visible", async () => {
  await assert.rejects(
    requestChat(
      options,
      deps(async () =>
        Response.json({ error: { message: "Model not configured" } }, { status: 400 }),
      ),
    ),
    /Model not configured/,
  );
  await assert.rejects(
    requestChat(
      options,
      deps(async () => response('data: {"error":{"message":"Provider unavailable"}}\n\n')),
    ),
    /Provider unavailable/,
  );
});
test("truncated, invalid and reasoning-only responses cannot appear as successful empty answers", async () => {
  for (const [text, message] of [
    [chunk({ content: "partial" }), /ended before completion/],
    ["data: nope\n", /invalid response/],
    [chunk({ reasoning: "hidden" }) + "data: [DONE]\n", /without an answer/],
  ])
    await assert.rejects(
      requestChat(
        options,
        deps(async () => response(text)),
      ),
      message,
    );
});
test("timeout bounds auth, fetch and read even when native adapters ignore abort", async () => {
  const never = () => new Promise(() => {});
  for (const d of [
    { ...deps(never), getAccessToken: never },
    deps(never),
    deps(async () => new Response(new ReadableStream({ pull: never }))),
  ])
    await assert.rejects(
      boundedTest(requestChat(options, { ...d, timeoutMs: 12 })),
      /took too long/,
    );
});
test("Stop settles a pending native read with the exact partial answer", async () => {
  const controller = new AbortController();
  const r = await boundedTest(
    requestChat(
      { ...options, signal: controller.signal, onDelta: () => controller.abort() },
      deps(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(chunk({ content: "partial" })));
              },
            }),
          ),
      ),
    ),
  );
  assert.deepEqual(r, { fullContent: "partial", fullReasoning: "", stopped: true });
});
test("Stop before dispatch never calls the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const r = await requestChat(
    { ...options, signal: controller.signal },
    deps(async () => {
      calls++;
      return response(answer);
    }),
  );
  assert.equal(calls, 0);
  assert.equal(r.stopped, true);
});
test("oversized user messages and streamed events fail without unbounded accumulation", async () => {
  await assert.rejects(
    requestChat(
      { ...options, messages: [{ role: "user", content: "x".repeat(201 * 1024) }] },
      deps(() => {
        throw Error("must not fetch");
      }),
    ),
    /too large/,
  );
  await assert.rejects(
    requestChat(
      options,
      deps(async () => response("data: " + "x".repeat(1024 * 1024))),
    ),
    /supported size/,
  );
});
test("real HTTP chunking publishes content before completion and cancels after DONE", async () => {
  let sent = false;
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(chunk({ content: "first" }));
    const timer = setTimeout(() => {
      sent = true;
      res.write(chunk({ content: " second" }) + "data: [DONE]\n\n");
    }, 30);
    res.once("close", () => clearTimeout(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await requestChat(
      {
        ...options,
        onDelta: (d) => {
          if (d.content === "first") assert.equal(sent, false);
        },
      },
      {
        ...deps(fetch),
        timeoutMs: 1000,
        getGatewayUrl: () => `http://127.0.0.1:${server.address().port}`,
      },
    );
    assert.equal(r.fullContent, "first second");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("Stop observes an already rejecting session lookup without an unhandled rejection", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await requestChat(
    { ...options, signal: controller.signal },
    {
      ...deps(async () => {
        assert.fail("must not dispatch");
      }),
      getAccessToken: async () => {
        throw Error("session cancelled");
      },
    },
  );
  assert.equal(result.stopped, true);
  await new Promise((resolve) => setImmediate(resolve));
});
