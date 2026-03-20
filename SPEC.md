# MPP Channel Demo — Specification

A web-based demo that showcases Stellar payment channels via the MPP (Machine Payments Protocol). Users interact with a monochrome CLI-style terminal to open a unidirectional payment channel on Soroban, chat with a Cloudflare AI bot behind an HTTP 402-gated endpoint, and watch their channel credits burn in real-time as tokens stream back. Channels can be topped up to continue indefinitely; when done, the channel closes and settles on-chain.

## Purpose

Demonstrate that once a payment channel is open, subsequent payments are **instant and off-chain** — no per-request on-chain transactions, no latency, no fees. The only on-chain events are open and close. Top-ups are the one exception — a single on-chain tx that extends a channel's spending power without reopening. Everything in between is signed commitments flowing over HTTP using the MPP protocol.

This directly addresses the core x402 criticism: on-chain tx + verification per API call is too expensive for multi-call workflows. Channels solve this.

## Architecture Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │      │                 │
│    Frontend     │─────▶│   MPP Server    │─────▶│   AI Worker     │
│  (CLI Terminal) │ HTTP │ (402 Gateway)   │ HTTP │ (Workers AI)    │
│                 │◀─────│                 │◀─────│                 │
└────────┬────────┘      └────────┬────────┘      └─────────────────┘
         │                        │
         │ Stellar SDK            │ Stellar SDK
         │ (sessionStorage key)   │
         ▼                        ▼
┌─────────────────────────────────────────────┐
│          Stellar Testnet (Soroban)          │
│  ┌─────────────┐  ┌──────────────────────┐ │
│  │   Channel    │  │   Channel Factory    │ │
│  │  (instance)  │  │   (deployer)         │ │
│  └─────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────┘
```

All inter-service communication is plain HTTP.

## Monorepo Structure

```
mpp-channel-demo/
├── packages/
│   ├── frontend/           # CLI terminal web UI
│   ├── mpp-server/         # MPP protocol gateway (HTTP 402)
│   ├── ai-worker/          # Cloudflare Workers AI inference
│   └── contract/           # Soroban one-way-channel + factory
├── SPEC.md
├── PLAN.md
├── AGENTS.md
├── package.json            # pnpm workspace root
└── pnpm-workspace.yaml
```

Each package is independently deployable. Frontend is a Cloudflare Worker (TanStack Start). MPP Server and AI Worker are Hono-based Cloudflare Workers. Contract is Rust/Soroban.

---

## Service Descriptions

### 1. Frontend (`packages/frontend`)

**Stack:** TanStack Start, React, Tailwind CSS, deployed on Cloudflare Workers

A single-page web app styled as a monochrome CLI terminal.

**Visual design:**
- Pure black background (`#000`)
- White monospace text (system `ui-monospace` / fallback `Courier New`)
- No color except: dim gray for system messages, white for user input
- Blinking cursor on the input line
- Auto-scrolling output area
- Status bar at top showing channel state, balance, and timer

**Terminal commands:**
- `/open` — Deploy channel (using sessionStorage wallet), start session
- `/close` — Manually close the channel and settle
- `/topup` — Add more credits to the active channel
- `/balance` — Show current channel balance and spend
- `/help` — List commands
- (any other text) — Send as a chat message to the AI

**Wallet (self-managed, testnet only):**
- On page load, checks `sessionStorage` for a Stellar secret key
- If absent, generates a new `Keypair.random()`, funds it via testnet Friendbot, stores the secret in `sessionStorage`
- This keypair is the **account key** — signs channel open transactions directly (no wallet popup)
- Additionally generates an ephemeral ed25519 `Keypair.random()` for commitment signing (separate from account key)
- The ephemeral public key is the `commitment_key` passed to the channel contract

**MPP client logic (built into frontend):**
- On first chat request, receives 402 with `WWW-Authenticate: Payment` challenge
- Opens a channel on Soroban (account key signs the factory `open()` tx directly)
- For each message: simulates `prepare_commitment(cumulative_amount)` via Soroban RPC to get the exact commitment bytes, signs them with ephemeral key, encodes the credential using `mppx` `Credential.serialize()`
- Tracks cumulative committed amount locally
- When credits are exhausted, prompts user to top up — submits `top_up(amount)` tx on-chain, then notifies server
- Handles channel close (user-initiated or timer expiry)

**Credit burn visualization:**
- Before each message, commits `cumulative + max_cost_per_message` credits
- As tokens stream in, the UI shows a real-time counter: `[▓▓▓▓▓▓░░░░] 720/1000 credits remaining`
- On stream completion, the actual cost is displayed
- When credits reach zero:
  ```
  Credits exhausted (1000/1000 used).
  Top up 1000 credits to continue? [y/n] _
  ```
