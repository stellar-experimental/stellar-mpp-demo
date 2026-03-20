import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "../packages/frontend/node_modules/@stellar/stellar-sdk";
import { Challenge, Credential } from "../packages/frontend/node_modules/mppx";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const COST_PER_TOKEN = 10_000n;
const MAX_TOKENS_PER_MESSAGE = 512n;
const DEFAULT_REMOTE_URLS = {
  frontendUrl: "https://mpp.stellar.buzz",
  serverUrl: "https://mpp-server.stellar.buzz",
  aiUrl: "https://mpp-ai.stellar.buzz",
};
const DEFAULT_LOCAL_URLS = {
  frontendUrl: "http://localhost:3000",
  serverUrl: "http://localhost:8787",
  aiUrl: "http://localhost:8788",
};
const CHAT_TIMEOUT_MS = 45_000;
const CHAIN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
const SEND_RETRY_DELAY_MS = 2_000;
const POLL_ATTEMPTS = 60;

type Target = "local" | "remote";

interface CliOptions {
  target: Target;
  frontendUrl?: string;
  serverUrl?: string;
  aiUrl?: string;
}

interface ResolvedUrls {
  frontendUrl: string;
  serverUrl: string;
  aiUrl: string;
}

interface SmokeContext {
  urls: ResolvedUrls;
  rpcUrl: string;
  wallet: Keypair;
  commitmentKeypair: Keypair;
  challenge: Challenge.Challenge;
  channelId: string;
  deposit: bigint;
  cumulativeAmount: bigint;
}

interface ChannelState {
  channelId: string;
  contractAddress: string;
  commitmentKey: string;
  cumulativeAmount: string;
  maxAuthorizedAmount: string;
  lastVoucherSig: string;
  deposit: string;
  messageCount: number;
  lastMessageAt: string;
  openedAt: string;
  expiresAt: string;
}

interface StreamResult {
  fullText: string;
  tokenCount: number;
  usage?: {
    completion_tokens: number;
    cost: string;
    cumulative_amount: string;
  };
}

let passCount = 0;
let failCount = 0;

function step(title: string) {
  console.log(`\n━━━ ${title} ━━━`);
}

function pass(message: string) {
  passCount += 1;
  console.log(`  ✅ ${message}`);
}

function fail(message: string): never {
  failCount += 1;
  console.error(`  ❌ ${message}`);
  throw new Error(message);
}

