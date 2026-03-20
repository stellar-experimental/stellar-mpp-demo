#!/bin/bash
# Local E2E smoke test for the full channel lifecycle.
# Usage: ./test/e2e-channel-lifecycle-local.sh [base_url]
# Default: http://localhost:3000

set +e

BASE_URL="${1:-http://localhost:3000}"
SERVER_URL="http://localhost:8787"
AI_URL="http://localhost:8788"
SCREENSHOT_DIR="/tmp/claude/e2e-channel-lifecycle-$(date +%s)"
BROWSER_SESSION="mpp-channel-lifecycle-$$"
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

interactiveSnapshot() {
  browser snapshot -i 2>/dev/null
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

waitForPromptReady() {
  local timeout="$1" interval="${2:-1000}"
  local attempts=$((timeout / interval))
  if [ "$attempts" -lt 1 ]; then attempts=1; fi

  local i snapshot=""
  for i in $(seq 1 "$attempts"); do
    sleep $((interval / 1000))
    snapshot=$(interactiveSnapshot)
    if echo "$snapshot" | grep -Fq 'textbox "type a message or /help"'; then
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
  browser click "$INPUT_SELECTOR" > /dev/null 2>&1 || return 1
  browser fill "$INPUT_SELECTOR" "$text" > /dev/null 2>&1 || return 1
  browser press Enter > /dev/null 2>&1
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

step "1. Local Services Health Check"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
[ "$HTTP" = "200" ] && pass "Frontend: $BASE_URL -> $HTTP" || fail "Frontend: $BASE_URL -> $HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/health")
[ "$HTTP" = "200" ] && pass "MPP Server: $SERVER_URL/health -> $HTTP" || fail "MPP Server: $SERVER_URL/health -> $HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$AI_URL/generate" \
  -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"say ok"}]}')
[ "$HTTP" = "200" ] && pass "AI Worker: $AI_URL/generate -> $HTTP" || fail "AI Worker: $AI_URL/generate -> $HTTP"

step "2. Browser Boot"

browser open "$BASE_URL" > /dev/null 2>&1

if waitFor "Wallet ready on testnet." $MAX_WAIT 1000; then
  pass "Wallet initialized in browser"
else
  fail "Wallet did not initialize"
  browser screenshot "$SCREENSHOT_DIR/fail-wallet.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

step "3. Open Channel"

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
  if waitFor "Channel open!" $MAX_WAIT $MAX_WAIT; then
    OPEN_OK=1
    break
  fi
  if waitForEither "Open failed" "Registration failed" 1000 1000; then
    break
  fi
done

if [ "$OPEN_OK" = "1" ]; then
  pass "Channel opened and registered"
else
  fail "Channel did not open successfully"
  browser screenshot "$SCREENSHOT_DIR/fail-open.png" > /dev/null 2>&1
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

if refreshChannelState && [ "$CHANNEL_STATE_HTTP" = "200" ]; then
  pass "Server state created for opened channel"
else
  fail "Opened channel was not visible via /channel state"
fi

step "4. First Message"

if submitAndConfirmEcho "reply with the single word alpha" 5000; then
  pass "First message submitted in terminal"
else
  fail "First message was not echoed in terminal"
fi

echo "  Waiting for first streamed response..."

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

if waitForBillingCount 1 $MAX_WAIT 1000; then
  pass "First response received with billing"
else
  fail "First response billing line not found"
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

step "5. Top Up"

if submitAndConfirmEcho "/topup" 5000; then
  pass "Top-up command submitted in terminal"
else
  fail "Top-up command was not echoed in terminal"
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

step "6. Second Message"

sleep 3
if submitAndConfirmEcho "reply with the single word beta" 5000; then
  pass "Second message submitted in terminal"
else
  fail "Second message was not echoed in terminal"
fi

echo "  Waiting for second streamed response..."

TOKEN_LINES_BEFORE=$(bodyText | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
if waitForChannelMessageCount 2 $CHAT_WAIT 1000; then
  if waitForChannelSpentIncrease "$FIRST_SPENT" $CHAT_WAIT 1000; then
    pass "Server state recorded the second paid message"
  else
    fail "Second message did not increase cumulative spend"
  fi
else
  fail "Server state never recorded the second message"
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

step "7. Close Channel"

if submitAndConfirmEcho "/close" 5000; then
  pass "Close command submitted in terminal"
else
  fail "Close command was not echoed in terminal"
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
  fail "Close did not complete"
  browser screenshot "$SCREENSHOT_DIR/fail-close.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

CLOSE_BODY=$(bodyText)
SETTLED=$(echo "$CLOSE_BODY" | grep -oE 'Channel closed: [0-9]+' | tail -1 | grep -oE '[0-9]+')
ACTUAL=$(echo "$CLOSE_BODY" | grep -oE 'actual spend: [0-9]+' | tail -1 | grep -oE '[0-9]+')

if echo "$CLOSE_BODY" | grep -Fq "Channel closing"; then
  pass "Server reported close is finalizing on-chain"
elif [ -n "$SETTLED" ]; then
  pass "Channel settled on-chain for $SETTLED stroops"
  if [ -n "$SECOND_SPENT" ]; then
    if [ -n "$ACTUAL" ]; then
      if [ "$ACTUAL" = "$SECOND_SPENT" ]; then
        pass "Actual spend matches client-observed total: $SECOND_SPENT stroops"
      else
        fail "Actual spend mismatch: close=$ACTUAL balance=$SECOND_SPENT"
      fi
    elif [ "$SETTLED" = "$SECOND_SPENT" ]; then
      pass "Closed amount matches client-observed total: $SECOND_SPENT stroops"
    else
      fail "Closed amount mismatch: close=$SETTLED balance=$SECOND_SPENT"
    fi
  fi
else
  fail "Close output did not include a recognizable settlement result"
fi

if waitForChannelClosed $CHAIN_WAIT 1000; then
  pass "Server state cleaned up after close"
else
  fail "Server state still exists after close"
fi

browser screenshot "$SCREENSHOT_DIR/closed.png" > /dev/null 2>&1
pass "Screenshot: closed.png"

step "Results"
echo "  $PASS passed, $FAIL failed"
echo "  Screenshots: $SCREENSHOT_DIR/"

[ "$FAIL" -eq 0 ] && echo "  ALL GREEN" || echo "  FAILURES DETECTED"
exit "$FAIL"
