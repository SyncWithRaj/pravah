#!/bin/bash
# ============================================================
# Pravah CDN — RBAC & Security Live Curl Test Suite
# Tests all Permutations & Combinations of Auth + Roles
# ============================================================

BASE="http://localhost:3000/api/v1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

assert_status() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✅ PASS${NC} [${expected}] ${test_name}"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}❌ FAIL${NC} [Expected: ${expected}, Got: ${actual}] ${test_name}"
  fi
}

echo -e "\n${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Pravah CDN — RBAC & Security Live Curl Test Suite${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}\n"

# ============================================================
# PHASE 1: Register & Login Users with Different Roles
# ============================================================
echo -e "${YELLOW}📦 Phase 1: User Registration & Login${NC}"

# Register Admin
curl -s -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"AdminUser","email":"admin-rbac-test@pravah.io","password":"Admin123!@#"}' > /dev/null 2>&1 || true

# Register Streamer
curl -s -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"StreamerUser","email":"streamer-rbac-test@pravah.io","password":"Stream123!@#"}' > /dev/null 2>&1 || true

# Register Viewer
curl -s -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"ViewerUser","email":"viewer-rbac-test@pravah.io","password":"View123!@#"}' > /dev/null 2>&1 || true

# Update roles directly in PostgreSQL via docker exec
docker exec pravah-postgres psql -U admin_postgres -d pravah_db -c \
  "UPDATE users SET role='ADMIN' WHERE email='admin-rbac-test@pravah.io';" > /dev/null 2>&1
docker exec pravah-postgres psql -U admin_postgres -d pravah_db -c \
  "UPDATE users SET role='STREAMER' WHERE email='streamer-rbac-test@pravah.io';" > /dev/null 2>&1
docker exec pravah-postgres psql -U admin_postgres -d pravah_db -c \
  "UPDATE users SET role='VIEWER' WHERE email='viewer-rbac-test@pravah.io';" > /dev/null 2>&1

# Login and extract JWT tokens
ADMIN_JWT=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"admin-rbac-test@pravah.io","password":"Admin123!@#"}' | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

STREAMER_JWT=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"streamer-rbac-test@pravah.io","password":"Stream123!@#"}' | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

VIEWER_JWT=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"viewer-rbac-test@pravah.io","password":"View123!@#"}' | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

echo "  Admin JWT:    ${ADMIN_JWT:0:20}..."
echo "  Streamer JWT: ${STREAMER_JWT:0:20}..."
echo "  Viewer JWT:   ${VIEWER_JWT:0:20}..."

if [ -z "$ADMIN_JWT" ] || [ -z "$STREAMER_JWT" ] || [ -z "$VIEWER_JWT" ]; then
  echo -e "${RED}❌ FATAL: Failed to obtain JWT tokens. Aborting.${NC}"
  exit 1
fi

echo -e "  ${GREEN}✅ All 3 users registered, roles assigned, and JWT tokens obtained${NC}\n"

# ============================================================
# PHASE 2: Test Admin-Only & Role-Scoped Endpoints (/admin/dlq, /admin/health)
# ============================================================
echo -e "${YELLOW}🅰️  Phase 2: Admin-Only & Role-Scoped Endpoints (/admin/dlq, /admin/health)${NC}"

# Test 1: ADMIN accessing /admin/dlq → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "Authorization: Bearer $ADMIN_JWT")
assert_status "ADMIN via JWT → GET /admin/dlq" "200" "$STATUS"

# Test 2: STREAMER accessing /admin/dlq → 403
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "Authorization: Bearer $STREAMER_JWT")
assert_status "STREAMER via JWT → GET /admin/dlq (insufficient role)" "403" "$STATUS"

# Test 3: VIEWER accessing /admin/dlq → 403
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "Authorization: Bearer $VIEWER_JWT")
assert_status "VIEWER via JWT → GET /admin/dlq (insufficient role)" "403" "$STATUS"

# Test 4: No Auth accessing /admin/dlq → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq")
assert_status "NO AUTH → GET /admin/dlq (unauthorized)" "401" "$STATUS"

# Test 5: ADMIN accessing /admin/health/nodes → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/health/nodes" \
  -H "Authorization: Bearer $ADMIN_JWT")
assert_status "ADMIN via JWT → GET /admin/health/nodes" "200" "$STATUS"

