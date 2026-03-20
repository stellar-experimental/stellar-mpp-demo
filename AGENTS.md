# MPP Channel Demo — Service Reference

Reference document for building and maintaining this monorepo. Each section covers one service with its boundaries, interfaces, and deployment details.

---

## Service Map

| Service | Path | Runtime | Port (dev) | Purpose |
|---|---|---|---|---|
| Frontend | `packages/frontend` | Cloudflare Worker (TanStack Start) | 3000 | CLI terminal UI, sessionStorage wallet, commitment signing |
| MPP Server | `packages/mpp-server` | Cloudflare Worker (Hono) | 8787 | HTTP 402 gateway (stellar-mpp-sdk + mppx), channel state, settlement |
| AI Worker | `packages/ai-worker` | Cloudflare Worker (Hono) | 8788 | Workers AI inference (streaming) |
| stellar-mpp-sdk | `submodules/stellar-mpp-sdk` | Workspace package | — | Stellar payment method for MPP (channel close, charge) |
| Contract | `submodules/one-way-channel` | Soroban (Stellar Testnet) | — | On-chain channel open/close/settle (git submodule) |

---

## Protocol: MPP (Machine Payments Protocol)

**Spec:** https://paymentauth.org (draft-httpauth-payment-00)

This demo implements a custom `stellar` payment method with `channel` intent. The wire format follows the MPP spec exactly — only the payment method semantics are Stellar-specific.

The server uses `stellar-mpp-sdk` (a workspace package providing the Stellar payment method for `mppx`) to handle settlement via on-chain `close()`. The server uses `mppx` for challenge creation, credential parsing, and receipt generation. The frontend uses `mppx` for credential serialization.

### Header Format

**402 Response:**
```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="<hmac-sha256>", realm="mpp-channel-demo",
  method="stellar", intent="channel",
  request="<base64url({ token, recipient, deposit, channelFactory, refundWaitingPeriod })>",
  expires="<ISO-8601>"
Cache-Control: no-store
Content-Type: application/problem+json
```

**Authorized Request:**
```
POST /chat
Authorization: Payment <base64url({
  challenge: { id, realm, method, intent, request },
  payload: { action, channelId, voucher: { amount, signature } }
})>
Content-Type: application/json
```

**Success Response:**
```
HTTP/1.1 200 OK
Payment-Receipt: <base64url({ status: "success", method: "stellar", timestamp, reference })>
Content-Type: text/event-stream
```

### Credential Payload by Action

| Action | Fields | When |
|---|---|---|
| `open` | `channelId`, `commitmentKey` | First request after channel deployment |
| `voucher` | `channelId`, `voucher: { amount, signature }` | Each subsequent chat message |
| `topup` | `channelId`, `txHash` | After on-chain `top_up()` tx confirms |
| `close` | `channelId`, `voucher?` (optional: tighter final commitment) | User or timer closes channel |

---

## Contract: one-way-channel

**Source:** `stellar-experimental/one-way-channel` (git submodule)

### Lifecycle

```
[*] ──constructor──▶ Open ──close(amt,sig)──▶ Closed
                       │                        │
                       ├──close_start()──▶ Closing ──(wait)──▶ Closed
                       │                     │
                       │                     └──close(amt,sig)──▶ Closed
                       │
                       └──top_up(amt)──▶ Open
```

### Key Functions

| Function | Caller | Purpose |
|---|---|---|
| `open` (factory) | Frontend (account key) | Deploy + fund a new channel |
| `settle(amount, sig)` | MPP Server | Withdraw funds without closing the channel |
| `close(amount, sig)` | MPP Server | Settle with latest commitment and close |
| `close_start()` | Frontend | Force-close if server unresponsive |
| `top_up(amount)` | Frontend (account key) | Add funds to existing channel |
| `refund()` | Frontend | Reclaim after waiting period |
| `prepare_commitment(amount)` | Frontend, MPP Server (via simulation) | XDR bytes to sign |
| `balance()` | Anyone | Current balance |
| `deposited()` | Anyone | Total amount deposited |
| `withdrawn()` | Anyone | Total amount already withdrawn |
| `token()` | Anyone | Token contract address |
| `from()` | Anyone | Funder address |
| `to()` | Anyone | Recipient address (server verifies this on open) |

### Commitment XDR Structure

```rust
ScVal::Map([
    (ScVal::Symbol("amount"),  ScVal::I128(amount)),
    (ScVal::Symbol("channel"), ScVal::Address(contract_address)),
    (ScVal::Symbol("domain"),  ScVal::Symbol("chancmmt")),
    (ScVal::Symbol("network"), ScVal::Bytes(sha256(network_passphrase))),
])
```

Both the frontend and server obtain commitment bytes by simulating `prepare_commitment()` — no manual XDR replication needed. The contract is the single source of truth for the commitment format.

---

## AI Worker Details

**Model:** `@cf/meta/llama-3.2-3b-instruct`

| Property | Value |
|---|---|
| Input cost | $0.051 / M tokens |
| Output cost | $0.335 / M tokens |
| Context window | 80,000 tokens |
| Streaming | SSE (`stream: true`) |
| Max tokens (hardcoded) | 512 |

**System prompt:**
```
You are a helpful, knowledgeable assistant. Answer questions clearly and thoroughly. Provide useful detail and examples where appropriate.
```

