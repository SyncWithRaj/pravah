# Pravah CDN - Master Roadmap & Global TODO List

## Completed Phases (Phases 0–7)

### Phase 0–4: Core Foundation & Event Broker
- [x] Resumable chunked uploads, checksum validation & MinIO storage
- [x] Gzip/Brotli compression & decompression pipelines
- [x] Redis edge caching with LRU eviction and memory limit enforcement
- [x] Object versioning (v1, v2) with automatic cache invalidation
- [x] Apache Kafka (RedPanda) event bus (`file.uploaded`, `cache.invalidate`, `edge.health_changed`)
- [x] Heartbeat health monitor with active node scanning (10s intervals)

### Phase 5: Microservices Split & Consistent Hashing
- [x] **Microservices Split:** Separated into `apps/core` (Control Plane) and `apps/edge` (Data Plane)
- [x] **Consistent Hashing Ring:** Custom hash ring with 150 virtual nodes per edge for deterministic file placement ($N=3$)
- [x] **GeoDNS Routing Algorithm:** Spherical Haversine distance calculator routing clients to nearest healthy edge via HTTP 302
- [x] **Dynamic Rebalancing:** Adding/removing edges only remaps $\sim 1/N$ keys across the ring

### Phase 6: Multi-Region Deployment & Full Observability
- [x] **Prometheus Metrics:** Core & Edge `/metrics` endpoints exporting request rates, latencies, and cache hit ratios
- [x] **Grafana Dashboards:** Unified real-time visual monitoring control room
- [x] **Loki & Promtail:** Centralized container log aggregation and stream indexing
- [x] **OpenTelemetry & Jaeger:** Distributed tracing with W3C `traceparent` context propagation across microservices
- [x] **Real-Time WebSocket Gateway:** Live telemetry stream pushing chunk progress, replication state, and node health

### Phase 7: System Hardening, Fault Tolerance & Performance Benchmarks
- [x] **Exponential Backoff & Retries:** $3\times$ exponential backoff ($1\text{s} \to 2\text{s} \to 4\text{s}$) with jitter on replication
- [x] **Dead Letter Queue (DLQ):** Kafka `edge.replication.dlq` topic + PostgreSQL `ReplicationDLQ` persistence
- [x] **Admin DLQ APIs:** Inspection, single replay, batch replay, and purge endpoints
- [x] **Failure Flow 2 (Edge Crash Failover):** Real-time `DOWN` detection + automatic 302 download rerouting to nearest healthy edge
- [x] **Hash Ring Dynamic Self-Healing:** Automatic dead-node virtual key ejection and BullMQ replica repair restoring $N=3$
- [x] **High-Throughput k6 Concurrency Suite:** 6 containerized load test scenarios (200 VUs, cache hits, GeoDNS routing, byte ranges, cache invalidation)
- [x] **Benchmark Documentation:** Full results recorded in `docs/benchmarks.md` and `docs/reports/phase_07_hardening_benchmarks.md`

---

## Active & Upcoming Roadmap

### 1. Adaptive Bitrate Video Transcoding Pipeline (Phase 8A) [COMPLETED]
- [x] **FFmpeg Worker Pipeline:** BullMQ background processing queue for raw video uploads (`video/*`).
- [x] **Multi-Bitrate Renditions:** Transcode into 1080p, 720p, 480p, 360p, 240p, 144p H.264/AAC streams with dynamic no-upscaling filtering.
- [x] **HLS Manifest Packaging:** Generate master `.m3u8` adaptive playlists and 4-second `.ts` video segments.
- [x] **Edge Video Streaming & Caching:** Sub-10ms delivery of `.m3u8` manifests and `.ts` segments via Edge Redis cache with CORS and immutable caching headers (`GET /edge/content/:fileId/hls/*`).

### 2. Kubernetes (K8s / EKS) Orchestration (Phase 8B) [COMPLETED]
- [x] **Container Packaging:** Helm charts and 16 Kubernetes manifests for Core Plane and Edge Data Plane.
- [x] **Horizontal Pod Autoscaler (HPA):** Auto-scale edge caching pods and transcoding worker pods based on CPU, memory, and RPS.
- [x] **High-Concurrency AWS EKS Load Test:** 100K RPS cloud stress testing suite on Amazon EKS with 2,000 VUs and 1.77ms latency.

