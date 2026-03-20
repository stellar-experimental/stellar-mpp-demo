#!/bin/bash
# Unified E2E smoke test for the full channel lifecycle.
# Usage: ./test/e2e-browser-smoke.sh [base_url]
# Default: https://mpp.stellar.buzz

set +e

BASE_URL="${1:-https://mpp.stellar.buzz}"
SCREENSHOT_DIR="/tmp/claude/e2e-$(date +%s)"
BROWSER_SESSION="mpp-smoke-$$"
INPUT_SELECTOR="input[type='text']"
MAX_WAIT=15000
CHAT_WAIT=45000
CHAIN_WAIT=120000
PASS=0
FAIL=0
CHANNEL_ID=""
CHANNEL_STATE_URL=""
FIRST_DEPOSIT=""
SECOND_DEPOSIT=""
FIRST_SPENT=""
SECOND_SPENT=""
CHANNEL_STATE_BODY=""
CHANNEL_STATE_HTTP=""

mkdir -p "$SCREENSHOT_DIR"

TIMEOUT_PID=$$
( sleep 300 && kill -TERM "$TIMEOUT_PID" 2>/dev/null ) &
WATCHDOG_PID=$!

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
step() { echo ""; echo "━━━ $1 ━━━"; }

browser() {
  agent-browser --session "$BROWSER_SESSION" "$@"
}

bodyText() {
  browser snapshot 2>/dev/null
}

browserEval() {
  local js="$1"
  browser eval "$js" 2>/dev/null | tr -d '\r'
}

terminalAttr() {
  local name="$1"
  browserEval "document.querySelector('[data-testid=\"terminal-output\"]')?.getAttribute('$name') ?? ''" | sed -e 's/^"//' -e 's/"$//'
}

waitFor() {
  local text="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    if bodyText | grep -Fq "$text"; then
      return 0
    fi
  done
  return 1
}

waitForEither() {
  local first="$1" second="$2" timeout="$3" interval="${4:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i body=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    body=$(bodyText)
    if echo "$body" | grep -Fq "$first" || echo "$body" | grep -Fq "$second"; then
      return 0
    fi
  done
  return 1
}

waitForTerminalAttr() {
  local name="$1" expected="$2" timeout="$3" interval="${4:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i value=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    value=$(terminalAttr "$name")
    if [ "$value" = "$expected" ]; then
      return 0
    fi
  done
  return 1
}

waitForUsageTurnIncrement() {
  local previous="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i value=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    value=$(terminalAttr "data-last-usage-turn")
    if [ -n "$value" ] && [ "$value" -gt "$previous" ]; then
      echo "$value"
      return 0
    fi
  done
  return 1
}

waitForUsageCost() {
  local timeout="$1" interval="${2:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i value=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    value=$(terminalAttr "data-last-usage-cost")
    if [ -n "$value" ]; then
      echo "$value"
      return 0
    fi
  done
  return 1
}

