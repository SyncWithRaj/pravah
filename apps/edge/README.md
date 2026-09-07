# Pravah CDN — Edge Data Plane Service

The Edge service (`apps/edge`) is the distributed data plane of the Pravah Content Delivery Network. Deployed across regional Points of Presence (PoPs), it terminates client connections, delivers cached media directly from in-memory RAM at line speed, orchestrates tiered peer cache fills, streams adaptive HLS video segments, and transmits authenticated heartbeats to the central Core.

---

## Architecture and Data Plane Flow

```
                              CLIENT REQUEST
                                     │
                                     ▼
                            Fastify Ingress (:3001)
                        (keepAliveTimeout: 65000ms)
                                     │
                                     ▼
                       ┌───────────────────────────┐
                       │  Local Redis RAM Cache    │
                       │  (Key: binary:file:v:ch)  │
                       └─────────────┬─────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
                     ▼                               ▼
               [Cache HIT]                     [Cache MISS]
             Return RAM Buffer             Acquire Stampede Lock
             (0.8ms - 2.5ms)                 (5s Expiry Mutex)
                     │                               │
                     │                 ┌─────────────┴─────────────┐
                     │                 │                           │
                     │                 ▼                           ▼
                     │            [Peer Mode]                [Origin Mode]
                     │         Fetch from Neighbor         Fetch from Mumbai
                     │          Regional Edge PoP           Origin S3 / MinIO
                     │                 │                           │
                     │                 └─────────────┬─────────────┘
                     │                               │
                     │                     Populate Local Redis
                     │                     Release Stampede Lock
                     │                               │
                     └───────────────┬───────────────┘
                                     │
                                     ▼
                         Deliver HTTP 200 Stream
```

---

## High-Performance Capabilities

### 1. Fastify HTTP Engine
* Migrated from Express to `@nestjs/platform-fastify` to eliminate V8 event loop serialization overhead.
* Pre-cached zero-allocation response formatting on `/health`, verified at **106,000 sustained RPS** across 3 AWS EKS clusters.
* Persistent HTTP Keep-Alive socket reuse eliminating Linux connection tracking (`nf_conntrack`) bottlenecks and `TIME_WAIT` socket exhaustion.

### 2. In-Memory RAM Caching with LRU Eviction
* High-demand binary chunks are cached in local Redis instances using raw buffers (`setBinary` / `getBinary`).
* Memory boundaries are enforced via `allkeys-lru` eviction policies, discarding cold assets under memory pressure while keeping hot video segments in memory.

### 3. Distributed Cache Stampede Protection
* Protects the origin from the "thundering herd" problem when an uncached popular file receives hundreds of concurrent requests.
* Uses an atomic Redis distributed lock:
  ```
  SET lock:stampede:{fileId}:v{version} <UUID> NX PX 5000
  ```
* Exactly one request acquires the lock to fetch and populate the cache. Competing requests enter a non-blocking 500ms sleep and resolve directly from the newly populated RAM cache.

### 4. Tiered Peer-to-Peer Cache Fill
* When an edge experiences a cache miss, it queries neighboring edge nodes (`X-Cache-Fill-Mode: peer`) before escalating to the central origin storage in Mumbai.
* Offloads cross-continental bandwidth and reduces origin load.

### 5. Adaptive HLS Video Segment Streaming
* Delivers multi-bitrate HLS playlists (`master.m3u8`) and 4-second `.ts` video segments via `GET /edge/content/:fileId/hls/*`.
* Configured with CORS headers and immutable cache-control headers (`public, max-age=31536000, immutable`) for seamless playback in web players.

### 6. Edge-to-Core HMAC-SHA256 Telemetry
* Background service (`HeartbeatService`) transmits status reports to the Core API every 10 seconds.
* Generates an HMAC-SHA256 cryptographic signature header using a shared secret and timestamp to guarantee zero-trust edge authenticity.

---

## API Endpoints Reference

| Method | Endpoint | Protection | Description |
| :--- | :--- | :--- | :--- |
| `GET`  | `/health` | Public | Sub-millisecond zero-allocation health and benchmark probe |
| `GET`  | `/metrics` | Public | Prometheus diagnostic metrics export (Cache hits, latency, bandwidth) |
| `GET`  | `/edge/content/:fileId` | Public / Peer | Stream binary chunk from cache or execute tiered fill |
| `GET`  | `/edge/content/:fileId/hls/*` | Public | Stream HLS adaptive playlists (`.m3u8`) and video chunks (`.ts`) |
| `POST` | `/edge/content/:fileId/purge` | HMAC / Key | Evict specific file and versions from local edge cache |

---

## Local Development Execution

```bash
# 1. Start Edge dependencies (Local Redis on port 6380)
docker compose -f infra/docker/docker-compose.edge.yml up -d

# 2. Start Edge Service in development watch mode
pnpm --filter edge start:dev
```
Service listens on `http://localhost:3001`.