### 3. Security Hardening & Role-Based Access Control (Phase 8C) [COMPLETED]
- [x] **Admin API Protection:** Add `UnifiedAuthGuard` and `RolesGuard` to secure `/api/v1/admin/*`, `/admin/dlq`, and `/admin/transcoding`.
- [x] **API Key Authentication:** Implement `ApiKeyGuard` with SHA-256 constant-time hash lookup for machine-to-machine clients.
- [x] **Inter-Service Security:** Implement `InterServiceGuard` with HMAC-SHA256 signatures & timestamp replay protection for Edge $\leftrightarrow$ Core communication.
- [x] **Per-Version Stampede Lock:** Refined mutex keys to `lock:stampede:{fileId}:v{version}` preventing multi-version thundering herds.
- [x] **Hybrid NVMe/Disk + Redis Storage:** Store large binary files and `.ts` video chunks on NVMe/SSD disk while using Redis RAM for hot metadata, ETags, and LRU indexes.

### 4. Zero-Copy Reverse Proxy Edge Acceleration (Phase 9) [COMPLETED]
- [x] **Linux Kernel Directives:** Configured `sendfile on;`, `tcp_nopush on;`, and `tcp_nodelay on;` for zero user-space memory copies.
- [x] **Segment Cache Zone:** 20GB persistent disk cache zone (`SEGMENT_CACHE`) for `.ts`, `.m4s`, and `.mp4` chunks.
- [x] **Manifest Microcaching:** 1-second microcache zone (`MANIFEST_CACHE`) for dynamic `.m3u8` playlists preventing live stream stampedes.
- [x] **Upstream Keep-Alive Pooling:** Persistent HTTP/1.1 connection pooling to NestJS Edge Service on ports 3001/4001.
- [x] **Alpine Linux Packaging:** Production `Dockerfile` with automated `nginx -t` build-time validation and health checks.
- [x] **CI Pipeline Matrix:** Integrated `nginx-edge` container build and validation into `.github/workflows/ci.yml`.
- [x] **Request Flow Architecture:** Documented request lifecycle, sequence diagrams, and data plane vs control plane separation in `docs/designs/edge_nginx_reverse_proxy_flow.md`.
- [x] **Kubernetes Sidecar Integration:** Deployed `edge-proxy` sidecar container in `infra/k8s/30-edge-deployment.yaml` and `32-spoke-edge-deployment.yaml`, updated `pravah-edge-service` to port 80, and wired Ingress routes.
- [x] **Fastify Reply Compatibility:** Enhanced `EdgeContentController` with universal reply helpers (`setHeader` and `sendResponse`) for safe high-throughput byte streaming under Fastify.
- [x] **Live Container Verification:** Validated cache hits, cache misses, and manifest microcaching on live containers (`pravah-edge`, `pravah-edge-proxy`, `pravah-edge-redis`).

---

## Target Architecture: Scaling to 1,000,000 Requests/Second (1M RPS)

### Scaling Architecture Blueprint
```
                          1,000,000 Requests / Second (1M RPS)
                                       │
                ┌──────────────────────┴──────────────────────┐
          Global Anycast DNS / BGP Routing (Multi-Region)
                │                      │                      │
         [Region 1: Mumbai]     [Region 2: Frankfurt]   [Region 3: Virginia]
           (250,000 RPS)          (250,000 RPS)          (500,000 RPS)
                │                      │                      │
         K8s Cluster            K8s Cluster            K8s Cluster
       (50 Edge Pods)         (50 Edge Pods)        (100 Edge Pods)
                │                      │                      │
     Nginx Zero-Copy Cache  Nginx Zero-Copy Cache  Nginx Zero-Copy Cache
```

### Scaling Milestones & Requirements

1. **Horizontal Edge Pod Expansion (Kubernetes HPA)**:
   - Baseline: A single optimized NestJS/Node.js edge worker process handles **~1,000 RPS**.
   - Target: **1,000 Edge Pods** distributed globally across 20 cloud regions (50 pods per region) to handle **1,000,000 RPS**.

2. **Zero-Copy Reverse Proxy Edge Acceleration (Nginx / Envoy / Varnish Layer)**:
   - Fronting edge nodes with an Nginx reverse proxy using Linux kernel `sendfile` (zero-copy socket transfer) increases single-server throughput to **25,000–50,000 RPS per bare-metal/EC2 instance**.
   - With zero-copy reverse proxy caching, only **20–40 high-performance edge servers** are required worldwide to sustain 1M RPS.

3. **Network Bandwidth at 1M RPS**:
   - Assuming an average file/video chunk payload of $50\text{ KB}$:
     $$\text{Bandwidth} = 1,000,000 \times 50\text{ KB} = 50\text{ GB/s} = 400\text{ Gbps}$$
   - Distributed evenly across global edge Points of Presence (PoPs).

4. **Database & Origin Decoupling**:
   - Achieve $99.5\%+$ edge cache hit ratio so that only $0.5\%$ ($5,000\text{ RPS}$) reaches the Core Origin MinIO/S3 cluster.
   - Redis cluster with read replicas and read-through caching prevents PostgreSQL connection exhaustion.
