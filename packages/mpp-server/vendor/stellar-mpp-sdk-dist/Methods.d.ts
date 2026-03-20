import { z } from 'zod/mini';
/**
 * Stellar charge intent for one-time SAC token transfers.
 *
 * Supports two credential flows:
 * - `type: "transaction"` — **server-broadcast** (pull mode):
 *   Client signs a Soroban SAC `transfer` invocation and sends
 *   the serialised XDR. The server broadcasts it.
 * - `type: "signature"` — **client-broadcast** (push mode):
 *   Client broadcasts itself and sends the transaction hash.
 *   The server looks it up on-chain for verification.
 *
 * @see https://stellar.org
 */
export declare const charge: {
    readonly name: "stellar";
    readonly intent: "charge";
    readonly schema: {
        readonly credential: {
            readonly payload: z.ZodMiniDiscriminatedUnion<[z.ZodMiniObject<{
                hash: z.ZodMiniString<string>;
                type: z.ZodMiniLiteral<"signature">;
            }, z.core.$strip>, z.ZodMiniObject<{
                xdr: z.ZodMiniString<string>;
                type: z.ZodMiniLiteral<"transaction">;
            }, z.core.$strip>], "type">;
        };
        readonly request: z.ZodMiniObject<{
            /** Payment amount in base units (stroops). */
            amount: z.ZodMiniString<string>;
            /** SAC contract address (C...) for the token to transfer. */
            currency: z.ZodMiniString<string>;
            /** Recipient Stellar public key (G...) or contract address (C...). */
            recipient: z.ZodMiniString<string>;
            /** Optional human-readable description. */
            description: z.ZodMiniOptional<z.ZodMiniString<string>>;
            /** Merchant-provided reconciliation ID (e.g. order ID, invoice number). */
            externalId: z.ZodMiniOptional<z.ZodMiniString<string>>;
            /** Method-specific details injected by the server. */
            methodDetails: z.ZodMiniOptional<z.ZodMiniObject<{
                /** Server-generated unique tracking ID. */
                reference: z.ZodMiniOptional<z.ZodMiniString<string>>;
                /** Stellar network identifier ("public" | "testnet"). */
                network: z.ZodMiniOptional<z.ZodMiniString<string>>;
                /** Optional memo text to attach to the transaction. */
                memo: z.ZodMiniOptional<z.ZodMiniString<string>>;
                /** Whether the server will sponsor transaction fees. */
                feePayer: z.ZodMiniOptional<z.ZodMiniBoolean<boolean>>;
                /** Public key of the server's fee payer account. */
                feePayerKey: z.ZodMiniOptional<z.ZodMiniString<string>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
};
/**
 * Convert a human-readable amount to base units (stroops).
 *
 * @example
 * ```ts
 * toBaseUnits('0.01', 7) // '100000'
 * toBaseUnits('1', 7)    // '10000000'
 * ```
 */
export declare function toBaseUnits(amount: string, decimals: number): string;
/**
 * Convert base units (stroops) back to a human-readable amount.
 *
 * @example
 * ```ts
 * fromBaseUnits('100000', 7)  // '0.0100000'
 * ```
 */
export declare function fromBaseUnits(baseUnits: string, decimals: number): string;
//# sourceMappingURL=Methods.d.ts.map