# Test 6: VIEWER accessing /admin/health/nodes → 200 (VIEWER inherits USER)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/health/nodes" \
  -H "Authorization: Bearer $VIEWER_JWT")
assert_status "VIEWER via JWT → GET /admin/health/nodes (USER role inherited)" "200" "$STATUS"

echo ""

# ============================================================
# PHASE 3: Test Streamer+Admin Endpoints (/upload, /admin/transcoding)
# ============================================================
echo -e "${YELLOW}🅱️  Phase 3: Streamer+Admin Endpoints (/upload, /admin/transcoding)${NC}"

# Test 7: ADMIN accessing upload init → 400 (passes auth, validation fails due to empty body)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/upload/init" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_status "ADMIN via JWT → POST /upload/init (authorized)" "400" "$STATUS"

# Test 8: STREAMER accessing upload init → 400 (passes auth, validation fails due to empty body)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/upload/init" \
  -H "Authorization: Bearer $STREAMER_JWT" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_status "STREAMER via JWT → POST /upload/init (authorized)" "400" "$STATUS"

# Test 9: VIEWER accessing upload init → 403
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/upload/init" \
  -H "Authorization: Bearer $VIEWER_JWT" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_status "VIEWER via JWT → POST /upload/init (insufficient role)" "403" "$STATUS"

# Test 10: No Auth accessing upload init → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/upload/init" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_status "NO AUTH → POST /upload/init (unauthorized)" "401" "$STATUS"

# Test 11: ADMIN accessing transcoding status → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/transcoding/status/nonexistent-file" \
  -H "Authorization: Bearer $ADMIN_JWT")
assert_status "ADMIN via JWT → GET /admin/transcoding/status (authorized)" "200" "$STATUS"

# Test 12: STREAMER accessing transcoding status → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/transcoding/status/nonexistent-file" \
  -H "Authorization: Bearer $STREAMER_JWT")
assert_status "STREAMER via JWT → GET /admin/transcoding/status (authorized)" "200" "$STATUS"

# Test 13: VIEWER accessing transcoding status → 403
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/transcoding/status/nonexistent-file" \
  -H "Authorization: Bearer $VIEWER_JWT")
assert_status "VIEWER via JWT → GET /admin/transcoding/status (insufficient role)" "403" "$STATUS"

echo ""

# ============================================================
# PHASE 3.5: Uploaded File Ownership / BOLA Regression Checks
# ============================================================
echo -e "${YELLOW}🧱 Phase 3.5: Uploaded File Ownership (BOLA Regression)${NC}"

BOLA_PAYLOAD=$(mktemp)
printf 'pravah-rbac-bola-payload-%s' "$(date +%s)" > "$BOLA_PAYLOAD"
BOLA_SIZE=$(wc -c < "$BOLA_PAYLOAD" | tr -d ' ')
BOLA_HASH=$(sha256sum "$BOLA_PAYLOAD" | awk '{print $1}')

BOLA_INIT=$(curl -s -X POST "$BASE/upload/init" \
  -H "Authorization: Bearer $STREAMER_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"rbac-bola-test.bin\",\"mimeType\":\"application/octet-stream\",\"totalSize\":${BOLA_SIZE},\"totalChunks\":1,\"fullFileChecksum\":\"${BOLA_HASH}\"}")
