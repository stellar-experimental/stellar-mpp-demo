import { memo, useRef, useEffect, useSyncExternalStore, type ReactNode } from "react";

export interface TerminalLine {
  id: number;
  type: "system" | "user" | "ai" | "error" | "success" | "warning" | "billing";
  content: string;
}

export interface TerminalCommand {
  command: string;
  label: string;
}

const URL_RE = /(https?:\/\/[^\s]+)/;
const BOTTOM_THRESHOLD_PX = 24;

// Module-level media query helpers — stable references, no recreation per render
const TOUCH_BREAKPOINT = "(max-width: 900px)";
function subscribeToTouchLayout(callback: () => void) {
  const mq = window.matchMedia(TOUCH_BREAKPOINT);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
function getTouchLayoutSnapshot() {
  return window.matchMedia(TOUCH_BREAKPOINT).matches;
}
function getTouchLayoutServerSnapshot() {
  return false;
}

function isNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

// Hoisted out of component — pure function, no need to recreate each render
function colorClass(type: TerminalLine["type"]): string {
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
}

function linkify(text: string): ReactNode {
  // URL_RE already has a capturing group — split preserves matches in the result array.
  // Avoid `new RegExp(URL_RE.source, "g")`: the /g flag gives RegExp mutable lastIndex state.
  const parts = text.split(URL_RE);
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
  onCommandTap: (command: string) => void;
  commands: TerminalCommand[];
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
  onCommandTap,
  commands,
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

  // useSyncExternalStore: correct for SSR, no useState+useEffect round-trip
  const isTouchLayout = useSyncExternalStore(
    subscribeToTouchLayout,
    getTouchLayoutSnapshot,
    getTouchLayoutServerSnapshot,
  );

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
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 text-[14px] leading-6 scrollbar-thin sm:text-[15px] sm:leading-7"
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
          <div
            key={line.id}
            className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${colorClass(line.type)}`}
          >
            {line.type === "user" ? `> ${line.content}` : linkify(line.content)}
          </div>
        ))}
        {streamingText && (
          <div className="text-neutral-100 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {streamingText}
            <span className="cursor-blink">▋</span>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-neutral-700 px-3 py-3 max-[520px]:sticky max-[520px]:bottom-0 max-[520px]:z-10 max-[520px]:border-neutral-800 max-[520px]:bg-neutral-950/95 max-[520px]:backdrop-blur max-[520px]:supports-[padding:max(0px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mb-2 min-[901px]:hidden">
          <div
            className="command-strip flex gap-1.5 overflow-x-auto pb-1"
            aria-label="Quick command panel"
          >
            {commands.map((item) => (
              <button
                key={item.command}
                type="button"
                onClick={() => {
                  if (!disabled) onCommandTap(item.command);
                }}
                disabled={disabled}
                className="shrink-0 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-neutral-200 transition hover:border-cyan-500/50 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Run ${item.command}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/80 px-2 py-2 min-[901px]:rounded-none min-[901px]:border-0 min-[901px]:bg-transparent min-[901px]:px-0 min-[901px]:py-0">
          <span className="shrink-0 text-cyan-300" aria-hidden="true">
            {">"}
          </span>
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
            className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-[16px] text-white caret-white outline-none placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 disabled:text-neutral-400 min-[521px]:text-[15px]"
            placeholder={
              disabled
                ? "Processing..."
                : isTouchLayout
                  ? "Message or /open"
                  : "Type a message, /wtf, /help, or /open"
            }
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
            disabled={disabled || !input.trim()}
            className="shrink-0 rounded border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-900 disabled:text-neutral-500 min-[901px]:hidden"
            aria-label="Submit terminal input"
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}

export default memo(Terminal);
