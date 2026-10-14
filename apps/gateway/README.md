# Bimax Gateway v1

AI Gateway Worker for Bimax (OpenAI-compatible `POST /v1/chat/completions`, streaming SSE passthrough, per-user token metering in D1, monthly quota enforcement, per-minute rate limiting).

## Setup & Secrets

### 1. Provider Secrets
Provider API keys are stored in Cloudflare Worker secrets and NEVER checked into source control:

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put QWEN_API_KEY
npx wrangler secret put NVIDIA_API_KEY   # Testing upstream (NVIDIA NIM)
```

#### Provider Routing Rules:
- **NVIDIA NIM (Testing Upstream)**: Any model ID containing `/` (e.g., `meta/llama-3.1-8b-instruct`) routes to `https://integrate.api.nvidia.com/v1/chat/completions` using `NVIDIA_API_KEY`. This check takes precedence so org/model identifiers route to NIM rather than misrouting.
- **DeepSeek (Launch Provider)**: Model IDs starting with `deepseek` (e.g. `deepseek-chat`) without a slash route to `https://api.deepseek.com/chat/completions` using `DEEPSEEK_API_KEY`.
- **Qwen (Launch Provider)**: Model IDs starting with `qwen` (e.g. `qwen-plus`, `qwen-turbo`) without a slash route to `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions` using `QWEN_API_KEY`.

For local testing without live provider accounts, start the worker with mock upstream mode:
```bash
MOCK_UPSTREAM=1 npx wrangler dev --local
```

### 2. D1 Database Setup
Create the D1 database:
```bash
npx wrangler d1 create bimax_gateway
```
Apply the schema locally or in production:
```bash
# Local
npx wrangler d1 execute bimax_gateway --local --file=./schema.sql

# Production
npx wrangler d1 execute bimax_gateway --remote --file=./schema.sql
```

### 3. KV Namespaces
Create KV namespaces for keys and rate limiting:
```bash
npx wrangler kv:namespace create GATEWAY_KEYS
npx wrangler kv:namespace create GATEWAY_RATELIMIT
```
Update the IDs in `wrangler.toml` accordingly.

### 4. Minting User API Keys (v1 Stub)
Generate a 32-byte hex API key and insert its SHA-256 hash into KV:
```bash
node scripts/mint-key.mjs user_123
# Run the printed wrangler kv:key put command
```
*(Note: In PROMPT-18, authentication moves to Supabase JWT verification alongside this seam).*

---

## Monthly Token Budget Math (~₹100 / User)

### Business Model
* User subscription: ₹200 / month
* Model allocation: ~50% = **₹100 / month** (~$1.18 USD at ₹85/USD)

### Launch Models & Published Pricing
1. **DeepSeek-Chat (DeepSeek-V3)**:
   * Input (cache miss): $0.14 per 1M tokens (Cache hit: $0.014 / 1M)
   * Output: $0.28 per 1M tokens
2. **Qwen (DashScope Alibaba Cloud)**:
   * **Qwen-Plus**: Input $0.11 / 1M tokens; Output $0.28 / 1M tokens
   * **Qwen-Turbo**: Input $0.04 / 1M tokens; Output $0.16 / 1M tokens

### Blended Ratio & Cost Calculation
Assuming a typical chat conversation traffic mix of **75% input (prompts + conversation history) and 25% output (model completions)**:
* **DeepSeek-Chat Blended**:
  `0.75 * $0.14 + 0.25 * $0.28 = $0.105 + $0.070 = $0.175` per 1M tokens
* **Qwen-Plus Blended**:
  `0.75 * $0.11 + 0.25 * $0.28 = $0.0825 + $0.070 = $0.1525` per 1M tokens
* **Qwen-Turbo Blended**:
  `0.75 * $0.04 + 0.25 * $0.16 = $0.030 + $0.040 = $0.070` per 1M tokens

Taking a conservative blended estimate across DeepSeek and Qwen of **$0.25 per 1M tokens** (accounting for variance in output length and un-cached context):
$$\text{Token Budget} = \frac{\$1.18}{\$0.25 \times 10^{-6}} \approx 4,720,000\text{ tokens}$$

Applying a safety buffer for fair-use margin yields a round default quota of:
$$\mathbf{4,000,000\text{ tokens/month}}\quad (\text{env: } \texttt{DEFAULT\_MONTHLY\_TOKENS=4000000})$$
