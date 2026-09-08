#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo " Pravah Edge Nginx Reverse Proxy Live Integration Test"
echo "============================================================"

# Container names
MOCK_UPSTREAM="pravah-test-upstream"
NGINX_PROXY="pravah-test-nginx"
TEST_PORT="8088"

cleanup() {
  echo ""
  echo "--> Cleaning up test containers..."
  docker rm -f "${NGINX_PROXY}" "${MOCK_UPSTREAM}" 2>/dev/null || true
  echo "--> Cleanup complete."
}
trap cleanup EXIT

# 1. Build Nginx Docker image
echo "[Step 1/5] Building Nginx Docker Image (infra/nginx)..."
docker build -q -t pravah-nginx-edge:test infra/nginx

# 2. Start mock NestJS upstream container
echo "[Step 2/5] Starting Mock NestJS Upstream Container..."
docker rm -f "${NGINX_PROXY}" "${MOCK_UPSTREAM}" 2>/dev/null || true

docker run -d \
  --name "${MOCK_UPSTREAM}" \
  -p "${TEST_PORT}:80" \
  node:20-alpine sh -c '
cat << "EOF" > /app.js
const http = require("http");
let requestCount = 0;

http.createServer((req, res) => {
  requestCount++;
  console.log(`[Upstream] Request #${requestCount}: ${req.method} ${req.url}`);

  if (req.url.endsWith(".ts")) {
    res.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Content-Length": "24",
      "ETag": "\"chunk-test-v1\"",
      "X-CDN-Edge": "edge-node-01"
    });
    res.end("PRAVAH_VIDEO_CHUNK_BYTES");
  } else if (req.url.endsWith(".m3u8")) {
    const manifest = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\n720p_001.ts\n#EXT-X-ENDLIST\n";
    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Content-Length": Buffer.byteLength(manifest),
      "X-CDN-Edge": "edge-node-01"
    });
    res.end(manifest);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mock-nestjs" }));
  }
}).listen(3001, "0.0.0.0", () => {
  console.log("[Upstream] Mock NestJS Edge ready on 3001");
});
EOF
node /app.js
'

sleep 2

# 3. Start Nginx container sharing the upstream network namespace (Simulating K8s Pod)
echo "[Step 3/5] Starting Nginx Container in Pod Network Namespace..."
docker run -d \
  --name "${NGINX_PROXY}" \
  --network "container:${MOCK_UPSTREAM}" \
  pravah-nginx-edge:test

sleep 2

# 4. Verify Nginx Healthcheck
echo "[Step 4/5] Testing Nginx Health Endpoint..."
HEALTH_RESP=$(curl -s -i "http://localhost:${TEST_PORT}/healthz")
if echo "${HEALTH_RESP}" | grep -q "200 OK"; then
  echo "PASS: Healthcheck /healthz returned HTTP 200 OK"
else
  echo "FAIL: Healthcheck /healthz did not return 200 OK"
  echo "${HEALTH_RESP}"
  exit 1
fi

# 5. Verify Video Segment Caching (Zero-Copy)
echo "[Step 5/5] Testing Video Segment Caching (sendfile zero-copy)..."

echo "--> Segment Request 1 (Expect MISS from cache)..."
RESP_1=$(curl -s -i "http://localhost:${TEST_PORT}/stream/video-01/720p_001.ts")
CACHE_HEADER_1=$(echo "${RESP_1}" | grep -i "x-proxy-cache" | tr -d '\r' || true)
echo "    Header: ${CACHE_HEADER_1}"
if echo "${CACHE_HEADER_1}" | grep -q "MISS"; then
  echo "    PASS: Request 1 was a Cache MISS as expected."
else
  echo "    FAIL: Expected Cache MISS on Request 1."
  exit 1
fi

echo "--> Segment Request 2 (Expect HIT from cache)..."
RESP_2=$(curl -s -i "http://localhost:${TEST_PORT}/stream/video-01/720p_001.ts")
CACHE_HEADER_2=$(echo "${RESP_2}" | grep -i "x-proxy-cache" | tr -d '\r' || true)
echo "    Header: ${CACHE_HEADER_2}"
if echo "${CACHE_HEADER_2}" | grep -q "HIT"; then
  echo "    PASS: Request 2 was a Cache HIT as expected (Zero-Copy)."
else
  echo "    FAIL: Expected Cache HIT on Request 2."
  exit 1
fi

# 6. Verify Manifest Microcaching
echo "--> Testing HLS Manifest Microcaching (1-second TTL)..."
M_RESP_1=$(curl -s -i "http://localhost:${TEST_PORT}/stream/video-01/playlist.m3u8")
M_CACHE_1=$(echo "${M_RESP_1}" | grep -i "x-proxy-cache" | tr -d '\r' || true)
echo "    Manifest Req 1 Header: ${M_CACHE_1}"

M_RESP_2=$(curl -s -i "http://localhost:${TEST_PORT}/stream/video-01/playlist.m3u8")
M_CACHE_2=$(echo "${M_RESP_2}" | grep -i "x-proxy-cache" | tr -d '\r' || true)
echo "    Manifest Req 2 Header: ${M_CACHE_2}"

if echo "${M_CACHE_2}" | grep -q "HIT"; then
  echo "    PASS: Manifest Req 2 was served from microcache (HIT)."
else
  echo "    FAIL: Manifest Req 2 expected HIT."
  exit 1
fi

# 7. Check upstream call count
echo ""
echo "--> Verifying Upstream Logs:"
docker logs "${MOCK_UPSTREAM}"

echo ""
echo "============================================================"
echo " All Nginx Reverse Proxy Tests Passed Successfully!"
echo "============================================================"
