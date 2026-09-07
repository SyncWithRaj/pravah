# Pravah CDN — Core Control Plane API

The Core service (`apps/core`) is the central control plane, origin coordinator, and metadata authority of the Pravah Distributed Content Delivery Network. It is responsible for user identity management, multi-tier role-based access control, cryptographic inter-service security, resumable chunked file ingestion, asynchronous video transcoding pipelines, spherical Haversine geo-routing, consistent hash ring topology management, and regional edge health monitoring.

---

## Architectural Topology

```
                                      INCOMING CLIENT & EDGE TRAFFIC
                                                    │
                                                    ▼
                                            Nginx / NLB (:3000)
                                                    │
                                                    ▼
                                      ┌───────────────────────────┐
                                      │     UnifiedAuthGuard      │
                                      │  (JWT / API Key / HMAC)   │
                                      └─────────────┬─────────────┘
                                                    │
             ┌──────────────────────┬───────────────┴───────────────┬──────────────────────┐
             │                      │                               │                      │
             ▼                      ▼                               ▼                      ▼
     Upload Controller      Download Controller            Placement & Routing     Health Check Scanner
     (Chunk Ingestion)      (GeoDNS Redirection)           (Consistent Hashing)    (Active Edge Probing)
             │                      │                               │                      │
             ▼                      ▼                               ▼                      ▼
     Multipart S3 Engine    PostgreSQL Metadata DB         Distance Resolver       Redis TTL Registry
     (MinIO Storage)        (Prisma ORM Models)            (Spherical Haversine)   (Failover Watcher)
             │                      │                               │                      │
             └──────────────────────┼───────────────────────────────┴──────────────────────┘
                                    │
                                    ▼
                         BullMQ Asynchronous Queues
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
      FFmpeg Transcoding Worker             Replication Processor
      (HLS Multi-Bitrate Packaging)         (Edge Replication & DLQ)
```

---

## Core Subsystems and Architecture

### 1. Tri-Mode Cryptographic Authentication and RBAC
The Control Plane provides three orthogonal authentication mechanisms managed through [`UnifiedAuthGuard`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/auth/guards/unified-auth.guard.ts):

* **JSON Web Tokens (JWT):** Designed for end-user web and mobile sessions. Employs asymmetric or shared secret signing with short-lived access tokens (15 minutes) and rotating refresh tokens stored in PostgreSQL. Passwords are encrypted using Argon2 hashing algorithms (`argon2id`).
* **Cryptographic API Keys:** Optimized for machine-to-machine, CI/CD automation, and external edge proxies. API keys are generated with high entropy (`prv_live_...`), stored exclusively as SHA-256 digests in the `api_keys` table, and evaluated using constant-time buffer comparisons (`crypto.timingSafeEqual`) to mitigate side-channel timing attacks.
* **Inter-Service HMAC-SHA256 Signatures:** Secures internal service-to-service communication between Edge nodes and Core origin. Requests must include `x-service-id`, `x-service-timestamp`, and `x-service-signature`. Signatures are generated over the payload string `${edgeId}:${method}:${path}:${timestamp}` using a pre-shared cryptographic key (`INTERNAL_SERVICE_SECRET`). Signatures include strict replay protection rejecting requests with clock drift exceeding 5 minutes.
* **Hierarchical Role-Based Access Control (RBAC):** Configured via `@Roles()` decorators and enforced at the controller layer via [`RolesGuard`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/auth/guards/roles.guard.ts):
  ```
  ADMIN (Level 4) ──► STREAMER (Level 3) ──► VIEWER (Level 2) ──► USER (Level 1)
  ```
  Higher roles implicitly inherit the full permission surface of all lower roles.

---

### 2. Resumable Multipart Chunked Upload Engine
The ingestion pipeline ([`UploadService`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/upload/upload.service.ts)) handles multi-gigabyte binary files split into uniform 5MB chunks:

