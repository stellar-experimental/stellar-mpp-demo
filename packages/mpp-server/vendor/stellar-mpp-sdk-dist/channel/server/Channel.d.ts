import { Keypair } from '@stellar/stellar-sdk';
import { Method, Store } from 'mppx';
import { type NetworkId } from '../../constants.js';
/**
 * Creates a Stellar one-way-channel method for use on the **server**.
 *
 * The server:
 * 1. Issues challenges with the channel contract address and cumulative amount
 * 2. Verifies commitment signatures against the channel's commitment key
 * 3. Optionally closes the channel and settles funds on-chain
 *
 * @example
 * ```ts
 * import { stellar } from 'stellar-mpp-sdk/channel/server'
 * import { Mppx } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   secretKey: 'my-secret',
 *   methods: [
 *     stellar.channel({
 *       channel: 'C...',          // on-chain channel contract
 *       commitmentKey: 'GABC...', // ed25519 public key for verifying commitments
 *     }),
 *   ],
 * })
 * ```
 */
export declare function channel(parameters: channel.Parameters): Method.Server<{
    readonly name: "stellar";
    readonly intent: "channel";
    readonly schema: {
        readonly credential: {
            readonly payload: import("zod/mini").ZodMiniObject<{
                amount: import("zod/mini").ZodMiniString<string>;
                signature: import("zod/mini").ZodMiniString<string>;
            }, import("zod/v4/core").$strip>;
        };
        readonly request: import("zod/mini").ZodMiniObject<{
            amount: import("zod/mini").ZodMiniString<string>;
            channel: import("zod/mini").ZodMiniString<string>;
            description: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            externalId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            methodDetails: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniObject<{
                reference: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                network: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                cumulativeAmount: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            }, import("zod/v4/core").$strip>>;
        }, import("zod/v4/core").$strip>;
    };
}, {
    readonly channel: string;
}, undefined>;
/**
 * Close the channel contract on-chain using a signed commitment.
 * Transfers the committed amount to the recipient and auto-refunds
 * the remaining balance to the funder. This is a server-side
 * administrative operation.
 */
export declare function close(parameters: {
    /** Channel contract address. */
    channel: string;
    /** Commitment amount to close with. */
    amount: bigint;
    /** Ed25519 signature for the commitment. */
    signature: Uint8Array;
    /** Keypair to sign the close transaction. */
    closeKey: Keypair;
    /** Network identifier. */
    network?: NetworkId;
    /** Custom RPC URL. */
    rpcUrl?: string;
}): Promise<string>;
export declare namespace channel {
    type Parameters = {
        /** On-chain channel contract address (C...). */
        channel: string;
        /**
         * Ed25519 public key for verifying commitment signatures.
         * Accepts a Stellar public key string (G...) or a Keypair instance.
         */
        commitmentKey: string | Keypair;
        /** Number of decimal places for amount conversion. @default 7 */
        decimals?: number;
        /** Stellar network. @default 'testnet' */
        network?: NetworkId;
        /** Custom Soroban RPC URL. */
        rpcUrl?: string;
        /**
         * Funded Stellar account address (G...) used as the source for
         * read-only transaction simulations. If omitted, the commitment
         * key's public key is used, which requires it to be a funded account.
         */
        sourceAccount?: string;
        /** Store for replay protection and cumulative amount tracking. */
        store?: Store.Store;
    };
}
//# sourceMappingURL=Channel.d.ts.map