# Bimax Mobile — Prompt #1: Monorepo scaffold + protocol v1 + Expo boot

Copy everything below the line into Antigravity as one prompt.

---

You are scaffolding the Bimax mobile companion app. Bimax is a desktop AI coding agent (Electron + TypeScript engine). The mobile app is a COMPANION REMOTE: it does NOT run the agent. It pairs with the desktop, shows live sessions, streams transcripts, and approves/denies tool calls via push. One codebase for Android + iOS.

STACK (exact, do not substitute):
- Node.js 20 LTS, npm workspaces (no pnpm/bun/yarn)
- TypeScript 5.x, strict: true
- Expo SDK 53, React Native 0.79 (New Architecture), Expo Router v4
- ESLint with eslint-config-expo (flat config) + Prettier
- packages/protocol: pure TypeScript types, ZERO runtime dependencies

TASK:
1. Create this layout:
   bimax-mobile/
     package.json            (npm workspaces: packages/*, apps/*; scripts: "typecheck": "tsc --noEmit", "lint": "eslint .")
     tsconfig.base.json      (strict: true, ES2022, moduleResolution: "bundler")
     eslint.config.cjs       (EXACT contents given below)
     .prettierrc             (EXACT contents given below)
     packages/protocol/
       package.json          (name @bimax/protocol, version 0.1.0, types field -> src/index.ts, NO dependencies)
       tsconfig.json         (extends the base config)
       src/index.ts          (EXACT contents given below - byte-identical, do not reformat the logic)
       README.md             (one line: "Owned by the architect. Do not edit without approval.")
     apps/mobile/
       (scaffold with: npx create-expo-app apps/mobile, then add TypeScript + expo-router per the official Expo docs)
       app/index.tsx         (placeholder screen rendering the text "Bimax Mobile - scaffold OK", and importing a TYPE from @bimax/protocol, e.g. `import type { SessionSummary } from "@bimax/protocol"`, used in a dummy const so the import is not elided)

2. Root devDependencies: eslint, eslint-config-expo, prettier, typescript.
   If the Expo template generates its own eslint config inside apps/mobile, delete it — the root eslint.config.cjs is the only one.

3. eslint.config.cjs must contain EXACTLY this:

const { defineConfig } = require("eslint/config");
const expo = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expo,
  { ignores: ["**/dist/**", "**/node_modules/**"] },
]);

4. .prettierrc must contain EXACTLY this:

{
  "printWidth": 100,
  "singleQuote": false,
  "trailingComma": "all"
}

5. The file packages/protocol/src/index.ts must contain EXACTLY this (do not add, remove, or rename anything):

/**
 * @bimax/protocol v1 — wire protocol between the Bimax desktop engine
 * and the mobile companion app.
 *
 * PURE TYPES ONLY. No runtime code, no dependencies.
 * This package is owned by the architect. Do not edit without approval.
 */

export const PROTOCOL_VERSION = 1 as const;

/* ---------------- transport envelope ---------------- */

export type DeviceRole = "desktop" | "mobile";

export interface Envelope<TKind extends string, TPayload> {
  v: typeof PROTOCOL_VERSION; // protocol version
  id: string;                 // client-generated stable id — idempotency key for retries
  ts: number;                 // unix millis, sender clock
  from: string;               // sender device id (public identifier)
  kind: TKind;                // message kind
  payload: TPayload;
}

/* ---------------- pairing ---------------- */

export interface PairingAdvertisement {
  // Encoded in the QR code shown by the desktop app. `ref` rotates ~20s.
  relayUrl: string;
  ref: string;
  desktopDeviceId: string;
  desktopPublicKey: string; // base64 X25519
  app: "bimax";
}

export interface PairingRequest {
  ref: string;
  mobileDeviceId: string;
  mobilePublicKey: string; // base64 X25519
}

export interface PairingGrant {
  mobileDeviceId: string;
  grantedAt: number;
}

export interface PairingRevoke {
  mobileDeviceId: string;
  revokedAt: number;
  reason: string;
}

/* ---------------- presence ---------------- */

export type PresenceStatus = "online" | "away" | "offline";

export interface Presence {
  deviceId: string;
  role: DeviceRole;
  status: PresenceStatus;
  lastSeen: number; // unix millis
}

/* ---------------- sessions ---------------- */

export type SessionStatus =
  | "running"
  | "paused"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "killed";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  repo?: string;
}

export interface SessionList {
  sessions: SessionSummary[];
}

export type TranscriptRole = "user" | "assistant" | "tool";

export interface TranscriptChunk {
  sessionId: string;
  seq: number; // per-session sequence; client buffers and orders by seq
  role: TranscriptRole;
  text: string;
  at: number;
}

/* ---------------- tool approvals ---------------- */

export interface ToolApprovalRequest {
  approvalId: string; // idempotency key for the decision
  sessionId: string;
  tool: string;       // e.g. "OS_COMMAND"
  summary: string;     // human-readable: what it wants to do
  detail: string;      // full command / arguments
  cwd?: string;
  requestedAt: number;
  expiresAt: number;   // expiry => treated as denied
}

export type ApprovalDecisionValue = "approved" | "denied";

export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecisionValue;
  decidedAt: number;
  denyReason?: "not_me" | "mistake"; // "not_me" raises a security alert
  signature: string; // base64 Ed25519 over canonical bytes; desktop verifies
}

/* ---------------- commands: mobile -> desktop ---------------- */

export type MobileCommandKind =
  | "send_message"
  | "pause"
  | "resume"
  | "kill"
  | "request_approval_list";

export interface MobileCommand {
  kind: MobileCommandKind;
  sessionId: string;
  text?: string; // for send_message
  idempotencyKey: string;
}

export interface CommandAck {
  idempotencyKey: string;
  ok: boolean;
  error?: string;
}

/* ---------------- errors ---------------- */

export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
}

6. Wire the workspace so `npx tsc --noEmit` at the repo root typechecks BOTH packages with zero errors.

SCOPE — DO NOT DO:
- No relay server code. No pairing UI. No screens beyond the placeholder. No auth, no push setup, no native modules, no Sentry, no analytics.
- Do not add any dependency beyond: the Expo default template set, typescript, eslint, eslint-config-expo, prettier.
- Do not modify the protocol file, eslint.config.cjs, or .prettierrc contents in any way. If something looks wrong in them, note it in your return — do not "fix" it.

ACCEPTANCE (run each, paste the full terminal output):
1. `npm install` at the repo root → exit 0
2. `npx tsc --noEmit` at the repo root → zero errors
3. `npx eslint .` at the repo root → zero errors
4. `npx expo --version` inside apps/mobile → prints a version

RETURN FOR REVIEW (paste all five):
1. The file tree you created
2. The FULL text of packages/protocol/src/index.ts (it will be diffed byte-for-byte)
3. The root package.json, packages/protocol/package.json, and apps/mobile/package.json
4. eslint.config.cjs and .prettierrc as created
5. The terminal output of the four acceptance commands
