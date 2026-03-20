import type { CredentialPayload } from './mpp.js';
import * as stellar from './stellar.js';
import type { rpc } from '@stellar/stellar-sdk';

export interface ChannelState {
  contractAddress: string;
  commitmentKey: string;
  cumulativeAmount: string;
  lastVoucherSig: string;
  deposit: string;
  messageCount: number;
  lastMessageAt: string;
  openedAt: string;
  expiresAt: string;
}

const CHANNEL_TTL_MS = 120_000; // 2 minutes
const RATE_LIMIT_MS = 3_000; // 1 message per 3 seconds

interface Env {
  CHANNEL_STATE: KVNamespace;
  SERVER_STELLAR_ADDRESS: string;
  TOKEN_CONTRACT_ID: string;
  STELLAR_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
}

/** Handle action="open": verify the channel on-chain and register it in KV. */
export async function handleOpen(
  payload: CredentialPayload,
  env: Env,
  server: rpc.Server,
): Promise<{ error?: string }> {
  if (!payload.channelId || !payload.commitmentKey) {
    return { error: 'Missing channelId or commitmentKey' };
  }

  // Check if channel already registered
  const existing = await env.CHANNEL_STATE.get(payload.channelId);
  if (existing) {
    return { error: 'Channel already registered' };
  }

  // Verify on-chain
  const toAddress = await stellar.getTo(server, payload.channelId, env.STELLAR_NETWORK_PASSPHRASE);
  if (toAddress !== env.SERVER_STELLAR_ADDRESS) {
    return { error: `Channel recipient mismatch: expected ${env.SERVER_STELLAR_ADDRESS}, got ${toAddress}` };
  }
  const tokenAddress = await stellar.getToken(server, payload.channelId, env.STELLAR_NETWORK_PASSPHRASE);
  if (tokenAddress !== env.TOKEN_CONTRACT_ID) {
    return { error: `Token mismatch: expected ${env.TOKEN_CONTRACT_ID}, got ${tokenAddress}` };
  }
  const balance = await stellar.getBalance(server, payload.channelId, env.STELLAR_NETWORK_PASSPHRASE);

  const now = new Date();
  const state: ChannelState = {
    contractAddress: payload.channelId,
    commitmentKey: payload.commitmentKey,
    cumulativeAmount: '0',
    lastVoucherSig: '',
    deposit: balance.toString(),
    messageCount: 0,
    lastMessageAt: '',
    openedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHANNEL_TTL_MS).toISOString(),
  };

  await env.CHANNEL_STATE.put(payload.channelId, JSON.stringify(state));
  return {};
}

/** Handle action="voucher": verify the commitment signature and update state. */
export async function handleVoucher(
  payload: CredentialPayload,
  env: Env,
  server: rpc.Server,
): Promise<{ error?: string; state?: ChannelState }> {
  if (!payload.channelId || !payload.voucher) {
    return { error: 'Missing channelId or voucher' };
  }

  const raw = await env.CHANNEL_STATE.get(payload.channelId);
  if (!raw) {
    return { error: 'Channel not found' };
  }

  const state: ChannelState = JSON.parse(raw);

  // Check expiry
  if (new Date() > new Date(state.expiresAt)) {
    return { error: 'Channel expired' };
  }

  // Rate limit: 1 message per 3 seconds
  if (state.lastMessageAt) {
    const elapsed = Date.now() - new Date(state.lastMessageAt).getTime();
    if (elapsed < RATE_LIMIT_MS) {
      return { error: `Rate limited: wait ${Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)}s` };
    }
  }

  const newAmount = BigInt(payload.voucher.amount);
  const prevAmount = BigInt(state.cumulativeAmount);
  const deposit = BigInt(state.deposit);

  // Must be monotonically increasing
  if (newAmount <= prevAmount) {
    return { error: `Amount must increase: ${newAmount} <= ${prevAmount}` };
  }

  // Must not exceed deposit
  if (newAmount > deposit) {
    return { error: `Amount exceeds deposit: ${newAmount} > ${deposit}` };
  }

  // Simulate prepare_commitment to get authoritative bytes
  const commitmentBytes = await stellar.prepareCommitment(
    server,
    payload.channelId,
    newAmount,
    env.STELLAR_NETWORK_PASSPHRASE,
  );

  // Verify ed25519 signature
  const valid = stellar.verifySignature(
    state.commitmentKey,
    commitmentBytes,
    payload.voucher.signature,
  );

  if (!valid) {
    return { error: 'Invalid commitment signature' };
  }

  // Update state
  state.cumulativeAmount = newAmount.toString();
  state.lastVoucherSig = payload.voucher.signature;
  state.messageCount += 1;
  state.lastMessageAt = new Date().toISOString();

  await env.CHANNEL_STATE.put(payload.channelId, JSON.stringify(state));
  return { state };
}

/** Handle action="topup": verify balance increased, update state, reset TTL. */
export async function handleTopup(
  payload: CredentialPayload,
  env: Env,
  server: rpc.Server,
): Promise<{ error?: string }> {
  if (!payload.channelId) {
    return { error: 'Missing channelId' };
  }

  const raw = await env.CHANNEL_STATE.get(payload.channelId);
  if (!raw) {
    return { error: 'Channel not found' };
  }

  const state: ChannelState = JSON.parse(raw);

  // Refresh on-chain balance
  const newBalance = await stellar.getBalance(server, payload.channelId, env.STELLAR_NETWORK_PASSPHRASE);

  if (newBalance <= BigInt(state.deposit)) {
    return { error: 'No balance increase detected on-chain' };
  }

  // Update deposit and reset TTL
  state.deposit = newBalance.toString();
  state.expiresAt = new Date(Date.now() + CHANNEL_TTL_MS).toISOString();

  await env.CHANNEL_STATE.put(payload.channelId, JSON.stringify(state));
  return {};
}

/** Get channel state from KV. */
export async function getChannel(
  kv: KVNamespace,
  channelId: string,
): Promise<ChannelState | null> {
  const raw = await kv.get(channelId);
  return raw ? JSON.parse(raw) : null;
}
