// test/auth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from "jose";
import { verifyAuth, sha256Hex } from "../src/auth";
import { createTestEnv } from "./mocks";

describe("auth module", () => {
  let publicKeyJwk: JWK;
  let privateKey: KeyLike;
  let otherPrivateKey: KeyLike;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-kid-1";
    jwk.alg = "RS256";
    jwk.use = "sig";
    publicKeyJwk = jwk;

    const otherPair = await generateKeyPair("RS256");
    otherPrivateKey = otherPair.privateKey;
  });

  it("rejects when Authorization header is missing", async () => {
    const { env } = createTestEnv();
    const req = new Request("http://localhost/v1/chat/completions");
    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });

  it("rejects when Authorization header does not match Bearer <key> format", async () => {
    const { env } = createTestEnv();
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Basic 12345" },
    });
    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });

  it("rejects key with incorrect length or characters", async () => {
    const { env } = createTestEnv();
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer not-a-valid-key" },
    });
    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });

  it("rejects when valid hex key is not in KV GATEWAY_KEYS (KV miss)", async () => {
    const { env } = createTestEnv();
    const randomKey = "a".repeat(64);
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${randomKey}` },
    });
    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });

  it("authenticates successfully when key SHA-256 exists in KV (KV hit)", async () => {
    const { env, mockKeysKV } = createTestEnv();
    const validKey = "0123456789abcdef".repeat(4); // 64 hex chars
    const hash = await sha256Hex(validKey);

    await mockKeysKV.put(hash, "user_alpha");

    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${validKey}` },
    });

    const result = await verifyAuth(req, env);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user_alpha");
    expect(result?.keyHash).toBe(hash);
  });

  it("authenticates successfully with valid Supabase RS256 JWT using sub as userId", async () => {
    const { env } = createTestEnv({
      TEST_JWKS: { keys: [publicKeyJwk] } as any,
    });

    const jwt = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setSubject("user_supabase_12345")
      .setIssuer("https://test-project.supabase.co/auth/v1")
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(privateKey);

    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    const result = await verifyAuth(req, env);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user_supabase_12345");
  });

  it("rejects Supabase JWT with invalid signature (wrong key)", async () => {
    const { env } = createTestEnv({
      TEST_JWKS: { keys: [publicKeyJwk] } as any,
    });

    const jwt = await new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setSubject("attacker_sub")
      .setIssuer("https://test-project.supabase.co/auth/v1")
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(otherPrivateKey);

    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });

  it("rejects expired Supabase JWT", async () => {
    const { env } = createTestEnv({
      TEST_JWKS: { keys: [publicKeyJwk] } as any,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ email: "expired@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
      .setSubject("expired_sub")
      .setIssuedAt(nowSeconds - 7200)
      .setExpirationTime(nowSeconds - 3600)
      .sign(privateKey);

    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    const result = await verifyAuth(req, env);
    expect(result).toBeNull();
  });
});
