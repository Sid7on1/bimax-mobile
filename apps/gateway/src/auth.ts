// src/auth.ts
import {
  createRemoteJWKSet,
  createLocalJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JSONWebKeySet,
} from "jose";

export interface Env {
  DB: D1Database;
  GATEWAY_KEYS: KVNamespace;
  GATEWAY_RATELIMIT: KVNamespace;
  ALLOWED_MODELS?: string;
  DEFAULT_MONTHLY_TOKENS?: string;
  RATE_LIMIT_PER_MIN?: string;
  DEEPSEEK_API_KEY?: string;
  QWEN_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  MOCK_UPSTREAM?: string;
  SUPABASE_URL?: string;
  TEST_JWKS?: JSONWebKeySet;
  MODEL_PRICES_JSON?: string;
  RELAY_TICKET_SECRET?: string;
  MAX_OUTPUT_TOKENS?: string;
  ALLOWED_ORIGINS?: string;
  GLOBAL_MONTHLY_MICROUSD?: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!match || !match[1]) {
    return null;
  }
  return match[1];
}

let cachedRemoteJWKS: { url: string; getKey: JWTVerifyGetKey } | null = null;

function getJWKSGetter(env: Env): JWTVerifyGetKey | null {
  if (env.TEST_JWKS) {
    return createLocalJWKSet(env.TEST_JWKS);
  }

  if (env.SUPABASE_URL) {
    const jwksUrl = `${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
    if (cachedRemoteJWKS && cachedRemoteJWKS.url === jwksUrl) {
      return cachedRemoteJWKS.getKey;
    }
    const getKey = createRemoteJWKSet(new URL(jwksUrl));
    cachedRemoteJWKS = { url: jwksUrl, getKey };
    return getKey;
  }

  return null;
}

/**
 * Verifies Bearer credentials:
 * 1. 3 dot-separated segments -> Supabase RS256 JWT path (user_id = JWT sub).
 * 2. 64-hex characters -> 32-byte API key looked up by SHA-256 hash in GATEWAY_KEYS.
 * 3. Invalid or expired token -> returns null (401).
 */
export async function verifyAuth(
  request: Request,
  env: Env,
): Promise<{ userId: string; keyHash: string } | null> {
  const rawToken = extractBearerToken(request);
  if (!rawToken) {
    return null;
  }

  // 1. Supabase JWT Path (token with 3 dot-separated segments)
  const segments = rawToken.split(".");
  if (segments.length === 3) {
    const getKey = getJWKSGetter(env);
    if (!getKey) {
      return null;
    }

    try {
      const { payload } = await jwtVerify(rawToken, getKey, {
        algorithms: ["RS256", "ES256"],
        issuer: `${env.SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1`,
        audience: "authenticated",
        requiredClaims: ["sub", "exp", "iat", "iss", "aud"],
      });

      if (typeof payload.sub === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(payload.sub)) {
        const keyHash = await sha256Hex(payload.sub);
        return { userId: payload.sub, keyHash };
      }
      return null;
    } catch {
      return null;
    }
  }

  // 2. 64-hex API key Bearer path
  if (/^[0-9a-fA-F]{64}$/.test(rawToken)) {
    const normalizedKey = rawToken.toLowerCase();
    const keyHash = await sha256Hex(normalizedKey);
    const userId = await env.GATEWAY_KEYS.get(keyHash);
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
      return null;
    }
    return { userId, keyHash };
  }

  return null;
}
