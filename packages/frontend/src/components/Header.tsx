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
  return `[${"▓".repeat(filled)}${"░".repeat(empty)}] ${balance}/${deposit}`;
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-semibold tracking-wide text-neutral-100">MPP Channel Demo</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] sm:text-xs">
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
              {creditBar(balance, deposit)}
            </span>
          )}
          <span className="text-neutral-300">
            <span className="text-neutral-400">timer:</span>
            {timer}
          </span>
        </div>
      </div>
    </header>
  );
}

export default memo(Header);