- On `y`: submit `top_up` tx → update balance → reset timer → resume chatting

### 2. MPP Server (`packages/mpp-server`)

**Stack:** Hono, Cloudflare Worker, `stellar-mpp-sdk` + `mppx`, `@stellar/stellar-sdk`

The payment gateway. Implements the server side of the MPP protocol (per paymentauth.org spec) with a custom `stellar` payment method using the Soroban one-way-channel for settlement.

**Endpoints:**
- `POST /chat` — The 402-gated chat endpoint
  - No credential → 402 with `WWW-Authenticate: Payment` challenge
  - Valid credential → proxy to AI Worker via HTTP, stream response back
- `GET /health` — Public health check
- `GET /channel/:id` — Get channel status (balance, time remaining, message count)

**MPP protocol implementation:**

Challenge (returned on 402):
```
WWW-Authenticate: Payment id="<hmac>", realm="mpp-channel-demo",
  method="stellar", intent="channel",
  request="<base64url of { token, recipient, deposit, channelFactory, refundWaitingPeriod }>"
```

Credential (sent by client):
```
Authorization: Payment <base64url of {
  challenge: { id, realm, method, intent, request },
  payload: {
    action: "open" | "voucher" | "topup" | "close",
    channelId: "<contract address>",
    commitmentKey: "<ed25519 pubkey>",  // only on "open"
    txHash: "<opening tx hash>",        // only on "open"
    voucher: { amount: "<cumulative>", signature: "<ed25519 sig>" }
  }
}>
```

Receipt (returned on success):
```
Payment-Receipt: <base64url of { status: "success", method: "stellar", timestamp, reference }>
```

**Channel state management:**
- Uses Cloudflare KV to track active channels:
  - `channelId` → `{ contractAddress, commitmentKey, cumulativeAmount, lastVoucherSig, deposit, messageCount, openedAt, expiresAt }`
- Uses `mppx` for protocol serialization: `Challenge` (HMAC-bound via `MPP_SECRET_KEY`), `Credential.fromRequest()` for parsing, `Receipt` for responses
- On `action: "open"`: verifies the channel contract via Soroban RPC simulation — calls `to()`, `balance()`, and `token()` getters to confirm the contract pays the server in the expected token with the claimed balance
- On `action: "voucher"`: simulates `prepare_commitment(amount)` to get authoritative commitment bytes, verifies ed25519 signature against commitment key, enforces monotonically increasing cumulative amounts
- On `action: "topup"`: verifies top-up tx, calls `balance()` to refresh on-chain balance, resets channel TTL
- On close: uses `close()` from `stellar-mpp-sdk/channel/server` to build and submit the Soroban settlement tx

**Cost model:**
- Cost per message: 100 credits (fixed, pre-authorized before AI call)
- Channel deposit: 1000 credits (allows ~10 messages)
- 1 credit = configurable stroop amount (default: 10,000 stroops = 0.001 XLM)
- Total channel value: ~1 XLM on testnet (free from friendbot)

**Safety limits:**
- max_tokens per AI response: 150
- Channel TTL: 120 seconds
- Rate limit: 1 message per 3 seconds per channel

### 3. AI Worker (`packages/ai-worker`)

**Stack:** Hono, Cloudflare Worker with Workers AI binding

A minimal worker that does one thing: call Cloudflare Workers AI and stream the response. No payment logic, no auth — the MPP Server handles all of that.

**Model:** `@cf/meta/llama-3.2-3b-instruct`
- Fast inference (3B params)
- Cheap: $0.051/M input tokens, $0.335/M output tokens
- Supports streaming (SSE)
- 80K context window

**Endpoint:**
- `POST /generate` — Accepts `{ messages: [{role, content}], max_tokens }`, returns SSE stream
- System prompt: "You are a helpful assistant in a payment channel demo. Keep responses concise and informative. You are demonstrating that AI services can be paid for using micropayment channels on the Stellar network."

**Response format (SSE):**
```
data: {"response":"Hello","p":"..."}\n\n
data: {"response":" there","p":"..."}\n\n
...
data: [DONE]\n\n
```

**Cost protection:**
- Hardcoded `max_tokens: 150` ceiling (server overrides any client value above this)
- No conversation history beyond current message + system prompt (limits input tokens)
- Estimated max cost per channel: ~1500 output tokens * $0.335/M = $0.0005 (~$0.05/100 channels)

### 4. Contract (`packages/contract`)

**Stack:** Rust, Soroban SDK

Cloned from `stellar-experimental/one-way-channel`. Two contracts:

