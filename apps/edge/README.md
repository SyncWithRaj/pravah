# Pravah CDN — Edge Data Plane Service

The Edge service (`apps/edge`) is the distributed, high-throughput data plane of the Pravah Content Delivery Network. Deployed at regional Points of Presence (PoPs) across multi-region edge clusters, it terminates client connections, delivers cached static and media assets directly from memory at line speed, coordinates tiered peer-to-peer cache fills, serves adaptive HLS video streams, and reports real-time node telemetry to the Core Control Plane.

---

## Architectural Data Plane Topology

```
                                         INCOMING CLIENT REQUEST
                                                    │
                                                    ▼
                                          Fastify Ingress (:4001)
                                        (keepAliveTimeout: 60000ms)
                                                    │
                                                    ▼
                                      ┌───────────────────────────┐
                                      │   Local Cache Inspection  │
                                      │   (Redis RAM / NVMe Disk) │
                                      └─────────────┬─────────────┘
                                                    │
                             ┌──────────────────────┴──────────────────────┐
                             │                                             │
                             ▼                                             ▼
                      [ Cache HIT ]                                 [ Cache MISS ]
               Read In-Memory Buffer (0.8ms)                    Acquire Stampede Lock
               Emit Metrics & Kafka Event                   (SET NX PX 10000 Mutex Key)
                             │                                             │
                             │                              ┌──────────────┴──────────────┐
                             │                              │                             │
                             │                              ▼                             ▼
                             │                     [ Lock ACQUIRED ]              [ Lock HELD ]
                             │                 Query Placement from Core      Wait (Exponential Backoff)
                             │                              │                 Resolve from Populated RAM
                             │                              ▼                             │
                             │                     Tiered Peer-to-Peer                    │
                             │                     Cache Fill Attempt                     │
                             │                              │                             │
                             │               ┌──────────────┴──────────────┐              │
                             │               ▼                             ▼              │
                             │        [ Peer Found ]                [ All Peers Miss ]    │
                             │      Fetch from Neighbor             Stream from Origin    │
                             │      Regional Edge Node              MinIO / S3 Storage    │
                             │               │                             │              │
                             │               └──────────────┬──────────────┘              │
                             │                              │                             │
                             │                     Populate RAM / NVMe                    │
                             │                     Release Stampede Lock                  │
                             │                              │                             │
                             └──────────────────────────────┼─────────────────────────────┘
                                                            │
                                                            ▼
                                                Deliver HTTP 200 Response
```

---

## Core Subsystems and Performance Engineering

### 1. Fastify High-Throughput HTTP Engine
The Edge data plane is engineered on `@nestjs/platform-fastify`, replacing traditional Express middleware to eliminate V8 event loop serialization overhead:

* **Connection Pooling and Keep-Alive:** Configured with a `keepAliveTimeout` of 60,000ms. Sockets remain open across tens of thousands of consecutive requests, preventing Linux TCP connection tracking (`nf_conntrack`) table exhaustion and socket churn in `TIME_WAIT` state.
* **CORS and Telemetry Exposure:** Exposes key diagnostic response headers:
  * `X-Cache`: Returns `HIT`, `MISS`, `PEER_HIT`, or `PEER_MISS`.
  * `X-CDN-Edge`: The identifier of the servicing edge node.
  * `X-CDN-Region`: Regional identifier (e.g., `ap-south-1`, `eu-central-1`, `us-east-1`).
  * `X-Trace-Id`: OpenTelemetry W3C distributed trace identifier.
* **Sustained Scale:** Benchmarked at **106,000 sustained requests per second** across 3 AWS EKS cloud regions with sub-2ms p99 latency during 2,000-VU distributed load tests.

---