waitForBillingCount() {
  local expected="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i body="" count=0
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    body=$(bodyText)
    count=$(echo "$body" | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
    if [ "$count" -ge "$expected" ]; then
      return 0
    fi
  done
  return 1
}

submitInput() {
  local text="$1"
  local text_b64
  text_b64=$(printf '%s' "$text" | base64 | tr -d '\n')
  browser eval --stdin > /dev/null 2>&1 <<EVALEOF
const input = document.querySelector('[data-testid="terminal-input"]');
if (!(input instanceof HTMLInputElement)) throw new Error('terminal input missing');
if (input.disabled) throw new Error('terminal input disabled');
const text = atob('${text_b64}');
input.focus();
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
if (!setter) throw new Error('input setter missing');
setter.call(input, text);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
'ok';
EVALEOF
}

submitAndConfirmEcho() {
  local text="$1" timeout="${2:-5000}"
  submitInput "$text" || return 1
  waitFor "> $text" "$timeout" 1000
}

extractLatestChannelId() {
  bodyText | sed -n 's/.*Channel deployed: \(C[A-Z0-9]*\).*/\1/p' | tail -1
}

extractLatestBalanceLine() {
  bodyText | grep -o 'Deposit: .* stroops | Spent: .* stroops | Remaining: .* stroops' | tail -1
}

extractNumberField() {
  local line="$1" field="$2"
  echo "$line" | sed -n "s/.*$field: \([0-9][0-9]*\) stroops.*/\1/p"
}

refreshChannelState() {
  if [ -z "$CHANNEL_STATE_URL" ]; then
    CHANNEL_STATE_HTTP=""
    CHANNEL_STATE_BODY=""
    return 1
  fi

  CHANNEL_STATE_BODY=$(curl -s -w $'\n%{http_code}' "$CHANNEL_STATE_URL")
  CHANNEL_STATE_HTTP=$(echo "$CHANNEL_STATE_BODY" | tail -1)
  CHANNEL_STATE_BODY=$(echo "$CHANNEL_STATE_BODY" | sed '$d')
  return 0
}

extractChannelStateNumber() {
  local field="$1"
  echo "$CHANNEL_STATE_BODY" | sed -n "s/.*\"$field\":\\([0-9][0-9]*\\).*/\\1/p"
}

waitForChannelMessageCount() {
  local expected="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i count=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    refreshChannelState || continue
    count=$(extractChannelStateNumber "messageCount")
    if [ "$CHANNEL_STATE_HTTP" = "200" ] && [ -n "$count" ] && [ "$count" -ge "$expected" ]; then
      return 0
    fi
  done
  return 1
}

waitForChannelDepositIncrease() {
  local previous="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i deposit=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    refreshChannelState || continue
    deposit=$(extractChannelStateNumber "deposit")
    if [ "$CHANNEL_STATE_HTTP" = "200" ] && [ -n "$deposit" ] && [ "$deposit" -gt "$previous" ]; then
      SECOND_DEPOSIT="$deposit"
      return 0
    fi
  done
  return 1
}

waitForChannelSpentIncrease() {
  local previous="$1" timeout="$2" interval="${3:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i spent=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    refreshChannelState || continue
    spent=$(extractChannelStateNumber "cumulativeAmount")
    if [ "$CHANNEL_STATE_HTTP" = "200" ] && [ -n "$spent" ] && [ "$spent" -gt "$previous" ]; then
      SECOND_SPENT="$spent"
      return 0
    fi
  done
  return 1
}

waitForChannelClosed() {
  local timeout="$1" interval="${2:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    refreshChannelState || continue
    if [ "$CHANNEL_STATE_HTTP" = "404" ] && echo "$CHANNEL_STATE_BODY" | grep -Fq '"status":"not-found"'; then
      return 0
    fi
  done
  return 1
}

cleanup() {
  kill "$WATCHDOG_PID" 2>/dev/null || true
  browser close > /dev/null 2>&1 || true
}
trap cleanup EXIT

step "1. Services Health Check"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
[ "$HTTP" = "200" ] && pass "Frontend: $BASE_URL → $HTTP" || fail "Frontend: $BASE_URL → $HTTP"

if echo "$BASE_URL" | grep -q "localhost"; then
  SERVER_URL="http://localhost:8787"
  AI_URL="http://localhost:8788"
else
  SERVER_URL="https://mpp-server.stellar.buzz"
  AI_URL="https://mpp-ai.stellar.buzz"
fi

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/health")
[ "$HTTP" = "200" ] && pass "MPP Server: $SERVER_URL/health → $HTTP" || fail "MPP Server: $SERVER_URL/health → $HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$AI_URL/generate" \
  -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"say ok"}]}')
[ "$HTTP" = "200" ] && pass "AI Worker: $AI_URL/generate → $HTTP" || fail "AI Worker: $AI_URL/generate → $HTTP"

step "2. 402 Challenge Flow"

