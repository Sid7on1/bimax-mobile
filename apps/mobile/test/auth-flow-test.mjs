import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const scratch = mkdtempSync(path.join(os.tmpdir(), "bimax-auth-flow-"));
const source = readFileSync(new URL("../lib/auth-flow.ts", import.meta.url), "utf8");
const target = path.join(scratch, "auth-flow.cjs");
writeFileSync(
  target,
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
);
const { authServiceHealth, oauthRedirect, exchangeLoginCode, signInWithBrowser } = require(target);
after(() => rmSync(scratch, { recursive: true, force: true }));
const serviceUrl = "https://auth.example.test",
  redirect = "https://bimax.example.test/auth/callback";
function fixture(changes = {}) {
  const calls = [];
  const options = {
    expoGo: false,
    redirect,
    serviceUrl,
    health: async () => {
      calls.push("health");
      return { ok: true };
    },
    authorize: async (value) => {
      calls.push(["authorize", value]);
      return { url: serviceUrl + "/auth/v1/authorize?provider=google", error: null };
    },
    open: async (...args) => {
      calls.push(["open", ...args]);
      return { type: "success", url: redirect + "?code=bound-pkce-code" };
    },
    exchange: async (code) => {
      calls.push(["exchange", code]);
      return { session: { user: { id: "fixture" } }, error: null };
    },
    ...changes,
  };
  return { options, calls };
}
test("Expo Go cannot start social OAuth even in development or with a configured URL", async () => {
  for (const configured of [redirect, undefined]) {
    const { options, calls } = fixture({ expoGo: true, redirect: configured });
    await assert.rejects(signInWithBrowser(options), /development build/);
    assert.deepEqual(calls, []);
  }
});
test("native social OAuth requires the exact configured HTTPS callback", () => {
  for (const value of [
    undefined,
    "bimax://auth/callback",
    "http://bimax.example.test/auth/callback",
    redirect + "?code=old",
    redirect + "#fragment",
    "https://user:pass@bimax.example.test/auth/callback",
    "https://bimax.example.test/foreign",
  ])
    assert.throws(() => oauthRedirect(false, value));
  assert.equal(oauthRedirect(false, redirect), redirect);
});
test("an unavailable auth server never authorizes or launches Safari", async () => {
  const { options, calls } = fixture({
    health: async () => ({ ok: false, message: "Service unreachable" }),
  });
  await assert.rejects(signInWithBrowser(options), /Service unreachable/);
  assert.deepEqual(calls, []);
});
test("successful native OAuth exchanges exactly one callback code after checking availability", async () => {
  const { options, calls } = fixture();
  assert.equal(await signInWithBrowser(options), true);
  assert.deepEqual(calls, [
    "health",
    ["authorize", redirect],
    ["open", serviceUrl + "/auth/v1/authorize?provider=google", redirect],
    ["exchange", "bound-pkce-code"],
  ]);
});
test("foreign or malformed authorization destinations never open the browser", async () => {
  for (const url of [
    "https://foreign.example.test/auth/v1/authorize",
    serviceUrl + "/foreign",
    "javascript:alert(1)",
    "https://user:pass@auth.example.test/auth/v1/authorize",
  ]) {
    const { options, calls } = fixture({ authorize: async () => ({ url, error: null }) });
    await assert.rejects(signInWithBrowser(options));
    assert.deepEqual(calls, ["health"]);
  }
});
test("foreign, duplicate, empty, oversized and provider-error callbacks never exchange a code", async () => {
  for (const url of [
    "https://other.example.test/auth/callback?code=x",
    "https://bimax.example.test/foreign?code=x",
    redirect + "?code=a&code=b",
    redirect + "?code=",
    redirect + "?code=" + "x".repeat(4097),
    redirect + "?code=x&error=denied",
    redirect + "?code=x#access_token=unexpected",
    "https://user:pass@bimax.example.test/auth/callback?code=x",
  ]) {
    const { options, calls } = fixture({ open: async () => ({ type: "success", url }) });
    await assert.rejects(signInWithBrowser(options));
    assert(!calls.some((v) => Array.isArray(v) && v[0] === "exchange"));
  }
});
test("cancelling or dismissing sign-in never exchanges a code", async () => {
  for (const type of ["cancel", "dismiss"]) {
    const { options, calls } = fixture({ open: async () => ({ type }) });
    assert.equal(await signInWithBrowser(options), false);
    assert(!calls.some((v) => Array.isArray(v) && v[0] === "exchange"));
  }
});
test("missing authorization URLs and provider errors are visible failures", async () => {
  for (const authorization of [
    { url: null, error: null },
    { url: serviceUrl, error: new Error("provider failure") },
  ]) {
    const { options, calls } = fixture({ authorize: async () => authorization });
    await assert.rejects(signInWithBrowser(options), /Could not start/);
    assert.deepEqual(calls, ["health"]);
  }
});
test("callback route cannot report success when SDK returns an error or no session", async () => {
  for (const result of [
    { error: new Error("expired"), session: null },
    { error: null, session: null },
  ])
    await assert.rejects(
      exchangeLoginCode("pkce-code", async () => result),
      /could not be completed/,
    );
  for (const code of [undefined, ["a", "b"], "", " ", "x".repeat(4097)])
    await assert.rejects(
      exchangeLoginCode(code, async () => {
        throw new Error("must not exchange");
      }),
      /authorization code/,
    );
});
test("health request uses a bounded first-party endpoint and a header, not a key in its URL", async () => {
  let calls = 0;
  const health = await authServiceHealth(serviceUrl, "public-fixture-key", async (url, options) => {
    calls++;
    assert.equal(url, serviceUrl + "/auth/v1/health");
    assert.equal(options.headers.apikey, "public-fixture-key");
    assert.equal(options.redirect, "error");
    return { ok: true };
  });
  assert.equal(calls, 1);
  assert.deepEqual(health, { ok: true });
});
test("DNS/network failure and HTTP refusal become an in-app outage, with no exception secrets", async () => {
  for (const request of [
    async () => {
      throw new Error("ENOTFOUND private diagnostic");
    },
    async () => ({ ok: false }),
  ]) {
    const result = await authServiceHealth(serviceUrl, "public-fixture-key", request);
    assert.equal(result.ok, false);
    assert.match(result.message, /Cannot reach/);
    assert(!result.message.includes("private diagnostic"));
  }
});
test("unresponsive health fetch is bounded even when a fetch adapter ignores abort", async () => {
  let signal;
  const result = await authServiceHealth(
    serviceUrl,
    "public-fixture-key",
    async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
    5,
  );
  assert.equal(result.ok, false);
  assert.equal(signal.aborted, true);
});
test("invalid or missing service configuration sends no health request", async () => {
  for (const [url, key] of [
    ["not a URL", "k"],
    ["http://auth.example.test", "k"],
    [serviceUrl + "?key=unsafe", "k"],
    [serviceUrl, ""],
  ]) {
    const result = await authServiceHealth(url, key, async () => {
      throw new Error("request must not run");
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /not configured/);
  }
});