BOLA_FILE_ID=$(echo "$BOLA_INIT" | grep -o '"fileId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$BOLA_FILE_ID" ]; then
  TOTAL=$((TOTAL + 1))
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}❌ FAIL${NC} STREAMER could not initialize the BOLA test upload"
else
  BOLA_CHUNK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    "$BASE/upload/$BOLA_FILE_ID/chunk/0" \
    -H "Authorization: Bearer $STREAMER_JWT" \
    -F "checksum=$BOLA_HASH" \
    -F "file=@$BOLA_PAYLOAD")
  assert_status "STREAMER uploads the BOLA test chunk" "200" "$BOLA_CHUNK_STATUS"

  BOLA_COMPLETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$BASE/upload/complete" \
    -H "Authorization: Bearer $STREAMER_JWT" \
    -H "Content-Type: application/json" \
    -d "{\"fileId\":\"$BOLA_FILE_ID\"}")
  assert_status "STREAMER completes the BOLA test upload" "201" "$BOLA_COMPLETE_STATUS"

  if [ "$BOLA_COMPLETE_STATUS" = "201" ]; then
    # Test 13a: owner can download the current version
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/download/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $STREAMER_JWT")
    assert_status "OWNER via JWT → GET /download/:fileId (current version)" "200" "$STATUS"

    # Test 13b: non-owner and admin cannot download the current version
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/download/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $VIEWER_JWT")
    assert_status "VIEWER via JWT → GET /download/:fileId (current version BOLA)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/download/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $ADMIN_JWT")
    assert_status "ADMIN via JWT → GET /download/:fileId (owner-only)" "403" "$STATUS"

    # Test 13c: versioned downloads must authorize before geo-routing
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/download/$BOLA_FILE_ID/versions/1" \
      -H "Authorization: Bearer $VIEWER_JWT" \
      -H "x-test-client-region: ap-south-1")
    assert_status "VIEWER via JWT → GET /download/:fileId/versions/1 (pre-routing BOLA)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/download/$BOLA_FILE_ID/versions/1" \
      -H "Authorization: Bearer $ADMIN_JWT" \
      -H "x-test-client-region: ap-south-1")
    assert_status "ADMIN via JWT → GET /download/:fileId/versions/1 (owner-only)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/download/$BOLA_FILE_ID/versions/1" \
      -H "Authorization: Bearer $STREAMER_JWT")
    assert_status "OWNER via JWT → GET /download/:fileId/versions/1" "200" "$STATUS"

    # Test 13d: core edge-content JWT path checks ownership, but allows DB admins
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/edge/content/$BOLA_FILE_ID?v=1" \
      -H "Authorization: Bearer $STREAMER_JWT")
    assert_status "OWNER via JWT → GET /edge/content/:fileId" "200" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/edge/content/$BOLA_FILE_ID?v=1" \
      -H "Authorization: Bearer $VIEWER_JWT")
    assert_status "VIEWER via JWT → GET /edge/content/:fileId (BOLA)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "$BASE/edge/content/$BOLA_FILE_ID?v=1" \
      -H "Authorization: Bearer $ADMIN_JWT")
    assert_status "ADMIN via JWT → GET /edge/content/:fileId (DB role admin)" "200" "$STATUS"

    # Test 13e: delete is owner-only
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      "$BASE/metadata/files/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $VIEWER_JWT")
    assert_status "VIEWER via JWT → DELETE /metadata/files/:fileId (BOLA)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      "$BASE/metadata/files/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $ADMIN_JWT")
    assert_status "ADMIN via JWT → DELETE /metadata/files/:fileId (owner-only)" "403" "$STATUS"

    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      "$BASE/metadata/files/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $STREAMER_JWT")
    assert_status "OWNER via JWT → DELETE /metadata/files/:fileId" "200" "$STATUS"
  else
    # Best-effort cleanup if completion failed.
    curl -s -o /dev/null -X DELETE "$BASE/metadata/files/$BOLA_FILE_ID" \
      -H "Authorization: Bearer $STREAMER_JWT" || true
  fi
fi

rm -f "$BOLA_PAYLOAD"
echo ""

# ============================================================
# PHASE 4: API Key Authentication (x-api-key)
# ============================================================
echo -e "${YELLOW}🔑 Phase 4: API Key Authentication (x-api-key)${NC}"

