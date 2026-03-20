function getMppServerUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:8787';
  if (window.location.hostname === 'localhost') return 'http://localhost:8787';
  return 'https://mpp-server.stellar.buzz';
}

export const CONFIG = {
  mppServerUrl: getMppServerUrl(),
  rpcUrl: `${getMppServerUrl()}/rpc`,
  networkPassphrase: 'Test SDF Network ; September 2015',
  factoryContractId: 'CDT3EF73C25AIENBQMIH2PCMQWEXT4YE73ED5SJIARWF4QROL7N6NJ44',
  tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  serverAddress: 'GCI2R2NNC36LLEEEPNSWMDSSE4KFZDFJKXNNKH5V6Y6452G7IUMNW2Z4',
  deposit: BigInt(10_000_000), // 1 XLM in stroops (1000 credits)
  costPerMessage: BigInt(1_000_000), // 0.1 XLM in stroops (100 credits)
  refundWaitingPeriod: 24,
  channelTtlMs: 120_000,
};