1. **Session Initialization (`POST /api/v1/upload/init`):** Allocates a `File` record in `PENDING` state and provisions `FileChunk` slots in PostgreSQL.
2. **Chunk Ingestion (`PUT /api/v1/upload/:id/chunk/:index`):** Clients stream binary chunks sequentially or concurrently. Each chunk is temporarily written to the MinIO origin bucket (`{fileId}/chunks/chunk-{index}`) and validated against a client-supplied SHA-256 checksum. Chunks transition from `PENDING` to `UPLOADED` to `VERIFIED`.
3. **Zero-RAM Server-Side Assembly (`POST /api/v1/upload/complete`):** Once all chunks achieve `VERIFIED` status, the Core engine leverages S3 Multipart Copy operations (`CreateMultipartUploadCommand`, `UploadPartCopyCommand`, and `CompleteMultipartUploadCommand`). MinIO stitches chunks directly on disk without loading entire multi-gigabyte files into Node.js process heap memory.
4. **Integrity Check and Event Dispatch:** Computes the full-file SHA-256 checksum, creates a new sequential `FileVersion` (v1, v2, etc.), purges temporary chunk fragments, and dispatches the `file.uploaded` event to the Kafka cluster.

---

### 3. Adaptive Bitrate Video Transcoding Subsystem (HLS)
Upon upload completion of any video MIME type (`video/*`), the Core automatically dispatches a transcoding task to BullMQ:

* **Worker Architecture:** Managed by [`TranscodingProcessor`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/transcoding/transcoding.processor.ts), running sandboxed background worker threads.
* **Stream Probing:** Invokes `ffprobe` to determine input resolution, framerate, and audio layout.
* **Dynamic Non-Upscaling Filter:** Transcodes video only into applicable resolutions at or below the source resolution across 6 standard profiles:
  * 1080p: 1920x1080 @ 4500 kbps
  * 720p: 1280x720 @ 2500 kbps
  * 480p: 854x480 @ 1200 kbps
  * 360p: 640x360 @ 800 kbps
  * 240p: 426x240 @ 400 kbps
  * 144p: 256x144 @ 200 kbps
* **HLS Packaging:** Spawns `ffmpeg` processes generating 4-second MPEG-TS segments (`.ts`) and quality-specific playlists (`index.m3u8`), unified under a top-level master adaptive playlist (`master.m3u8`).
* **Origin Push:** All segments are written directly to MinIO under `hls/{ownerId}/{fileId}/{versionId}/` and indexed in the PostgreSQL `video_transcodes` table.

---

### 4. Spherical Haversine GeoDNS Routing Engine
The routing service ([`RoutingService`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/common/routing/routing.service.ts)) resolves incoming download requests (`GET /api/v1/download/:fileId`) to the physically closest operational edge node:

* **Coordinate Resolution:** Extracts client geographic hints from headers (`x-test-client-region` or upstream GeoIP resolver).
* **Exact Region Match:** If healthy edge nodes exist in the client's identical region, load is distributed uniformly across those nodes.
* **Haversine Distance Computation:** If no edge is located in the client region, the algorithm computes spherical great-circle distance:
  $$\text{distance} = 2R \arcsin \left( \sqrt{ \sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right) } \right)$$
  Where $R = 6371\text{ km}$, $\phi$ is latitude, and $\lambda$ is longitude.
* **Redirection:** Emits an **HTTP 302 Found** redirect with headers (`X-CDN-Edge`, `X-CDN-Region`, `X-CDN-Distance-Km`, `X-CDN-Strategy`) steering the user agent directly to the chosen Edge node URL.

---

### 5. Consistent Hashing Ring and Dynamic Topology
Managed by [`HashRing`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/common/replication/hash-ring.ts) and [`PlacementService`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/placement/placement.service.ts):

* **Virtual Node Density:** Assigns 150 virtual nodes per physical Edge server on a $[0, 2^{32}-1]$ ring using MD5 hash distribution.
* **Replica Assignment:** For any given `fileId`, a binary search on the ring identifies $N=3$ distinct physical nodes responsible for hosting replicas.
* **Dynamic Self-Healing:** When nodes fail or recover, topology synchronization recalculates replica distributions, minimizing cache invalidation to $1/N$ keys across the cluster.

---

