#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=========================================================="
echo "⚡ PRAVAH CDN — FULL-SPECTRUM CONCURRENCY BENCHMARK SUITE"
echo "=========================================================="

CORE_URL="${CORE_URL:-http://localhost:3000}"
EDGE_URL="${EDGE_URL:-http://localhost:3001}"

# 1. Authenticate to get JWT token for authenticated routes
echo "Step 1: Authenticating test runner with Core Origin ($CORE_URL)..."
LOGIN_RES=$(curl -s -X POST "$CORE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"dlquser@pravah.io","password":"Password123!"}' || true)

AUTH_TOKEN=$(echo "$LOGIN_RES" | jq -r '.access_token // empty')

if [ -z "$AUTH_TOKEN" ] || [ "$AUTH_TOKEN" = "null" ]; then
  echo "Registering benchmark test user..."
  curl -s -X POST "$CORE_URL/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"email":"benchmark_user@pravah.io","username":"benchmarker","password":"Password123!"}' > /dev/null
  LOGIN_RES=$(curl -s -X POST "$CORE_URL/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"identifier":"benchmark_user@pravah.io","password":"Password123!"}')
  AUTH_TOKEN=$(echo "$LOGIN_RES" | jq -r '.access_token')
fi

echo "✅ Authenticated. JWT token acquired."

# 2. Seed a benchmark file in Origin and Edge Cache
echo "Step 2: Seeding benchmark file in Origin..."
SEED_FILE="/tmp/k6_benchmark_payload.bin"
head -c 65536 /dev/urandom > "$SEED_FILE" # 64KB payload
SEED_SIZE=$(wc -c < "$SEED_FILE")
SEED_CHECKSUM=$(sha256sum "$SEED_FILE" | awk '{print $1}')

INIT_RES=$(curl -s -X POST "$CORE_URL/api/v1/upload/init" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"k6_benchmark_payload.bin\",\"mimeType\":\"application/octet-stream\",\"totalSize\":$SEED_SIZE,\"totalChunks\":1,\"fullFileChecksum\":\"$SEED_CHECKSUM\"}")

BENCHMARK_FILE_ID=$(echo "$INIT_RES" | jq -r '.fileId // .id')
echo "Benchmark File ID: $BENCHMARK_FILE_ID"

curl -s -X PUT "$CORE_URL/api/v1/upload/$BENCHMARK_FILE_ID/chunk/0" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F "file=@$SEED_FILE" \
  -F "checksum=$SEED_CHECKSUM" > /dev/null

curl -s -X POST "$CORE_URL/api/v1/upload/complete" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\":\"$BENCHMARK_FILE_ID\"}" > /dev/null

echo "✅ Seed file uploaded to Origin."

# Warm up Edge Cache
echo "Warming up Edge Cache for file $BENCHMARK_FILE_ID..."
curl -s "$EDGE_URL/edge/content/$BENCHMARK_FILE_ID?v=1" > /dev/null || true
sleep 1

# 3. Function to run k6 via Docker or local CLI
run_k6_scenario() {
  local script_file="$1"
  local scenario_name="$2"

  echo ""
  echo "=========================================================="
  echo "🚀 Scenario: $scenario_name"
  echo "=========================================================="

  if command -v k6 &> /dev/null; then
    k6 run \
      -e CORE_URL="$CORE_URL" \
      -e EDGE_URL="$EDGE_URL" \
      -e FILE_ID="$BENCHMARK_FILE_ID" \
      -e AUTH_TOKEN="$AUTH_TOKEN" \
      "$script_file" || true
  else
    docker run --rm -i \
      --network=host \
      -v "$PROJECT_ROOT/benchmarks/k6:/scripts" \
      -e CORE_URL="$CORE_URL" \
      -e EDGE_URL="$EDGE_URL" \
      -e FILE_ID="$BENCHMARK_FILE_ID" \
      -e AUTH_TOKEN="$AUTH_TOKEN" \
      grafana/k6:latest run "/scripts/$(basename "$script_file")" || true
  fi
}

# 4. Execute all 6 benchmark scenarios
run_k6_scenario "$SCRIPT_DIR/k6/01_edge_cache_hit.js" "1. Edge Node Cache Hit Concurrency (200 VUs)"
run_k6_scenario "$SCRIPT_DIR/k6/02_geo_routing_throughput.js" "2. GeoDNS 302 Redirection Throughput (200 VUs)"
run_k6_scenario "$SCRIPT_DIR/k6/03_origin_cache_fill.js" "3. Edge Cache Miss & Origin Stream (50 VUs)"
run_k6_scenario "$SCRIPT_DIR/k6/04_chunked_upload_concurrency.js" "4. Resumable Chunk Upload Ingestion (50 VUs)"
run_k6_scenario "$SCRIPT_DIR/k6/05_byte_range_streaming.js" "5. HTTP 206 Byte-Range Partial Streaming (50 VUs)"
run_k6_scenario "$SCRIPT_DIR/k6/06_cache_invalidation_under_load.js" "6. Edge Cache Invalidation Under Load (30 VUs)"

echo ""
echo "=========================================================="
echo "🎉 ALL PRAVAH CDN CONCURRENCY BENCHMARKS COMPLETED!"
echo "=========================================================="
