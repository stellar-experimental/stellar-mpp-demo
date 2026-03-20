import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Address,
  rpc,
  Account,
} from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";

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

/** Open a channel via the factory contract. Returns the channel contract address. */
export async function openChannel(
  accountKeypair: Keypair,
  commitmentKeypair: Keypair,
): Promise<string> {
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
  const result = await server.sendTransaction(prepared);

  if (result.status === "ERROR") {
    throw new Error(`Transaction failed: ${result.status}`);
  }

  const txResult = await server.pollTransaction(result.hash, {
    attempts: 30,
    sleepStrategy: rpc.BasicSleepStrategy,
  });

  if (txResult.status !== "SUCCESS") {
    throw new Error(`Transaction failed: ${txResult.status}`);
  }

  // Extract channel address from the return value
  const returnVal = txResult.returnValue;
  if (!returnVal) throw new Error("No return value from open()");
  const channelAddress = Address.fromScVal(returnVal).toString();
  return channelAddress;
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
  const result = await server.sendTransaction(prepared);

  if (result.status === "ERROR") {
    throw new Error(`Top-up transaction failed: ${result.status}`);
  }

  const txResult = await server.pollTransaction(result.hash, {
    attempts: 30,
    sleepStrategy: rpc.BasicSleepStrategy,
  });

  if (txResult.status !== "SUCCESS") {
    throw new Error(`Top-up failed: ${txResult.status}`);
  }

  return result.hash;
}

/** Get channel balance via simulation. */
export async function getChannelBalance(channelId: string): Promise<bigint> {
  const retval = await simulateCall(channelId, "balance");
  return scValToNative(retval) as bigint;
}
