import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef, useDeferredValue, startTransition } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import Header from "../components/Header";
import Terminal, { type TerminalCommand, type TerminalLine } from "../components/Terminal";
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
import tourMarkdown from "../content/tour.md?raw";

export const Route = createFileRoute("/")({ component: App });

let lineId = 0;
function newLine(type: TerminalLine["type"], content: string): TerminalLine {
  return { id: lineId++, type, content };
}

type RequestState = "idle" | "opening" | "chatting" | "topping-up" | "closing";
type WalletStatus = "created" | "restored" | null;

const STARTUP_HINT =
  "Type /tour for the protocol tour, /help for commands, or /open to start a session.\n";
const MOBILE_COMMANDS: TerminalCommand[] = [
  { command: "/tour", label: "Tour" },
  { command: "/help", label: "Help" },
  { command: "/open", label: "Open" },
  { command: "/balance", label: "Balance" },
  { command: "/topup", label: "Top Up" },
  { command: "/close", label: "Close" },
  { command: "/clear", label: "Clear" },
  { command: "/github", label: "GitHub" },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkMarkdownForStream(markdown: string): string[] {
  return markdown.match(/\S+\s*/g) ?? [markdown];
}

function renderMarkdownForTerminal(markdown: string): string {
  const lines = markdown.split("\n");
  const rendered: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      if (rendered.at(-1) !== "") rendered.push("");
      continue;
    }

    if (line.startsWith("# ")) {
      const title = line.slice(2).replace(/\*\*/g, "").trim().toUpperCase();
      rendered.push(title);
      rendered.push("=".repeat(title.length));
      continue;
    }

    if (line.startsWith("## ")) {
      const title = line.slice(3).replace(/\*\*/g, "").trim().toUpperCase();
      if (rendered.at(-1) !== "") rendered.push("");
      rendered.push(title);
      continue;
    }

    if (line.startsWith("### ")) {
      const title = line.slice(4).replace(/\*\*/g, "").trim();
      if (rendered.at(-1) !== "") rendered.push("");
      rendered.push(title);
      continue;
    }

    const text = line
      .replace(/^-\s+/, "• ")
      .replace(/^>\s+/, '"')
      .replace(/\*\*/g, "")
      .replace(/`([^`]+)`/g, "$1");

    if (line.startsWith("> ")) {
      rendered.push(`${text}"`);
      continue;
    }

    rendered.push(text);
  }

  return rendered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function App() {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [input, setInput] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [lastUsageTokens, setLastUsageTokens] = useState<number | null>(null);
  const [lastUsageCost, setLastUsageCost] = useState<string | null>(null);
  const [lastUsageTurn, setLastUsageTurn] = useState(0);

  const [walletReady, setWalletReady] = useState(false);
  const [walletStatus, setWalletStatus] = useState<WalletStatus>(null);
  const [walletFundingError, setWalletFundingError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [channelId, setChannelId] = useState<string | null>(null);
  const [balance, setBalance] = useState(BigInt(0));
  const [deposit, setDeposit] = useState(BigInt(0));
  const [timeRemaining, setTimeRemaining] = useState(0);

  const walletRef = useRef<Keypair | null>(null);
  const commitmentRef = useRef<Keypair | null>(null);
  const sessionRef = useRef<ChannelSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deferredBalance = useDeferredValue(balance);
  const deferredStreamingText = useDeferredValue(streamingText);

  // Wallet state ref — updated synchronously each render so callbacks can read
  // current values without capturing them as closure deps (advanced-use-latest pattern).
  const walletStateRef = useRef({ walletAddress, walletStatus, walletReady, walletFundingError });
  walletStateRef.current = { walletAddress, walletStatus, walletReady, walletFundingError };

  // Input value ref — keeps handleSubmit stable across keystrokes (rerender-defer-reads).
  const inputValueRef = useRef(input);
  inputValueRef.current = input;

  const addLine = useCallback((type: TerminalLine["type"], content: string) => {
    setLines((prev) => [...prev, newLine(type, content)]);
  }, []);
  const addSuccess = useCallback((content: string) => addLine("success", content), [addLine]);
  const addWarning = useCallback((content: string) => addLine("warning", content), [addLine]);
  const addBilling = useCallback((content: string) => addLine("billing", content), [addLine]);

  // Stable [] deps: reads wallet state from ref instead of closure.
  // Breaks the buildStartupLines → clearTerminalLog → handleCommand → handleSubmit
  // recreation chain that previously fired on every wallet state update.
  const buildStartupLines = useCallback(
    ({
      nextWalletAddress,
      nextWalletStatus,
      nextWalletReady,
      nextWalletFundingError,
    }: {
      nextWalletAddress?: string;
      nextWalletStatus?: WalletStatus;
      nextWalletReady?: boolean;
      nextWalletFundingError?: string | null;
    } = {}): TerminalLine[] => {
      const ws = walletStateRef.current;
      const addr = nextWalletAddress ?? ws.walletAddress;
      const status = nextWalletStatus ?? ws.walletStatus;
      const ready = nextWalletReady ?? ws.walletReady;
      // Use !== undefined so an explicitly-passed null ("no error") is respected
      const fundingError =
        nextWalletFundingError !== undefined ? nextWalletFundingError : ws.walletFundingError;

      const startupLines: TerminalLine[] = [
        newLine(
          "system",
          "MPP Chat Demo — AI chatbot with pay-per-message via MPP Sessions on Stellar",
        ),
        newLine(
          "system",
          "https://mpp.dev | https://github.com/stellar-experimental/stellar-mpp-sdk | https://github.com/stellar-experimental/stellar-mpp-demo",
        ),
        newLine("system", STARTUP_HINT),
      ];

      if (addr && status) {
        startupLines.push(newLine("system", `Wallet ${status}: ${addr}`));
        startupLines.push(newLine("system", "Ensuring account is funded..."));

        if (ready) {
          startupLines.push(newLine("success", "Wallet ready on testnet."));
        } else if (fundingError) {
          startupLines.push(newLine("error", fundingError));
        }
      }

      return startupLines;
    },
    [], // stable — reads from walletStateRef
  );
  const clearTerminalLog = useCallback(() => {
    setStreamingText("");
    setLines(buildStartupLines());
  }, [buildStartupLines]);

  // Initialize wallet on mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (walletRef.current) return;

    const init = async () => {
      setLines(buildStartupLines());

      const { keypair, isNew } = getOrCreateKeypair();
      const nextWalletStatus = isNew ? "created" : "restored";
      const nextWalletAddress = keypair.publicKey();
      walletRef.current = keypair;
      setWalletAddress(nextWalletAddress);
      setWalletStatus(nextWalletStatus);
      setWalletFundingError(null);
      setLines(
        buildStartupLines({
          nextWalletAddress,
          nextWalletStatus,
          nextWalletReady: false,
          nextWalletFundingError: null,
        }),
      );

      try {
        await fundWallet(nextWalletAddress);
        setWalletFundingError(null);
        setWalletReady(true);
        setLines(
          buildStartupLines({
            nextWalletAddress,
            nextWalletStatus,
            nextWalletReady: true,
            nextWalletFundingError: null,
          }),
        );
      } catch (e) {
        const message = `Funding failed: ${e}. Reload to retry.`;
        setWalletFundingError(message);
        setLines(
          buildStartupLines({
            nextWalletAddress,
            nextWalletStatus,
            nextWalletReady: false,
            nextWalletFundingError: message,
          }),
        );
      }
    };
    init();
  }, [buildStartupLines]);

  const handleOpen = useCallback(async () => {
    if (sessionRef.current) {
      addLine("error", "Session already open. /close it first.");
      return;
    }
    if (!walletRef.current || !walletReady) {
      addLine("system", "Wallet still initializing, please wait...");
      return;
    }

    setDisabled(true);
    setRequestState("opening");
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
        return;
      }

      const challenge = parseChallenge(challengeRes);
      addLine("system", "Challenge received. Opening session on Stellar...");

      // 2. Generate ephemeral commitment keypair
      const commitmentKp = Keypair.random();
      commitmentRef.current = commitmentKp;

      // 3. Open channel on-chain via factory
      const { channelAddress: chanId, txHash: openTxHash } = await openChannel(
        walletRef.current,
        commitmentKp,
      );
      addSuccess(`Session opened: ${chanId}`);
      addLine("system", `Open tx: https://stellar.expert/explorer/testnet/tx/${openTxHash}`);

      // 4. Register channel with the server
      addLine("system", "Registering session...");
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
      addSuccess(
        `Session open! ${CONFIG.deposit.toString()} stroops deposited. Timer: ${ttlMin}:${ttlSec.toString().padStart(2, "0")}`,
      );
      addLine(
        "system",
        `Type a message to chat (${CONFIG.costPerToken.toString()} stroops per token).\n`,
      );
    } catch (e) {
      addLine("error", `Open failed: ${e}`);
    } finally {
      setDisabled(false);
      setRequestState("idle");
    }
  }, [addLine, addSuccess, walletReady]);

  const handleTopup = useCallback(async () => {
    if (!sessionRef.current || !walletRef.current) {
      addLine("system", "No active session. Type /open first.");
      return;
    }

    setDisabled(true);
    setRequestState("topping-up");
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
        addSuccess(`Topped up! Deposit now ${newBalance} stroops. Timer reset.`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        addLine("error", `Server rejected top-up: ${body.detail || res.status}`);
      }
    } catch (e) {
      addLine("error", `Top-up error: ${e}`);
    } finally {
      setDisabled(false);
      setRequestState("idle");
    }
  }, [addLine, addSuccess]);

  const handleClose = useCallback(async () => {
    if (!sessionRef.current) {
      addLine("system", "No active session to close.");
      return;
    }

    setDisabled(true);
    setRequestState("closing");
    addLine("system", "Closing session...");
    let shouldClearSession = false;
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
          addLine("system", "Session already closed by server.");
          shouldClearSession = true;
        } else if (body.status === "closing") {
          addWarning(
            `Session closing — server will finalize ${body.closedAmount || session.cumulativeAmount} stroops on-chain.`,
          );
        } else if (body.status === "no-funds") {
          addSuccess("Session closed. No charges.");
          shouldClearSession = true;
        } else if (body.txHash) {
          const closed = body.closedAmount || session.cumulativeAmount.toString();
          const spent = body.actualSpend || session.cumulativeAmount.toString();
          if (closed !== spent) {
            addSuccess(
              `Session closed: ${closed} stroops on-chain (actual spend: ${spent} stroops).`,
            );
          } else {
            addSuccess(`Session closed: ${spent} stroops.`);
          }
          addLine("system", `Close tx: https://stellar.expert/explorer/testnet/tx/${body.txHash}`);
          shouldClearSession = true;
        } else {
          addSuccess("Session closed.");
          shouldClearSession = true;
        }
      } else {
        const body = (await res.json().catch(() => ({ detail: "" }))) as { detail?: string };
        addLine("error", `Close failed: ${body.detail || res.status}`);
      }
    } catch (e) {
      addLine("error", `Close error: ${e}`);
    }

    if (shouldClearSession) {
      sessionRef.current = null;
      commitmentRef.current = null;
      setChannelId(null);
      setBalance(BigInt(0));
      setDeposit(BigInt(0));
      setTimeRemaining(0);
    }
    setDisabled(false);
    setRequestState("idle");
  }, [addLine, addSuccess, addWarning]);

  const handleChat = useCallback(
    async (message: string) => {
      if (!sessionRef.current || !commitmentRef.current) {
        addLine("system", "No active session. Type /open first.");
        return;
      }

      const session = sessionRef.current;
      // Pre-authorize: sign for max possible cost
      const maxAuthorized = session.cumulativeAmount + CONFIG.maxCostPerMessage;

      if (maxAuthorized > session.deposit) {
        const remaining = session.deposit - session.cumulativeAmount;
        if (remaining < CONFIG.costPerToken) {
          addWarning(`Credits exhausted (${session.cumulativeAmount}/${session.deposit} used).`);
          addWarning("Type /topup to add more credits, or /close to settle.");
          return;
        }
      }

      setDisabled(true);
      setRequestState("chatting");
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
          return;
        }

        if (!res.ok) {
          const body = (await res.json().catch(() => ({ detail: res.statusText }))) as {
            detail?: string;
          };
          addLine("error", `Server error: ${body.detail || res.status}`);
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
            const spent = BigInt(tokenCount) * CONFIG.costPerToken;
            startTransition(() => {
              setStreamingText(fullResponse);
              // Animate balance: deduct per-token cost as tokens arrive
              setBalance(prevBalance - spent);
            });
          } else if (event.type === "usage") {
            // Server-reported cost is informational only — display it
            gotUsage = true;
            setLastUsageTokens(event.usage.completion_tokens);
            setLastUsageCost(event.usage.cost);
            setLastUsageTurn((prev) => prev + 1);
            addLine("ai", fullResponse);
            addBilling(`[${event.usage.completion_tokens} tokens, ${event.usage.cost} stroops]`);
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
      } finally {
        setDisabled(false);
        setRequestState("idle");
      }
    },
    [addBilling, addLine, addWarning],
  );

  const streamMarkdownNarration = useCallback(
    async (markdown: string) => {
      setDisabled(true);
      setRequestState("chatting");
      setStreamingText("");

      try {
        const chunks = chunkMarkdownForStream(markdown);
        let rendered = "";

        await sleep(280);

        for (const chunk of chunks) {
          rendered += chunk;
          startTransition(() => {
            setStreamingText(rendered);
          });

          const normalized = chunk.trim();
          const delay = normalized.length > 8 ? 48 + Math.random() * 110 : 28 + Math.random() * 70;
          await sleep(delay);
        }

        await sleep(160);
        addLine("ai", rendered.trimEnd());
      } finally {
        setStreamingText("");
        setDisabled(false);
        setRequestState("idle");
      }
    },
    [addLine],
  );

  const handleCommand = useCallback(
    async (cmd: string) => {
      const command = cmd.toLowerCase().split(" ")[0];

      switch (command) {
        case "/help":
          addLine("system", "Commands:");
          addLine("system", "  /open    — Open a session");
          addLine("system", "  /close   — Close session and settle on-chain");
          addLine("system", "  /topup   — Add more credits to the session");
          addLine("system", "  /balance — Show session balance");
          addLine("system", "  /clear   — Reset the terminal log");
          addLine("system", "  /tour    — Explain what this demo is actually doing");
          addLine("system", "  /github  — View project source on GitHub");
          addLine("system", "  /help    — Show this help");
          addLine("system", "  (text)   — Send a chat message");
          addLine(
            "system",
            "\nSuggested next step: /tour for the tour, or /open to watch it happen.",
          );
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
          window.open("https://github.com/stellar-experimental/stellar-mpp-demo", "_blank");
          addLine("system", "Opening github.com/stellar-experimental/stellar-mpp-demo");
          break;

        case "/balance":
          if (!sessionRef.current) {
            addLine("system", "No active session. Type /open to start.");
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

        case "/clear":
          clearTerminalLog();
          break;

        case "/tour":
          await streamMarkdownNarration(renderMarkdownForTerminal(tourMarkdown));
          addLine(
            "system",
            "\nSuggested next step: /open to run the flow live, or /help to see the controls.",
          );
          break;

        default:
          addLine("error", `Unknown command: ${command}. Type /help for commands.`);
      }
    },
    [addLine, clearTerminalLog, handleOpen, handleClose, handleTopup, streamMarkdownNarration],
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
        addWarning("Session expired. Auto-closing...");
        handleClose();
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channelId, addWarning, handleClose]);

  const handleSubmit = useCallback(async () => {
    // Read current input from ref — removes `input` from deps so this callback
    // stays stable across keystrokes instead of being recreated on every change.
    const text = inputValueRef.current.trim();
    if (!text) return;
    setInput("");
    addLine("user", text);

    if (text.startsWith("/")) {
      await handleCommand(text);
    } else {
      await handleChat(text);
    }
  }, [addLine, handleCommand, handleChat]);

  const handleQuickCommand = useCallback(
    async (command: string) => {
      setInput("");
      addLine("user", command);
      await handleCommand(command);
    },
    [addLine, handleCommand],
  );

  return (
    <>
      <Header
        walletAddress={walletAddress}
        channelId={channelId}
        balance={deferredBalance}
        deposit={deposit}
        timeRemaining={timeRemaining}
      />
      <Terminal
        lines={lines}
        streamingText={deferredStreamingText}
        input={input}
        onInputChange={setInput}
        onSubmit={handleSubmit}
        onCommandTap={handleQuickCommand}
        commands={MOBILE_COMMANDS}
        disabled={disabled}
        requestState={requestState}
        lastUsageTokens={lastUsageTokens}
        lastUsageCost={lastUsageCost}
        lastUsageTurn={lastUsageTurn}
      />
    </>
  );
}