### 2. Hybrid NVMe/SSD Disk and Redis RAM Caching
The edge caching subsystem ([`EdgeCacheService`](file:///home/raj-ribadiya/Desktop/pravah/apps/edge/src/cache/cache.service.ts)) employs a hybrid storage strategy to balance speed and memory density:

* **Small Files (< 2MB):** Cached directly in Redis RAM using binary buffers (`getBuffer` / `setBinary`). Retrieval latencies remain between 0.8ms and 2.5ms.
* **Large Files ($\ge$ 2MB):** Stored on local high-speed NVMe/SSD disk storage (`CACHE_DISK_PATH/{fileId}/v{version}/content.bin`). Metadata (size, checksum, ETag, MIME type, disk pointer) is preserved in Redis hashes (`file:{fileId}:{version}:meta`).
* **LRU Eviction Engine:** Enforces a configurable cache ceiling (`MAX_CACHE_SIZE`, default 500MB). Whenever memory thresholds are crossed, an atomic Lua script evaluates a Redis Sorted Set (`cache:lru`) scored by access timestamp, removing least recently used assets until memory usage falls below limits.
* **Multi-Version Tracking and Synchronous Purging:** Maintains an index of all versions of a file in Redis Set `file:{fileId}:keys`. Calling `POST /edge/content/:fileId/purge` triggers an atomic Lua script that evicts all versions from RAM and deletes local disk directories simultaneously.

---

### 3. Distributed Cache Stampede Protection (Singleflight Mutex)
To prevent the thundering herd problem when an uncached hot asset is requested by hundreds of concurrent clients:

* **Lock Acquisition:**
  ```redis
  SET lock:stampede:{fileId}:v{version} <UUID> NX PX 10000
  ```
* **Leader Process:** The single request that acquires the lock queries upstream peers or the central origin, streams the data, populates the local cache, and releases the lock.
* **Follower Processes:** Competing requests fail to acquire the lock and enter an adaptive exponential backoff loop (`waitForCache`). They poll the cache at intervals of 100ms, 150ms, 225ms... up to 10 seconds. Once the leader populates the cache, followers immediately resolve from RAM without ever touching the origin.
* **Safe Release:** Lock release is executed via an atomic Lua script that validates the UUID token, ensuring a slow worker cannot release a lock acquired by a subsequent worker.

---

### 4. Tiered Peer-to-Peer Cache Fill Mechanism
When a cache miss occurs, the Edge node avoids immediately routing traffic across WAN connections to the central MinIO origin in Mumbai:

1. **Placement Query:** Queries Core Control Plane at `/api/v1/internal/placement/:fileId/v/:version`.
2. **Proximity Ordering:** The Core calculates spherical Haversine distances from the requesting edge to the $N=3$ responsible replica nodes designated by the Consistent Hash Ring and returns them sorted by physical distance.
3. **Peer Fetch Loop:** The Edge attempts HTTP peer fetches against neighboring edge nodes with header `X-Cache-Fill-Mode: peer`.
4. **Peer Cache Resolution:** If a neighboring edge has the file in RAM (`HTTP 200`), the local edge caches the buffer, sets `X-Cache: PEER_HIT`, and serves the client, cutting origin bandwidth consumption and inter-region transit costs.
5. **Origin Fallback:** Only if all peers return misses (`HTTP 404`) or connection timeouts (`PEER_FETCH_TIMEOUT_MS`, default 2000ms) does the edge fall back to streaming directly from MinIO.

---

### 5. Adaptive HLS Video Segment Delivery
The Edge provides high-performance video delivery via dedicated HLS handlers ([`EdgeContentController`](file:///home/raj-ribadiya/Desktop/pravah/apps/edge/src/content/edge-content.controller.ts)):

* **Route:** `GET /edge/content/:fileId/hls/*`
* **MIME Negotiation:** Dynamically identifies MPEG-TS video segments (`video/MP2T`) versus Apple HLS playlists (`application/vnd.apple.mpegurl`).
* **Caching Strategy:**
  * **Video Segments (`.ts`):** Cached on local NVMe disk with immutable headers (`public, max-age=31536000, immutable`) and 24-hour TTL in Redis.
  * **Master & Variant Playlists (`.m3u8`):** Cached in Redis RAM with 60-second TTL to ensure playlist updates propagate rapidly.
* **Origin Stream Fallback:** If HLS segments are not present locally, the edge fetches them directly from `hls/{ownerId}/{fileId}/{versionId}/{subpath}` in MinIO origin storage.

---

### 6. HMAC-SHA256 Signed Heartbeat Telemetry
Operated by [`HeartbeatService`](file:///home/raj-ribadiya/Desktop/pravah/apps/edge/src/heartbeat/heartbeat.service.ts):

* **Cron Interval:** Runs every 10 seconds (`*/10 * * * * *`).
* **Cryptographic Payload:** Builds payload `${edgeNodeId}:POST:/api/v1/admin/health/heartbeat:${timestamp}`.
* **HMAC Signature:** Signs the payload with SHA-256 using `INTERNAL_SERVICE_SECRET`.
* **Verification:** The Core control plane validates the signature and timestamp drift before renewing the node's TTL in the Redis health registry.

---

### 7. Observability and Prometheus Diagnostics
Operated by [`MetricsService`](file:///home/raj-ribadiya/Desktop/pravah/apps/edge/src/metrics/metrics.service.ts):

* **Scrape Endpoint:** `GET /metrics` exports standard Prometheus metrics for Grafana scraping.
* **Metrics Catalog:**
  * `cache_hits_total`: Cumulative cache hits segmented by cache type.
  * `cache_misses_total`: Cumulative cache misses triggering tiered fills.
  * `bytes_served_total`: Total egress bytes classified by source (`ram_cache`, `peer_cache`, `origin_stream`).
  * `request_duration_seconds`: Histogram measuring end-to-end download latency by cache result and HTTP status code.
  * `peer_fetches_total`: Counter tracking peer fill attempts categorized by status (`success`, `miss`, `error`).
* **Distributed Tracing:** [`tracer.ts`](file:///home/raj-ribadiya/Desktop/pravah/apps/edge/src/tracer.ts) initializes OpenTelemetry SDK with W3C `traceparent` context propagation, transmitting spans to Jaeger.

---

## Complete API Route Catalog

| Method | Endpoint | Protection | Description |
| :--- | :--- | :--- | :--- |
| `GET`  | `/health` | Public | Sub-millisecond zero-allocation health probe and benchmark target |
| `GET`  | `/metrics` | Public | Prometheus diagnostic metrics export |
| `GET`  | `/edge/content/:fileId` | Public / Peer | Stream binary content from local cache, neighbor peer, or origin |
| `GET`  | `/edge/content/:fileId/hls/*` | Public | Stream HLS adaptive playlists (`master.m3u8`) and video segments (`.ts`) |
| `POST` | `/edge/content/:fileId/purge` | HMAC / Key | Evict specific file and all cached versions from local RAM and NVMe disk |

---

## Environment Configuration Parameters

| Variable Name | Default Value | Description |
| :--- | :--- | :--- |
| `PORT` | `4001` | TCP port for the Fastify HTTP application server |
| `EDGE_NODE_ID` | `edge-node-01` | Unique regional identifier for this edge instance |
| `EDGE_REGION` | `ap-south-1` | Regional cloud identifier (`ap-south-1`, `eu-central-1`, `us-east-1`) |
| `REDIS_HOST` | `localhost` | Local Redis cache host |
| `REDIS_PORT` | `6379` | Local Redis cache TCP port |
| `REDIS_DB` | `0` | Redis logical database index |
| `CORE_API_URL` | `http://localhost:3000` | URL of the central Core Control Plane service |
| `INTERNAL_SERVICE_SECRET` | `pravah-internal-microservice-super-secret-2026` | Secret for signing telemetry heartbeats |
| `MAX_CACHE_SIZE` | `524288000` | Maximum cache capacity in bytes before LRU eviction (500MB) |
| `CACHE_DISK_PATH` | `/tmp/pravah-disk-cache` | Local filesystem directory for NVMe hybrid storage |
| `DISK_CACHE_THRESHOLD_BYTES` | `2097152` | File size threshold triggering disk storage instead of pure RAM (2MB) |
| `PEER_FETCH_TIMEOUT_MS` | `2000` | Timeout in milliseconds when attempting peer cache fills |
| `PEER_MAX_ATTEMPTS` | `3` | Maximum number of peer replicas to query before falling back to origin |
| `MINIO_ENDPOINT` | `localhost` | MinIO origin endpoint address |
| `MINIO_PORT` | `9000` | MinIO origin port |
| `MINIO_ACCESS_KEY` | `admin_minio` | MinIO origin access credentials |
| `MINIO_SECRET_KEY` | `minio_password` | MinIO origin secret credentials |
| `MINIO_BUCKET_NAME` | `pravah-origin` | Origin storage bucket name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OpenTelemetry OTLP collector gRPC/HTTP endpoint |

---

## Local Development Execution

```bash
# 1. Start Edge dependencies (Local Redis)
docker compose -f infra/docker/docker-compose.edge.yml up -d

# 2. Start Edge Service in development watch mode
pnpm --filter edge start:dev
```
The Edge data plane will initialize on Fastify and listen on `http://localhost:4001`.

```bash
# Verify edge health endpoint
curl -i http://localhost:4001/health

# Verify cache hit metrics
curl -i http://localhost:4001/metrics
```
