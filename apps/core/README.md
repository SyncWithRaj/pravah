# Pravah CDN — Core Control Plane API

The Core service (`apps/core`) is the central control plane, origin coordinator, and metadata authority of the Pravah Distributed CDN. It manages user authentication, file lifecycle orchestration, origin object storage, background video transcoding, inter-service security, and regional edge health monitoring.

---

## Architecture and Core Responsibilities

```
                                  INCOMING TRAFFIC
                                         │
                                         ▼
                                   Nginx / NLB (:3000)
                                         │
                                         ▼
                            ┌────────────────────────┐
                            │    UnifiedAuthGuard    │
                            │ (JWT / API Key / HMAC) │
                            └────────────┬───────────┘
                                         │
                 ┌───────────────────────┼───────────────────────┐
                 │                       │                       │
                 ▼                       ▼                       ▼
          Upload Pipeline          Metadata & CDN          Video Transcoder
          (Resumable Chunks)      Routing (Haversine)     (BullMQ + FFmpeg)
                 │                       │                       │
                 ▼                       ▼                       ▼
          MinIO / S3 Origin       PostgreSQL DB           HLS Adaptive Slices
          (pravah-origin)         (Prisma ORM)            (1080p / 720p / 480p)
```

---

## Subsystems and Capabilities

### 1. Cryptographic Tri-Mode Authentication & RBAC
* **JSON Web Tokens (JWT):** User sessions with access and refresh tokens (`/api/v1/auth/*`).
* **API Key Engine:** High-speed machine-to-machine authentication using SHA-256 one-way hashing with constant-time buffer validation (`crypto.timingSafeEqual`).
* **Inter-Service HMAC Signatures:** Edge-to-Core requests must provide an `X-Service-Signature` header computed via HMAC-SHA256 with timestamp replay protection (maximum 5-minute clock drift).
* **Hierarchical RBAC:** Strict 4-tier role hierarchy (`ADMIN > STREAMER > VIEWER > USER`) enforced via `@Roles()` decorators and `RolesGuard`.

### 2. Resumable Chunked Ingestion
* Handles large binary uploads divided into 5MB chunks.
* Tracks chunk arrival idempotently in PostgreSQL, enabling upload resumption without restarting from byte zero.
* Assembles chunks in MinIO/S3 and computes a full-file SHA-256 integrity checksum upon completion.

### 3. Adaptive Bitrate Video Transcoding (HLS)
* Detects video content types (`video/*`) and dispatches background processing jobs to a BullMQ Redis queue.
* Spawns FFmpeg workers to transcode raw video into multi-bitrate renditions (1080p, 720p, 480p, 360p, 240p, 144p) with dynamic no-upscaling logic.
* Packages streams into adaptive HLS master playlists (`master.m3u8`) and 4-second MPEG-TS segments (`.ts`).

### 4. Geo-Aware CDN Routing
* Implements the Spherical Haversine distance formula to resolve the physically closest healthy Edge node based on client IP coordinates.
* Issues an **HTTP 302 Found** redirect pointing the client directly to the chosen Edge PoP Fastify ingress.

### 5. Active Node Health Scanner
* Edge nodes transmit authenticated heartbeats to `POST /common/health-check/heartbeat` every 10 seconds.
* A background cron scanner evaluates active nodes. Nodes missing consecutive cycles are marked `DEGRADED`, then `DOWN`, and automatically evicted from the candidate routing pool and Consistent Hashing Ring.

---

## API Endpoints Reference

| Method | Endpoint | Protection | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Public | Register new user account |
| `POST` | `/api/v1/auth/login` | Public | Authenticate user, verify password hash, return JWT |
| `POST` | `/api/v1/auth/refresh` | Public | Exchange refresh token for new access token |
| `POST` | `/api/v1/upload/init` | JWT / API Key | Initialize resumable multipart upload session |
| `PUT`  | `/api/v1/upload/:id/chunk/:index` | JWT / API Key | Stream individual binary chunk to storage |
| `POST` | `/api/v1/upload/complete` | JWT / API Key | Finalize assembly, verify checksum, trigger Kafka events |
| `GET`  | `/api/v1/download/:fileId` | Public / Signed | Geo-route client to nearest healthy edge via HTTP 302 |
| `GET`  | `/api/v1/metadata/files/:fileId` | JWT / API Key | Retrieve object metadata, versions, and replication state |
| `POST` | `/api/v1/common/health-check/heartbeat` | HMAC-SHA256 | Process edge node health report |
| `GET`  | `/api/v1/metrics` | Public | Export Prometheus control plane metrics |

---

## Local Development Execution

```bash
# 1. Install dependencies
pnpm install

# 2. Run Prisma database migrations
pnpm --filter core exec prisma migrate dev

# 3. Seed initial admin user and edge nodes
pnpm --filter core exec prisma db seed

# 4. Start Core API in development watch mode
pnpm --filter core start:dev
```
Service listens on `http://localhost:3000`.