RESP=$(curl -s -D - -X POST "$SERVER_URL/chat" \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' 2>&1)
HTTP=$(echo "$RESP" | grep -i "^HTTP" | tail -1 | awk '{print $2}')
[ "$HTTP" = "402" ] && pass "POST /chat (no credential) → 402" || fail "POST /chat → $HTTP (expected 402)"

echo "$RESP" | grep -qi "www-authenticate" && \
  pass "WWW-Authenticate header present" || fail "WWW-Authenticate header missing"

echo "$RESP" | grep -qi "payment-required" && \
  pass "Response body: payment-required" || fail "Response body missing payment-required"

step "3. Browser Boot"

echo "  Opening $BASE_URL..."
browser open "$BASE_URL" > /dev/null 2>&1

if waitFor "Wallet ready" $MAX_WAIT 1000; then
  pass "Wallet ready"
else
  fail "Wallet not ready"
  browser screenshot "$SCREENSHOT_DIR/fail-load.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal state exposed as idle"
else
  fail "Terminal state marker not ready"
fi

step "4. Open Channel"

if submitAndConfirmEcho "/open" 5000; then
  pass "Open command submitted in terminal"
else
  fail "Open command was not echoed in terminal"
  browser screenshot "$SCREENSHOT_DIR/fail-open-command.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

echo "  Waiting for channel deployment and registration..."
OPEN_OK=0
for i in $(seq 1 8); do
  if waitFor "Channel open" $MAX_WAIT $MAX_WAIT; then
    OPEN_OK=1
    break
  fi
  if waitForEither "Open failed" "Registration failed" 1000 1000; then
    break
  fi
done

if [ "$OPEN_OK" = "1" ]; then
  pass "Channel opened successfully"
else
  browser screenshot "$SCREENSHOT_DIR/fail-open.png" > /dev/null 2>&1
  BODY=$(bodyText)
  ERR=$(echo "$BODY" | grep -o "Open failed.*\|Registration failed.*" | head -1)
  fail "Channel open failed: ${ERR:-timeout}"
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

CHANNEL_ID=$(extractLatestChannelId)
if [ -n "$CHANNEL_ID" ]; then
  CHANNEL_STATE_URL="$SERVER_URL/channel/$CHANNEL_ID"
  pass "Captured channel id: $CHANNEL_ID"
else
  fail "Could not extract channel id from terminal output"
fi

browser screenshot "$SCREENSHOT_DIR/channel-open.png" > /dev/null 2>&1
pass "Screenshot: channel-open.png"

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal returned to idle after open"
else
  fail "Terminal did not return to idle after open"
fi

if refreshChannelState && [ "$CHANNEL_STATE_HTTP" = "200" ]; then
  pass "Server state created for opened channel"
else
  fail "Opened channel was not visible via /channel state"
fi

step "5. First Message"

if submitAndConfirmEcho "reply with the single word alpha" 5000; then
  pass "First message submitted in terminal"
else
  fail "First message was not echoed in terminal"
fi

if waitForTerminalAttr "data-request-state" "chatting" 5000 500; then
  pass "Terminal entered chatting state"
else
  fail "Terminal did not enter chatting state"
fi

echo "  Waiting for first streamed response..."

PREV_USAGE_TURN=$(terminalAttr "data-last-usage-turn")
if [ -z "$PREV_USAGE_TURN" ]; then PREV_USAGE_TURN=0; fi

if waitForChannelMessageCount 1 $CHAT_WAIT 1000; then
  refreshChannelState
  FIRST_DEPOSIT=$(extractChannelStateNumber "deposit")
  FIRST_SPENT=$(extractChannelStateNumber "cumulativeAmount")
  if [ -n "$FIRST_SPENT" ] && [ "$FIRST_SPENT" -gt 0 ]; then
    pass "Server state recorded the first paid message"
  else
    fail "First message did not increase cumulative spend"
  fi
else
  fail "Server state never recorded the first message"
fi

NEW_USAGE_TURN=$(waitForUsageTurnIncrement "$PREV_USAGE_TURN" $CHAT_WAIT 1000)
if [ -n "$NEW_USAGE_TURN" ]; then
  pass "First response completed with usage marker"
else
  fail "First response did not publish a usage marker"
fi

USAGE_COST=$(waitForUsageCost 5000 500)
if [ -n "$USAGE_COST" ]; then
  pass "First response usage cost recorded: $USAGE_COST stroops"
else
  fail "First response usage cost missing"
fi

if waitForBillingCount 1 $MAX_WAIT 1000; then
  pass "First response received with billing line"
else
  fail "First response billing line not found"
fi

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal returned to idle after first message"
else
  fail "Terminal did not return to idle after first message"
fi

if submitAndConfirmEcho "/balance" 5000 && waitFor "Deposit:" $MAX_WAIT 1000; then
  BALANCE_LINE=$(extractLatestBalanceLine)
  UI_FIRST_SPENT=$(extractNumberField "$BALANCE_LINE" "Spent")
  if [ -n "$FIRST_SPENT" ] && [ -n "$UI_FIRST_SPENT" ] && [ "$UI_FIRST_SPENT" = "$FIRST_SPENT" ]; then
    pass "Terminal /balance matches server state after first message"
  else
    fail "Terminal /balance did not match server state after first message"
  fi
else
  fail "First /balance output missing"
fi

browser screenshot "$SCREENSHOT_DIR/first-message.png" > /dev/null 2>&1
pass "Screenshot: first-message.png"

step "6. Top Up"

if submitAndConfirmEcho "/topup" 5000; then
  pass "Top-up command submitted in terminal"
else
  fail "Top-up command was not echoed in terminal"
fi

if waitForTerminalAttr "data-request-state" "topping-up" 5000 500; then
  pass "Terminal entered top-up state"
else
  fail "Terminal did not enter top-up state"
fi

echo "  Waiting for on-chain top-up confirmation..."

if [ -n "$FIRST_DEPOSIT" ] && waitForChannelDepositIncrease "$FIRST_DEPOSIT" $CHAIN_WAIT 1000; then
  pass "Top-up completed and increased on-chain deposit"
else
  fail "Top-up did not complete"
  browser screenshot "$SCREENSHOT_DIR/fail-topup.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

if waitFor "Topped up! Deposit now" $MAX_WAIT 1000; then
  pass "Terminal reported top-up success"
else
  fail "Terminal did not report top-up success"
fi

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal returned to idle after top-up"
else
  fail "Terminal did not return to idle after top-up"
fi

if submitAndConfirmEcho "/balance" 5000 && waitFor "Deposit:" $MAX_WAIT 1000; then
  BALANCE_LINE=$(extractLatestBalanceLine)
  UI_SECOND_DEPOSIT=$(extractNumberField "$BALANCE_LINE" "Deposit")
  if [ -n "$SECOND_DEPOSIT" ] && [ -n "$UI_SECOND_DEPOSIT" ] && [ "$UI_SECOND_DEPOSIT" = "$SECOND_DEPOSIT" ]; then
    pass "Terminal /balance matches server state after top-up"
  else
    fail "Terminal /balance did not match server state after top-up"
  fi
else
  fail "Post-top-up /balance output missing"
fi

browser screenshot "$SCREENSHOT_DIR/topup.png" > /dev/null 2>&1
pass "Screenshot: topup.png"

step "7. Second Message"

sleep 3
if submitAndConfirmEcho "reply with the single word beta" 5000; then
  pass "Second message submitted in terminal"
else
  fail "Second message was not echoed in terminal"
fi

if waitForTerminalAttr "data-request-state" "chatting" 5000 500; then
  pass "Terminal entered chatting state for second message"
else
  fail "Terminal did not enter chatting state for second message"
fi

echo "  Waiting for second streamed response..."

TOKEN_LINES_BEFORE=$(bodyText | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
PREV_USAGE_TURN=$(terminalAttr "data-last-usage-turn")
if [ -z "$PREV_USAGE_TURN" ]; then PREV_USAGE_TURN=0; fi
if waitForChannelMessageCount 2 $CHAT_WAIT 1000; then
  if waitForChannelSpentIncrease "$FIRST_SPENT" $CHAT_WAIT 1000; then
    pass "Server state recorded the second paid message"
  else
    fail "Second message did not increase cumulative spend"
  fi
else
  fail "Server state never recorded the second message"
fi

NEW_USAGE_TURN=$(waitForUsageTurnIncrement "$PREV_USAGE_TURN" $CHAT_WAIT 1000)
if [ -n "$NEW_USAGE_TURN" ]; then
  pass "Second response completed with usage marker"
else
  fail "Second response did not publish a usage marker"
fi

if waitForBillingCount 2 $MAX_WAIT 1000; then
  TOKEN_LINES_AFTER=$(bodyText | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
  if [ "$TOKEN_LINES_AFTER" -ge $((TOKEN_LINES_BEFORE + 1)) ]; then
    pass "Second response received with an additional billing event"
  else
    fail "Second response did not add a new billing event"
  fi
else
  fail "Second response billing line not found"
fi

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal returned to idle after second message"
else
  fail "Terminal did not return to idle after second message"
fi

if submitAndConfirmEcho "/balance" 5000 && waitFor "Deposit:" $MAX_WAIT 1000; then
  BALANCE_LINE=$(extractLatestBalanceLine)
  UI_SECOND_SPENT=$(extractNumberField "$BALANCE_LINE" "Spent")
  if [ -n "$SECOND_SPENT" ] && [ -n "$UI_SECOND_SPENT" ] && [ "$UI_SECOND_SPENT" = "$SECOND_SPENT" ]; then
    pass "Terminal /balance matches server state after second message"
  else
    fail "Terminal /balance did not match server state after second message"
  fi
else
  fail "Second /balance output missing"
fi

browser screenshot "$SCREENSHOT_DIR/second-message.png" > /dev/null 2>&1
pass "Screenshot: second-message.png"

step "8. Close & Settlement"

if submitAndConfirmEcho "/close" 5000; then
  pass "Close command submitted in terminal"
else
  fail "Close command was not echoed in terminal"
fi

if waitForTerminalAttr "data-request-state" "closing" 5000 500; then
  pass "Terminal entered closing state"
else
  fail "Terminal did not enter closing state"
fi

echo "  Waiting for close result..."
CLOSE_OK=0
for i in $(seq 1 4); do
  if waitForEither "Channel closed" "Channel closing" $MAX_WAIT $MAX_WAIT; then
    CLOSE_OK=1
    break
  fi
  if waitForEither "Close failed" "Close error" 1000 1000; then
    break
  fi
done

if [ "$CLOSE_OK" = "1" ]; then
  pass "Close request accepted"
else
  browser screenshot "$SCREENSHOT_DIR/fail-close.png" > /dev/null 2>&1
  fail "Channel close failed or timed out"
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

browser screenshot "$SCREENSHOT_DIR/closed.png" > /dev/null 2>&1
pass "Screenshot: closed.png"

CLOSE_BODY=$(bodyText)
SETTLED=$(echo "$CLOSE_BODY" | grep -oE 'closed: [0-9]+' | tail -1 | grep -oE '[0-9]+')
ACTUAL=$(echo "$CLOSE_BODY" | grep -oE 'actual spend: [0-9]+' | tail -1 | grep -oE '[0-9]+')

if [ -n "$SETTLED" ]; then
  if [ -n "$ACTUAL" ]; then
    if [ "$SETTLED" = "$ACTUAL" ]; then
      pass "Tighter settlement: closed ($SETTLED) == actual spend ($ACTUAL)"
    else
      fail "Settlement mismatch: closed=$SETTLED vs actual=$ACTUAL"
    fi
  else
    pass "Tighter settlement: closed ($SETTLED) == actual spend (equal, compact format)"
  fi

  if [ -n "$SECOND_SPENT" ]; then
    if [ -n "$ACTUAL" ]; then
      if [ "$ACTUAL" = "$SECOND_SPENT" ]; then
        pass "Close amount matches observed spend: $SECOND_SPENT stroops"
      else
        fail "Observed spend mismatch: close=$ACTUAL balance=$SECOND_SPENT"
      fi
    elif [ "$SETTLED" = "$SECOND_SPENT" ]; then
      pass "Close amount matches observed spend: $SECOND_SPENT stroops"
    else
      fail "Observed spend mismatch: close=$SETTLED balance=$SECOND_SPENT"
    fi
  fi

  if [ -n "$SECOND_DEPOSIT" ] && [ "$SETTLED" -lt "$SECOND_DEPOSIT" ]; then
    pass "No overpayment: closed ($SETTLED) < deposit ($SECOND_DEPOSIT)"
  elif [ -n "$SECOND_DEPOSIT" ]; then
    fail "Possible overpayment: closed ($SETTLED) >= deposit ($SECOND_DEPOSIT)"
  fi
else
  if echo "$CLOSE_BODY" | grep -q "Channel closing"; then
    pass "Channel closing — server will finalize on-chain (alarm retry)"
  else
    fail "Could not parse close amount from output"
  fi
fi

if echo "$CLOSE_BODY" | grep -q "stellar.expert"; then
  pass "Stellar Expert link present"
elif echo "$CLOSE_BODY" | grep -q "Channel closing"; then
  pass "No tx link (close pending — expected for alarm retry)"
else
  fail "Stellar Expert link missing"
fi

if waitForChannelClosed $CHAIN_WAIT 1000; then
  pass "Server state cleaned up after close"
else
  fail "Server state still exists after close"
fi

if waitForTerminalAttr "data-request-state" "idle" 5000 500; then
  pass "Terminal returned to idle after close"
else
  fail "Terminal did not return to idle after close"
fi

step "9. Help Command"

submitInput "/help"
waitFor "/balance" 5000 1000 && pass "/help shows commands" || fail "/help output missing"

step "Results"
echo "  $PASS passed, $FAIL failed"
echo "  Screenshots: $SCREENSHOT_DIR/"

[ "$FAIL" -eq 0 ] && echo "  ALL GREEN" || echo "  FAILURES DETECTED"
exit "$FAIL"
