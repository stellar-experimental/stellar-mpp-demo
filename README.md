# MPP Channel Demo

A web-based demo showcasing Stellar payment channels via the MPP (Machine Payments Protocol). Users interact with a monochrome CLI-style terminal to open a unidirectional payment channel on Soroban, chat with a Cloudflare AI bot behind an HTTP 402-gated endpoint, and watch their channel credits burn in real-time as tokens stream back.

## Architecture

```
Frontend (CLI Terminal) ──HTTP──▶ MPP Server (402 Gateway) ──HTTP──▶ AI Worker (Workers AI)
        │                                │
        │ Stellar SDK                    │ Stellar SDK
        ▼                                ▼
              Stellar Testnet (Soroban)
         Channel Factory + Channel Instances
```

## Monorepo Structure

```
packages/
├── frontend/           # CLI terminal web UI (TanStack Start + Cloudflare Workers)
├── mpp-server/         # MPP protocol gateway with HTTP 402 (Hono + Cloudflare Workers)
└── ai-worker/          # Cloudflare Workers AI inference (Hono)
submodules/
├── stellar-mpp-sdk/    # Stellar payment method for MPP (workspace package)
└── one-way-channel/    # Soroban one-way-channel + factory (Rust, git submodule)
```

## Getting Started

```bash
pnpm install
pnpm dev
```

This starts all three services concurrently:
- Frontend: http://localhost:3000
- MPP Server: http://localhost:8787
- AI Worker: http://localhost:8788

Useful root commands:

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
pnpm run deploy:all
```

## How It Works

1. User types `/open` in the terminal
2. Frontend fetches a 402 challenge from the MPP server
3. Frontend opens a payment channel on Stellar testnet via the factory contract
4. User chats freely — each message is paid with an off-chain signed commitment (no on-chain tx)
5. Tokens stream back via SSE, credits burn per-token in real-time
6. When done, `/close` settles on-chain: recipient gets paid, remainder refunded

The only on-chain transactions are open, top-up, and close. Everything in between is signed commitments over HTTP.

## Terminal Commands

- `/open` — Open a payment channel and start a session
- `/close` — Close the channel and settle on-chain
- `/topup` — Add more credits to the active channel
- `/balance` — Show current channel balance and spend
- `/help` — List commands
- (any text) — Send as a chat message to the AI

## Contract Coverage

This demo exercises the core happy-path of the channel contract: open, off-chain commitments, top-up, and close. Several contract methods are **not** showcased:

### Incremental Settlement (`settle`)

The contract supports withdrawing earned funds on-chain without closing the channel. The recipient calls `settle(amount, sig)` — same signature verification as `close`, but the channel stays open for continued use. This is useful for long-lived channels where the recipient wants to periodically sweep earnings.

### Funder Dispute Resolution (`close_start` + `refund`)

If the recipient/server goes offline, the funder can initiate `close_start()` which begins a waiting period (`refund_waiting_period` ledgers). The recipient can still call `close` during this window. Once the waiting period elapses, the funder calls `refund()` to reclaim the remaining balance. This is the funder's safety net for recovering unspent funds.

### Additional Getters (`from`, `deposited`, `withdrawn`, `refund_waiting_period`)

The contract exposes getters for the funder address, total deposited amount, total withdrawn amount, and the refund waiting period. The demo uses `balance`, `to`, and `token` but not these.

See [submodules/one-way-channel/README.md](submodules/one-way-channel/README.md) for the full contract API, state diagram, and security model.

## Testing

The repo keeps two smoke-test layers:

- `pnpm run test:smoke:local` and `pnpm run test:smoke:remote` run the protocol smoke test in TypeScript without browser automation. They verify health checks, 402 challenge flow, real channel open, two paid chats, top-up, close, close tx reporting, and channel cleanup.
- `pnpm run test:smoke:browser:local` and `pnpm run test:smoke:browser:remote` run the browser-driven smoke test for terminal/UI behavior and end-to-end interaction coverage.
- `pnpm run test:unit` runs the package-level Vitest suites across the workspace.

## Deployment

All TypeScript services deploy to Cloudflare Workers:

```bash
pnpm run deploy:all
```

See [SPEC.md](SPEC.md) for the full specification, [AGENTS.md](AGENTS.md) for service reference, and [PLAN.md](PLAN.md) for the implementation plan.
