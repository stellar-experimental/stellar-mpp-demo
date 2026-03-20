import { memo } from "react";

interface HeaderProps {
  walletAddress: string;
  channelId: string | null;
  balance: bigint;
  deposit: bigint;
  timeRemaining: number;
}

function creditBar(balance: bigint, deposit: bigint): string {
  if (deposit <= BigInt(0)) return "";
  const width = 10;
  const filled = Number((balance * BigInt(width)) / deposit);
  const empty = width - filled;
  return `[${"▓".repeat(filled)}${"░".repeat(empty)}]`;
}

function Header({ walletAddress, channelId, balance, deposit, timeRemaining }: HeaderProps) {
  const mins = Math.floor(timeRemaining / 60);
  const secs = timeRemaining % 60;
  const timer = timeRemaining > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : "--:--";
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    : "----";
  const shortChannel = channelId ? `${channelId.slice(0, 4)}...${channelId.slice(-4)}` : "none";

  return (
    <header className="shrink-0 border-b border-neutral-700 bg-neutral-900 px-3 py-2">
      <div className="hidden min-[901px]:flex min-[901px]:items-start min-[901px]:gap-4">
        <span className="shrink-0 text-sm font-semibold tracking-wide text-neutral-100">
          MPP Channel Demo
        </span>
        <div className="ml-auto flex max-w-[70%] flex-wrap justify-end gap-x-4 gap-y-1 text-right text-xs">
          <span className="text-neutral-300">
            <span className="text-neutral-400">wallet:</span>
            {shortWallet}
          </span>
          <span className="text-neutral-300">
            <span className="text-neutral-400">channel:</span>
            {shortChannel}
          </span>
          {deposit > BigInt(0) && (
            <span
              className="text-neutral-200"
              aria-label={`credits ${balance.toString()} of ${deposit.toString()} stroops remaining`}
            >
              <span className="text-neutral-400">credits:</span>
              {creditBar(balance, deposit)} {balance.toString()}/{deposit.toString()}
            </span>
          )}
          <span className="text-neutral-300">
            <span className="text-neutral-400">timer:</span>
            {timer}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 min-[901px]:hidden">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold tracking-wide text-neutral-100">
            MPP Channel Demo
          </span>
        </div>
        <dl className="grid grid-cols-3 gap-1.5 text-[11px] min-[521px]:text-xs">
          <div className="min-w-0 rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1">
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">Wallet</dt>
            <dd className="truncate text-neutral-200">{shortWallet}</dd>
          </div>
          <div className="min-w-0 rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1">
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">Channel</dt>
            <dd className="truncate text-neutral-200">{shortChannel}</dd>
          </div>
          <div className="min-w-0 rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1">
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">Timer</dt>
            <dd className="text-neutral-200">{timer}</dd>
          </div>
          {deposit > BigInt(0) && (
            <div
              className="col-span-3 min-w-0 rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1 text-neutral-200"
              aria-label={`credits ${balance.toString()} of ${deposit.toString()} stroops remaining`}
            >
              <dt className="text-[10px] uppercase tracking-wide text-neutral-500">Credits</dt>
              <dd className="mt-1 overflow-x-auto whitespace-nowrap text-neutral-200">
                {creditBar(balance, deposit)} {balance.toString()}/{deposit.toString()}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </header>
  );
}

export default memo(Header);
