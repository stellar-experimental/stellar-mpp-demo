import { memo, useRef, useEffect, type ReactNode } from "react";

export interface TerminalLine {
  id: number;
  type: "system" | "user" | "ai" | "error" | "success" | "warning" | "billing";
  content: string;
}

const URL_RE = /(https?:\/\/[^\s]+)/;
const BOTTOM_THRESHOLD_PX = 24;

function isNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function linkify(text: string): ReactNode {
  const parts = text.split(new RegExp(URL_RE.source, "g"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    URL_RE.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-300 underline underline-offset-2 decoration-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 rounded-sm"
      >
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
  const shouldAutoScrollRef = useRef(true);
  const previousLastLineRef = useRef<TerminalLine | null>(null);

  useEffect(() => {
    const lastLine = lines.at(-1) ?? null;
    const previousLastLine = previousLastLineRef.current;

    if (
      lastLine &&
      lastLine.type === "user" &&
      (!previousLastLine || previousLastLine.id !== lastLine.id)
    ) {
      shouldAutoScrollRef.current = true;
    }

    previousLastLineRef.current = lastLine;
  }, [lines]);

  useEffect(() => {
    if (outputRef.current && shouldAutoScrollRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, streamingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [disabled]);

  const colorClass = (type: TerminalLine["type"]) => {
    switch (type) {
      case "system":
        return "text-neutral-300";
      case "user":
        return "text-cyan-300";
      case "ai":
        return "text-neutral-100";
      case "error":
        return "text-red-300";
      case "success":
        return "text-emerald-300";
      case "warning":
        return "text-amber-300";
      case "billing":
        return "text-violet-300";
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
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Terminal output"
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 text-[15px] leading-7 scrollbar-thin"
        onScroll={() => {
          if (!outputRef.current) return;
          shouldAutoScrollRef.current = isNearBottom(outputRef.current);
        }}
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
          <div className="text-neutral-100 whitespace-pre-wrap break-words">
            {streamingText}
            <span className="cursor-blink">▋</span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2 border-t border-neutral-700 px-3 py-3">
        <span className="text-cyan-300">{">"}</span>
        <input
          ref={inputRef}
          data-testid="terminal-input"
          aria-label="Terminal input"
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onSubmit();
          }}
          disabled={disabled}
          className="flex-1 rounded-sm bg-transparent px-1 py-0.5 text-white caret-white outline-none placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 disabled:text-neutral-400"
          placeholder={disabled ? "processing..." : "type a message, /wtf, /help, or /open"}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          data-testid="terminal-submit"
          onClick={() => {
            if (!disabled) onSubmit();
          }}
          disabled={disabled}
          className="sr-only"
          aria-label="Submit terminal input"
        >
          Send
        </button>
      </div>
    </>
  );
}

export default memo(Terminal);
