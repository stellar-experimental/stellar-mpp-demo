# MPP Channel Demo — Implementation Plan

## Phase 0: Monorepo Setup

**Goal:** Restructure from single TanStack app to pnpm workspace monorepo.

1. Create `pnpm-workspace.yaml` with `packages/*`
2. Move existing TanStack Start app into `packages/frontend/`
3. Scaffold `packages/mpp-server/` — Hono + Cloudflare Worker
4. Scaffold `packages/ai-worker/` — Hono + Cloudflare Worker with AI binding
5. Add `stellar-experimental/one-way-channel` as a git submodule at `packages/contract/`
6. Root `package.json` with shared scripts: `dev`, `build`, `deploy`
7. Verify all three workers run locally with `wrangler dev`

**Deliverable:** `pnpm dev` starts all services. Each has its own `wrangler.jsonc`.

---

## Phase 1: AI Worker (Simplest Service First)

**Goal:** A working streaming AI endpoint with no auth.

1. Set up `wrangler.jsonc` with `[ai]` binding
2. Single Hono route: `POST /generate`
   - Accept `{ messages: [{role, content}], max_tokens? }`
   - Clamp `max_tokens` to 512 ceiling
   - Prepend system prompt
   - Call `env.AI.run("@cf/meta/llama-3.2-3b-instruct", { messages, stream: true, max_tokens })`
   - Return `ReadableStream` as `text/event-stream`
3. Test with curl: `curl -X POST http://localhost:8788/generate -d '{"messages":[{"role":"user","content":"hello"}]}'`

**Deliverable:** Streaming AI responses from local worker.

---

## Phase 2: Contract Deployment

**Goal:** Channel factory and channel WASM deployed to Stellar testnet.

1. Review cloned `one-way-channel` contract code
2. Install Stellar CLI and Rust toolchain if not present
3. Build contracts: `stellar contract build`
4. Deploy channel WASM: `stellar contract install --wasm target/.../one_way_channel.wasm --network testnet`
5. Deploy factory contract: `stellar contract deploy --wasm target/.../channel_factory.wasm --network testnet -- --admin <deployer> --wasm_hash <channel_wasm_hash>`
6. Record factory contract ID and channel WASM hash
7. Create a test channel manually via CLI to validate the full lifecycle:
   - `open` via factory → simulate `prepare_commitment` → sign → `close` → verify settlement
   - Test `top_up` on the opened channel, verify `balance()` reflects new amount
8. Store deployed addresses in `deployed.json` at the repo root

**Deliverable:** Factory contract on testnet. Validated open/sign/close cycle.

---

## Phase 3: MPP Server

**Goal:** Payment gateway that issues 402 challenges and validates Stellar commitments.

### 3a: SDK Setup
1. Include `stellar-mpp-sdk` as a workspace package, install `mppx`, use `@stellar/stellar-sdk` v14
2. Use `mppx` for protocol serialization: `Challenge` (HMAC-bound), `Credential.fromRequest()`, `Receipt`
3. Use `close()` from `stellar-mpp-sdk/channel/server` for on-chain settlement
4. Use Cloudflare Durable Objects for per-channel state management (with alarm-based auto-close)

### 3b: Challenge/Credential Protocol
1. Implement 402 challenge flow using `mppx`:
   - `Challenge.serialize()` — builds `WWW-Authenticate: Payment` header with HMAC-bound `id`
   - `Credential.fromRequest()` — parses `Authorization: Payment` header
   - `Receipt.serialize()` — builds `Payment-Receipt` header
2. Route: `POST /chat` — if no credential, return 402 with challenge

### 3c: Channel Verification (Custom Action Dispatch)
1. On `action: "open"`:
   - Verify channel contract via Soroban RPC simulation: `to()`, `balance()`, `token()` getters
   - Store channel state in Durable Object, set auto-close alarm at TTL
2. On `action: "voucher"`:
   - Simulate `prepare_commitment(amount)` to get authoritative commitment bytes
   - Verify ed25519 signature, enforce monotonically increasing cumulative amounts
   - Proxy to AI Worker via HTTP fetch to `AI_WORKER_URL`, count tokens in stream, append usage event, record actual spend
3. On `action: "topup"`:
   - Call `balance()` via simulation to verify on-chain increase, update Durable Object state, reset TTL and alarm
4. On `action: "close"`:
   - Use `close()` from `stellar-mpp-sdk/channel/server` to submit Soroban settlement tx
   - Clear Durable Object state, return settlement receipt to frontend

**Deliverable:** Fully functional 402 gateway. Curl test: first request → 402, request with valid credential → AI stream.

---