**one-way-channel** — A single payment channel instance:
- `__constructor(token, from, commitment_key, to, amount, refund_waiting_period)` — Deploy and fund
- `close(amount, sig)` — Recipient closes with signed commitment, receives `amount`, remainder refunded
- `close_start()` — Sender initiates force-close (starts waiting period)
- `refund()` — Sender reclaims after waiting period
- `top_up(amount)` — Add more funds
- `prepare_commitment(amount)` — Returns XDR bytes to sign off-chain
- `balance()` — Current channel balance
- `token()` — Token contract address
- `from()` — Funder address
- `to()` — Recipient address
- `refund_waiting_period()` — Waiting period in ledgers

**channel-factory** — Deploys channel instances:
- `__constructor(admin, wasm_hash)` — Initialize with channel WASM
- `open(salt, token, from, commitment_key, to, amount, refund_waiting_period)` — Deploy a new channel

**Commitment format (XDR):**
```
ScVal::Map([
  ("amount", ScVal::I128(amount)),
  ("channel", ScVal::Address(contract_address)),
  ("domain", ScVal::Symbol("chancmmt")),
  ("network", ScVal::Bytes(network_passphrase_hash))
])
```

Ed25519 signature over these serialized bytes. Verified on-chain at close time.

**Deployment target:** Stellar Testnet (network passphrase: `Test SDF Network ; September 2015`)

---

## End-to-End Flow

### Phase 1: Discovery (402 Challenge)

```
1. User types a chat message in the terminal
2. Frontend POSTs to MPP Server: POST /chat { message: "hello" }
3. MPP Server has no credential → responds 402:
   WWW-Authenticate: Payment ... method="stellar", intent="channel"
   Body: { type: "payment-required", detail: "Open a payment channel to chat" }
4. Frontend parses challenge, displays: "Payment required. Opening channel..."
```

### Phase 2: Channel Open

```
5. Frontend generates ephemeral ed25519 keypair (commitment_key)
6. Frontend loads account key from sessionStorage (already funded via Friendbot)
7. Frontend builds a transaction calling channel-factory.open(
     salt, token, user_address, commitment_key, server_address, 1000_credits, 24_ledgers
   )
8. Transaction signed with account key directly (no wallet popup)
9. Transaction submitted to Stellar testnet, channel contract deployed
10. Frontend stores: channelId, ephemeral private key, deposit amount
11. Frontend displays: "Channel opened. 1000 credits loaded. Timer: 2:00"
```

### Phase 3: Chat Loop (Off-Chain Micropayments)

```
12. Frontend signs a commitment: amount = cumulative + 100 (cost per message)
    - Builds commitment XDR bytes matching prepare_commitment format
    - Signs with ephemeral private key
13. Frontend POSTs to MPP Server:
    POST /chat
    Authorization: Payment <credential with action="voucher", amount, signature>
    Body: { message: "hello" }
14. MPP Server validates:
    - Signature matches commitment_key
    - Amount > previous cumulative amount
    - Channel not expired
    - Message count < max
15. MPP Server proxies to AI Worker via HTTP
16. AI Worker streams response back through MPP Server to Frontend
17. Frontend displays streaming tokens, updates credit counter
18. MPP Server stores latest valid commitment
19. Repeat from step 12 for each message
```

### Phase 3.5: Top-Up (When Credits Exhaust)

```
Trigger: cumulative amount would exceed channel balance

20. Frontend displays: "Credits exhausted. Top up 1000 credits? [y/n]"
21. User confirms → Frontend builds top_up(1000) transaction on the channel contract
22. Signed with account key, submitted to Stellar testnet
23. Frontend sends credential with action="topup", txHash to MPP Server
24. MPP Server calls balance() via simulation to verify new on-chain balance
25. Server updates KV state: new deposit amount, resets expiresAt
26. Frontend resets timer, resumes chat loop from step 12
```

### Phase 4: Channel Close & Settlement

```
Trigger: user types /close, timer expires, or credits exhausted

27. MPP Server calls close(final_amount, final_signature) on the channel contract
28. Contract transfers final_amount to server, remainder to user
29. Frontend displays: "Channel closed. Settled: 700 credits spent, 300 refunded."
30. UI shows final receipt with on-chain transaction link
```

---

## Key Design Decisions

### Why MPP over raw x402?
MPP is the IETF-track standardization of HTTP 402 payment authentication. Using MPP means this demo is protocol-compliant and interoperable with the mppx ecosystem (Cloudflare's mpp-proxy, wevm's mppx SDK). The `stellar` payment method we implement here could be upstreamed to mppx as a first-class method.

### Why separate MPP Server from AI Worker?
Separation of concerns. The AI Worker is a standalone HTTP service — it could be hosted anywhere (another cloud, a local server, a third-party API), not just as a Cloudflare Worker. The MPP Server calls it via a plain HTTP fetch, with no bespoke bindings or platform-specific coupling. The MPP Server is a generic payment gateway — it could gate any HTTP service, not just AI. The AI Worker is a generic inference endpoint — it could be swapped for any provider. Independence is the point. The `stellar-mpp-sdk` and `mppx` libraries handle all MPP protocol plumbing — challenge creation, credential verification, receipt generation — so the MPP Server is mostly configuration, not custom protocol code.

