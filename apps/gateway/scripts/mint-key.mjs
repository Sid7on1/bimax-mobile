#!/usr/bin/env node
import crypto from "node:crypto";

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: node scripts/mint-key.mjs <userId>");
  process.exit(1);
}

// 32 random bytes hex-encoded (64 hex characters)
const rawKey = crypto.randomBytes(32).toString("hex");
const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

console.log("=== Bimax Gateway API Key Minted ===");
console.log(`User ID: ${userId}`);
console.log(`API Key (show ONCE, give to user):`);
console.log(rawKey);
console.log("");
console.log(`Key SHA-256 Hash: ${keyHash}`);
console.log("");
console.log("To store in Cloudflare KV (Production):");
console.log(`wrangler kv:key put --binding=GATEWAY_KEYS "${keyHash}" "${userId}"`);
console.log("");
console.log("To store in Cloudflare KV (Local dev):");
console.log(`wrangler kv:key put --binding=GATEWAY_KEYS --local "${keyHash}" "${userId}"`);
console.log("");
console.log("Note: Production issuance moves to Supabase signup in PROMPT-18.");