**SSE format from Workers AI:**
```
data: {"response":"token text"}\n\n
data: [DONE]\n\n
```

**Wrangler binding:**
```jsonc
{ "ai": { "binding": "AI" } }
```

---

## Frontend: Wallet & Commitment Signing

### Self-Managed Wallet (testnet)
```
On page load:
1. Check sessionStorage for "stellar_secret_key"
2. If absent:
   a. Keypair.random() → store secret in sessionStorage
   b. Fund via testnet Friendbot (GET https://friendbot.stellar.org?addr=<public>)
3. If present: Keypair.fromSecret(storedSecret)
4. This keypair signs all transactions directly (no wallet extension)
```

### Commitment Signing
The critical path for zero-latency payments. After channel open, NO further wallet interactions. Uses `@stellar/stellar-sdk` `Keypair` for all ed25519 operations (no extra crypto deps needed).

```
1. Generate commitment keypair: Keypair.random() → commitmentKeypair
2. toHex(commitmentKeypair.rawPublicKey()) becomes commitment_key in channel constructor
3. For each message:
   a. preAuthAmount = cumulativeAmount + maxCostPerMessage (up to 512 tokens * 10k stroops)
   b. commitAmount = min(preAuthAmount, deposit) — can't exceed channel deposit
   c. Simulate prepare_commitment(commitAmount) on channel contract via Soroban RPC
   d. bytes = simulation result (authoritative commitment bytes from contract)
   e. signature = commitmentKeypair.sign(bytes)
   f. Include { amount: commitAmount, signature } in MPP credential as voucher
   g. After streaming, server reports actual cost; update cumulativeAmount accordingly
```

**Commitment bytes via simulation** (using @stellar/stellar-sdk):
```js
import { Contract, TransactionBuilder, Account, nativeToScVal, rpc } from '@stellar/stellar-sdk';

async function getCommitmentBytes(server, channelAddress, amount, networkPassphrase) {
  const contract = new Contract(channelAddress);
  const source = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase })
    .addOperation(contract.call('prepare_commitment', nativeToScVal(amount, { type: 'i128' })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return rpc.Api.isSimulationSuccess(sim)
    ? sim.result.retval.bytes()
    : null;
}
```

---

## Environment Variables & Secrets

### MPP Server (`packages/mpp-server`)
| Name | Type | Description |
|---|---|---|
| `MPP_SECRET_KEY` | Secret | HMAC key for challenge ID generation |
| `SERVER_STELLAR_SECRET` | Secret | Server's Stellar secret key (for close tx) |
| `SERVER_STELLAR_ADDRESS` | Var | Server's Stellar public address (channel recipient) |
| `CHANNEL_FACTORY_ID` | Var | Deployed factory contract address |
| `STELLAR_RPC_URL` | Var | Soroban RPC endpoint (testnet) |
| `STELLAR_NETWORK_PASSPHRASE` | Var | `Test SDF Network ; September 2015` |
| `TOKEN_CONTRACT_ID` | Var | SAC token contract (native XLM on testnet) |
| `CHANNEL_MANAGER` | Durable Object Binding | Durable Object for per-channel state management |
| `AI_WORKER_URL` | Var | URL of the AI Worker endpoint |

### AI Worker (`packages/ai-worker`)
| Name | Type | Description |
|---|---|---|
| `AI` | AI Binding | Workers AI |

### Frontend (`packages/frontend`)

No environment variables. All configuration is hardcoded in `src/lib/config.ts` (MPP server URL, factory contract ID, token contract ID, network passphrase, etc.). The frontend uses the MPP server's `/rpc` endpoint as a CORS proxy for Soroban RPC calls.

---

## Deployment

All three TypeScript services deploy to Cloudflare Workers.

```bash
# From repo root
pnpm run deploy:all
```

Contract deployment uses Stellar CLI:
```bash
cd submodules/one-way-channel
stellar contract build
stellar contract install --wasm target/wasm32-unknown-unknown/release/one_way_channel.wasm --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/channel_factory.wasm --network testnet -- --admin <key> --wasm_hash <hash>
```

## Root Workflows

```bash
pnpm dev
pnpm run dev:frontend
pnpm run dev:mpp-server
pnpm run dev:ai-worker

pnpm run test:unit
pnpm run test:smoke:local
pnpm run test:smoke:remote
pnpm run test:smoke:browser:local
pnpm run test:smoke:browser:remote
```

The protocol smoke test is the canonical lifecycle verification. It exercises health checks, the 402 challenge flow, real channel open, two paid chats, top-up, close, close tx reporting, and channel cleanup.

---

## Reference Links

| Resource | URL |
|---|---|
| MPP Spec | https://paymentauth.org |
| MPP Homepage | https://mpp.dev |
| mpp-proxy (Cloudflare) | https://github.com/cloudflare/mpp-proxy |
| mppx SDK (wevm) | https://github.com/wevm/mppx |
| stellar-mpp-sdk (workspace package, upstream) | https://github.com/stellar-experimental/stellar-mpp-sdk |
| one-way-channel contract | https://github.com/stellar-experimental/one-way-channel |
| Cloudflare Workers AI | https://developers.cloudflare.com/workers-ai/ |
| Stellar Testnet Friendbot | https://friendbot.stellar.org |
| Stellar Expert (testnet) | https://stellar.expert/explorer/testnet |
