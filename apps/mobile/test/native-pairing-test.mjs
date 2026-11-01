import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url),
  ts = require("typescript"),
  WebSocket = require("ws");
const scratch = mkdtempSync(path.join(os.tmpdir(), "bimax-native-pairing-"));
function source(relative, name) {
  writeFileSync(
    path.join(scratch, name + ".cjs"),
    ts.transpileModule(
      readFileSync(
        path.resolve(process.env.BIMAX_NATIVE_PAIRING_SOURCE_ROOT || "apps/mobile/lib", relative),
        "utf8",
      ),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
  );
  return require(path.join(scratch, name + ".cjs"));
}
const { relaySocketConstructor } = source("relay/native-socket.ts", "native");
const { pairingProgress, pairingTimeout } = source("session/pairing-progress.ts", "progress");
after(() => rmSync(scratch, { recursive: true, force: true }));
test("native LAN sockets clear the implicit Origin without changing the exact URL/token", () => {
  let received;
  class Native {
    constructor(...args) {
      received = args;
    }
  }
  const C = relaySocketConstructor(Native, true),
    url = "ws://192.168.1.20:8787/room/mac?lanToken=fixture-secret";
  new C(url);
  assert.deepEqual(received, [url, [], { headers: { Origin: "" } }]);
});
test("browser constructors are returned unchanged and cannot use native header options", () => {
  class Browser {}
  assert.equal(relaySocketConstructor(Browser, false), Browser);
});
test("cloud TLS sockets preserve native default origin and exact ticket", () => {
  let received;
  class Native {
    constructor(...args) {
      received = args;
    }
  }
  const C = relaySocketConstructor(Native, true),
    url = "wss://relay.example.test/room/mac?ticket=fixture";
  new C(url);
  assert.deepEqual(received, [url, [], undefined]);
});
test("connection and handshake progress never pretend that the Mac has an approval request", () => {
  for (const status of ["idle", "connecting", "offline", "reconnecting", "online"]) {
    const p = pairingProgress(status);
    assert(!/waiting for.*approval/i.test(p.title));
    assert(p.description.length > 30);
    assert.match(
      pairingTimeout(status),
      status === "online" ? /secure connection/ : /Could not reach/,
    );
  }
  assert.match(pairingProgress("online").title, /secure connection/);
  assert.match(pairingProgress("reconnecting").title, /Reconnecting/);
});
// Uses the actual app-owned listener with only a native constructor shim: iOS/Android
// synthesize Origin, then apply caller headers. No admission/hello/confirmation bypass.
test("actual LAN upgrade rejects simulated native default and browser origins; admits repaired native only with the right token", async () => {
  const { createLanRelay } = await import("../../desktop-responder/dist/lan-relay.js");
  const token = "native-fixture-token-" + "x".repeat(40);
  const server = await createLanRelay({
    host: "127.0.0.1",
    port: 0,
    token,
    desktopDeviceId: "fixture-mac",
  });
  const url = `ws://127.0.0.1:${server.port}/room/fixture-mac?lanToken=${token}`;
  class NativeLike extends WebSocket {
    constructor(url, _protocols, options) {
      super(url, {
        headers: { Origin: new URL(url).origin.replace("ws:", "http:"), ...options?.headers },
      });
    }
  }
  async function opened(Constructor, target) {
    return new Promise((resolve) => {
      const ws = new Constructor(target);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 1500);
      const done = (value) => {
        clearTimeout(timer);
        ws.terminate();
        resolve(value);
      };
      ws.once("error", () => done(false));
      ws.once("open", () => done(true));
    });
  }
  try {
    assert.equal(await opened(NativeLike, url), false);
    assert.equal(await opened(relaySocketConstructor(NativeLike, true), url), true);
    assert.equal(
      await opened(relaySocketConstructor(NativeLike, true), url.replace(token, "wrong")),
      false,
    );
    assert.equal(
      await opened(
        relaySocketConstructor(NativeLike, true),
        url.replace("/room/fixture-mac", "/room/foreign"),
      ),
      false,
    );
    assert.equal(await opened(relaySocketConstructor(NativeLike, false), url), false);
  } finally {
    await server.close();
  }
});