# Generate Admin API Key (explicitly role: ADMIN)
ADMIN_KEY_RESP=$(curl -s -X POST "$BASE/auth/api-keys" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"CI-CD-Admin-Key","role":"ADMIN"}')
ADMIN_RAW_KEY=$(echo "$ADMIN_KEY_RESP" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

# Generate Streamer API Key
STREAMER_KEY_RESP=$(curl -s -X POST "$BASE/auth/api-keys" \
  -H "Authorization: Bearer $STREAMER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"OBS-Streamer-Key","role":"STREAMER"}')
STREAMER_RAW_KEY=$(echo "$STREAMER_KEY_RESP" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

echo "  Admin API Key:    ${ADMIN_RAW_KEY:0:15}..."
echo "  Streamer API Key: ${STREAMER_RAW_KEY:0:15}..."

# Test 14: Valid Admin API Key accessing /admin/dlq → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "x-api-key: $ADMIN_RAW_KEY")
assert_status "ADMIN via x-api-key → GET /admin/dlq (authorized)" "200" "$STATUS"

# Test 15: Valid Streamer API Key accessing upload init → 400 (passes auth)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/upload/init" \
  -H "x-api-key: $STREAMER_RAW_KEY" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_status "STREAMER via x-api-key → POST /upload/init (authorized)" "400" "$STATUS"

# Test 16: Streamer API Key accessing /admin/dlq → 403 (insufficient role)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "x-api-key: $STREAMER_RAW_KEY")
assert_status "STREAMER via x-api-key → GET /admin/dlq (insufficient role)" "403" "$STATUS"

# Test 17: Invalid/Fake API Key → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/dlq" \
  -H "x-api-key: prv_live_fakefakefakefakefakefake")
assert_status "INVALID x-api-key → GET /admin/dlq (unauthorized)" "401" "$STATUS"

echo ""

# ============================================================
# PHASE 5: Inter-Service HMAC Signature Authentication
# ============================================================
echo -e "${YELLOW}🔒 Phase 5: Inter-Service HMAC Signature & Anti-Replay${NC}"

SECRET="pravah-internal-microservice-super-secret-2026"
if [ -f "$ROOT_DIR/.env" ]; then
  ENV_SECRET=$(grep -E '^INTERNAL_SERVICE_SECRET=' "$ROOT_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
  if [ -n "$ENV_SECRET" ]; then
    SECRET="$ENV_SECRET"
  fi
fi
SERVICE_ID="edge-node-01"
TIMESTAMP=$(node -e 'console.log(Date.now())')
METHOD="GET"
PATH_URI="/api/v1/admin/health/nodes"
# The HMAC binds the body hash even when the request has no body.
BODY_HASH=$(printf '{}' | openssl dgst -sha256 | awk '{print $2}')
PAYLOAD="${SERVICE_ID}:${METHOD}:${PATH_URI}:${TIMESTAMP}:${BODY_HASH}"
VALID_SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# Test 18: Valid HMAC Signature + Timestamp → 200
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/health/nodes" \
  -H "x-service-id: $SERVICE_ID" \
  -H "x-service-timestamp: $TIMESTAMP" \
  -H "x-service-signature: $VALID_SIG")
assert_status "VALID HMAC Signature → GET /admin/health/nodes (authorized)" "200" "$STATUS"

# Test 19: Tampered HMAC Signature → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/health/nodes" \
  -H "x-service-id: $SERVICE_ID" \
  -H "x-service-timestamp: $TIMESTAMP" \
  -H "x-service-signature: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
assert_status "TAMPERED HMAC Signature → GET /admin/health/nodes (unauthorized)" "401" "$STATUS"

# Test 20: Replay Attack (Timestamp 10 minutes in past) → 401
STALE_TIMESTAMP=$(( $(node -e 'console.log(Date.now())') - 600000 ))
STALE_PAYLOAD="${SERVICE_ID}:${METHOD}:${PATH_URI}:${STALE_TIMESTAMP}:${BODY_HASH}"
STALE_SIG=$(echo -n "$STALE_PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/health/nodes" \
  -H "x-service-id: $SERVICE_ID" \
  -H "x-service-timestamp: $STALE_TIMESTAMP" \
  -H "x-service-signature: $STALE_SIG")
assert_status "REPLAY ATTACK (Timestamp 10m ago) → GET /admin/health/nodes (clock drift rejected)" "401" "$STATUS"

echo ""

# ============================================================
# PHASE 6: Public Endpoints (No Auth Required)
# ============================================================
echo -e "${YELLOW}🌐 Phase 6: Public Endpoints (No Auth Required)${NC}"

# Test 21: Prometheus Metrics endpoint (public)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/metrics")
assert_status "NO AUTH → GET /metrics (public Prometheus scrape)" "200" "$STATUS"

echo ""

# ============================================================
# RESULTS
# ============================================================
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}                    TEST RESULTS SUMMARY                     ${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "  Total Tests:  ${TOTAL}"
echo -e "  ${GREEN}Passed:       ${PASS}${NC}"
echo -e "  ${RED}Failed:       ${FAIL}${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}🎉 ALL ${TOTAL} TESTS PASSED — RBAC & Security is 100% VERIFIED!${NC}"
else
  echo -e "  ${RED}⚠️  ${FAIL} TEST(S) FAILED — Review the output above${NC}"
fi
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}\n"
