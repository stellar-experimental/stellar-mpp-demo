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
    <div className="shrink-0 flex items-center justify-between px-3 py-1.5 bg-neutral-900 text-neutral-500 text-xs border-b border-neutral-800">
      <span>MPP Channel Demo</span>
      <div className="flex gap-4">
        <span>wallet:{shortWallet}</span>
        <span>channel:{shortChannel}</span>
        {deposit > BigInt(0) && <span>credits:{creditBar(balance, deposit)}</span>}
        <span>timer:{timer}</span>
      </div>
    </div>
  );
}

export default memo(Header);
