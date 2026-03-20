# WTF Is This Demo?

This is an **HTTP 402 + MPP + Stellar payment channel terminal**.

You are talking to an AI service that can get paid **inside the request flow itself**. Instead of asking your wallet to approve every prompt, the app opens a **one-way Stellar channel** once, then uses **signed off-chain vouchers** while the model streams.

## Why It Hits

- **402 is real.** The server can require payment before doing work.
- **MPP gives the handshake structure.** The payment challenge and credential follow a standard shape.
- **Stellar makes it fast.** You do not send an on-chain tx for every message.
- **Streaming still feels instant.** The server already has a signed upper bound before it starts generating.
- **Settlement gets compressed.** Open once, chat a few times, settle once.

## The Moving Parts

- **Frontend:** makes a testnet wallet, opens the channel, signs vouchers, and renders the terminal.
- **MPP server:** issues 402 challenges, verifies credentials, tracks channel state, and closes on-chain.
- **AI worker:** streams model output.
- **Channel contract:** escrows funds and lets the server claim up to the latest valid signed amount.

## The Core Idea

MPP is the payment-aware HTTP wrapper.

1. You hit `/chat` with no payment.
2. The server returns **402 Payment Required** with a `WWW-Authenticate: Payment ...` challenge.
3. That challenge says "pay me with the `stellar` method using a `channel` flow."
4. The client answers with `Authorization: Payment ...` carrying a verifiable credential.

So the request is not "I promise I’ll pay." It is "Here is the payment proof answering your challenge."

## The Stellar Part

On first load, the frontend creates a **temporary Stellar testnet wallet** and funds it with Friendbot.

When you run `/open`, it:

1. Creates a second temporary **commitment keypair**.
2. Deploys and funds a **channel contract**.
3. Sets the server as recipient.
4. Stores the commitment public key in the channel.

That split matters:

- the wallet key handles channel funding and lifecycle actions
- the commitment key signs spend updates
- after open, normal chats need **no wallet interaction**

## What The Voucher Means

Each chat sends a signed message that says, in effect:

> "This channel may now pay the server up to X stroops."

That message is the **voucher**.

The contract itself generates the exact bytes to sign through `prepare_commitment(amount)`. Both sides use those bytes, so the contract is the source of truth for what a valid commitment is.

The amount is **cumulative**.

If the first chat authorizes `18,000` stroops and the second reaches `31,000`, the second voucher says `31,000`, not "add 13,000 more." The server only needs the latest valid voucher.

## Typical Flow

### `/open`

- client requests a 402 challenge
- client opens and funds the Stellar channel
- client sends an MPP `open` credential
- server records the channel and starts its timer

Result: funds are locked, spend is still zero.

### `chat`

- client estimates the max response cost
- client simulates `prepare_commitment(maxAmount)`
- client signs the returned bytes with the commitment key
- client sends a `voucher` credential plus the prompt
- server verifies first, then streams AI tokens
- UI burns credits as tokens arrive
- final spend updates from the actual token count

Result: the server can stream immediately because it already has a signed spending cap.

### `/topup`

- client sends on-chain `top_up()`
- client sends an MPP `topup` credential with the tx hash
- server refreshes balance and resets the timer

Result: same channel, more runway.

### `chat`

Same flow again, but with a higher cumulative authorized amount.

### `/close`

- client can send one final tighter voucher
- client sends an MPP `close` credential
- server submits `close(amount, sig)` on-chain
- contract pays the server and closes the channel

Result: many streamed AI turns settle with one final on-chain close.

## The Punchline

This demo makes AI billing feel like **protocol behavior**, not checkout behavior:

**402 challenge -> channel open -> off-chain signed vouchers -> streamed AI -> top-up if needed -> final on-chain close**

That is the point of the whole thing:

- standard HTTP semantics
- real cryptographic payment authorization
- near-zero friction after open
- on-chain enforcement only when it matters

It is a concrete preview of what **machine-to-machine paid APIs** can look like when payment is built directly into the request lifecycle.
