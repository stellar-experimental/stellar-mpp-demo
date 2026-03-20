import { Networks } from '@stellar/stellar-sdk';
export declare const NETWORK_PASSPHRASE: {
    readonly public: Networks.PUBLIC;
    readonly testnet: Networks.TESTNET;
};
export type NetworkId = keyof typeof NETWORK_PASSPHRASE;
export declare const SOROBAN_RPC_URLS: Record<NetworkId, string>;
export declare const HORIZON_URLS: Record<NetworkId, string>;
/** USDC SAC contract address on Stellar mainnet. */
export declare const USDC_SAC_MAINNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI";
/** USDC SAC contract address on Stellar testnet. */
export declare const USDC_SAC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
/** Native XLM SAC contract address on mainnet. */
export declare const XLM_SAC_MAINNET = "CAS3J7GYLGVE45MR3HPSFG352DAANEV5GGMFTO3IZIE4JMCDALQO57Y";
/** Native XLM SAC contract address on testnet. */
export declare const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** Map from network to well-known SAC addresses. */
export declare const SAC_ADDRESSES: {
    readonly public: {
        readonly USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI";
        readonly XLM: "CAS3J7GYLGVE45MR3HPSFG352DAANEV5GGMFTO3IZIE4JMCDALQO57Y";
    };
    readonly testnet: {
        readonly USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
        readonly XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    };
};
/** Default number of decimal places for Stellar assets. */
export declare const DEFAULT_DECIMALS = 7;
/** Default fee in stroops. */
export declare const DEFAULT_FEE = "100";
/** Default transaction timeout in seconds. */
export declare const DEFAULT_TIMEOUT = 180;
//# sourceMappingURL=constants.d.ts.map