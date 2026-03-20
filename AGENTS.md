# MPP Channel Demo — Service Reference

Reference document for building and maintaining this monorepo. Each section covers one service with its boundaries, interfaces, and deployment details.

---

## Service Map

| Service | Path | Runtime | Port (dev) | Purpose |
|---|---|---|---|---|
| Frontend | `packages/frontend` | Cloudflare Worker (TanStack Start) | 5173 | CLI terminal UI, sessionStorage wallet, commitment signing |
| MPP Server | `packages/mpp-server` | Cloudflare Worker (Hono) | 8787 | HTTP 402 gateway (stellar-mpp-sdk + mppx), channel state, settlement |
| AI Worker | `packages/ai-worker` | Cloudflare Worker (Hono) | 8788 | Workers AI inference (streaming) |
| Contract | `packages/contract` | Soroban (Stellar Testnet) | — | On-chain channel open/close/settle |

---

## Protocol: MPP (Machine Payments Protocol)

**Spec:** https://paymentauth.org (draft-httpauth-payment-00)

This demo implements a custom `stellar` payment method with `channel` intent. The wire format follows the MPP spec exactly — only the payment method semantics are Stellar-specific.

The server uses `stellar-mpp-sdk` (the official Stellar payment method for `mppx`) to handle challenge creation, credential verification, and settlement. The frontend uses `mppx` for credential serialization.

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
| `open` | `channelId`, `commitmentKey`, `txHash`, `voucher` | First request after channel deployment |
| `voucher` | `channelId`, `voucher: { amount, signature }` | Each subsequent chat message |
| `topup` | `channelId`, `txHash` | After on-chain `top_up()` tx confirms |
| `close` | `channelId`, `voucher` (final) | User or timer closes channel |

---

## Contract: one-way-channel

**Source:** Cloned from `stellar-experimental/one-way-channel`

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
| `close(amount, sig)` | MPP Server | Settle with latest commitment |
| `close_start()` | Frontend | Force-close if server unresponsive |
| `top_up(amount)` | Frontend (account key) | Add funds to existing channel |
| `refund()` | Frontend | Reclaim after waiting period |
| `prepare_commitment(amount)` | (reference only) | XDR bytes to sign |
| `balance()` | Anyone | Current balance |
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
| Max tokens (hardcoded) | 150 |

**System prompt:**
```
You are a helpful assistant in a payment channel demo. Keep responses concise and informative. You are demonstrating that AI services can be paid for using micropayment channels on the Stellar network.
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
2. commitmentKeypair.publicKey() becomes commitment_key in channel constructor
3. For each message:
   a. cumulative += 100
   b. Simulate prepare_commitment(cumulative) on channel contract via Soroban RPC
   c. bytes = simulation result (authoritative commitment bytes from contract)
   d. signature = commitmentKeypair.sign(bytes)
   e. Include { amount: cumulative, signature } in MPP credential
```

**Commitment bytes via simulation** (using @stellar/stellar-sdk):
```js
import { Contract, TransactionBuilder, SorobanRpc, nativeToScVal } from '@stellar/stellar-sdk';

async function getCommitmentBytes(server, account, channelAddress, amount) {
  const contract = new Contract(channelAddress);
  const tx = new TransactionBuilder(account, { fee: '0', networkPassphrase })
    .addOperation(contract.call('prepare_commitment', nativeToScVal(amount, { type: 'i128' })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return SorobanRpc.Api.isSimulationSuccess(sim)
    ? sim.result.retval.toXDR()
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
| `CHANNEL_STATE` | KV Binding | KV namespace for channel state |
| `AI_WORKER_URL` | Var | URL of the AI Worker endpoint |

### AI Worker (`packages/ai-worker`)
| Name | Type | Description |
|---|---|---|
| `AI` | AI Binding | Workers AI |

### Frontend (`packages/frontend`)
| Name | Type | Description |
|---|---|---|
| `VITE_MPP_SERVER_URL` | Build var | MPP Server URL |
| `VITE_CHANNEL_FACTORY_ID` | Build var | Factory contract address |
| `VITE_STELLAR_RPC_URL` | Build var | Soroban RPC endpoint |
| `VITE_TOKEN_CONTRACT_ID` | Build var | Token contract ID |

---

## Deployment

All three TypeScript services deploy to Cloudflare Workers.

```bash
# From repo root
pnpm --filter ai-worker deploy        # Deploy AI Worker first
pnpm --filter mpp-server deploy       # Then MPP Server
pnpm --filter frontend deploy         # Then Frontend
```

Contract deployment uses Stellar CLI:
```bash
cd packages/contract
stellar contract build
stellar contract install --wasm target/wasm32-unknown-unknown/release/one_way_channel.wasm --network testnet
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/channel_factory.wasm --network testnet -- --admin <key> --wasm_hash <hash>
```

---

## Reference Links

| Resource | URL |
|---|---|
| MPP Spec | https://paymentauth.org |
| MPP Homepage | https://mpp.dev |
| mpp-proxy (Cloudflare) | https://github.com/cloudflare/mpp-proxy |
| mppx SDK (wevm) | https://github.com/wevm/mppx |
| stellar-mpp-sdk | https://github.com/stellar-experimental/stellar-mpp-sdk |
| one-way-channel contract | https://github.com/stellar-experimental/one-way-channel |
| Cloudflare Workers AI | https://developers.cloudflare.com/workers-ai/ |
| Stellar Testnet Friendbot | https://friendbot.stellar.org |
| Stellar Expert (testnet) | https://stellar.expert/explorer/testnet |
