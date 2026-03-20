import { DurableObject } from 'cloudflare:workers';
import { Keypair } from '@stellar/stellar-sdk';
import { close } from 'stellar-mpp-sdk/channel/server';
import * as stellar from './stellar.js';

export interface ChannelState {
  contractAddress: string;
  commitmentKey: string;
  cumulativeAmount: string;       // actual spend so far
  maxAuthorizedAmount: string;    // highest signed commitment
  lastVoucherSig: string;        // signature for maxAuthorizedAmount
  deposit: string;
  messageCount: number;
  lastMessageAt: string;
  openedAt: string;
  expiresAt: string;
}

const CHANNEL_TTL_MS = 120_000; // 2 minutes
const RATE_LIMIT_MS = 3_000; // 1 message per 3 seconds

interface Env {
  SERVER_STELLAR_SECRET: string;
  SERVER_STELLAR_ADDRESS: string;
  STELLAR_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  TOKEN_CONTRACT_ID: string;
}

export class ChannelManager extends DurableObject<Env> {
  /** Register a new channel: verify on-chain, store state, schedule auto-close. */
  async open(channelId: string, commitmentKey: string): Promise<{ error?: string }> {
    const existing = await this.ctx.storage.get<ChannelState>('state');
    if (existing) {
      return { error: 'Channel already registered' };
    }

    const server = stellar.createServer(this.env.STELLAR_RPC_URL);

    const toAddress = await stellar.getTo(server, channelId, this.env.STELLAR_NETWORK_PASSPHRASE);
    if (toAddress !== this.env.SERVER_STELLAR_ADDRESS) {
      return { error: `Channel recipient mismatch: expected ${this.env.SERVER_STELLAR_ADDRESS}, got ${toAddress}` };
    }

    const tokenAddress = await stellar.getToken(server, channelId, this.env.STELLAR_NETWORK_PASSPHRASE);
    if (tokenAddress !== this.env.TOKEN_CONTRACT_ID) {
      return { error: `Token mismatch: expected ${this.env.TOKEN_CONTRACT_ID}, got ${tokenAddress}` };
    }

    const balance = await stellar.getBalance(server, channelId, this.env.STELLAR_NETWORK_PASSPHRASE);

    const now = new Date();
    const state: ChannelState = {
      contractAddress: channelId,
      commitmentKey,
      cumulativeAmount: '0',
      maxAuthorizedAmount: '0',
      lastVoucherSig: '',
      deposit: balance.toString(),
      messageCount: 0,
      lastMessageAt: '',
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHANNEL_TTL_MS).toISOString(),
    };

    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(new Date(state.expiresAt).getTime());
    return {};
  }

  /** Get current channel state. */
  async getState(): Promise<ChannelState | null> {
    return await this.ctx.storage.get<ChannelState>('state') ?? null;
  }

  /** Validate a voucher and update authorization atomically. */
  async acceptVoucher(
    amount: string,
    signature: string,
  ): Promise<{ error?: string; state?: ChannelState }> {
    const state = await this.ctx.storage.get<ChannelState>('state');
    if (!state) {
      return { error: 'Channel not found' };
    }

    if (new Date() > new Date(state.expiresAt)) {
      return { error: 'Channel expired' };
    }

    if (state.lastMessageAt) {
      const elapsed = Date.now() - new Date(state.lastMessageAt).getTime();
      if (elapsed < RATE_LIMIT_MS) {
        return { error: `Rate limited: wait ${Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)}s` };
      }
    }

    const newAmount = BigInt(amount);
    const prevAuthorized = BigInt(state.maxAuthorizedAmount);

    if (newAmount <= prevAuthorized) {
      return { error: `Amount must increase: ${newAmount} <= ${prevAuthorized}` };
    }
    if (newAmount > BigInt(state.deposit)) {
      return { error: `Amount exceeds deposit: ${newAmount} > ${state.deposit}` };
    }

    // Verify commitment signature
    const server = stellar.createServer(this.env.STELLAR_RPC_URL);
    const commitmentBytes = await stellar.prepareCommitment(
      server, state.contractAddress, newAmount, this.env.STELLAR_NETWORK_PASSPHRASE,
    );
    const valid = stellar.verifySignature(state.commitmentKey, commitmentBytes, signature);
    if (!valid) {
      return { error: 'Invalid commitment signature' };
    }

    // Atomically update authorization state
    state.maxAuthorizedAmount = newAmount.toString();
    state.lastVoucherSig = signature;
    state.messageCount += 1;
    state.lastMessageAt = new Date().toISOString();
    await this.ctx.storage.put('state', state);

    return { state };
  }

  /** Record actual token spend after streaming completes. */
  async recordSpend(actualCost: string): Promise<void> {
    const state = await this.ctx.storage.get<ChannelState>('state');
    if (!state) return;
    state.cumulativeAmount = (BigInt(state.cumulativeAmount) + BigInt(actualCost)).toString();
    await this.ctx.storage.put('state', state);
  }

  /** Verify a top-up on-chain and update deposit + TTL. */
  async topup(): Promise<{ error?: string }> {
    const state = await this.ctx.storage.get<ChannelState>('state');
    if (!state) {
      return { error: 'Channel not found' };
    }

    const server = stellar.createServer(this.env.STELLAR_RPC_URL);
    const newBalance = await stellar.getBalance(
      server, state.contractAddress, this.env.STELLAR_NETWORK_PASSPHRASE,
    );

    if (newBalance <= BigInt(state.deposit)) {
      return { error: 'No balance increase detected on-chain' };
    }

    state.deposit = newBalance.toString();
    state.expiresAt = new Date(Date.now() + CHANNEL_TTL_MS).toISOString();
    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(new Date(state.expiresAt).getTime());
    return {};
  }

  /** Clear all storage and cancel alarm. */
  async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Auto-close alarm: settle on-chain and clean up. */
  async alarm() {
    const state = await this.ctx.storage.get<ChannelState>('state');

    if (!state) {
      await this.ctx.storage.deleteAll();
      return;
    }

    try {
      if (state.maxAuthorizedAmount !== '0' && state.lastVoucherSig) {
        const closeKey = Keypair.fromSecret(this.env.SERVER_STELLAR_SECRET);
        await close({
          channel: state.contractAddress,
          amount: BigInt(state.maxAuthorizedAmount),
          signature: Buffer.from(state.lastVoucherSig, 'hex'),
          closeKey,
          network: 'testnet',
          rpcUrl: this.env.STELLAR_RPC_URL,
        });
      }
    } catch (err) {
      console.error(`Auto-close on-chain failed for ${state.contractAddress}:`, err);
    }

    await this.ctx.storage.deleteAll();
  }
}