function assert(condition: unknown, message: string) {
  if (!condition) fail(message);
  pass(message);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { target: "remote" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "local" || arg === "remote") {
      options.target = arg;
      continue;
    }
    if (arg === "--target") {
      const value = argv[i + 1];
      if (value !== "local" && value !== "remote") {
        fail(`Invalid value for --target: ${value ?? "<missing>"}`);
      }
      options.target = value;
      i += 1;
      continue;
    }
    if (arg === "--frontend-url") {
      options.frontendUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--server-url") {
      options.serverUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--ai-url") {
      options.aiUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  bun run test/e2e-protocol-smoke.ts --target local
  bun run test/e2e-protocol-smoke.ts --target remote

Options:
  --target local|remote
  --frontend-url <url>
  --server-url <url>
  --ai-url <url>`);
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveUrls(options: CliOptions): ResolvedUrls {
  const defaults = options.target === "local" ? DEFAULT_LOCAL_URLS : DEFAULT_REMOTE_URLS;
  return {
    frontendUrl: options.frontendUrl ?? defaults.frontendUrl,
    serverUrl: options.serverUrl ?? defaults.serverUrl,
    aiUrl: options.aiUrl ?? defaults.aiUrl,
  };
}

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T;
  return { response, body };
}

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    await wait(POLL_INTERVAL_MS);
  }
  fail(`Timed out waiting for ${label}`);
}

function createRpcServer(rpcUrl: string) {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

async function sendTx(server: rpc.Server, tx: Parameters<typeof server.sendTransaction>[0]) {
  let result = await server.sendTransaction(tx);

  if (result.status === "TRY_AGAIN_LATER") {
    await wait(SEND_RETRY_DELAY_MS);
    result = await server.sendTransaction(tx);
  }

  if (result.status === "ERROR") {
    throw new Error(
      `Transaction rejected: ${result.errorResult?.result()?.switch().name ?? result.status}`,
    );
  }

  return result.hash;
}

async function pollTx(server: rpc.Server, hash: string) {
  const result = await server.pollTransaction(hash, {
    attempts: POLL_ATTEMPTS,
    sleepStrategy: rpc.BasicSleepStrategy,
  });

  if (result.status !== "SUCCESS") {
    throw new Error(`Transaction failed: ${result.status}`);
  }

  return result as rpc.Api.GetSuccessfulTransactionResponse;
}

async function simulateCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: any[] = [],
) {
  const contract = new Contract(contractId);
  const source = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(
      `Simulation failed for ${method}: ${(sim as rpc.Api.SimulateTransactionErrorResponse).error}`,
    );
  }

  const retval = sim.result?.retval;
  if (!retval) {
    throw new Error(`Simulation returned no result for ${method}`);
  }
  return retval;
}

async function getChannelBalance(server: rpc.Server, channelId: string) {
  return scValToNative(await simulateCall(server, channelId, "balance")) as bigint;
}

async function prepareCommitment(server: rpc.Server, channelId: string, amount: bigint) {
  return (await simulateCall(server, channelId, "prepare_commitment", [
    nativeToScVal(amount, { type: "i128" }),
  ])).bytes() as Uint8Array;
}

async function openChannel(params: {
  rpcUrl: string;
  wallet: Keypair;
  commitmentKeypair: Keypair;
  factoryContractId: string;
  tokenContractId: string;
  recipient: string;
  deposit: bigint;
  refundWaitingPeriod: number;
}) {
  const server = createRpcServer(params.rpcUrl);
  const factory = new Contract(params.factoryContractId);
  const account = await server.getAccount(params.wallet.publicKey());
  const salt = crypto.getRandomValues(new Uint8Array(32));

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      factory.call(
        "open",
        nativeToScVal(salt),
        new Address(params.tokenContractId).toScVal(),
        new Address(params.wallet.publicKey()).toScVal(),
        nativeToScVal(params.commitmentKeypair.rawPublicKey()),
        new Address(params.recipient).toScVal(),
        nativeToScVal(params.deposit, { type: "i128" }),
        nativeToScVal(params.refundWaitingPeriod, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(params.wallet);
  const hash = await sendTx(server, prepared);
  const result = await pollTx(server, hash);
  const returnValue = result.returnValue;
  if (!returnValue) {
    throw new Error("open() returned no channel address");
  }

  return {
    txHash: hash,
    channelId: Address.fromScVal(returnValue).toString(),
  };
}

async function topUpChannel(params: {
  rpcUrl: string;
  wallet: Keypair;
  channelId: string;
  amount: bigint;
}) {
  const server = createRpcServer(params.rpcUrl);
  const channel = new Contract(params.channelId);
  const account = await server.getAccount(params.wallet.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(channel.call("top_up", nativeToScVal(params.amount, { type: "i128" })))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(params.wallet);
  const hash = await sendTx(server, prepared);
  await pollTx(server, hash);
  return hash;
}

function toHex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex");
}

async function ensureFunded(wallet: Keypair, rpcUrl: string) {
  const server = createRpcServer(rpcUrl);
  try {
    await server.getAccount(wallet.publicKey());
    return false;
  } catch {
    const response = await fetch(`https://friendbot.stellar.org?addr=${wallet.publicKey()}`);
    const text = await response.text();
    if (!response.ok && !text.includes("already funded") && !text.includes("createAccountAlreadyExist")) {
      throw new Error(`Friendbot failed: ${response.status} ${text}`);
    }
    await pollUntil(
      "wallet funding confirmation",
      async () => {
        try {
          await server.getAccount(wallet.publicKey());
          return true;
        } catch {
          return false;
        }
      },
      Boolean,
      30_000,
    );
    return true;
  }
}

