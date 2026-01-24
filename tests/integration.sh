#!/bin/bash
#
# vnsh Integration Tests
#
# Prerequisites:
#   - Worker deployed or running locally (wrangler dev)
#   - vn CLI installed (curl -sL vnsh.dev/i | sh)
#
# Usage:
#   ./integration.sh [host]
#   ./integration.sh http://localhost:8787
#

set -e

HOST="${1:-http://localhost:8787}"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "${RED}✗ FAIL${NC}: $1"
  echo "  $2"
  FAILED=$((FAILED + 1))
}

info() {
  echo -e "${YELLOW}→${NC} $1"
}

echo "================================"
echo "vnsh Integration Tests"
echo "Host: $HOST"
echo "================================"
echo ""

# Test 1: Health check
info "Test 1: Health check"
HEALTH=$(curl -s "$HOST/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  pass "Health check returns OK"
else
  fail "Health check failed" "$HEALTH"
fi

# Test 2: Upload blob via API
info "Test 2: Upload blob via API"
TEST_CONTENT="test-content-$(date +%s)"
UPLOAD_RESPONSE=$(echo -n "$TEST_CONTENT" | curl -s -X POST --data-binary @- -H "Content-Type: application/octet-stream" "$HOST/api/drop")
BLOB_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -n "$BLOB_ID" ]; then
  pass "Upload returns blob ID: $BLOB_ID"
else
  fail "Upload failed" "$UPLOAD_RESPONSE"
fi

# Test 3: Download blob via API
info "Test 3: Download blob via API"
if [ -n "$BLOB_ID" ]; then
  DOWNLOAD_CONTENT=$(curl -s "$HOST/api/blob/$BLOB_ID")
  if [ "$DOWNLOAD_CONTENT" = "$TEST_CONTENT" ]; then
    pass "Download returns correct content"
  else
    fail "Download content mismatch" "Expected: $TEST_CONTENT, Got: $DOWNLOAD_CONTENT"
  fi
else
  fail "Skipped - no blob ID"
fi

# Test 4: 404 for non-existent blob
info "Test 4: 404 for non-existent blob"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/blob/00000000-0000-0000-0000-000000000000")
if [ "$HTTP_CODE" = "404" ]; then
  pass "Non-existent blob returns 404"
else
  fail "Expected 404, got $HTTP_CODE"
fi

# Test 5: Upload with TTL
info "Test 5: Upload with TTL parameter"
TTL_RESPONSE=$(echo -n "ttl-test" | curl -s -X POST --data-binary @- -H "Content-Type: application/octet-stream" "$HOST/api/drop?ttl=1")
if echo "$TTL_RESPONSE" | grep -q '"expires"'; then
  pass "Upload with TTL returns expiry"
else
  fail "TTL upload failed" "$TTL_RESPONSE"
fi

