import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Keypair } from '@stellar/stellar-sdk';
import Header from '../components/Header';
import Terminal, { type TerminalLine } from '../components/Terminal';
import { getOrCreateKeypair, fundWallet, clearKeypair } from '../lib/wallet';
import { openChannel, prepareCommitment, topUpChannel, getChannelBalance, toHex } from '../lib/stellar';
import { CONFIG } from '../lib/config';
import {
  sendChat,
  parseChallenge,
  streamTokens,
  buildOpenPayload,
  buildVoucherPayload,
  buildTopupPayload,
  buildClosePayload,
  type ChannelSession,
} from '../lib/mpp-client';

export const Route = createFileRoute('/')({ component: App });

let lineId = 0;
function newLine(type: TerminalLine['type'], content: string): TerminalLine {
  return { id: lineId++, type, content };
}

function App() {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [input, setInput] = useState('');
  const [disabled, setDisabled] = useState(false);

  const [walletReady, setWalletReady] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [balance, setBalance] = useState(BigInt(0));
  const [deposit, setDeposit] = useState(BigInt(0));
  const [timeRemaining, setTimeRemaining] = useState(0);

  const walletRef = useRef<Keypair | null>(null);
  const commitmentRef = useRef<Keypair | null>(null);
  const sessionRef = useRef<ChannelSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLine = useCallback((type: TerminalLine['type'], content: string) => {
    setLines((prev) => [...prev, newLine(type, content)]);
  }, []);

  // Initialize wallet on mount (client-side only)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const init = async () => {
      addLine('system', 'MPP Channel Demo — Stellar Payment Channels via HTTP 402');
      addLine('system', 'Type /help for commands, or /open to start a session.\n');

      const { keypair, isNew } = getOrCreateKeypair();
      walletRef.current = keypair;
      setWalletAddress(keypair.publicKey());

      addLine('system', `Wallet ${isNew ? 'created' : 'restored'}: ${keypair.publicKey()}`);
      addLine('system', 'Ensuring account is funded...');

      try {
        await fundWallet(keypair.publicKey());
        addLine('system', 'Wallet ready on testnet.');
        setWalletReady(true);
      } catch (e) {
        // Funding failed — create a fresh keypair and try again
        addLine('system', 'Account invalid, creating fresh wallet...');
        clearKeypair();
        const fresh = getOrCreateKeypair();
        walletRef.current = fresh.keypair;
        setWalletAddress(fresh.keypair.publicKey());
        addLine('system', `New wallet: ${fresh.keypair.publicKey()}`);
        try {
          await fundWallet(fresh.keypair.publicKey());
          addLine('system', 'Wallet funded on testnet.');
          setWalletReady(true);
        } catch (e2) {
          addLine('error', `Friendbot failed: ${e2}. Reload to retry.`);
        }
      }
    };
    init();
  }, [addLine]);

  // Countdown timer
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!sessionRef.current) return;

    timerRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.floor((sessionRef.current!.expiresAt - Date.now()) / 1000));
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        addLine('system', 'Channel expired. Type /open to start a new session.');
        setChannelId(null);
        sessionRef.current = null;
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channelId, addLine]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    addLine('user', text);

    if (text.startsWith('/')) {
      await handleCommand(text);
    } else {
      await handleChat(text);
    }
  }, [input]);

  async function handleCommand(cmd: string) {
    const command = cmd.toLowerCase().split(' ')[0];

    switch (command) {
      case '/help':
        addLine('system', 'Commands:');
        addLine('system', '  /open   — Open a payment channel');
        addLine('system', '  /close  — Close channel and settle on-chain');
        addLine('system', '  /topup  — Add more credits to the channel');
        addLine('system', '  /balance — Show channel balance');
        addLine('system', '  /help   — Show this help');
        addLine('system', '  (text)  — Send a chat message');
        break;

      case '/open':
        await handleOpen();
        break;

      case '/close':
        await handleClose();
        break;

      case '/topup':
        await handleTopup();
        break;

      case '/balance':
        if (!sessionRef.current) {
          addLine('system', 'No active channel. Type /open to start.');
        } else {
          const dep = sessionRef.current.deposit;
          const sp = sessionRef.current.cumulativeAmount;
          const rem = dep - sp;
          addLine('system', `Deposit: ${dep} stroops | Spent: ${sp} stroops | Remaining: ${rem} stroops`);
        }
        break;

      default:
        addLine('error', `Unknown command: ${command}. Type /help for commands.`);
    }
  }

  async function handleOpen() {
    if (sessionRef.current) {
      addLine('error', 'Channel already open. /close it first.');
      return;
    }
    if (!walletRef.current || !walletReady) {
      addLine('system', 'Wallet still initializing, please wait...');
      return;
    }

    setDisabled(true);
    try {
      // 1. Get a challenge from the server
      addLine('system', 'Requesting 402 challenge...');
      const challengeRes = await fetch(`${CONFIG.mppServerUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });

      if (challengeRes.status !== 402) {
        addLine('error', `Expected 402, got ${challengeRes.status}`);
        setDisabled(false);
        return;
      }

      const challenge = parseChallenge(challengeRes);
      addLine('system', 'Challenge received. Opening channel on Stellar...');

      // 2. Generate ephemeral commitment keypair
      const commitmentKp = Keypair.random();
      commitmentRef.current = commitmentKp;

      // 3. Open channel on-chain via factory
      const chanId = await openChannel(walletRef.current, commitmentKp);
      addLine('system', `Channel deployed: ${chanId}`);

      // 4. Register channel with the server
      addLine('system', 'Registering channel with MPP server...');
      const commitmentKeyHex = toHex(commitmentKp.rawPublicKey());
      const openPayload = buildOpenPayload(chanId, commitmentKeyHex);
      const tempSession = { channelId: chanId, commitmentKeyHex, cumulativeAmount: BigInt(0), deposit: CONFIG.deposit, challenge, openedAt: Date.now(), expiresAt: Date.now() + CONFIG.channelTtlMs };

      const regRes = await sendChat('', tempSession, openPayload);
      if (!regRes.ok) {
        const errText = await regRes.text().catch(() => `${regRes.status}`);
        let detail: string;
        try { detail = (JSON.parse(errText) as { detail?: string }).detail || errText; } catch { detail = errText; }
        addLine('error', `Registration failed: ${detail}`);
        setDisabled(false);
        return;
      }

      // 5. Set up session
      const session: ChannelSession = {
        channelId: chanId,
        commitmentKeyHex,
        cumulativeAmount: BigInt(0),
        deposit: CONFIG.deposit,
        challenge,
        openedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.channelTtlMs,
      };
      sessionRef.current = session;
      setChannelId(chanId);
      setBalance(CONFIG.deposit);
      setDeposit(CONFIG.deposit);
      setTimeRemaining(CONFIG.channelTtlMs / 1000);

      addLine('system', `Channel open! ${CONFIG.deposit.toString()} stroops loaded. Timer: 2:00`);
      addLine('system', 'Type a message to chat (each costs 100 credits).\n');
    } catch (e) {
      addLine('error', `Open failed: ${e}`);
    }
    setDisabled(false);
  }

  async function handleChat(message: string) {
    if (!sessionRef.current || !commitmentRef.current) {
      addLine('system', 'No active channel. Type /open first.');
      return;
    }

    const session = sessionRef.current;
    const newCumulative = session.cumulativeAmount + CONFIG.costPerMessage;

    if (newCumulative > session.deposit) {
      addLine('system', `Credits exhausted (${session.cumulativeAmount}/${session.deposit} used).`);
      addLine('system', 'Type /topup to add more credits, or /close to settle.');
      return;
    }

    setDisabled(true);
    try {
      // 1. Simulate prepare_commitment
      const commitmentBytes = await prepareCommitment(session.channelId, newCumulative);

      // 2. Sign with ephemeral key
      const signature = commitmentRef.current.sign(commitmentBytes as Buffer);
      const sigHex = toHex(signature);

      // 3. Build credential and send
      const payload = buildVoucherPayload(session.channelId, newCumulative.toString(), sigHex);
      const res = await sendChat(message, session, payload);

      if (res.status === 402) {
        addLine('error', 'Server returned 402. Challenge may have expired. Try /open again.');
        setDisabled(false);
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string };
        addLine('error', `Server error: ${body.detail || res.status}`);
        setDisabled(false);
        return;
      }

      // 4. Stream response with animated credit burn
      session.cumulativeAmount = newCumulative;
      setStreamingText('');
      let fullResponse = '';
      let tokenCount = 0;
      const prevBalance = session.deposit - (newCumulative - CONFIG.costPerMessage);
      const newBalance = session.deposit - newCumulative;
      const creditDelta = prevBalance - newBalance;

      for await (const token of streamTokens(res)) {
        fullResponse += token;
        tokenCount++;
        setStreamingText(fullResponse);

        // Animate balance: interpolate from prevBalance to newBalance as tokens arrive
        // Estimate ~100 tokens per response, adjust proportionally
        const progress = Math.min(tokenCount / 100, 1);
        const interpolated = prevBalance - BigInt(Math.floor(Number(creditDelta) * progress));
        setBalance(interpolated);
      }

      // 5. Finalize — snap to exact new balance
      setBalance(newBalance);
      setStreamingText('');
      addLine('ai', fullResponse);
    } catch (e) {
      addLine('error', `Chat error: ${e}`);
    }
    setDisabled(false);
  }

  async function handleClose() {
    if (!sessionRef.current) {
      addLine('system', 'No active channel to close.');
      return;
    }

    setDisabled(true);
    try {
      const session = sessionRef.current;
      const payload = buildClosePayload(session.channelId);
      const res = await sendChat('', session, payload);

      if (res.ok) {
        const body = await res.json() as { txHash?: string };
        addLine('system', `Channel settled: ${session.cumulativeAmount} stroops spent.`);
        if (body.txHash) {
          addLine('system', `Settlement tx: ${body.txHash}`);
          addLine('system', `View: https://stellar.expert/explorer/testnet/tx/${body.txHash}`);
        }
      } else {
        const body = await res.json().catch(() => ({ detail: '' })) as { detail?: string };
        addLine('error', `Close failed: ${body.detail || res.status}`);
      }
    } catch (e) {
      addLine('error', `Close error: ${e}`);
    }

    // Clean up regardless
    sessionRef.current = null;
    commitmentRef.current = null;
    setChannelId(null);
    setBalance(BigInt(0));
    setDeposit(BigInt(0));
    setTimeRemaining(0);
    setDisabled(false);
  }

  async function handleTopup() {
    if (!sessionRef.current || !walletRef.current) {
      addLine('system', 'No active channel. Type /open first.');
      return;
    }

    setDisabled(true);
    try {
      const session = sessionRef.current;
      addLine('system', `Topping up ${CONFIG.deposit} stroops...`);

      // 1. Submit top_up tx on-chain
      const txHash = await topUpChannel(walletRef.current, session.channelId, CONFIG.deposit);
      addLine('system', `Top-up tx submitted: ${txHash}`);

      // 2. Notify server
      const payload = buildTopupPayload(session.channelId, txHash);
      const res = await sendChat('', session, payload);

      if (res.ok) {
        // Update session
        const newBalance = await getChannelBalance(session.channelId);
        session.deposit = newBalance;
        session.expiresAt = Date.now() + CONFIG.channelTtlMs;
        setDeposit(newBalance);
        setBalance(newBalance - session.cumulativeAmount);
        setTimeRemaining(CONFIG.channelTtlMs / 1000);
        addLine('system', `Topped up! New balance: ${newBalance} stroops. Timer reset.`);
      } else {
        const body = await res.json().catch(() => ({}));
        addLine('error', `Server rejected top-up: ${(body as any).detail || res.status}`);
      }
    } catch (e) {
      addLine('error', `Top-up error: ${e}`);
    }
    setDisabled(false);
  }

  return (
    <>
      <Header
        walletAddress={walletAddress}
        channelId={channelId}
        balance={balance}
        deposit={deposit}
        timeRemaining={timeRemaining}
      />
      <Terminal
        lines={lines}
        streamingText={streamingText}
        input={input}
        onInputChange={setInput}
        onSubmit={handleSubmit}
        disabled={disabled}
      />
    </>
  );
}
