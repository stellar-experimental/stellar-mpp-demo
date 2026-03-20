import { memo, useRef, useEffect, type ReactNode } from "react";

export interface TerminalLine {
  id: number;
  type: "system" | "user" | "ai" | "error";
  content: string;
}

const URL_RE = /(https?:\/\/[^\s]+)/;

function linkify(text: string): ReactNode {
  const parts = text.split(new RegExp(URL_RE.source, "g"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    URL_RE.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

interface TerminalProps {
  lines: TerminalLine[];
  streamingText: string;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  requestState: string;
  lastUsageTokens: number | null;
  lastUsageCost: string | null;
  lastUsageTurn: number;
}

function Terminal({
  lines,
  streamingText,
  input,
  onInputChange,
  onSubmit,
  disabled,
  requestState,
  lastUsageTokens,
  lastUsageCost,
  lastUsageTurn,
}: TerminalProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, streamingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [disabled]);

  const colorClass = (type: TerminalLine["type"]) => {
    switch (type) {
      case "system":
        return "text-neutral-500";
      case "user":
        return "text-white";
      case "ai":
        return "text-neutral-300";
      case "error":
        return "text-red-400";
    }
  };

  return (
    <>
      <div
        ref={outputRef}
        data-testid="terminal-output"
        data-request-state={requestState}
        data-input-ready={disabled ? "false" : "true"}
        data-last-usage-turn={String(lastUsageTurn)}
        data-last-usage-tokens={lastUsageTokens === null ? "" : String(lastUsageTokens)}
        data-last-usage-cost={lastUsageCost ?? ""}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 scrollbar-thin"
        onClick={() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) inputRef.current?.focus();
        }}
      >
        {lines.map((line) => (
          <div key={line.id} className={`whitespace-pre-wrap break-words ${colorClass(line.type)}`}>
            {line.type === "user" ? `> ${line.content}` : linkify(line.content)}
          </div>
        ))}
        {streamingText && (
          <div className="text-neutral-300 whitespace-pre-wrap break-words">
            {streamingText}
            <span className="cursor-blink">▋</span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center px-3 py-2 border-t border-neutral-800">
        <span className="text-neutral-500 mr-2">{">"}</span>
        <input
          ref={inputRef}
          data-testid="terminal-input"
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onSubmit();
          }}
          disabled={disabled}
          className="flex-1 bg-transparent text-white outline-none caret-white"
          placeholder={disabled ? "processing..." : "type a message or /help"}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </>
  );
}

export default memo(Terminal);
