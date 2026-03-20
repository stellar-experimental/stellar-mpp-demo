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
import type { ChannelManager } from './channel-manager.js';

export { ChannelManager } from './channel-manager.js';

type Bindings = {
  AI_WORKER_URL: string;
  MPP_SECRET_KEY: string;
  SERVER_STELLAR_SECRET: string;
  SERVER_STELLAR_ADDRESS: string;
  CHANNEL_FACTORY_ID: string;
  STELLAR_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  TOKEN_CONTRACT_ID: string;
  CHANNEL_MANAGER: DurableObjectNamespace<ChannelManager>;
};

const COST_PER_TOKEN = 10_000n; // 10,000 stroops per token
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

  if (!payload.channelId) {
    return c.json({ type: 'bad-request', detail: 'Missing channelId' }, 400);
  }

  const channelDO = c.env.CHANNEL_MANAGER.get(
    c.env.CHANNEL_MANAGER.idFromName(payload.channelId),
  );

  try {
  switch (payload.action) {
    case 'open': {
      if (!payload.commitmentKey) {
        return c.json({ type: 'channel-error', detail: 'Missing commitmentKey' }, 400);
      }

      const result = await channelDO.open(payload.channelId, payload.commitmentKey);
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
      if (!payload.voucher) {
        return c.json({ type: 'verification-failed', detail: 'Missing voucher' }, 402);
      }

      const result = await channelDO.acceptVoucher(payload.voucher.amount, payload.voucher.signature);
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

      // Intercept the AI stream to count tokens and append usage
      const priorCumulative = BigInt(result.state!.cumulativeAmount);
      let tokenCount = 0;
      let sseBuffer = '';
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();

      const pipePromise = (async () => {
        const reader = aiResponse.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            await writer.write(value);

            // Count tokens from SSE data lines
            sseBuffer += chunk;
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop()!;
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.response) tokenCount++;
                } catch { /* skip */ }
              }
            }
          }
        } finally {
          // Append usage event after stream ends
          const actualCost = BigInt(tokenCount) * COST_PER_TOKEN;
          const newCumulative = priorCumulative + actualCost;
          const usageEvent = `data: ${JSON.stringify({
            usage: {
              completion_tokens: tokenCount,
              cost: actualCost.toString(),
              cumulative_amount: newCumulative.toString(),
            },
          })}\n\n`;
          await writer.write(encoder.encode(usageEvent));
          await writer.close();

          // Record actual spend atomically in DO
          c.executionCtx.waitUntil(
            channelDO.recordSpend(actualCost.toString()),
          );
        }
      })();

      c.executionCtx.waitUntil(pipePromise);

      return withReceipt(
        new Response(readable, {
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
      const result = await channelDO.topup();
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
      const state = await channelDO.getState();

      if (!state) {
        return c.json({ status: 'already-settled', channelId: payload.channelId }, 200);
      }

      let txHash: string | undefined;

      if (state.maxAuthorizedAmount !== '0' && state.lastVoucherSig) {
        try {
          const closeKey = Keypair.fromSecret(c.env.SERVER_STELLAR_SECRET);
          txHash = await close({
            channel: payload.channelId,
            amount: BigInt(state.maxAuthorizedAmount),
            signature: Buffer.from(state.lastVoucherSig, 'hex'),
            closeKey,
            network: 'testnet',
            rpcUrl: c.env.STELLAR_RPC_URL,
          });
        } catch (err) {
          console.error(`On-chain close failed for ${payload.channelId}:`, err);
        }
      }

      // Clean up DO state after on-chain settlement attempt
      await channelDO.clear();

      return withReceipt(
        new Response(JSON.stringify({
          status: 'settled',
          channelId: payload.channelId,
          settledAmount: state.maxAuthorizedAmount,
          actualSpend: state.cumulativeAmount,
          txHash,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        `close:${txHash || payload.channelId}`,
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
  const channelDO = c.env.CHANNEL_MANAGER.get(
    c.env.CHANNEL_MANAGER.idFromName(id),
  );
  const state = await channelDO.getState();
  if (!state) {
    return c.json({ channelId: id, status: 'not-found' }, 404);
  }
  return c.json({ channelId: id, ...state });
});

export default app;
