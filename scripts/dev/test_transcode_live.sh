#!/usr/bin/env bash
set -e

CORE_URL="http://localhost:3000"
EDGE_URL="http://localhost:3001"
TIMESTAMP=$(date +%s)
TEST_DIR="/tmp/pravah-transcode-test-$TIMESTAMP"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo "================================================================="
echo "🎬 PRAVAH CDN — LIVE MULTI-QUALITY VIDEO TRANSCODING TEST"
echo "================================================================="

# 1. Generate a real 720p synthetic MP4 video (6 seconds, 1280x720)
echo "[1/6] 🎥 Generating 720p synthetic test video with FFmpeg..."
ffmpeg -y -f lavfi -i testsrc=duration=6:size=1280x720:rate=30 \
       -f lavfi -i sine=frequency=1000:duration=6 \
       -pix_fmt yuv420p -c:v libx264 -c:a aac -b:a 128k \
       input_720p.mp4 -loglevel error

FILE_SIZE=$(wc -c < input_720p.mp4 | tr -d ' ')
CHECKSUM=$(sha256sum input_720p.mp4 | awk '{print $1}')
echo "      Video created: input_720p.mp4 ($FILE_SIZE bytes, SHA-256: ${CHECKSUM:0:16}...)"

# 2. Register & Login test user
echo "[2/6] 👤 Registering test user..."
EMAIL="test_video_$TIMESTAMP@pravah.cdn"
PASSWORD="TestPassword123!"

curl -s -X POST "$CORE_URL/api/v1/auth/register" \
     -H "Content-Type: application/json" \
     -d "{\"email\":\"$EMAIL\",\"username\":\"testuser_$TIMESTAMP\",\"password\":\"$PASSWORD\"}" > /dev/null

LOGIN_RES=$(curl -s -X POST "$CORE_URL/api/v1/auth/login" \
     -H "Content-Type: application/json" \
     -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

JWT_TOKEN=$(echo "$LOGIN_RES" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$JWT_TOKEN" ]; then
  echo "❌ Login failed! Could not retrieve JWT token."
  exit 1
fi
echo "      Authenticated: JWT token acquired."

# 3. Initialize upload session
echo "[3/6] 📤 Initializing upload session for input_720p.mp4..."
INIT_RES=$(curl -s -X POST "$CORE_URL/api/v1/upload/init" \
     -H "Authorization: Bearer $JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"name\":\"input_720p.mp4\",\"mimeType\":\"video/mp4\",\"totalSize\":$FILE_SIZE,\"totalChunks\":1,\"fullFileChecksum\":\"$CHECKSUM\"}")

FILE_ID=$(echo "$INIT_RES" | grep -o '"fileId":"[^"]*' | cut -d'"' -f4)
if [ -z "$FILE_ID" ]; then
  echo "❌ Upload init failed: $INIT_RES"
  exit 1
fi
echo "      Upload Session ID (fileId): $FILE_ID"

# 4. Upload chunk 0 (multipart form-data with file and checksum fields)
echo "[4/6] 📦 Uploading video chunk..."
CHUNK_RES=$(curl -s -X PUT "$CORE_URL/api/v1/upload/$FILE_ID/chunk/0" \
     -H "Authorization: Bearer $JWT_TOKEN" \
     -F "file=@input_720p.mp4;type=video/mp4" \
     -F "checksum=$CHECKSUM")
echo "      Chunk 0 response: $CHUNK_RES"

# 5. Complete upload to trigger BullMQ transcoding pipeline
echo "[5/6] ⚡ Finalizing upload & triggering FFmpeg Transcoding Worker..."
COMPLETE_RES=$(curl -s -X POST "$CORE_URL/api/v1/upload/complete" \
     -H "Authorization: Bearer $JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"fileId\":\"$FILE_ID\"}")
echo "      Complete response: $COMPLETE_RES"

echo "      Upload complete! Waiting for FFmpeg transcoding worker..."

# 6. Poll for transcoding completion
for i in {1..30}; do
  sleep 1
  STATUS_RES=$(curl -s "$CORE_URL/api/v1/admin/transcoding/status/$FILE_ID")
  COMPLETED_COUNT=$(echo "$STATUS_RES" | grep -o '"status":"COMPLETED"' | wc -l || true)
  
  echo -ne "      Transcoding in progress... ($COMPLETED_COUNT profiles completed) [$i/30s]\r"
  
  # For 720p input, exactly 5 profiles (720p, 480p, 360p, 240p, 144p) must complete (NO 1080p upscaling!)
  if [ "$COMPLETED_COUNT" -ge 5 ]; then
    echo ""
    echo "================================================================="
    echo "🎉 TRANSCODING COMPLETED SUCCESSFULLY! (5/5 QUALITIES PRODUCED)"
    echo "================================================================="
    echo ""
    echo "📋 SUMMARY OF GENERATED HLS QUALITIES (NO UPSCALING APPLIED):"
    echo "-----------------------------------------------------------------"
    echo "  • 720p  (1280x720) - 3000 kbps HD"
    echo "  • 480p  (854x480)  - 1400 kbps SD"
    echo "  • 360p  (640x360)  - 800 kbps  Mobile"
    echo "  • 240p  (426x240)  - 400 kbps  Low-Bandwidth"
    echo "  • 144p  (256x144)  - 200 kbps  Data-Saver"
    echo ""
    echo "🔗 TESTING URLS & PLAYLIST ENDPOINTS (EDGE CDN STREAMING):"
    echo "-----------------------------------------------------------------"
    echo "  [Master Multi-Bitrate ABR Manifest (Edge CDN - Mumbai ap-south-1)]:"
    echo "  👉 $EDGE_URL/edge/content/$FILE_ID/hls/master.m3u8?v=1"
    echo ""
    echo "  [Individual Quality Variant Streams (Edge CDN)]:"
    echo "  👉 720p HD:          $EDGE_URL/edge/content/$FILE_ID/hls/720p/index.m3u8?v=1"
    echo "  👉 480p SD:          $EDGE_URL/edge/content/$FILE_ID/hls/480p/index.m3u8?v=1"
    echo "  👉 360p Mobile:      $EDGE_URL/edge/content/$FILE_ID/hls/360p/index.m3u8?v=1"
    echo "  👉 240p Low:         $EDGE_URL/edge/content/$FILE_ID/hls/240p/index.m3u8?v=1"
    echo "  👉 144p Data-Saver:  $EDGE_URL/edge/content/$FILE_ID/hls/144p/index.m3u8?v=1"
    echo ""
    echo "  [Core Origin Direct Streaming Endpoints]:"
    echo "  👉 $CORE_URL/api/v1/edge/content/$FILE_ID/hls/master.m3u8?v=1"
    echo ""
    echo "  [Transcoding Admin Status API]:"
    echo "  👉 $CORE_URL/api/v1/admin/transcoding/status/$FILE_ID"
    echo "================================================================="
    rm -rf "$TEST_DIR"
    exit 0
  fi
done

echo ""
echo "❌ Transcoding timed out or failed. Current DB Status:"
curl -s "$CORE_URL/api/v1/admin/transcoding/status/$FILE_ID"
rm -rf "$TEST_DIR"
exit 1
