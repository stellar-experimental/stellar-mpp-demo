import { Keypair } from '@stellar/stellar-sdk';
import { Method } from 'mppx';
import { z } from 'zod/mini';
/**
 * Creates a Stellar charge method for use on the **client**.
 *
 * Builds a Soroban SAC `transfer` invocation, signs it, and either:
 * - **pull** (default): sends the signed XDR to the server to broadcast
 * - **push**: broadcasts itself and sends the tx hash
 *
 * @example
 * ```ts
 * import { Keypair } from '@stellar/stellar-sdk'
 * import { Mppx } from 'mppx/client'
 * import { stellar } from 'stellar-mpp-sdk/client'
 *
 * Mppx.create({
 *   methods: [
 *     stellar.charge({
 *       keypair: Keypair.fromSecret('S...'),
 *     }),
 *   ],
 * })
 *
 * const response = await fetch('https://api.example.com/resource')
 * ```
 */
export declare function charge(parameters: charge.Parameters): Method.Client<{
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
            amount: z.ZodMiniString<string>;
            currency: z.ZodMiniString<string>;
            recipient: z.ZodMiniString<string>;
            description: z.ZodMiniOptional<z.ZodMiniString<string>>;
            externalId: z.ZodMiniOptional<z.ZodMiniString<string>>;
            methodDetails: z.ZodMiniOptional<z.ZodMiniObject<{
                reference: z.ZodMiniOptional<z.ZodMiniString<string>>;
                network: z.ZodMiniOptional<z.ZodMiniString<string>>;
                memo: z.ZodMiniOptional<z.ZodMiniString<string>>;
                feePayer: z.ZodMiniOptional<z.ZodMiniBoolean<boolean>>;
                feePayerKey: z.ZodMiniOptional<z.ZodMiniString<string>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
}, z.ZodMiniObject<{
    mode: z.ZodMiniOptional<z.ZodMiniEnum<{
        push: "push";
        pull: "pull";
    }>>;
}, z.core.$strip>>;
export declare namespace charge {
    type ProgressEvent = {
        type: 'challenge';
        recipient: string;
        amount: string;
        currency: string;
        feePayerKey?: string;
    } | {
        type: 'signing';
    } | {
        type: 'signed';
        xdr: string;
    } | {
        type: 'paying';
    } | {
        type: 'confirming';
        hash: string;
    } | {
        type: 'paid';
        hash: string;
    };
    type Parameters = {
        /** Stellar secret key (S...). Provide either this or `keypair`. */
        secretKey?: string;
        /** Stellar Keypair instance. Provide either this or `secretKey`. */
        keypair?: Keypair;
        /** Custom Soroban RPC URL. Defaults based on network. */
        rpcUrl?: string;
        /**
         * Controls how the charge transaction is submitted.
         *
         * - `'push'`: Client broadcasts the transaction and sends the tx hash.
         * - `'pull'`: Client signs the transaction and sends the signed XDR
         *   to the server for broadcast.
         *
         * @default 'pull'
         */
        mode?: 'push' | 'pull';
        /** Transaction timeout in seconds. @default 180 */
        timeout?: number;
        /** Callback invoked at each lifecycle stage. */
        onProgress?: (event: ProgressEvent) => void;
    };
}
//# sourceMappingURL=Charge.d.ts.map