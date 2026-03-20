import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  StrKey,
  Account,
  rpc,
} from "@stellar/stellar-sdk";

export function createServer(rpcUrl: string) {
  return new rpc.Server(rpcUrl);
}

/**
 * Simulate a read-only contract call and return the result ScVal.
 * Uses a dummy source account (no funding needed for simulation).
 */
async function simulateCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: Parameters<Contract["call"]>[1][],
  networkPassphrase: string,
) {
  const contract = new Contract(contractId);
  const source = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(
      `Simulation failed: ${(sim as rpc.Api.SimulateTransactionErrorResponse).error}`,
    );
  }

  const retval = sim.result?.retval;
  if (!retval) {
    throw new Error(`Simulation returned no result for ${method}`);
  }
  return retval;
}

/** Get the channel's balance in stroops. */
export async function getBalance(
  server: rpc.Server,
  channelId: string,
  networkPassphrase: string,
): Promise<bigint> {
  const retval = await simulateCall(server, channelId, "balance", [], networkPassphrase);
  return scValToNative(retval) as bigint;
}

/** Get the channel's recipient (to) address. */
export async function getTo(
  server: rpc.Server,
  channelId: string,
  networkPassphrase: string,
): Promise<string> {
  const retval = await simulateCall(server, channelId, "to", [], networkPassphrase);
  return scValToNative(retval) as string;
}

/** Get the channel's token contract address. */
export async function getToken(
  server: rpc.Server,
  channelId: string,
  networkPassphrase: string,
): Promise<string> {
  const retval = await simulateCall(server, channelId, "token", [], networkPassphrase);
  return scValToNative(retval) as string;
}

/** Simulate prepare_commitment to get the authoritative commitment bytes. */
export async function prepareCommitment(
  server: rpc.Server,
  channelId: string,
  amount: bigint,
  networkPassphrase: string,
): Promise<Buffer> {
  const retval = await simulateCall(
    server,
    channelId,
    "prepare_commitment",
    [nativeToScVal(amount, { type: "i128" })],
    networkPassphrase,
  );
  return retval.bytes();
}

/** Verify an ed25519 signature over arbitrary bytes using a raw 32-byte public key (hex). */
export function verifySignature(
  publicKeyHex: string,
  message: Buffer,
  signatureHex: string,
): boolean {
  const gAddress = StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyHex, "hex"));
  const keypair = Keypair.fromPublicKey(gAddress);
  return keypair.verify(message, Buffer.from(signatureHex, "hex"));
}
