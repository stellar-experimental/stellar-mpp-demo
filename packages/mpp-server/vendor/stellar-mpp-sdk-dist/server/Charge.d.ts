import { Keypair } from '@stellar/stellar-sdk';
import { Method, Store } from 'mppx';
import { type NetworkId } from '../constants.js';
export declare function charge(parameters: charge.Parameters): Method.Server<{
    readonly name: "stellar";
    readonly intent: "charge";
    readonly schema: {
        readonly credential: {
            readonly payload: import("zod/mini").ZodMiniDiscriminatedUnion<[import("zod/mini").ZodMiniObject<{
                hash: import("zod/mini").ZodMiniString<string>;
                type: import("zod/mini").ZodMiniLiteral<"signature">;
            }, import("zod/v4/core").$strip>, import("zod/mini").ZodMiniObject<{
                xdr: import("zod/mini").ZodMiniString<string>;
                type: import("zod/mini").ZodMiniLiteral<"transaction">;
            }, import("zod/v4/core").$strip>], "type">;
        };
        readonly request: import("zod/mini").ZodMiniObject<{
            amount: import("zod/mini").ZodMiniString<string>;
            currency: import("zod/mini").ZodMiniString<string>;
            recipient: import("zod/mini").ZodMiniString<string>;
            description: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            externalId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            methodDetails: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniObject<{
                reference: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                network: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                memo: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                feePayer: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                feePayerKey: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            }, import("zod/v4/core").$strip>>;
        }, import("zod/v4/core").$strip>;
    };
}, {
    readonly currency: string;
    readonly recipient: string;
}, undefined>;
export declare namespace charge {
    type Parameters = {
        recipient: string;
        currency: string;
        decimals?: number;
        network?: NetworkId;
        rpcUrl?: string;
        feePayer?: Keypair | string;
        store?: Store.Store;
    };
}
//# sourceMappingURL=Charge.d.ts.map