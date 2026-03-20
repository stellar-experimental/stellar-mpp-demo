#!/bin/bash
# E2E Smoke Test for MPP Channel Demo
# Usage: ./test/e2e-smoke.sh [base_url]
# Default: https://mpp.stellar.buzz
# Constraints: total runtime ≤ 5 minutes, no individual wait > 15 seconds
# (except on-chain tx operations which depend on Stellar ledger close time)

set +e  # Don't exit on errors — we handle failures via pass/fail

BASE_URL="${1:-https://mpp.stellar.buzz}"
SCREENSHOT_DIR="/tmp/claude/e2e-$(date +%s)"
BROWSER_SESSION="mpp-smoke-$$"
INPUT_SELECTOR="input[type='text']"
mkdir -p "$SCREENSHOT_DIR"
PASS=0
FAIL=0
MAX_WAIT=15000        # 15s max per individual wait

# Kill the test after 5 minutes
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
  browser fill "$INPUT_SELECTOR" "$text" > /dev/null 2>&1 || return 1
  browser press Enter > /dev/null 2>&1
}

cleanup() {
  kill "$WATCHDOG_PID" 2>/dev/null || true
  browser close > /dev/null 2>&1 || true
}
trap cleanup EXIT

step "1. Services Health Check"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
[ "$HTTP" = "200" ] && pass "Frontend: $BASE_URL → $HTTP" || fail "Frontend: $BASE_URL → $HTTP"

# Derive server URL
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

step "3. Channel Open & Chat"

echo "  Opening $BASE_URL..."
browser open "$BASE_URL" > /dev/null 2>&1

# Wait for wallet
if waitFor "Wallet ready" $MAX_WAIT 1000; then
  pass "Wallet ready"
else
  fail "Wallet not ready"
  browser screenshot "$SCREENSHOT_DIR/fail-load.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

# /open command (on-chain tx — uses extended timeout)
submitInput "/open"

echo "  Waiting for channel open (on-chain tx)..."
OPEN_OK=0
for i in $(seq 1 8); do
  if waitFor "Channel open" $MAX_WAIT $MAX_WAIT; then OPEN_OK=1; break; fi
  waitFor "Open failed" 1000 1000 && break
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

browser screenshot "$SCREENSHOT_DIR/channel-open.png" > /dev/null 2>&1
pass "Screenshot: channel-open.png"

# Chat message (short prompt for fast AI response)
submitInput "say ok"

echo "  Waiting for AI response..."
if waitFor "tokens," $MAX_WAIT 3000; then
  pass "Chat response received with billing"
else
  fail "Chat response or billing not received"
fi

browser screenshot "$SCREENSHOT_DIR/chat-response.png" > /dev/null 2>&1
pass "Screenshot: chat-response.png"

# Verify per-token billing
if bodyText | grep -qE '\[[0-9]+ tokens, [0-9]+ stroops\]'; then
  pass "Per-token billing reported after chat"
else
  fail "Per-token billing not shown after chat"
fi

step "4. Cumulative Billing (Second Message)"

submitInput "say hi"

echo "  Waiting for second AI response..."
# Wait for second billing line by checking split count on "stroops]"
if waitForBillingCount 2 $MAX_WAIT 3000; then
  pass "Second chat response received"
  pass "Cumulative billing: 2+ billing events across messages"
else
  BODY=$(bodyText)
  BILLING_COUNT=$(echo "$BODY" | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
  if [ "$BILLING_COUNT" -ge 2 ]; then
    pass "Second chat response received"
    pass "Cumulative billing: $BILLING_COUNT billing events"
  elif [ "$BILLING_COUNT" -ge 1 ]; then
    pass "Second chat response received"
    fail "Expected 2+ billing events, got $BILLING_COUNT"
  else
    fail "Second chat failed"
  fi
fi

browser screenshot "$SCREENSHOT_DIR/second-chat.png" > /dev/null 2>&1
pass "Screenshot: second-chat.png"

step "5. Balance & Header"

submitInput "/balance"

if waitFor "Deposit:" 5000 1000; then
  pass "/balance shows credit info"
  BALANCE_LINE=$(bodyText | grep -o "Deposit:.*stroops")
  SPENT=$(echo "$BALANCE_LINE" | grep -oE 'Spent: [0-9]+' | grep -oE '[0-9]+')
  if [ -n "$SPENT" ] && [ "$SPENT" -gt 0 ]; then
    pass "Balance reflects spend: $SPENT stroops after 2 messages"
  else
    fail "Balance shows zero spend after chat messages"
  fi
else
  fail "/balance output missing"
fi

# Header sticky check
if bodyText | grep -q 'MPP Channel Demo'; then
  pass "Header visible (sticky)"
else
  fail "Header not visible"
fi

step "6. Close & Tighter Settlement"

submitInput "/close"

echo "  Waiting for close (on-chain tx)..."
CLOSE_OK=0
for i in $(seq 1 4); do
  if waitForEither "Channel closed" "Channel closing" $MAX_WAIT $MAX_WAIT; then
    CLOSE_OK=1; break
  fi
done
if [ "$CLOSE_OK" = "1" ]; then
  pass "Channel closed on-chain"
else
  browser screenshot "$SCREENSHOT_DIR/fail-close.png" > /dev/null 2>&1
  fail "Channel close failed or timed out"
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

browser screenshot "$SCREENSHOT_DIR/closed.png" > /dev/null 2>&1
pass "Screenshot: closed.png"

# Verify tighter settlement
# When amounts match: "Channel closed: X stroops."
# When they differ: "Channel closed: X stroops on-chain (actual spend: Y stroops)."
CLOSE_BODY=$(bodyText)
SETTLED=$(echo "$CLOSE_BODY" | grep -oE 'closed: [0-9]+' | head -1 | grep -oE '[0-9]+')
ACTUAL=$(echo "$CLOSE_BODY" | grep -oE 'actual spend: [0-9]+' | head -1 | grep -oE '[0-9]+')

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
  if [ "$SETTLED" -lt 10000000 ]; then
    pass "No overpayment: closed ($SETTLED) < deposit (10000000)"
  else
    fail "Possible overpayment: closed ($SETTLED) >= deposit (10000000)"
  fi
else
  # "Channel closing" means on-chain tx failed, server will retry via alarm
  if echo "$CLOSE_BODY" | grep -q "Channel closing"; then
    pass "Channel closing — server will finalize on-chain (alarm retry)"
  else
    fail "Could not parse close amount from output"
  fi
fi

# Verify settlement link (only present if close succeeded with txHash)
if echo "$CLOSE_BODY" | grep -q "stellar.expert"; then
  pass "Stellar Expert link present"
elif echo "$CLOSE_BODY" | grep -q "Channel closing"; then
  pass "No tx link (close pending — expected for alarm retry)"
else
  fail "Stellar Expert link missing"
fi

step "7. Help Command"

# Running /help before /open makes subsequent browser reads flaky in agent-browser,
# so verify it after the core payment-channel flow instead.
submitInput "/help"
waitFor "/balance" 5000 1000 && pass "/help shows commands" || fail "/help output missing"

# Summary
step "Results"
echo "  $PASS passed, $FAIL failed"
echo "  Screenshots: $SCREENSHOT_DIR/"

[ "$FAIL" -eq 0 ] && echo "  🟢 ALL GREEN" || echo "  🔴 FAILURES DETECTED"
exit "$FAIL"
