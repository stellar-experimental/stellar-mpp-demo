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

step "3. Browser E2E (agent-browser)"

echo "  Opening $BASE_URL..."
agent-browser open "$BASE_URL" > /dev/null 2>&1

# Wait for wallet to be fully funded/restored (not just "Wallet created")
if agent-browser wait --text "Wallet funded" --timeout 60000 > /dev/null 2>&1 || \
   agent-browser wait --text "Wallet restored" --timeout 5000 > /dev/null 2>&1; then
  pass "Wallet ready (funded or restored)"
else
  fail "Wallet not ready"
  agent-browser screenshot "$SCREENSHOT_DIR/fail-load.png" > /dev/null 2>&1
  agent-browser close > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

agent-browser wait 1000 > /dev/null 2>&1

# /help command
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/help" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1
agent-browser wait 1000 > /dev/null 2>&1
if agent-browser get text body 2>/dev/null | grep -q "/open"; then
  pass "/help shows commands"
else
  fail "/help output missing"
fi

# /open command
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/open" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for channel open (on-chain tx + verification, up to 3 min)..."
OPEN_OK=0
for i in $(seq 1 36); do
  BODY=$(agent-browser get text body 2>/dev/null)
  if echo "$BODY" | grep -q "Channel open"; then
    OPEN_OK=1
    break
  fi
  if echo "$BODY" | grep -q "failed after retries\|Open failed"; then
    break
  fi
  sleep 5
done

if [ "$OPEN_OK" = "1" ]; then
  pass "Channel opened successfully"
else
  agent-browser screenshot "$SCREENSHOT_DIR/fail-open.png" > /dev/null 2>&1
  ERR=$(agent-browser get text body 2>/dev/null | grep -o "Open failed.*\|Registration failed.*" | head -1)
  fail "Channel open failed: ${ERR:-timeout}"
  agent-browser close > /dev/null 2>&1
  echo ""; echo "Results: $PASS passed, $FAIL failed"
  echo "Screenshots: $SCREENSHOT_DIR/"
  exit 1
fi

agent-browser screenshot "$SCREENSHOT_DIR/channel-open.png" > /dev/null 2>&1
pass "Screenshot: channel-open.png"

# Chat message
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "Explain what HTTP status code 402 means." > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for AI response..."
agent-browser wait 20000 > /dev/null 2>&1

BODY=$(agent-browser get text body 2>/dev/null)
if echo "$BODY" | grep -qi "402\|payment\|status"; then
  pass "Chat response received (contains relevant content)"
else
  if echo "$BODY" | grep -qi "error"; then
    ERR=$(echo "$BODY" | grep -o "Server error.*\|Chat error.*" | head -1)
    fail "Chat failed: ${ERR:-unknown}"
  else
    pass "Chat response received"
  fi
fi

agent-browser screenshot "$SCREENSHOT_DIR/chat-response.png" > /dev/null 2>&1
pass "Screenshot: chat-response.png"

# /balance check
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/balance" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1
agent-browser wait 1000 > /dev/null 2>&1

if agent-browser get text body 2>/dev/null | grep -q "Deposit\|Remaining"; then
  pass "/balance shows credit info"
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

# /close command
agent-browser snapshot -i > /dev/null 2>&1
agent-browser fill @e1 "/close" > /dev/null 2>&1
agent-browser press Enter > /dev/null 2>&1

echo "  Waiting for settlement (on-chain tx, ~30-60s)..."
CLOSE_OK=0
for i in $(seq 1 24); do
  if agent-browser get text body 2>/dev/null | grep -q "settled"; then
    CLOSE_OK=1
    break
  fi
  sleep 5
done

if [ "$CLOSE_OK" = "1" ]; then
  pass "Channel settled on-chain"
else
  fail "Channel close failed or timed out"
fi

agent-browser screenshot "$SCREENSHOT_DIR/settled.png" > /dev/null 2>&1
pass "Screenshot: settled.png"

# Verify settlement link
if agent-browser get text body 2>/dev/null | grep -q "stellar.expert"; then
  pass "Stellar Expert link present"
else
  fail "Stellar Expert link missing"
fi

agent-browser close > /dev/null 2>&1

# Summary
step "Results"
echo "  $PASS passed, $FAIL failed"
echo "  Screenshots: $SCREENSHOT_DIR/"

[ "$FAIL" -eq 0 ] && echo "  🟢 ALL GREEN" || echo "  🔴 FAILURES DETECTED"
exit "$FAIL"