## Phase 4: Frontend Terminal UI

**Goal:** Monochrome CLI interface with wallet integration and channel management.

### 4a: Terminal Shell
1. Strip the existing TanStack Start template to a single route
2. Build terminal component:
   - Output area (scrollable div, monospace)
   - Input line with blinking cursor
   - Status bar (channel state, balance, timer)
3. Style: black bg, white text, no borders, no gradients, no icons
4. Command parser: `/open`, `/close`, `/topup`, `/balance`, `/help`, or plain text → chat

### 4b: Wallet & Channel
1. On page load, initialize self-managed wallet:
   - Check `sessionStorage` for `stellar_secret_key`
   - If absent: `Keypair.random()` → fund via testnet Friendbot → store secret in `sessionStorage`
   - If present: restore `Keypair.fromSecret()`
2. On `/open`:
   - Generate ephemeral ed25519 keypair for commitment signing via `Keypair.random()`
   - Build factory `open()` transaction
   - Sign directly with account keypair (no wallet popup)
   - Submit to testnet
   - Parse result for deployed channel contract ID
   - Start 2-minute countdown timer
3. Store ephemeral commitment keypair in memory (never persisted)

### 4c: Chat with MPP
1. On chat message:
   - Calculate new pre-authorized amount = cumulative + maxCostPerMessage (up to 512 tokens)
   - Simulate `prepare_commitment(cumulative)` on channel contract via Soroban RPC
   - Sign returned commitment bytes with ephemeral key
   - Encode credential using `Credential.serialize()` from `mppx`
   - `POST /chat` with `Authorization: Payment <credential>` and `{ message }` body
2. Parse SSE stream:
   - Read chunks, extract `data:` lines
   - Append tokens to terminal output character by character
   - Update credit counter as tokens arrive (visual burn effect)
3. On `/close`:
   - Send credential with `action: "close"`
   - Display settlement result

### 4d: Edge Cases
1. Timer expires: auto-close via Durable Object alarm settles on-chain; frontend cleans up session
2. Credits exhausted: prompt user to `/topup` or `/close`
   - `/topup`: build `top_up(deposit)` tx → sign with account key → submit → send `action: "topup"` credential → query on-chain balance → reset timer → continue
   - `/close`: send close credential, display settlement
3. Network error during stream: display error, allow retry
4. Friendbot funding fails: display error, allow retry on reload
5. Already has open channel: reject `/open`, show existing channel info

**Deliverable:** Full end-to-end demo working locally.

---

## Phase 5: Polish & Deploy

1. Deploy AI Worker to Cloudflare
2. Deploy MPP Server to Cloudflare
3. Deploy Frontend to Cloudflare
4. Configure custom domain (optional)
5. Test full flow on deployed environment
6. Add welcome message to terminal explaining the demo
7. Add a "View on Stellar Expert" link for the settlement transaction

**Deliverable:** Live, shareable demo URL.

---

## Dependency Graph

```
Phase 0 (monorepo)
    ├── Phase 1 (ai-worker) ──────────────────┐
    ├── Phase 2 (contract) ───┐                │
    │                         ▼                ▼
    │                    Phase 3 (mpp-server) ──┤
    │                                          │
    │                         ┌────────────────┘
    │                         ▼
    └──────────────────► Phase 4 (frontend)
                              │
                              ▼
                         Phase 5 (deploy)
```

Phases 1 and 2 can be done in parallel. Phase 3 depends on both. Phase 4 depends on Phase 3. Phase 5 depends on all.

---

## Key Libraries

| Package | Service | Purpose |
|---|---|---|
| `hono` | mpp-server, ai-worker | Cloudflare Worker framework |
| `stellar-mpp-sdk` | mpp-server (workspace package) | Stellar channel payment method for MPP |
| `mppx` | mpp-server, frontend | MPP protocol SDK (challenges, credentials, receipts) |
| `@stellar/stellar-sdk` | mpp-server, frontend | Transaction building, XDR, ed25519 |
| `@tanstack/react-start` | frontend | SSR React framework |
| `tailwindcss` | frontend | Terminal styling |

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| `prepare_commitment` bytes incorrect | Eliminated: both frontend and server simulate `prepare_commitment()` via Soroban RPC instead of replicating XDR construction |
| Friendbot rate limiting | Cache funded keypair in sessionStorage; only call Friendbot on first visit |
| Stellar testnet instability | Graceful error messages, retry logic on tx submission |
| AI model unavailability | Fallback error message, don't deduct credits on AI failure |
| Channel state lost (worker restart) | Durable Objects persist state; auto-close alarm ensures settlement; on loss, sender can `close_start()` for refund |
