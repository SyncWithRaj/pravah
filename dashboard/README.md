# Pravah CDN — Web Control Center & Testing Playground

The Dashboard is a real-time web application for monitoring, testing, and visualizing the Pravah Distributed CDN. It integrates live WebSocket telemetry, distributed edge health tracking, and an interactive adaptive HLS video player.

---

## Directory Overview

```
dashboard/
├── index.html         # Single-page control center interface (Tailwind CSS)
├── app.js             # Client logic, WebSocket listener, and HLS player controller
├── socket.io.min.js   # Client library for real-time WebSocket communication
└── styles.css         # Custom UI styling and animation overrides
```

---

## Key Capabilities

### 1. Real-Time WebSocket Telemetry
* Connects to the Core WebSocket Gateway via Socket.io.
* Streams live metrics without browser polling:
  - **Global Cache Hit Ratio:** Rolling percentage of requests resolved directly from RAM.
  - **Bandwidth Offload:** Real-time data volume delivered by regional edge nodes.
  - **Request Throughput:** Live requests per second (RPS) metrics.

### 2. Embedded Adaptive HLS Video Player
* Powered by `hls.js` for testing sub-10ms edge-cached video delivery.
* Automatically resolves adaptive master playlists (`GET /edge/content/:fileId/hls/master.m3u8?v=1`).
* Features an interactive rendition selector:
  - Supports automatic bandwidth-based switching or manual quality locking (1080p, 720p, 480p, 360p, 240p, 144p).
  - Displays real-time playback diagnostics: current rendition, bitrate (kbps), buffer length (seconds), and cache state (`HIT` from RAM vs `MISS` from origin).

### 3. Edge Node Health & Topology Visualizer
* Displays all active Edge PoPs across Mumbai, Virginia, and Frankfurt.
* Shows regional status indicators: `HEALTHY`, `DEGRADED`, or `DOWN`.
* Illustrates automated failover in real-time when an edge node crashes or misses its 10-second heartbeat.

### 4. Interactive Testing Playground
* Resumable chunked upload testing tool with live progress bars.
* Single-click cache purge button to broadcast `cache.invalidate` events across the cluster.
* Direct download link generator with GeoDNS 302 routing simulation.

---

## Running the Dashboard

### Using the Makefile
```bash
make ui
```
Launches a local HTTP server on port `8080`.

### Using Python Directly
```bash
python3 -m http.server 8080 --directory dashboard
```

Open your browser at `http://localhost:8080`.
