import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const wranglerPackage = require("wrangler/package.json");
const wrangler = path.resolve(
  path.dirname(require.resolve("wrangler/package.json")),
  wranglerPackage.bin.wrangler,
);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-workers-"));
const secret = "local-test-relay-secret-at-least-32-bytes";
let relay, gateway;
try {
  for (const app of ["gateway", "cloud-relay"]) {
    execFileSync(
      process.execPath,
      [wrangler, "deploy", "--dry-run", "--outdir", path.join(temp, app)],
      {
        cwd: path.resolve("apps", app),
        stdio: "pipe",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
  }
  gateway = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      name: "gateway",
      script: fs.readFileSync(path.join(temp, "gateway/index.js"), "utf8"),
      compatibilityDate: "2026-10-01",
      d1Databases: { DB: "audit-db" },
      kvNamespaces: ["GATEWAY_KEYS", "GATEWAY_RATELIMIT"],
      bindings: {
        RELAY_TICKET_SECRET: secret,
        ALLOWED_MODELS: "deepseek-chat",
        DEFAULT_MONTHLY_TOKENS: "4000000",
        RATE_LIMIT_PER_MIN: "30",
        MODEL_PRICES_JSON: JSON.stringify({ "deepseek-chat": { input: 1000000, output: 2000000 } }),
        GLOBAL_MONTHLY_MICROUSD: "1000000",
        MOCK_UPSTREAM: "1",
      },
    }),
  );
  const db = await gateway.getD1Database("DB");
  // Prepared statements preserve complete trigger bodies, including internal semicolons.
  const schema = fs.readFileSync("apps/gateway/schema.sql", "utf8");
  for (const sql of schema
    .split(/(?=^(?:CREATE|INSERT|ALTER))/m)
    .filter((sql) => /^(CREATE|INSERT|ALTER)/m.test(sql))) {
    const statement = sql
      .replace(/--[^\n]*/g, "")
      .trim()
      .replace(/;$/, "");
    try {
      await db.prepare(statement).run();
    } catch (err) {
      console.error("Schema statement failed:", statement.slice(0, 120));
      throw err;
    }
  }
  const key = "ab".repeat(32),
    user = "platform-user";
  const keys = await gateway.getKVNamespace("GATEWAY_KEYS");
  await keys.put(createHash("sha256").update(key).digest("hex"), user);
  await db
    .prepare("INSERT INTO entitlements VALUES (?,'active','2099-01-01T00:00:00.000Z',1000000)")
    .bind(user)
    .run();
  const request = () =>
    gateway.dispatchFetch("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      }),
    });
  const response = await request();
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  const usage = await db
    .prepare("SELECT tokens,microusd FROM budget_totals WHERE user_id=?")
    .bind(user)
    .first();
  assert.equal(usage.tokens, 15);
  assert.equal(usage.microusd, 20);
  console.log(
    "PASS actual Workers runtime: D1 reservation, triggers, transaction settlement, and upstream response",
  );
  relay = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      name: "relay",
      script: fs.readFileSync(path.join(temp, "cloud-relay/index.js"), "utf8"),
      compatibilityDate: "2026-10-01",
      durableObjects: { ROOM: { className: "Room", useSQLite: true } },
      bindings: { RELAY_TICKET_SECRET: secret },
    }),
  );
  const rejected = await relay.dispatchFetch("https://relay.test/room/desktop", {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(rejected.status, 401);
  const keypair = ed25519.keygen(),
    helloPubkey = Buffer.from(keypair.publicKey).toString("base64");
  const ticket = await new SignJWT({
    roomId: "desktop",
    deviceId: "desktop",
    role: "desktop",
    helloPubkey,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("bimax-gateway")
    .setAudience("bimax-relay")
    .setSubject(user)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
  const upgrade = await relay.dispatchFetch(`https://relay.test/room/desktop?ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(upgrade.status, 101);
  const ws = upgrade.webSocket;
  ws.accept();
  const ts = Date.now(),
    id = "hello-platform";
  const canonical = (value) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
    );
  const helloSignature = Buffer.from(
    ed25519.sign(
      new TextEncoder().encode(
        canonical({
          id,
          ts,
          from: "desktop",
          deviceId: "desktop",
          role: "desktop",
          helloPubkey,
          protocolVersion: 2,
        }),
      ),
      keypair.secretKey,
    ),
  ).toString("base64");
  ws.send(
    JSON.stringify({
      v: 2,
      id,
      ts,
      from: "desktop",
      to: "relay",
      kind: "hello",
      payload: {
        protocolVersion: 2,
        deviceId: "desktop",
        role: "desktop",
        helloPubkey,
        helloSignature,
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Replay is rejected even within the freshness window and after a valid upgrade.
  const replayCode = new Promise((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code), { once: true }),
  );
  // A second connection with an admission ticket must prove its own hello.
  const second = await relay.dispatchFetch(`https://relay.test/room/desktop?ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  second.webSocket.accept();
  const closed = new Promise((resolve) =>
    second.webSocket.addEventListener("close", (event) => resolve(event.code), { once: true }),
  );
  second.webSocket.send(
    JSON.stringify({
      v: 2,
      id,
      ts,
      from: "desktop",
      to: "relay",
      kind: "hello",
      payload: {
        protocolVersion: 2,
        deviceId: "desktop",
        role: "desktop",
        helloPubkey,
        helloSignature,
      },
    }),
  );
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(Error("Hello replay deadline")), 3000)),
  ]);
  assert.equal(code, 4401);
  // A valid room ticket alone must not receive traffic or emit offline presence.
  const phoneKeys = ed25519.keygen(),
    phonePub = Buffer.from(phoneKeys.publicKey).toString("base64");
  const phoneTicket = await new SignJWT({
    roomId: "desktop",
    deviceId: "phone",
    role: "mobile",
    helloPubkey: phonePub,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("bimax-gateway")
    .setAudience("bimax-relay")
    .setSubject(user)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
  const phoneUpgrade = await relay.dispatchFetch(
    `https://relay.test/room/desktop?ticket=${phoneTicket}`,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(phoneUpgrade.status, 101);
  const phone = phoneUpgrade.webSocket;
  phone.accept();
  const phoneEvents = [];
  phone.addEventListener("message", (event) => phoneEvents.push(JSON.parse(event.data)));
  const phoneHello = {
    id: "phone-hello",
    ts: Date.now(),
    from: "phone",
    deviceId: "phone",
    role: "mobile",
    helloPubkey: phonePub,
    protocolVersion: 2,
  };
  phone.send(
    JSON.stringify({
      v: 2,
      id: phoneHello.id,
      ts: phoneHello.ts,
      from: "phone",
      to: "relay",
      kind: "hello",
      payload: {
        deviceId: "phone",
        role: "mobile",
        protocolVersion: 2,
        helloPubkey: phonePub,
        helloSignature: Buffer.from(
          ed25519.sign(new TextEncoder().encode(canonical(phoneHello)), phoneKeys.secretKey),
        ).toString("base64"),
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    phoneEvents.some(
      (event) =>
        event.kind === "presence" &&
        event.payload.deviceId === "desktop" &&
        event.payload.status === "online",
    ),
  );
  // Exercise both new public prekey message kinds in the actual admitted room runtime.
  for (const [kind, sender, from, to, target] of [
    ["pairing_prekey_request", phone, "phone", "desktop", ws],
    ["pairing_prekey", ws, "desktop", "phone", phone],
  ]) {
    const messageId = "pq-routing-" + kind;
    const delivered = new Promise((resolve) =>
      target.addEventListener("message", (event) => {
        if (JSON.parse(event.data).id === messageId) resolve();
      }),
    );
    sender.send(
      JSON.stringify({
        v: 2,
        id: messageId,
        ts: Date.now(),
        from,
        to,
        kind,
        payload: { ref: "ref", pqPrekeyId: "public-prekey-id" },
      }),
    );
    await Promise.race([
      delivered,
      new Promise((_, reject) => setTimeout(() => reject(Error("PQ routing deadline")), 3000)),
    ]);
  }
  console.log("PASS actual Durable Object runtime: PQ prekey lookup and response routing");
  const shadowUpgrade = await relay.dispatchFetch(
    `https://relay.test/room/desktop?ticket=${ticket}`,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(shadowUpgrade.status, 101);
  const shadow = shadowUpgrade.webSocket;
  shadow.accept();
  const shadowEvents = [];
  shadow.addEventListener("message", (event) => shadowEvents.push(event.data));
  const received = new Promise((resolve) =>
    ws.addEventListener("message", (event) => {
      if (JSON.parse(event.data).id === "verified-target") resolve();
    }),
  );
  phone.send(
    JSON.stringify({
      v: 2,
      id: "verified-target",
      ts: Date.now(),
      from: "phone",
      to: "desktop",
      kind: "encrypted",
      payload: { ciphertext: "test-routing" },
    }),
  );
  await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(Error("Verified delivery deadline")), 3000)),
  ]);
  shadow.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(shadowEvents.length, 0);
  assert.equal(
    phoneEvents.some(
      (event) =>
        event.kind === "presence" &&
        event.payload.deviceId === "desktop" &&
        event.payload.status === "offline",
    ),
    false,
  );
  phone.close();
  console.log(
    "PASS actual Durable Object runtime: pre-hello sockets cannot receive traffic or forge offline presence",
  );
  ws.close();
  void replayCode;
  console.log(
    "PASS actual Durable Object runtime: ticket enforcement, signed hello, SQL state, and replay rejection",
  );
} finally {
  await relay?.dispose();
  await gateway?.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
}
