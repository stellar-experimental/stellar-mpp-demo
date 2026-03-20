import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { close } from 'stellar-mpp-sdk/channel/server';
import { Keypair } from '@stellar/stellar-sdk';
import {
  createChallenge,
  paymentRequired,
  parseCredential,
  verifyChallenge,
  withReceipt,
  type CredentialPayload,
} from './mpp.js';
import { createServer } from './stellar.js';
import { handleOpen, handleVoucher, handleTopup, getChannel } from './channel.js';

type Bindings = {
  CHANNEL_STATE: KVNamespace;
  AI_WORKER_URL: string;
  MPP_SECRET_KEY: string;
  SERVER_STELLAR_SECRET: string;
  SERVER_STELLAR_ADDRESS: string;
  CHANNEL_FACTORY_ID: string;
  STELLAR_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  TOKEN_CONTRACT_ID: string;
};

const COST_PER_MESSAGE = '1000000'; // 100 credits = 1M stroops = 0.1 XLM per message
const DEFAULT_DEPOSIT = '10000000'; // 1000 credits = 10M stroops = 1 XLM deposit

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({
  origin: '*',
  exposeHeaders: ['WWW-Authenticate', 'Payment-Receipt'],
}));

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Soroban RPC proxy — the browser can't call the RPC directly due to CORS
app.post('/rpc', async (c) => {
  const body = await c.req.text();
  const res = await fetch(c.env.STELLAR_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

app.post('/chat', async (c) => {
  // 1. Try to parse credential from Authorization header
  let credential;
  try {
    credential = parseCredential(c.req.raw);
  } catch {
    // No credential → issue 402 challenge
    const challenge = createChallenge({
      secretKey: c.env.MPP_SECRET_KEY,
      realm: 'mpp-channel-demo',
      serverAddress: c.env.SERVER_STELLAR_ADDRESS,
      channelFactoryId: c.env.CHANNEL_FACTORY_ID,
      tokenContractId: c.env.TOKEN_CONTRACT_ID,
      deposit: DEFAULT_DEPOSIT,
      refundWaitingPeriod: 24,
    });

    return paymentRequired(challenge, 'Open a payment channel to chat');
  }

  // 2. Verify the challenge HMAC (confirms we issued it)
  if (!verifyChallenge(credential.challenge, c.env.MPP_SECRET_KEY)) {
    return c.json({ type: 'invalid-challenge', detail: 'Challenge HMAC verification failed' }, 403);
  }

  // 3. Dispatch based on action
  const payload = credential.payload as CredentialPayload;
  const server = createServer(c.env.STELLAR_RPC_URL);
  const env = {
    CHANNEL_STATE: c.env.CHANNEL_STATE,
    SERVER_STELLAR_ADDRESS: c.env.SERVER_STELLAR_ADDRESS,
    TOKEN_CONTRACT_ID: c.env.TOKEN_CONTRACT_ID,
    STELLAR_RPC_URL: c.env.STELLAR_RPC_URL,
    STELLAR_NETWORK_PASSPHRASE: c.env.STELLAR_NETWORK_PASSPHRASE,
  };

  try {
  switch (payload.action) {
    case 'open': {
      const result = await handleOpen(payload, env, server);
      if (result.error) {
        return c.json({ type: 'channel-error', detail: result.error }, 400);
      }
      return withReceipt(
        new Response(JSON.stringify({ status: 'channel-registered', channelId: payload.channelId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        `open:${payload.channelId}`,
      );
    }

    case 'voucher': {
      const result = await handleVoucher(payload, env, server);
      if (result.error) {
        return c.json({ type: 'verification-failed', detail: result.error }, 402);
      }

      // Proxy to AI Worker
      let body: { message?: string };
      try {
        body = await c.req.json();
      } catch {
        body = { message: '' };
      }

      const aiResponse = await fetch(`${c.env.AI_WORKER_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: body.message || 'hello' }],
        }),
      });

      if (!aiResponse.ok) {
        const errText = await aiResponse.text().catch(() => '');
        return c.json({ type: 'ai-error', detail: `AI service error: ${aiResponse.status} ${errText}`.trim() }, 502);
      }

      return withReceipt(
        new Response(aiResponse.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        }),
        `voucher:${payload.channelId}:${payload.voucher?.amount}`,
      );
    }

    case 'topup': {
      const result = await handleTopup(payload, env, server);
      if (result.error) {
        return c.json({ type: 'topup-error', detail: result.error }, 400);
      }
      return withReceipt(
        new Response(JSON.stringify({ status: 'topped-up', channelId: payload.channelId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        `topup:${payload.channelId}`,
      );
    }

    case 'close': {
      const state = await getChannel(c.env.CHANNEL_STATE, payload.channelId);
      if (!state) {
        return c.json({ type: 'channel-error', detail: 'Channel not found' }, 404);
      }

      // Settle on-chain using stellar-mpp-sdk close()
      const closeKey = Keypair.fromSecret(c.env.SERVER_STELLAR_SECRET);
      const txHash = await close({
        channel: payload.channelId,
        amount: BigInt(state.cumulativeAmount),
        signature: Buffer.from(state.lastVoucherSig, 'hex'),
        closeKey,
        network: 'testnet',
        rpcUrl: c.env.STELLAR_RPC_URL,
      });

      // Clean up KV
      await c.env.CHANNEL_STATE.delete(payload.channelId);

      return withReceipt(
        new Response(JSON.stringify({
          status: 'settled',
          channelId: payload.channelId,
          amount: state.cumulativeAmount,
          txHash,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        `close:${txHash}`,
      );
    }

    default:
      return c.json({ type: 'bad-request', detail: `Unknown action: ${payload.action}` }, 400);
  }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ type: 'server-error', detail: message }, 500);
  }
});

app.get('/channel/:id', async (c) => {
  const id = c.req.param('id');
  const state = await getChannel(c.env.CHANNEL_STATE, id);
  if (!state) {
    return c.json({ channelId: id, status: 'not-found' }, 404);
  }
  return c.json({ channelId: id, ...state });
});

export default app;