# Test 6: Upload with payment requirement
info "Test 6: Upload with payment requirement"
PAID_RESPONSE=$(echo -n "paid-content" | curl -s -X POST --data-binary @- -H "Content-Type: application/octet-stream" "$HOST/api/drop?price=0.01")
PAID_ID=$(echo "$PAID_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -n "$PAID_ID" ]; then
  # Try to download without payment
  PAID_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/blob/$PAID_ID")
  if [ "$PAID_HTTP" = "402" ]; then
    pass "Paid blob returns 402 without payment proof"
  else
    fail "Expected 402, got $PAID_HTTP"
  fi
else
  fail "Failed to create paid blob" "$PAID_RESPONSE"
fi

# Test 7: CORS headers
info "Test 7: CORS headers"
CORS_HEADERS=$(curl -s -I "$HOST/api/blob/$BLOB_ID" 2>/dev/null | grep -i "access-control")
if echo "$CORS_HEADERS" | grep -qi "access-control-allow-origin"; then
  pass "CORS headers present"
else
  fail "Missing CORS headers"
fi

# Test 8: Empty body rejection
info "Test 8: Empty body rejection"
EMPTY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/octet-stream" "$HOST/api/drop")
if [ "$EMPTY_CODE" = "400" ]; then
  pass "Empty body rejected with 400"
else
  fail "Expected 400 for empty body, got $EMPTY_CODE"
fi

# Test 9: CLI local mode (if vn is available)
info "Test 9: CLI local mode"
if command -v vn &> /dev/null; then
  VN_CMD="vn"
  LOCAL_OUTPUT=$(echo "local-test" | VNSH_HOST="$HOST" "$VN_CMD" --local 2>/dev/null || echo "")
  if echo "$LOCAL_OUTPUT" | grep -q "Decryption key:"; then
    pass "CLI local mode works"
  else
    fail "CLI local mode failed" "$LOCAL_OUTPUT"
  fi
else
  echo "  (skipped - vn not found)"
fi

# Test 10: CLI upload (if vn is available)
info "Test 10: CLI end-to-end upload"
if command -v vn &> /dev/null; then
  VN_CMD="vn"
  CLI_URL=$(echo "cli-test-$(date +%s)" | VNSH_HOST="$HOST" "$VN_CMD" 2>/dev/null | grep -o "http.*")
  if echo "$CLI_URL" | grep -q "#k="; then
    pass "CLI upload returns URL with key fragment"
  else
    fail "CLI upload failed" "$CLI_URL"
  fi
else
  echo "  (skipped - vn not found)"
fi

# Test 11: Full crypto round-trip (CLI encrypt -> API -> OpenSSL decrypt)
info "Test 11: Full crypto round-trip"
if command -v vn &> /dev/null; then
  VN_CMD="vn"
  CRYPTO_CONTENT="crypto-roundtrip-$(date +%s)"

  # Upload via CLI
  CRYPTO_OUTPUT=$(printf '%s' "$CRYPTO_CONTENT" | VNSH_HOST="$HOST" "$VN_CMD" 2>&1)
  CRYPTO_URL=$(echo "$CRYPTO_OUTPUT" | grep -o "http[^ ]*#k=[^ ]*")

  if [ -n "$CRYPTO_URL" ]; then
    # Extract ID, key, and IV from URL
    CRYPTO_ID=$(echo "$CRYPTO_URL" | sed 's|.*/v/||' | sed 's|#.*||')
    CRYPTO_KEY=$(echo "$CRYPTO_URL" | sed 's|.*#k=||' | sed 's|&.*||')
    CRYPTO_IV=$(echo "$CRYPTO_URL" | sed 's|.*&iv=||')

    # Download encrypted blob to temp file (binary-safe)
    TEMP_ENCRYPTED=$(mktemp)
    curl -s "$HOST/api/blob/$CRYPTO_ID" > "$TEMP_ENCRYPTED"

    # Decrypt with OpenSSL
    DECRYPTED=$(openssl enc -d -aes-256-cbc -K "$CRYPTO_KEY" -iv "$CRYPTO_IV" -in "$TEMP_ENCRYPTED" 2>/dev/null)
    rm -f "$TEMP_ENCRYPTED"

    if [ "$DECRYPTED" = "$CRYPTO_CONTENT" ]; then
      pass "Full crypto round-trip works (CLI -> API -> OpenSSL)"
    else
      fail "Crypto round-trip failed" "Expected: $CRYPTO_CONTENT, Got: $DECRYPTED"
    fi
  else
    fail "Failed to get URL from CLI" "$CRYPTO_OUTPUT"
  fi
else
  echo "  (skipped - vn not found)"
fi

# Test 12: Viewer HTML served correctly
info "Test 12: Viewer HTML served"
VIEWER_RESPONSE=$(curl -s "$HOST/v/12345678-1234-1234-1234-123456789abc")
if echo "$VIEWER_RESPONSE" | grep -q "<!DOCTYPE html>" && echo "$VIEWER_RESPONSE" | grep -q "vnsh"; then
  pass "Viewer HTML served correctly"
else
  fail "Viewer HTML not served" "${VIEWER_RESPONSE:0:100}..."
fi

# Test 13: OPTIONS preflight
info "Test 13: OPTIONS preflight request"
PREFLIGHT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$HOST/api/drop")
PREFLIGHT_CORS=$(curl -s -I -X OPTIONS "$HOST/api/drop" 2>/dev/null | grep -i "access-control-allow-methods")
if [ "$PREFLIGHT_CODE" = "204" ] && echo "$PREFLIGHT_CORS" | grep -qi "POST"; then
  pass "OPTIONS preflight returns 204 with correct headers"
else
  fail "Preflight failed" "Code: $PREFLIGHT_CODE, Headers: $PREFLIGHT_CORS"
fi

# Test 14: Binary content handling
info "Test 14: Binary content handling"
BINARY_FILE=$(mktemp)
# Create some binary content with null bytes
printf '\x00\x01\x02\xff\xfe\xfd' > "$BINARY_FILE"
BINARY_RESPONSE=$(curl -s -X POST --data-binary @"$BINARY_FILE" -H "Content-Type: application/octet-stream" "$HOST/api/drop")
BINARY_ID=$(echo "$BINARY_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -n "$BINARY_ID" ]; then
  # Download and compare
  DOWNLOADED_FILE=$(mktemp)
  curl -s "$HOST/api/blob/$BINARY_ID" > "$DOWNLOADED_FILE"
  if cmp -s "$BINARY_FILE" "$DOWNLOADED_FILE"; then
    pass "Binary content preserved correctly"
  else
    fail "Binary content mismatch"
  fi
  rm -f "$DOWNLOADED_FILE"
else
  fail "Binary upload failed" "$BINARY_RESPONSE"
fi
rm -f "$BINARY_FILE"

# Test 15: Payment with proof (mock)
info "Test 15: Payment proof acceptance"
if [ -n "$PAID_ID" ]; then
  PROOF_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/blob/$PAID_ID?paymentProof=mock-token")
  if [ "$PROOF_CODE" = "200" ]; then
    pass "Payment proof accepted (mock)"
  else
    fail "Payment proof rejected" "Expected 200, got $PROOF_CODE"
  fi
else
  echo "  (skipped - no paid blob)"
fi

# Test 16: Upload page served
info "Test 16: Upload page served"
UPLOAD_PAGE=$(curl -s "$HOST/")
if echo "$UPLOAD_PAGE" | grep -q "<!DOCTYPE html>" && echo "$UPLOAD_PAGE" | grep -q "Encrypt"; then
  pass "Upload page served correctly"
else
  fail "Upload page not served" "${UPLOAD_PAGE:0:100}..."
fi

# Test 17: CLI read command
info "Test 17: CLI read command"
if command -v vn &> /dev/null; then
  VN_CMD="vn"
  READ_CONTENT="cli-read-test-$(date +%s)"

  # Upload via CLI
  CLI_OUTPUT=$(printf '%s' "$READ_CONTENT" | VNSH_HOST="$HOST" "$VN_CMD" 2>&1)
  CLI_URL=$(echo "$CLI_OUTPUT" | grep -o "http[^ ]*#k=[^ ]*")

  if [ -n "$CLI_URL" ]; then
    # Read back via CLI
    DECRYPTED=$(VNSH_HOST="$HOST" "$VN_CMD" read "$CLI_URL" 2>/dev/null)
    if [ "$DECRYPTED" = "$READ_CONTENT" ]; then
      pass "CLI read command works (vn -> vn read round-trip)"
    else
      fail "CLI read failed" "Expected: $READ_CONTENT, Got: $DECRYPTED"
    fi
  else
    fail "CLI upload failed for read test" "$CLI_OUTPUT"
  fi
else
  echo "  (skipped - vn not found)"
fi

# Summary
echo ""
echo "================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