### 6. Active Health Monitoring and Failover Engine
Operated by [`HealthCheckService`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/common/health-check/health-check.service.ts):

* **Heartbeat Ingestion:** Regional edge nodes post HMAC-authenticated heartbeats to `/api/v1/admin/health/heartbeat` every 10 seconds, writing an ephemeral Redis key with a 15-second TTL.
* **Scanner Loop:** A background cron executes every 5 seconds, checking active Redis TTLs:
  * **0 missed cycles:** Node remains `HEALTHY`.
  * **1 missed cycle:** Transition to `DEGRADED`. Node is flagged for potential latency.
  * **3 consecutive missed cycles:** Transition to `DOWN`. The node is evicted from candidate routing pools and the Consistent Hash Ring.
* **Recovery:** When a dead node resumes heartbeats, the scanner automatically restores it to `HEALTHY` and re-registers its virtual nodes on the ring.

---

### 7. Asynchronous Replication and Dead Letter Queue (DLQ)
Operated by [`ReplicationProcessor`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/src/replication/replication.processor.ts):

* **Event Triggering:** Ingestion of `file.uploaded` initiates BullMQ jobs to replicate files to the $N=3$ designated Edge nodes.
* **Exponential Backoff:** Configured with 3 retry attempts using exponential backoff ($1\text{s} \to 2\text{s} \to 4\text{s}$) with randomized jitter.
* **Dead Letter Queue:** If all 3 attempts fail, the job is recorded in the PostgreSQL `ReplicationDLQ` table and emitted to Kafka topic `edge.replication.dlq`.
* **Administrative Operations:** Exposes `/api/v1/admin/dlq` endpoints allowing operators to inspect failures, trigger single or bulk replays, or purge poisoned records.

---

## Database Schema Reference (PostgreSQL + Prisma)