function buildAuthorizationHeader(challenge: Challenge.Challenge, payload: Record<string, unknown>) {
  return Credential.serialize(Credential.from({ challenge, payload }));
}

async function requestChallenge(serverUrl: string) {
  const { response, text } = await fetchText(`${serverUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });

  assert(response.status === 402, "POST /chat without credential returns 402");
  assert(response.headers.has("www-authenticate"), "WWW-Authenticate header present");
  assert(text.includes("payment-required"), "402 body contains payment-required");
  return Challenge.fromResponse(response);
}

async function openSession(urls: ResolvedUrls): Promise<SmokeContext> {
  const challenge = await requestChallenge(urls.serverUrl);
  const request = challenge.request as {
    recipient: string;
    deposit: string;
    channelFactory: string;
    refundWaitingPeriod: number;
    token: string;
  };

  const rpcUrl = `${urls.serverUrl}/rpc`;
  const wallet = Keypair.random();
  const commitmentKeypair = Keypair.random();
  const funded = await ensureFunded(wallet, rpcUrl);
  pass(`Wallet ready on testnet (${funded ? "funded via Friendbot" : "already existed"})`);

  const deposit = BigInt(request.deposit);
  const { channelId, txHash } = await openChannel({
    rpcUrl,
    wallet,
    commitmentKeypair,
    factoryContractId: request.channelFactory,
    tokenContractId: request.token,
    recipient: request.recipient,
    deposit,
    refundWaitingPeriod: request.refundWaitingPeriod,
  });
  pass(`Opened channel on-chain: ${channelId}`);
  pass(`Open tx submitted: ${txHash}`);

  const registerResponse = await fetch(`${urls.serverUrl}/chat`, {
    method: "POST",
    headers: {
      Authorization: buildAuthorizationHeader(challenge, {
        action: "open",
        channelId,
        commitmentKey: toHex(commitmentKeypair.rawPublicKey()),
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "" }),
  });

  const registerBody = (await registerResponse.json()) as { status?: string; expiresAt?: string; detail?: string };
  assert(registerResponse.ok, `Channel registration succeeded${registerBody.detail ? `: ${registerBody.detail}` : ""}`);
  assert(registerResponse.headers.has("payment-receipt"), "Open response includes Payment-Receipt");
  assert(registerBody.status === "channel-registered", "Open response reports channel-registered");

  const state = await pollUntil(
    "channel state after open",
    async () => {
      const response = await fetch(`${urls.serverUrl}/channel/${channelId}`);
      return {
        response,
        body: response.ok ? ((await response.json()) as ChannelState & { channelId: string }) : null,
      };
    },
    ({ response, body }) => response.ok && body !== null,
    15_000,
  );

  assert(state.body?.deposit === deposit.toString(), "Server state deposit matches the opened channel");

  return {
    urls,
    rpcUrl,
    wallet,
    commitmentKeypair,
    challenge,
    channelId,
    deposit,
    cumulativeAmount: 0n,
  };
}

async function sendPaidChat(context: SmokeContext, message: string) {
  const server = createRpcServer(context.rpcUrl);
  const commitAmount = context.cumulativeAmount + COST_PER_TOKEN * MAX_TOKENS_PER_MESSAGE > context.deposit
    ? context.deposit
    : context.cumulativeAmount + COST_PER_TOKEN * MAX_TOKENS_PER_MESSAGE;
  const commitment = await prepareCommitment(server, context.channelId, commitAmount);
  const signatureHex = toHex(context.commitmentKeypair.sign(Buffer.from(commitment)));

  const response = await fetch(`${context.urls.serverUrl}/chat`, {
    method: "POST",
    headers: {
      Authorization: buildAuthorizationHeader(context.challenge, {
        action: "voucher",
        channelId: context.channelId,
        voucher: {
          amount: commitAmount.toString(),
          signature: signatureHex,
        },
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  assert(response.ok, `Paid chat request succeeded for "${message}"`);
  assert(response.headers.has("payment-receipt"), "Voucher response includes Payment-Receipt");

  const stream = await readSse(response, CHAT_TIMEOUT_MS);
  assert(stream.tokenCount > 0, `AI stream returned tokens for "${message}"`);
  assert(!!stream.usage, "AI stream ended with usage event");
  assert(stream.usage!.completion_tokens === stream.tokenCount, "Usage token count matches streamed token count");

  const expectedCost = BigInt(stream.tokenCount) * COST_PER_TOKEN;
  assert(BigInt(stream.usage!.cost) === expectedCost, "Usage cost matches token count * price");

  context.cumulativeAmount += expectedCost;
  assert(
    BigInt(stream.usage!.cumulative_amount) === context.cumulativeAmount,
    "Server-reported cumulative amount matches local cumulative amount",
  );

  return {
    stream,
    expectedCost,
  };
}

async function readSse(response: Response, timeoutMs: number): Promise<StreamResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Missing response body");
  }

  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let fullText = "";
  let tokenCount = 0;
  let usage: StreamResult["usage"];

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out while reading SSE stream");
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          continue;
        }
        const parsed = JSON.parse(data) as { response?: string; usage?: StreamResult["usage"] };
        if (parsed.response) {
          fullText += parsed.response;
          tokenCount += 1;
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    }
  }

  return { fullText, tokenCount, usage };
}

async function getChannelState(serverUrl: string, channelId: string) {
  const response = await fetch(`${serverUrl}/channel/${channelId}`);
  if (response.status === 404) {
    const body = (await response.json()) as { status?: string };
    return { response, body };
  }
  return { response, body: (await response.json()) as ChannelState & { channelId: string } };
}

async function verifyStateAfterMessage(
  context: SmokeContext,
  expectedMessageCount: number,
  expectedDeposit: bigint,
) {
  const state = await pollUntil(
    `channel state for message ${expectedMessageCount}`,
    () => getChannelState(context.urls.serverUrl, context.channelId),
    ({ response, body }) =>
      response.ok &&
      "messageCount" in body &&
      body.messageCount >= expectedMessageCount &&
      BigInt(body.cumulativeAmount) >= context.cumulativeAmount,
    15_000,
  );

  if (!("messageCount" in state.body)) {
    fail("Expected channel state body for an open channel");
  }

  assert(state.body.messageCount === expectedMessageCount, `Server state messageCount is ${expectedMessageCount}`);
  assert(BigInt(state.body.cumulativeAmount) === context.cumulativeAmount, "Server state cumulativeAmount matches local amount");
  assert(BigInt(state.body.deposit) === expectedDeposit, "Server state deposit matches expected deposit");
}

async function runTopUp(context: SmokeContext) {
  const priorDeposit = context.deposit;
  const txHash = await topUpChannel({
    rpcUrl: context.rpcUrl,
    wallet: context.wallet,
    channelId: context.channelId,
    amount: priorDeposit,
  });
  pass(`Top-up tx submitted: ${txHash}`);

  const response = await fetch(`${context.urls.serverUrl}/chat`, {
    method: "POST",
    headers: {
      Authorization: buildAuthorizationHeader(context.challenge, {
        action: "topup",
        channelId: context.channelId,
        txHash,
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "" }),
  });
  const body = (await response.json()) as { status?: string; detail?: string };
  assert(response.ok, `Top-up registration succeeded${body.detail ? `: ${body.detail}` : ""}`);
  assert(body.status === "topped-up", "Top-up response reports topped-up");

  const state = await pollUntil(
    "channel deposit increase after top-up",
    () => getChannelState(context.urls.serverUrl, context.channelId),
    ({ response: stateResponse, body: stateBody }) =>
      stateResponse.ok && "deposit" in stateBody && BigInt(stateBody.deposit) > priorDeposit,
    CHAIN_TIMEOUT_MS,
  );

  if (!("deposit" in state.body)) {
    fail("Expected channel state body after top-up");
  }

  context.deposit = BigInt(state.body.deposit);
  assert(context.deposit > priorDeposit, "Server state deposit increased after top-up");
}

async function closeChannelSession(context: SmokeContext) {
  const server = createRpcServer(context.rpcUrl);
  const finalCommitment = await prepareCommitment(server, context.channelId, context.cumulativeAmount);
  const finalSignature = toHex(context.commitmentKeypair.sign(Buffer.from(finalCommitment)));

  const response = await fetch(`${context.urls.serverUrl}/chat`, {
    method: "POST",
    headers: {
      Authorization: buildAuthorizationHeader(context.challenge, {
        action: "close",
        channelId: context.channelId,
        voucher: {
          amount: context.cumulativeAmount.toString(),
          signature: finalSignature,
        },
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "" }),
  });
  const body = (await response.json()) as {
    status?: "closed" | "already-closed" | "closing" | "no-funds";
    txHash?: string;
    closedAmount?: string;
    actualSpend?: string;
  };

  assert(response.ok, "Close request succeeded");
  assert(response.headers.has("payment-receipt"), "Close response includes Payment-Receipt");
  assert(body.status === "closed" || body.status === "closing", "Close returned closed or closing");

  if (body.status === "closed") {
    assert(!!body.txHash, "Close returned an on-chain tx hash");
    pass(`Close tx submitted: ${body.txHash}`);
  } else {
    pass("Close is finalizing asynchronously; cleanup polling will verify completion");
  }

  if (body.actualSpend) {
    assert(BigInt(body.actualSpend) === context.cumulativeAmount, "Close actualSpend matches local cumulative amount");
  }
  if (body.closedAmount) {
    assert(BigInt(body.closedAmount) === context.cumulativeAmount, "Close settled exact cumulative amount");
  }

  await pollUntil(
    "channel cleanup after close",
    () => getChannelState(context.urls.serverUrl, context.channelId),
    ({ response: stateResponse, body: stateBody }) =>
      stateResponse.status === 404 && "status" in stateBody && stateBody.status === "not-found",
    CHAIN_TIMEOUT_MS,
  );
  pass("Server state cleaned up after close");
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const urls = resolveUrls(options);

  console.log(`Target: ${options.target}`);
  console.log(`Frontend: ${urls.frontendUrl}`);
  console.log(`MPP Server: ${urls.serverUrl}`);
  console.log(`AI Worker: ${urls.aiUrl}`);

  step("1. Services Health Check");
  {
    const frontend = await fetch(urls.frontendUrl);
    assert(frontend.ok, `Frontend reachable at ${urls.frontendUrl}`);

    const health = await fetchJson<{ status: string }>(`${urls.serverUrl}/health`);
    assert(health.response.ok, "MPP server /health returned 200");
    assert(health.body.status === "ok", "MPP server /health body is ok");

    const ai = await fetch(urls.aiUrl + "/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "say ok" }] }),
    });
    assert(ai.ok, "AI worker /generate returned 200");
  }

  step("2. Open Channel");
  const context = await openSession(urls);

  step("3. First Paid Message");
  await sendPaidChat(context, "reply with the single word alpha");
  await verifyStateAfterMessage(context, 1, context.deposit);

  step("4. Top Up");
  await runTopUp(context);

  step("5. Second Paid Message");
  await wait(3_100);
  await sendPaidChat(context, "reply with the single word beta");
  await verifyStateAfterMessage(context, 2, context.deposit);

  step("6. Close Channel");
  await closeChannelSession(context);

  step("Results");
  console.log(`  ${passCount} passed, ${failCount} failed`);
  console.log("  ALL GREEN");
}

run().catch((error) => {
  console.error(`\nResults: ${passCount} passed, ${failCount + 1} failed`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