### Why pre-authorize max cost per message?
Commitments are signed before the request (not during streaming). This avoids the complexity of signing per-token during streaming. The commitment authorizes up to `cost_per_message` credits. Actual token count is tracked server-side; unused portion stays in the channel as credit for future messages.

### Why a sessionStorage wallet instead of Freighter?
This is a CLI-style agentic demo, not a typical dApp with wallet popups. Using a self-managed keypair (generated on page load, funded via testnet Friendbot) makes the flow fully autonomous — no extension install, no approval dialogs, no UX friction. The secret lives in `sessionStorage` so it's scoped to the tab and cleared on close. Since this is testnet-only, there's no real value at risk.

### Why ephemeral commitment keys?
The one-way-channel contract uses a separate ed25519 key for commitment signing, distinct from the Stellar account key. This means after the initial channel open, all subsequent messages are signed instantly. This is the "zero-latency" in practice.

### Why a channel factory?
Deploying a WASM contract per channel without a factory requires the user to have the contract WASM. The factory holds the WASM hash and deploys instances with a simple `open()` call. This is how the `stellar-experimental/one-way-channel` repo structures it.

### Why Llama 3.2 3B?
The cheapest model that still produces quality chat responses. At $0.051/M input and $0.335/M output tokens, even 100 demo sessions cost < $0.05 total. The 3B size gives fast inference (~100ms first token) while being conversational enough for a demo.

### Why stellar-mpp-sdk + mppx?
`mppx` (by wevm) is the MPP protocol SDK — it handles challenge HMAC generation, credential serialization/parsing, and receipt creation. `stellar-mpp-sdk` provides the `close()` function for on-chain Soroban settlement. Together they handle the protocol plumbing and settlement, while our server adds the custom action dispatch (open/voucher/topup/close) and channel verification logic specific to the demo's dynamic channel flow. On the client side, `mppx` provides `Credential.serialize()` for encoding the Authorization header, while the frontend retains explicit control over the 402 flow for interactive UI feedback.

### Why simulate `prepare_commitment` instead of replicating XDR in JavaScript?
The contract's `prepare_commitment(amount)` returns the exact bytes that must be signed for a valid commitment. By calling it via `simulateTransaction` (a free, read-only Soroban RPC call), both the frontend and server get authoritative commitment bytes directly from the contract. This eliminates the entire class of XDR construction mismatch bugs — which was previously the #1 implementation risk. Simulation adds ~100-200ms per call, but this is categorically different from submitting an on-chain transaction: no gas, no block confirmation, no fees.

### Why top-up instead of opening a new channel?
Opening a new channel requires deploying a new contract (expensive on-chain tx), generating new commitment keys, and re-doing the 402 handshake. Top-up is a single `top_up(amount)` call on the existing contract — same channel, same commitment key, same server state. The conversation continues without interruption. This showcases that payment channels are long-lived infrastructure, not disposable per-session artifacts.

---

## Constraints & Guardrails

| Constraint | Value | Rationale |
|---|---|---|
| Channel TTL | 120 seconds | Keeps demo snappy, prevents idle channels |
| Max tokens per response | 150 | Bounds AI cost per message |
| Cost per message | 100 credits | Simple, predictable pricing |
| Channel deposit | 1000 credits | ~10 messages worth |
| Rate limit | 1 msg / 3 sec | Prevents spam/abuse |
| Refund waiting period | 24 ledgers (~2 min) | Matches channel TTL |
| Top-up amount | 1000 credits | Same as initial deposit, extends TTL |
| Concurrent channels per wallet | 1 | Simplifies state management |

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Friendbot funding fails | Display error, allow retry (or generate new keypair) |
| Channel open tx fails | Display Stellar error, allow retry |
| Invalid commitment signature | 402 with `verification-failed` problem type |
| Channel expired mid-message | Complete current stream, then close. Next request gets 402 (or top up to extend) |
| AI Worker error | Return 502 to frontend, do NOT deduct credits |
| Credits exhausted | Prompt user to top up; if declined, close channel and settle |
| Channel already closed | 402 with fresh challenge (open new channel) |
| Network disconnect during stream | Frontend reconnects, resumes from last known state |
| Server crash with unsettled channel | Channel stays open; sender can `close_start()` after waiting period |

---

## Out of Scope (for this demo)

- Production Stellar mainnet deployment
- Real USDC or any mainnet tokens
- Multi-party channels or bidirectional payments
- Persistent conversation history across channels
- User accounts or authentication beyond sessionStorage keypair
- Mobile-responsive design (desktop terminal only)