The core database schema is modeled in [`prisma/schema.prisma`](file:///home/raj-ribadiya/Desktop/pravah/apps/core/prisma/schema.prisma):

| Model | Table Name | Purpose & Critical Fields |
| :--- | :--- | :--- |
| `User` | `users` | User credentials, Argon2 password hashes, and assigned base role (`ADMIN`, `STREAMER`, `VIEWER`, `USER`). |
| `ApiKey` | `api_keys` | High-speed machine keys storing SHA-256 hashes (`keyHash`), key prefix (`keyPrefix`), and expiration dates. |
| `File` | `files` | Master file catalog tracking owner, MIME type, total size (`BigInt`), status (`PENDING`, `UPLOADING`, `COMPLETED`), and active version pointer. |
| `FileChunk` | `file_chunks` | Resumable chunk slots tracking 0-based chunk indices, byte sizes, verified checksums, and storage paths. |
| `FileVersion` | `file_versions` | Sequential versioning records (v1, v2) with storage paths, byte sizes, checksums, and compression flags. |
| `VideoTranscode` | `video_transcodes` | Transcoding jobs tracking qualities (`1080p` to `144p`), status (`PENDING`, `PROCESSING`, `COMPLETED`), duration, and master playlist locations. |
| `EdgeNode` | `edge_nodes` | Registered CDN edge points of presence with geo-coordinates (`latitude`, `longitude`), URLs, regions, and live health status. |
| `ReplicationStatus` | `replication_status` | File-to-node replication matrix tracking retry counters, latency metrics, and Dead Letter Queue states. |

---

## Complete API Route Catalog

### Authentication & User Management
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Public | Register new user account with Argon2 password hashing |
| `POST` | `/api/v1/auth/login` | Public | Authenticate user credentials, generate access and refresh tokens |
| `POST` | `/api/v1/auth/refresh` | Public | Exchange refresh token for new access token |
| `GET`  | `/api/v1/user/me` | UnifiedAuthGuard | Retrieve profile of the currently authenticated user |

### API Key Management
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/api-keys` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Generate new machine-to-machine SHA-256 API key |
| `GET`  | `/api/v1/auth/api-keys` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | List active API keys belonging to the user |
| `DELETE` | `/api/v1/auth/api-keys/:id` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Revoke an existing API key |

### Ingestion & Chunked Uploads
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/upload/init` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Initialize multi-chunk upload session |
| `POST` | `/api/v1/upload/:fileId/versions` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Initialize upload session for a new file version |
| `PUT`  | `/api/v1/upload/:fileId/chunk/:chunkIndex` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Upload individual binary chunk with checksum verification |
| `GET`  | `/api/v1/upload/status/:fileId` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Check chunk verification progress and remaining chunks |
| `POST` | `/api/v1/upload/complete` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Assemble chunks server-side in S3 and dispatch events |

### Content Delivery & Geo-Routing
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET`  | `/api/v1/download/:fileId` | UnifiedAuthGuard | Geo-route client to closest healthy edge via HTTP 302 |
| `GET`  | `/api/v1/download/:fileId/versions/:version` | UnifiedAuthGuard | Geo-route client to closest edge for a specific historical version |
| `GET`  | `/api/v1/download/:fileId/signed` | UnifiedAuthGuard | Generate time-limited pre-signed S3 download URL |

### Metadata & Diagnostics
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET`  | `/api/v1/metadata/files` | UnifiedAuthGuard | List files owned by user with pagination |
| `GET`  | `/api/v1/metadata/files/:fileId` | UnifiedAuthGuard | Retrieve file metadata, version history, and transcoding status |
| `DELETE` | `/api/v1/metadata/files/:fileId` | UnifiedAuthGuard (`ADMIN`, `STREAMER`) | Soft/hard delete file and invalidate edge caches |
| `GET`  | `/api/v1/metrics` | Public | Prometheus control plane metric scrape endpoint |

### Inter-Service & Internal APIs
| Method | Endpoint | Guards / Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET`  | `/api/v1/internal/placement/:fileId/v/:version` | Inter-Service / HMAC | Query responsible replica nodes and peer fill hierarchy |
| `GET`  | `/api/v1/internal/metadata/files/:fileId/versions/:version` | Inter-Service / HMAC | Retrieve raw object storage path for edge origin fills |
| `POST` | `/api/v1/admin/health/heartbeat` | Inter-Service / HMAC | Ingest edge node health telemetry |
| `GET`  | `/api/v1/admin/dlq` | UnifiedAuthGuard (`ADMIN`) | List failed replication jobs in the Dead Letter Queue |
| `POST` | `/api/v1/admin/dlq/replay/:id` | UnifiedAuthGuard (`ADMIN`) | Re-queue a specific failed replication job |
| `DELETE` | `/api/v1/admin/dlq/:id` | UnifiedAuthGuard (`ADMIN`) | Purge record from the Dead Letter Queue |

---

## Environment Configuration Parameters

| Variable Name | Default Value | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port for the NestJS Express application |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/pravah` | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis host for queues, locks, and heartbeat registries |
| `REDIS_PORT` | `6379` | Redis TCP port |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-delimited list of Kafka / RedPanda brokers |
| `MINIO_ENDPOINT` | `localhost` | MinIO / S3 endpoint address |
| `MINIO_PORT` | `9000` | MinIO S3 API port |
| `MINIO_ACCESS_KEY` | `admin_minio` | S3 API root access key |
| `MINIO_SECRET_KEY` | `minio_password` | S3 API root secret key |
| `MINIO_BUCKET_NAME` | `pravah-origin` | Primary object storage bucket |
| `JWT_SECRET` | `super-secret-jwt-key` | HMAC key for signing user authentication tokens |
| `INTERNAL_SERVICE_SECRET` | `pravah-internal-microservice-super-secret-2026` | Shared secret for inter-service HMAC signatures |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OpenTelemetry OTLP collector gRPC/HTTP endpoint |

---

## Local Development Execution

```bash
# 1. Start core backing services (Postgres, MinIO, Redis, Kafka)
docker compose up -d postgres minio redis kafka

# 2. Run Prisma migrations against local database
pnpm --filter core exec prisma migrate dev

# 3. Seed test users, roles, and edge nodes
pnpm --filter core exec prisma db seed

# 4. Start Core service in hot-reload development mode
pnpm --filter core start:dev
```
The Core service will initialize and listen on `http://localhost:3000`.
