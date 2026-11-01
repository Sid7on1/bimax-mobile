// Regression checks for the October 2026 audit. No live provider or account calls.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const Module = require("node:module");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."),
  ts = require(root + "/node_modules/typescript");
require.extensions[".ts"] = (mod, file) =>
  mod._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    file,
  );
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === "expo/fetch") return { fetch: globalThis.fetch };
  if (id.endsWith("/supabase") || id === "./supabase") {
    return {
      supabase: {
        auth: {
          getSession: async () => ({ data: { session: null } }),
        },
      },
    };
  }
  return originalLoad.call(this, id, ...args);
};
const local = (p) => require(path.join(root, p));
const { IdempotencyLog, OperationOutcomeUnknownError } = local(
  "apps/desktop-responder/src/idempotency.ts",
);
if (process.argv[2] === "--crash-child") {
  const dir = process.argv[3];
  (async () => {
    const log = new IdempotencyLog({ storagePath: path.join(dir, "journal.json") });
    await log.init();
    await log.execute("crashed", async () => {
      fs.appendFileSync(path.join(dir, "effects"), "effect\n");
      process.exit(0);
    });
  })();
} else
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
async function main() {
  const scope = local("apps/mobile/lib/account-scope.ts");
  scope.setActiveAccount("account-a");
  const a = scope.accountStorageKey("trust");
  scope.setActiveAccount("account-b");
  assert.notEqual(scope.accountStorageKey("trust"), a);
  scope.setActiveAccount(null);
  assert.throws(() => scope.requireActiveAccount());
  console.log("PASS account storage isolation and signed-out access rejection");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-security-"));
  try {
    const file = path.join(tmp, "completed.json");
    let calls = 0;
    const log = new IdempotencyLog({ storagePath: file });
    await log.init();
    await log.execute("done", async () => ++calls, undefined, "operation-a");
    const restarted = new IdempotencyLog({ storagePath: file });
    await restarted.init();
    await restarted.execute("done", async () => ++calls, undefined, "operation-a");
    assert.equal(calls, 1);
    await assert.rejects(
      restarted.execute("done", async () => ++calls, undefined, "operation-b"),
      /different operation/,
    );
    const crash = spawnSync(process.execPath, [__filename, "--crash-child", tmp], {
      encoding: "utf8",
    });
    assert.equal(crash.status, 0, crash.stderr);
    const recovered = new IdempotencyLog({ storagePath: path.join(tmp, "journal.json") });
    await recovered.init();
    await assert.rejects(
      recovered.execute("crashed", async () =>
        fs.appendFileSync(path.join(tmp, "effects"), "duplicate\n"),
      ),
      OperationOutcomeUnknownError,
    );
    assert.equal(fs.readFileSync(path.join(tmp, "effects"), "utf8"), "effect\n");
    await recovered.reconcileUnknown("crashed", undefined, { verified: true });
    const reconciled = await recovered.execute("crashed", async () => {
      throw Error("must not re-execute");
    });
    assert.deepEqual(reconciled.result, { verified: true });
    fs.mkdirSync(path.join(tmp, "blocked"));
    const bad = new IdempotencyLog({ storagePath: path.join(tmp, "blocked") });
    let effect = false;
    await assert.rejects(
      bad.execute("unwritable", async () => {
        effect = true;
      }),
    );
    assert.equal(effect, false);
    console.log(
      "PASS completed-operation restart, actual process-crash recovery, payload binding, and fail-closed durability",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { NoiseIKInitiator, NoiseIKResponder } = require("@bimax/core/crypto/noise");
  const { generateX25519Keypair } = require("@bimax/core/crypto/keys");
  const { blake2s } = require(root + "/node_modules/@noble/hashes/blake2.js");
  const ik = generateX25519Keypair(),
    rk = generateX25519Keypair();
  const init = new NoiseIKInitiator({ staticKeypair: ik, remoteStaticPublicKey: rk.publicKey });
  const resp = new NoiseIKResponder({ staticKeypair: rk });
  // Independent specified initialization, including the zero-length prologue.
  resp.initializeSymmetric = function () {
    this.h = blake2s(new TextEncoder().encode("Noise_IK_25519_ChaChaPoly_BLAKE2s"));
    this.ck = new Uint8Array(this.h);
    this.k = null;
    this.n = 0n;
  };
  resp.readMessage1(init.writeMessage1(new Uint8Array()));
  init.readMessage2(resp.writeMessage2(new Uint8Array()));
  init.encrypt(new TextEncoder().encode("lost"));
  const next = init.encrypt(new TextEncoder().encode("next"));
  assert.equal(new TextDecoder().decode(resp.decrypt(next)), "next");
  assert.throws(() => resp.decrypt(next), /replay/);
  assert.throws(() => init.encrypt(new Uint8Array(65520)), /65535/);
  console.log(
    "PASS empty-prologue conformance, packet loss recovery, replay rejection, and Noise size limits",
  );

  const { dispatchIncomingEnvelope } = local("apps/mobile/lib/session/incoming.ts");
  scope.setActiveAccount("account-a");
  const observations = {};
  const approvals = local("apps/mobile/lib/approvals/approvals.ts");
  approvals.clearApprovals();
  const ctx = {
    owner: "account-a",
    isActiveAccount: scope.isActiveAccount,
    deviceId: "phone",
    trustedDesktopId: "desktop",
    onApprovalRequest: (req) => {
      approvals.addApproval(req);
      observations.pending = approvals.getPending();
    },
    onAgentStatus: (status) => {
      observations.status = status;
    },
  };
  for (const from of ["attacker", "desktop"]) {
    dispatchIncomingEnvelope(
      {
        v: 2,
        id: "forged-status",
        ts: Date.now(),
        from,
        to: "phone",
        kind: "agent_status",
        payload: { state: "idle", taskSummary: "forged" },
      },
      ctx,
      false,
    );
    dispatchIncomingEnvelope(
      {
        v: 2,
        id: "forged-approval",
        ts: Date.now(),
        from,
        to: "phone",
        kind: "approval_request",
        payload: {
          approvalId: "forged",
          sessionId: "session",
          tool: "shell",
          summary: "forged",
          detail: "forged",
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60000,
        },
      },
      ctx,
      false,
    );
  }
  assert.equal(observations.status, undefined);
  assert.equal(approvals.getPending().length, 0);
  console.log(
    "PASS raw application message rejection, including spoofed paired-device identifiers",
  );
  await streamChecks();
  await pairing();
  console.log("All audit regression checks passed.");
}
async function pairing() {
  const { Responder } = local("apps/desktop-responder/src/responder.ts"),
    { createIdentity } = local("apps/desktop-responder/src/identity.ts"),
    { FakeEngine } = local("apps/desktop-responder/src/fake-engine.ts");
  const { RelayClient } = local("apps/mobile/lib/relay/client.ts");
  const { PairingManager } = require("@bimax/core/session/session");
  const {
    generateX25519Keypair,
    generateEd25519Keypair,
    ed25519Sign,
  } = require("@bimax/core/crypto/keys");
  const { bytesToBase64 } = require("@bimax/core/crypto/base64");
  const WebSocket = require(root + "/node_modules/ws"),
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bimax-pairing-"));
  const relay = spawn(process.execPath, [root + "/apps/relay/dist/index.js"], {
    cwd: root,
    env: { ...process.env, PORT: "18891", DB_PATH: path.join(tmp, "relay.db") },
    stdio: "ignore",
  });
  let responder, phone;
  async function until(check) {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Loopback deadline");
  }
  try {
    await until(async () => {
      try {
        return (await fetch("http://127.0.0.1:18891/health")).ok;
      } catch {
        return false;
      }
    });
    responder = new Responder({
      hostControls: { setRemoteSessionActive: async () => {}, authorize: async () => true },
      identity: createIdentity(),
      enginePort: new FakeEngine(),
      relayUrl: "ws://127.0.0.1:18891",
      dataDir: path.join(tmp, "desktop"),
    });
    await responder.start();
    await until(() => responder.relayClient.status === "online");
    const ed = generateEd25519Keypair();
    let grant;
    phone = new RelayClient({
      url: responder.pairingManager.getAdvertisement().relayUrl,
      deviceId: "audit-phone",
      role: "mobile",
      wsImpl: WebSocket,
      helloSigner: {
        pubkeyB64: bytesToBase64(ed.publicKey),
        sign: async (msg) => ed25519Sign(ed.privateKey, msg),
      },
      onMessage: (env) => {
        if (env.kind === "pairing_grant") grant = env;
      },
    });
    phone.connect();
    await until(() => phone.status === "online");
    const manager = new PairingManager({
      deviceId: "audit-phone",
      staticKeypair: generateX25519Keypair(),
      helloKeypair: ed,
    });
    phone.send(manager.beginPairing(responder.pairingManager.getAdvertisement()));
    await until(() => !!grant);
    const auditSession = manager.handleGrant(grant);
    phone.send(require("@bimax/core/session/lifecycle").buildTransportConfirmation(auditSession, "audit-phone"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    responder.pairingManager.noteHelloPubkey(
      "audit-phone",
      bytesToBase64(generateEd25519Keypair().publicKey),
    );
    const record = await responder.confirmTrustedPhone(
      responder.pairingManager.getCandidatePairing().verificationCode,
    );
    assert.equal(record.phoneHelloPubkeyB64, bytesToBase64(ed.publicKey));
    console.log(
      "PASS real-socket pairing with transcript-bound signing key and no out-of-band key",
    );
  } finally {
    phone?.close();
    if (responder) await responder.stop();
    const exited = new Promise((r) => relay.once("exit", r));
    relay.kill("SIGKILL");
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function streamChecks() {
  const { streamChat } = local("apps/mobile/lib/gateway.ts");
  const make = (data) => (options) =>
    streamChat(options, {
      getAccessToken: async () => "audit-token",
      getGatewayUrl: () => "https://test.invalid",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(data));
              controller.close();
            },
          }),
        ),
    });
  const options = { model: "deepseek-chat", messages: [{ role: "user", content: "test" }] };
  const complete = await make('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]')(
    options,
  );
  assert.equal(complete.fullContent, "hello");
  await assert.rejects(
    make('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')(options),
    /ended before completion/,
  );
  await assert.rejects(
    make('data: {"error":{"message":"test failure"}}\n\n')(options),
    /test failure/,
  );
  console.log("PASS mobile SSE trailing event, truncated stream, and provider error handling");
}
