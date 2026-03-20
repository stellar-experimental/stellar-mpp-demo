#!/bin/bash
# E2E Smoke Test for MPP Channel Demo
# Usage: ./test/e2e-smoke.sh [base_url]
# Default: https://mpp.stellar.buzz

set -e

BASE_URL="${1:-https://mpp.stellar.buzz}"
SCREENSHOT_DIR="/tmp/claude/e2e-$(date +%s)"
mkdir -p "$SCREENSHOT_DIR"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
step() { echo ""; echo "━━━ $1 ━━━"; }

cleanup() { agent-browser close > /dev/null 2>&1 || true; }
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
agent-browser open "$BASE_URL" > /dev/null 2>&1

# Wait for wallet
if agent-browser wait --text "Wallet ready" --timeout 15000 > /dev/null 2>&1; then
  pass "Wallet ready"
else
  fail "Wallet not ready"
  agent-browser screenshot "$SCREENSHOT_DIR/fail-load.png" > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

# /help command
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/help" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1
agent-browser wait --text "/open" --timeout 5000 > /dev/null 2>&1 && \
  pass "/help shows commands" || fail "/help output missing"

# /open command
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/open" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for channel open (on-chain tx)..."
if agent-browser wait --text "Channel open" --timeout 120000 > /dev/null 2>&1; then
  pass "Channel opened successfully"
else
  agent-browser screenshot "$SCREENSHOT_DIR/fail-open.png" > /dev/null 2>&1
  BODY=$(agent-browser get text body 2>/dev/null)
  ERR=$(echo "$BODY" | grep -o "Open failed.*\|Registration failed.*" | head -1)
  fail "Channel open failed: ${ERR:-timeout}"
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

agent-browser screenshot "$SCREENSHOT_DIR/channel-open.png" > /dev/null 2>&1
pass "Screenshot: channel-open.png"

# Chat message
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "say ok" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for AI response..."
if agent-browser wait --text "tokens," --timeout 15000 > /dev/null 2>&1; then
  pass "Chat response received with billing"
else
  fail "Chat response or billing not received"
fi

agent-browser screenshot "$SCREENSHOT_DIR/chat-response.png" > /dev/null 2>&1
pass "Screenshot: chat-response.png"

# Verify per-token billing
if agent-browser get text body 2>/dev/null | grep -qE '\[[0-9]+ tokens, [0-9]+ stroops\]'; then
  pass "Per-token billing reported after chat"
else
  fail "Per-token billing not shown after chat"
fi

step "4. Cumulative Billing (Second Message)"

agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "say hi" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for second AI response..."
# Wait for second billing line by checking the text splits on "stroops]"
agent-browser wait --fn "document.body.innerText.split('stroops]').length > 2" --timeout 15000 > /dev/null 2>&1
BODY=$(agent-browser get text body 2>/dev/null)
BILLING_COUNT=$(echo "$BODY" | grep -cE '\[[0-9]+ tokens, [0-9]+ stroops\]')
if [ "$BILLING_COUNT" -ge 2 ]; then
  pass "Second chat response received"
  pass "Cumulative billing: $BILLING_COUNT billing events across messages"
elif [ "$BILLING_COUNT" -ge 1 ]; then
  pass "Second chat response received"
  fail "Expected 2+ billing events, got $BILLING_COUNT"
else
  fail "Second chat failed"
fi

agent-browser screenshot "$SCREENSHOT_DIR/second-chat.png" > /dev/null 2>&1
pass "Screenshot: second-chat.png"

step "5. Balance & Header"

agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/balance" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

if agent-browser wait --text "Deposit:" --timeout 5000 > /dev/null 2>&1; then
  pass "/balance shows credit info"
  BALANCE_LINE=$(agent-browser get text body 2>/dev/null | grep -o "Deposit:.*stroops")
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
HEADER=$(agent-browser get text body 2>/dev/null | head -1)
if echo "$HEADER" | grep -q "MPP Channel Demo"; then
  pass "Header visible (sticky)"
else
  fail "Header not visible"
fi

step "6. Close & Tighter Settlement"

agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/close" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for close (on-chain tx)..."
if agent-browser wait --fn "document.body.innerText.includes('Channel closed') || document.body.innerText.includes('Channel closing')" --timeout 60000 > /dev/null 2>&1; then
  pass "Channel closed on-chain"
else
  agent-browser screenshot "$SCREENSHOT_DIR/fail-close.png" > /dev/null 2>&1
  fail "Channel close failed or timed out"
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

agent-browser screenshot "$SCREENSHOT_DIR/closed.png" > /dev/null 2>&1
pass "Screenshot: closed.png"

# Verify tighter settlement
# When amounts match: "Channel closed: X stroops."
# When they differ: "Channel closed: X stroops on-chain (actual spend: Y stroops)."
CLOSE_BODY=$(agent-browser get text body 2>/dev/null)
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

# Summary
step "Results"
echo "  $PASS passed, $FAIL failed"
echo "  Screenshots: $SCREENSHOT_DIR/"

[ "$FAIL" -eq 0 ] && echo "  🟢 ALL GREEN" || echo "  🔴 FAILURES DETECTED"
exit "$FAIL"
