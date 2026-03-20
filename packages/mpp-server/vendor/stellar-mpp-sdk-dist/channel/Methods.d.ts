import { z } from 'zod/mini';
/**
 * Stellar one-way payment channel intent.
 *
 * Instead of settling each payment on-chain, the funder signs
 * cumulative commitments off-chain. The recipient can close the channel
 * on-chain at any time using the latest commitment.
 *
 * @see https://github.com/stellar-experimental/one-way-channel
 */
export declare const channel: {
    readonly name: "stellar";
    readonly intent: "channel";
    readonly schema: {
        readonly credential: {
            readonly payload: z.ZodMiniObject<{
                /** Cumulative amount authorised by this commitment (base units). */
                amount: z.ZodMiniString<string>;
                /** Ed25519 signature over the commitment bytes (128 hex chars). */
                signature: z.ZodMiniString<string>;
            }, z.core.$strip>;
        };
        readonly request: z.ZodMiniObject<{
            /** Incremental payment amount in base units (stroops). */
            amount: z.ZodMiniString<string>;
            /** On-chain channel contract address (C...). */
            channel: z.ZodMiniString<string>;
            /** Optional human-readable description. */
            description: z.ZodMiniOptional<z.ZodMiniString<string>>;
            /** Merchant-provided reconciliation ID. */
            externalId: z.ZodMiniOptional<z.ZodMiniString<string>>;
            /** Method-specific details injected by the server. */
            methodDetails: z.ZodMiniOptional<z.ZodMiniObject<{
                /** Server-generated unique tracking ID. */
                reference: z.ZodMiniOptional<z.ZodMiniString<string>>;
                /** Stellar network identifier ("public" | "testnet"). */
                network: z.ZodMiniOptional<z.ZodMiniString<string>>;
                /** Cumulative amount already committed up to this point (base units). */
                cumulativeAmount: z.ZodMiniOptional<z.ZodMiniString<string>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
};
//# sourceMappingURL=Methods.d.ts.map