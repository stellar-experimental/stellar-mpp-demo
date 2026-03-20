import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import Header from "../components/Header";
import Terminal, { type TerminalLine } from "../components/Terminal";
import { getOrCreateKeypair, fundWallet } from "../lib/wallet";
import {
  openChannel,
  prepareCommitment,
  topUpChannel,
  getChannelBalance,
  toHex,
} from "../lib/stellar";
import { CONFIG } from "../lib/config";
import {
  sendChat,
  parseChallenge,
  streamTokens,
  buildOpenPayload,
  buildVoucherPayload,
  buildTopupPayload,
  buildClosePayload,
  type ChannelSession,
} from "../lib/mpp-client";

export const Route = createFileRoute("/")({ component: App });

let lineId = 0;
function newLine(type: TerminalLine["type"], content: string): TerminalLine {
  return { id: lineId++, type, content };
}

function App() {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [input, setInput] = useState("");
  const [disabled, setDisabled] = useState(false);

  const [walletReady, setWalletReady] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [channelId, setChannelId] = useState<string | null>(null);
  const [balance, setBalance] = useState(BigInt(0));
  const [deposit, setDeposit] = useState(BigInt(0));
  const [timeRemaining, setTimeRemaining] = useState(0);

  const walletRef = useRef<Keypair | null>(null);
  const commitmentRef = useRef<Keypair | null>(null);
  const sessionRef = useRef<ChannelSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLine = useCallback((type: TerminalLine["type"], content: string) => {
    setLines((prev) => [...prev, newLine(type, content)]);
  }, []);

  // Initialize wallet on mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const init = async () => {
      addLine("system", "MPP Channel Demo — Stellar Payment Channels via HTTP 402");
      addLine("system", "Type /help for commands, or /open to start a session.\n");

      const { keypair, isNew } = getOrCreateKeypair();
      walletRef.current = keypair;
      setWalletAddress(keypair.publicKey());

      addLine("system", `Wallet ${isNew ? "created" : "restored"}: ${keypair.publicKey()}`);
      addLine("system", "Ensuring account is funded...");

      try {
        await fundWallet(keypair.publicKey());
        addLine("system", "Wallet ready on testnet.");
        setWalletReady(true);
      } catch (e) {
        addLine("error", `Funding failed: ${e}. Reload to retry.`);
      }
    };
    init();
  }, [addLine]);

  const handleOpen = useCallback(async () => {
    if (sessionRef.current) {
      addLine("error", "Channel already open. /close it first.");
      return;
    }
    if (!walletRef.current || !walletReady) {
      addLine("system", "Wallet still initializing, please wait...");
      return;
    }

    setDisabled(true);
    try {
      // 1. Get a challenge from the server
      addLine("system", "Requesting 402 challenge...");
      const challengeRes = await fetch(`${CONFIG.mppServerUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });

      if (challengeRes.status !== 402) {
        addLine("error", `Expected 402, got ${challengeRes.status}`);
        setDisabled(false);
        return;
      }

      const challenge = parseChallenge(challengeRes);
      addLine("system", "Challenge received. Opening channel on Stellar...");

      // 2. Generate ephemeral commitment keypair
      const commitmentKp = Keypair.random();
      commitmentRef.current = commitmentKp;

      // 3. Open channel on-chain via factory
      const { channelAddress: chanId, txHash: openTxHash } = await openChannel(
        walletRef.current,
        commitmentKp,
      );
      addLine("system", `Channel deployed: ${chanId}`);
      addLine("system", `Open tx: https://stellar.expert/explorer/testnet/tx/${openTxHash}`);

      // 4. Register channel with the server
      addLine("system", "Registering channel with MPP server...");
      const commitmentKeyHex = toHex(commitmentKp.rawPublicKey());
      const openPayload = buildOpenPayload(chanId, commitmentKeyHex);
      const tempSession = {
        channelId: chanId,
        commitmentKeyHex,
        cumulativeAmount: BigInt(0),
        deposit: CONFIG.deposit,
        challenge,
        openedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.channelTtlMs,
      };

      const regRes = await sendChat("", tempSession, openPayload);
      if (!regRes.ok) {
        const errText = await regRes.text().catch(() => `${regRes.status}`);
        let detail: string;
        try {
          detail = (JSON.parse(errText) as { detail?: string }).detail || errText;
        } catch {
          detail = errText;
        }
        addLine("error", `Registration failed: ${detail}`);
        setDisabled(false);
        return;
      }

      // 5. Set up session — use server's expiresAt as source of truth
      const regBody = (await regRes.json()) as { expiresAt?: string };
      const expiresAt = regBody.expiresAt
        ? new Date(regBody.expiresAt).getTime()
        : Date.now() + CONFIG.channelTtlMs;
      const session: ChannelSession = {
        channelId: chanId,
        commitmentKeyHex,
        cumulativeAmount: BigInt(0),
        deposit: CONFIG.deposit,
        challenge,
        openedAt: Date.now(),
        expiresAt,
      };
      sessionRef.current = session;
      setChannelId(chanId);
      setBalance(CONFIG.deposit);
      setDeposit(CONFIG.deposit);
      const ttlSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeRemaining(ttlSeconds);

      const ttlMin = Math.floor(ttlSeconds / 60);
      const ttlSec = ttlSeconds % 60;
      addLine(
        "system",
        `Channel open! ${CONFIG.deposit.toString()} stroops deposited. Timer: ${ttlMin}:${ttlSec.toString().padStart(2, "0")}`,
      );
      addLine(
        "system",
        `Type a message to chat (${CONFIG.costPerToken.toString()} stroops per token).\n`,
      );
    } catch (e) {
      addLine("error", `Open failed: ${e}`);
    }
    setDisabled(false);
  }, [addLine, walletReady]);

  const handleTopup = useCallback(async () => {
    if (!sessionRef.current || !walletRef.current) {
      addLine("system", "No active channel. Type /open first.");
      return;
    }

    setDisabled(true);
    try {
      const session = sessionRef.current;
      addLine("system", `Topping up ${CONFIG.deposit} stroops...`);

      // 1. Submit top_up tx on-chain
      const txHash = await topUpChannel(walletRef.current, session.channelId, CONFIG.deposit);
      addLine("system", `Top-up tx: https://stellar.expert/explorer/testnet/tx/${txHash}`);

      // 2. Notify server
      const payload = buildTopupPayload(session.channelId, txHash);
      const res = await sendChat("", session, payload);

      if (res.ok) {
        const topupBody = (await res.json()) as { expiresAt?: string };
        const newBalance = await getChannelBalance(session.channelId);
        const newExpiresAt = topupBody.expiresAt
          ? new Date(topupBody.expiresAt).getTime()
          : Date.now() + CONFIG.channelTtlMs;
        session.deposit = newBalance;
        session.expiresAt = newExpiresAt;
        setDeposit(newBalance);
        setBalance(newBalance - session.cumulativeAmount);
        setTimeRemaining(Math.max(0, Math.floor((newExpiresAt - Date.now()) / 1000)));
        addLine("system", `Topped up! Deposit now ${newBalance} stroops. Timer reset.`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        addLine("error", `Server rejected top-up: ${body.detail || res.status}`);
      }
    } catch (e) {
      addLine("error", `Top-up error: ${e}`);
    }
    setDisabled(false);
  }, [addLine]);

  const handleClose = useCallback(async () => {
    if (!sessionRef.current) {
      addLine("system", "No active channel to close.");
      return;
    }

    setDisabled(true);
    addLine("system", "Closing channel...");
    try {
      const session = sessionRef.current;

      // Sign a final commitment for exact actual spend to avoid overpay
      let voucher: { amount: string; signature: string } | undefined;
      if (session.cumulativeAmount > 0n && commitmentRef.current) {
        const commitmentBytes = await prepareCommitment(
          session.channelId,
          session.cumulativeAmount,
        );
        const signature = commitmentRef.current.sign(commitmentBytes as Buffer);
        voucher = {
          amount: session.cumulativeAmount.toString(),
          signature: toHex(signature),
        };
      }

      const payload = buildClosePayload(session.channelId, voucher);
      const res = await sendChat("", session, payload);

      if (res.ok) {
        const body = (await res.json()) as {
          status?: string;
          txHash?: string;
          closedAmount?: string;
          actualSpend?: string;
        };
        if (body.status === "already-closed") {
          addLine("system", "Channel already closed by server.");
        } else if (body.status === "closing") {
          addLine(
            "system",
            `Channel closing — server will finalize ${body.closedAmount || session.cumulativeAmount} stroops on-chain.`,
          );
        } else if (body.status === "no-funds") {
          addLine("system", "Channel closed. No charges.");
        } else if (body.txHash) {
          const closed = body.closedAmount || session.cumulativeAmount.toString();
          const spent = body.actualSpend || session.cumulativeAmount.toString();
          if (closed !== spent) {
            addLine(
              "system",
              `Channel closed: ${closed} stroops on-chain (actual spend: ${spent} stroops).`,
            );
          } else {
            addLine("system", `Channel closed: ${spent} stroops.`);
          }
          addLine("system", `Close tx: https://stellar.expert/explorer/testnet/tx/${body.txHash}`);
        } else {
          addLine("system", "Channel closed.");
        }
      } else {
        const body = (await res.json().catch(() => ({ detail: "" }))) as { detail?: string };
        addLine("error", `Close failed: ${body.detail || res.status}`);
      }
    } catch (e) {
      addLine("error", `Close error: ${e}`);
    }

    // Clean up regardless
    sessionRef.current = null;
    commitmentRef.current = null;
    setChannelId(null);
    setBalance(BigInt(0));
    setDeposit(BigInt(0));
    setTimeRemaining(0);
    setDisabled(false);
  }, [addLine]);

  const handleChat = useCallback(
    async (message: string) => {
      if (!sessionRef.current || !commitmentRef.current) {
        addLine("system", "No active channel. Type /open first.");
        return;
      }

      const session = sessionRef.current;
      // Pre-authorize: sign for max possible cost
      const maxAuthorized = session.cumulativeAmount + CONFIG.maxCostPerMessage;

      if (maxAuthorized > session.deposit) {
        const remaining = session.deposit - session.cumulativeAmount;
        if (remaining < CONFIG.costPerToken) {
          addLine(
            "system",
            `Credits exhausted (${session.cumulativeAmount}/${session.deposit} used).`,
          );
          addLine("system", "Type /topup to add more credits, or /close to settle.");
          return;
        }
      }

      setDisabled(true);
      try {
        // 1. Simulate prepare_commitment for max authorized amount
        const commitAmount = maxAuthorized > session.deposit ? session.deposit : maxAuthorized;
        const commitmentBytes = await prepareCommitment(session.channelId, commitAmount);

        // 2. Sign with ephemeral key
        const signature = commitmentRef.current.sign(commitmentBytes as Buffer);
        const sigHex = toHex(signature);

        // 3. Build credential and send
        const payload = buildVoucherPayload(session.channelId, commitAmount.toString(), sigHex);
        const res = await sendChat(message, session, payload);

        if (res.status === 402) {
          const body = (await res.json().catch(() => ({ detail: "" }))) as { detail?: string };
          addLine("error", `Payment rejected: ${body.detail || "verification failed"}`);
          setDisabled(false);
          return;
        }

        if (!res.ok) {
          const body = (await res.json().catch(() => ({ detail: res.statusText }))) as {
            detail?: string;
          };
          addLine("error", `Server error: ${body.detail || res.status}`);
          setDisabled(false);
          return;
        }

        // 4. Stream response with animated per-token credit burn
        const priorCumulative = session.cumulativeAmount;
        const prevBalance = session.deposit - priorCumulative;
        setStreamingText("");
        let fullResponse = "";
        let tokenCount = 0;
        let gotUsage = false;

        for await (const event of streamTokens(res)) {
          if (event.type === "token") {
            fullResponse += event.text;
            tokenCount++;
            setStreamingText(fullResponse);

            // Animate balance: deduct per-token cost as tokens arrive
            const spent = BigInt(tokenCount) * CONFIG.costPerToken;
            setBalance(prevBalance - spent);
          } else if (event.type === "usage") {
            // Server-reported cost is informational only — display it
            gotUsage = true;
            addLine("ai", fullResponse);
            addLine(
              "system",
              `[${event.usage.completion_tokens} tokens, ${event.usage.cost} stroops]`,
            );
          }
        }

        // 5. Client computes cumulative from its own token count — no server trust needed
        const actualCost = BigInt(tokenCount) * CONFIG.costPerToken;
        session.cumulativeAmount = priorCumulative + actualCost;
        setBalance(session.deposit - session.cumulativeAmount);
        if (!gotUsage) {
          addLine("ai", fullResponse);
        }
        setStreamingText("");
      } catch (e) {
        addLine("error", `Chat error: ${e}`);
      }
      setDisabled(false);
    },
    [addLine],
  );

  const handleCommand = useCallback(
    async (cmd: string) => {
      const command = cmd.toLowerCase().split(" ")[0];

      switch (command) {
        case "/help":
          addLine("system", "Commands:");
          addLine("system", "  /open    — Open a payment channel");
          addLine("system", "  /close   — Close channel and settle on-chain");
          addLine("system", "  /topup   — Add more credits to the channel");
          addLine("system", "  /balance — Show channel balance");
          addLine("system", "  /github  — View project source on GitHub");
          addLine("system", "  /help    — Show this help");
          addLine("system", "  (text)   — Send a chat message");
          break;

        case "/open":
          await handleOpen();
          break;

        case "/close":
          await handleClose();
          break;

        case "/topup":
          await handleTopup();
          break;

        case "/github":
          window.open(
            "https://github.com/stellar-experimental/stellar-mpp-demo",
            "_blank",
          );
          addLine(
            "system",
            "Opening github.com/stellar-experimental/stellar-mpp-demo",
          );
          break;

        case "/balance":
          if (!sessionRef.current) {
            addLine("system", "No active channel. Type /open to start.");
          } else {
            const dep = sessionRef.current.deposit;
            const sp = sessionRef.current.cumulativeAmount;
            const rem = dep - sp;
            addLine(
              "system",
              `Deposit: ${dep} stroops | Spent: ${sp} stroops | Remaining: ${rem} stroops`,
            );
          }
          break;

        default:
          addLine("error", `Unknown command: ${command}. Type /help for commands.`);
      }
    },
    [addLine, handleOpen, handleClose, handleTopup],
  );

  // Countdown timer — auto-close when expired
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!sessionRef.current) return;

    timerRef.current = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.floor((sessionRef.current!.expiresAt - Date.now()) / 1000),
      );
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        addLine("system", "Channel expired. Auto-closing...");
        handleClose();
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channelId, addLine, handleClose]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    addLine("user", text);

    if (text.startsWith("/")) {
      await handleCommand(text);
    } else {
      await handleChat(text);
    }
  }, [input, addLine, handleCommand, handleChat]);

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
