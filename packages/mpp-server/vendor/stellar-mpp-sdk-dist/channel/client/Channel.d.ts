import { Keypair } from '@stellar/stellar-sdk';
import { Method } from 'mppx';
import { z } from 'zod/mini';
/**
 * Creates a Stellar one-way-channel method for use on the **client**.
 *
 * Instead of building a full Soroban transaction per payment, the client
 * signs an ed25519 commitment authorising the recipient to close the channel and receive up
 * to a cumulative amount from the on-chain channel contract.
 *
 * @example
 * ```ts
 * import { Keypair } from '@stellar/stellar-sdk'
 * import { Mppx } from 'mppx/client'
 * import { stellar } from 'stellar-mpp-sdk/channel/client'
 *
 * Mppx.create({
 *   methods: [
 *     stellar.channel({
 *       commitmentKey: Keypair.fromSecret('S...'),
 *     }),
 *   ],
 * })
 * ```
 */
export declare function channel(parameters: channel.Parameters): Method.Client<{
    readonly name: "stellar";
    readonly intent: "channel";
    readonly schema: {
        readonly credential: {
            readonly payload: z.ZodMiniObject<{
                amount: z.ZodMiniString<string>;
                signature: z.ZodMiniString<string>;
            }, z.core.$strip>;
        };
        readonly request: z.ZodMiniObject<{
            amount: z.ZodMiniString<string>;
            channel: z.ZodMiniString<string>;
            description: z.ZodMiniOptional<z.ZodMiniString<string>>;
            externalId: z.ZodMiniOptional<z.ZodMiniString<string>>;
            methodDetails: z.ZodMiniOptional<z.ZodMiniObject<{
                reference: z.ZodMiniOptional<z.ZodMiniString<string>>;
                network: z.ZodMiniOptional<z.ZodMiniString<string>>;
                cumulativeAmount: z.ZodMiniOptional<z.ZodMiniString<string>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
}, z.ZodMiniObject<{
    /** Override the cumulative amount to commit. */
    cumulativeAmount: z.ZodMiniOptional<z.ZodMiniString<string>>;
}, z.core.$strip>>;
export declare namespace channel {
    type ProgressEvent = {
        type: 'challenge';
        channel: string;
        amount: string;
        cumulativeAmount: string;
    } | {
        type: 'signing';
    } | {
        type: 'signed';
        cumulativeAmount: string;
    };
    type Parameters = {
        /** Ed25519 secret key (S...) for signing commitments. Provide either this or `commitmentKey`. */
        commitmentSecret?: string;
        /** Stellar Keypair for signing commitments. Provide either this or `commitmentSecret`. */
        commitmentKey?: Keypair;
        /** Custom Soroban RPC URL. Defaults based on network. */
        rpcUrl?: string;
        /**
         * Funded Stellar account address (G...) used as the source for
         * read-only transaction simulations. If omitted, the commitment
         * key's public key is used, which requires it to be a funded account.
         */
        sourceAccount?: string;
        /** Callback invoked at each lifecycle stage. */
        onProgress?: (event: ProgressEvent) => void;
    };
}
//# sourceMappingURL=Channel.d.ts.map