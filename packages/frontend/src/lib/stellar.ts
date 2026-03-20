import {
  Contract,
  type FeeBumpTransaction,
  Keypair,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Address,
  rpc,
  Account,
} from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";

const POLL_ATTEMPTS = 60;
const SEND_RETRY_DELAY_MS = 2000;

/** Submit a transaction with status handling and one retry on TRY_AGAIN_LATER. */
async function sendTx(server: rpc.Server, tx: Transaction | FeeBumpTransaction): Promise<string> {
  let result = await server.sendTransaction(tx);

  if (result.status === "TRY_AGAIN_LATER") {
    await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
    result = await server.sendTransaction(tx);
  }

  if (result.status === "ERROR") {
    throw new Error(
      `Transaction rejected: ${result.errorResult?.result()?.switch().name ?? result.status}`,
    );
  }

  return result.hash;
}

/** Poll for a confirmed transaction with exponential backoff. */
async function pollTx(
  server: rpc.Server,
  hash: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const result = await server.pollTransaction(hash, {
    attempts: POLL_ATTEMPTS,
    sleepStrategy: rpc.BasicSleepStrategy,
  });

  if (result.status !== "SUCCESS") {
    throw new Error(`Transaction failed: ${result.status}`);
  }

  return result as rpc.Api.GetSuccessfulTransactionResponse;
}

/** Convert Uint8Array to hex string (browser-safe, no Buffer needed). */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let serverInstance: rpc.Server | null = null;

export function getServer(): rpc.Server {
  if (!serverInstance) {
    serverInstance = new rpc.Server(CONFIG.rpcUrl, { allowHttp: true });
  }
  return serverInstance;
}

/** Simulate a read-only contract call. */
async function simulateCall(contractId: string, method: string, args: any[] = []) {
  const server = getServer();
  const contract = new Contract(contractId);
  const source = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: CONFIG.networkPassphrase,
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

/** Open a channel via the factory contract. Returns the channel address and tx hash. */
export async function openChannel(
  accountKeypair: Keypair,
  commitmentKeypair: Keypair,
): Promise<{ channelAddress: string; txHash: string }> {
  const server = getServer();
  const factory = new Contract(CONFIG.factoryContractId);

  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);

  const account = await server.getAccount(accountKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(
      factory.call(
        "open",
        nativeToScVal(salt),
        new Address(CONFIG.tokenContractId).toScVal(),
        new Address(accountKeypair.publicKey()).toScVal(),
        nativeToScVal(commitmentKeypair.rawPublicKey()),
        new Address(CONFIG.serverAddress).toScVal(),
        nativeToScVal(CONFIG.deposit, { type: "i128" }),
        nativeToScVal(CONFIG.refundWaitingPeriod, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(accountKeypair);
  const hash = await sendTx(server, prepared);
  const txResult = await pollTx(server, hash);

  // Extract channel address from the return value
  const returnVal = txResult.returnValue;
  if (!returnVal) throw new Error("No return value from open()");
  const channelAddress = Address.fromScVal(returnVal).toString();
  return { channelAddress, txHash: hash };
}

/** Simulate prepare_commitment to get bytes to sign. */
export async function prepareCommitment(channelId: string, amount: bigint): Promise<Uint8Array> {
  const retval = await simulateCall(channelId, "prepare_commitment", [
    nativeToScVal(amount, { type: "i128" }),
  ]);
  return retval.bytes();
}

/** Submit a top_up transaction on an existing channel. */
export async function topUpChannel(
  accountKeypair: Keypair,
  channelId: string,
  amount: bigint,
): Promise<string> {
  const server = getServer();
  const channel = new Contract(channelId);
  const account = await server.getAccount(accountKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(channel.call("top_up", nativeToScVal(amount, { type: "i128" })))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(accountKeypair);
  const hash = await sendTx(server, prepared);
  await pollTx(server, hash);

  return hash;
}

/** Get channel balance via simulation. */
export async function getChannelBalance(channelId: string): Promise<bigint> {
  const retval = await simulateCall(channelId, "balance");
  return scValToNative(retval) as bigint;
}
