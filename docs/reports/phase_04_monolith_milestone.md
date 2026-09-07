# Pravah CDN: Phase 0 to 4 Implementation Report

## Executive Summary
This report details the exact technical implementation completed during Phases 0 through 4 of the Pravah CDN project. It reflects the real codebase structure, algorithms, and architectural decisions implemented in the NestJS application, transitioning from a basic monolith to a distributed, event-driven, fault-tolerant edge replication system.

---

## Phase 0: Design & Infrastructure Setup
**Objective:** Establish the foundational infrastructure and application skeleton.

**Implementation Details:**
- **Infrastructure Setup:** Created `docker-compose.yml` to run the core dependencies locally:
  - PostgreSQL 16 (Relational Metadata)
  - Redis 7 (Edge Cache & Distributed Locks)
  - MinIO (Local S3-compatible Origin Storage)
  - Redpanda (High-performance Kafka-compatible broker without Zookeeper)
- **Application Skeleton:** Bootstrapped the NestJS core module structure (`AppModule`, `UploadModule`, `DownloadModule`, `MetadataModule`, `KafkaModule`, `MinioModule`).
- **Database Schema:** Defined the initial Prisma schema containing `User`, `File`, and `FileChunk` models.

---

## Phase 1: Core Storage & Assembly
**Objective:** Build a robust, fault-tolerant upload and download pipeline.

**Implementation Details:**
- **Chunked Resumable Uploads:** 
  - Created endpoints in `UploadController` for initiating sessions (`POST /uploads`) and accepting binary chunks (`PUT /uploads/:id/chunk/:index`).
  - Stored chunk metadata in PostgreSQL and chunk binaries in MinIO (`/chunks/chunk-{index}`).
- **Origin Assembly & Compression:** 
  - In `UploadService.completeUpload()`, we implemented logic to read all chunks sequentially from MinIO.
  - Applied Node.js `zlib.createGzip()` to compress textual/compressible payloads dynamically.
  - Assembled the final compressed object in MinIO at `bucket/v1/original.ext.gz` and deleted the temporary chunks.
- **Range Request Downloads:** 
  - Built `DownloadService.processDownload()` to handle HTTP `Range` headers.
  - Interfaced with MinIO using `getObjectStreamWithRange` to support `206 Partial Content` delivery (e.g., video scrubbing) directly from origin.

---

## Phase 2: Edge Caching & Object Versioning
**Objective:** Introduce DB-less edge delivery, Redis caching, and immutable versioning.

**Implementation Details:**
- **Immutable Object Versioning:** 
  - Added the `FileVersion` Prisma model. When an existing file is updated, `UploadService` does not overwrite the old object. Instead, it increments `currentVersion` (e.g., v1 -> v2).
- **Redis Edge Cache Integration:** 
  - Created `EdgeCacheService` to handle direct Redis communication.
  - Implemented `cacheFile()` using a **Redis Pipeline** to atomically save binary buffers, metadata (`HSET`), update the `current` version pointer, and track the file in a `ZSET` (`cache:lru`) for Least-Recently-Used tracking.
  - Implemented `enforceLruLimits()` to continuously check the `cache:size` tracker and automatically evict the oldest files if the 20MB memory limit is breached.
- **HTTP 304 ETags:** 
  - Injected `ETag` generation based on file checksums. If a client's `If-None-Match` header matches the Redis ETag, the server instantly throws a `304 Not Modified` exception, saving bandwidth.
- **Telemetry Hooks:** 
  - Configured Kafka producer in `KafkaService` and added `emitCacheHit()` / `emitCacheMiss()` hooks inside the Redis lookup functions for future analytics.

---

## Phase 3: Event-Driven Invalidation & Stampede Protection
**Objective:** Ensure cache consistency across a distributed cluster and prevent MinIO failure under massive concurrent load.

**Implementation Details:**
- **Kafka Hybrid Microservice:** 
  - Modified `main.ts` to configure NestJS as a Kafka Microservice with a randomized `groupId`. This ensures that *every* edge node instance receives broadcasted events, rather than load-balancing them.
- **Cluster-Wide Auto-Invalidation:** 
  - Updated `UploadService`: upon successfully committing a v2 upload, it emits a `cache.invalidate` event via Kafka.
  - `EdgeCacheController` consumes this event and triggers `evictFile()`. 
  - **O(1) Lua Eviction:** Instead of using slow, blocking `KEYS *` commands, we implemented tracking Sets (`SADD file:{fileId}:keys`). During eviction, `SMEMBERS` retrieves the exact keys, and a Lua script atomically deletes them while updating the `cache:size` counter.
- **Admin Purge API:** 
  - Added `POST /api/v1/admin/cache/purge` to allow manual broadcasting of the invalidation event.
- **Advanced Cache Stampede Protection (The "Leader/Waiter" Pattern):**
  - Refactored `DownloadService` to handle massive concurrent traffic.
  - **The Lock:** Added `acquireStampedeLock()` using Redis `SET NX PX 10000` with a generated UUID to prevent lock stealing.
  - **Active Polling:** Waiters (requests that fail to get the lock) enter `waitForCache()`, which loops every 100ms querying Redis until the Leader finishes downloading the file.
  - **Stream Decoupling:** When the Leader fetches from MinIO, it splits the data using Node.js `PassThrough` streams. One stream goes to the client, and the other goes to `cacheFile()`. This guarantees that if the client disconnects prematurely, the background cache population still completes successfully.

---

## Phase 4: Proactive Edge Replication & Health Checks
**Objective:** Introduce multi-edge replication via BullMQ background jobs and robust health monitoring for high availability.

**Implementation Details:**
- **In-Memory Health Checks:** 
  - Built `HealthCheckService` to monitor edge node heartbeats via Redis `SET EX 15`.
  - A `@Interval(5000)` non-blocking monitor loop checks the Redis TTLs. It transitions node states: `DEGRADED` (1 miss) and `DOWN` (3+ misses).
  - Uses an in-memory `nodeMap` synced with PostgreSQL every 5 minutes to prevent DB contention.
- **BullMQ Replication Pipeline:** 
  - Created `ReplicationController` to listen for the `file.uploaded` Kafka event.
  - Built `ReplicationService` to select a strict **Replication Factor of 3** (picking 3 healthy nodes) and dispatch background jobs to the `replication.normal` BullMQ queue with `priority: 5` and exponential backoff + jitter.
  - Created a dedicated worker, `ReplicationProcessor`, bounded by `concurrency: 5`, to execute the actual replication.
- **OOM Defense (RAM Bloat Protection):** 
  - Implemented a pre-stream safety check in the processor. If a file exceeds the **20MB RAM cache limit**, it is intentionally bypassed to prevent Node.js Out-Of-Memory crashes.
- **Idempotent Execution & Telemetry:** 
  - `ReplicationStatus` model in PostgreSQL tracks job states (`PENDING`, `IN_PROGRESS`, `COMPLETE`, `FAILED`) and timing metrics (`durationMs`). Jobs can be manually retried from the Admin DLQ API.

---

## Current System Flow (End of Phase 4)

The following Mermaid diagram maps out the complete programmatic flow, incorporating all components built up to this point, including the new BullMQ Replication pipeline.

```mermaid
%%{init: {'theme': 'dark'}}%%
sequenceDiagram
    autonumber
    actor Client
    participant UploadSvc as Upload Service
    participant EdgeCache as Edge Cache (Redis)
    participant DB as Postgres DB
    participant MinIO as Origin (MinIO)
    participant Kafka as Event Bus (Redpanda)
    participant BullMQ as BullMQ Worker (Processor)

    rect rgb(20, 40, 30)
        Note over Client, Kafka: 1. UPLOAD & VERSIONING FLOW
        Client->>UploadSvc: PUT /uploads/{fileId}/complete
        UploadSvc->>MinIO: Assemble chunks & compress
        UploadSvc->>DB: INSERT file_versions
        UploadSvc->>Kafka: Publish "file.uploaded"
    end

    rect rgb(30, 20, 50)
        Note over Kafka, BullMQ: 2. PROACTIVE REPLICATION (PHASE 4)
        Kafka-->>BullMQ: Controller consumes "file.uploaded"
        BullMQ->>DB: Check Health & upsert ReplicationStatus (PENDING)
        BullMQ->>BullMQ: Enqueue job (Factor: 3, Priority: 5)
        BullMQ->>MinIO: Worker streams file from Origin
        BullMQ->>EdgeCache: cacheFile(binary, metadata, LRU)
        BullMQ->>DB: Update ReplicationStatus (COMPLETE + durationMs)
    end
```

## System Architecture Flowchart

The following flowchart represents the exact same system logic and routing paths, visualizing the integration of BullMQ and the Health Monitor.

```mermaid
%%{init: {'theme': 'dark'}}%%
flowchart LR
    Client((Client))

    subgraph Services [Pravah CDN Services]
        direction TB
        UploadSvc[Upload Service]
        DownloadSvc[Download Service]
        ReplicationSvc[Replication Service / Worker]
        HealthCheck[Health Monitor]
    end

    subgraph Storage [Storage & Events]
        direction TB
        DB[(PostgreSQL)]
        MinIO[(MinIO)]
        Kafka[[Redpanda]]
        Redis[(Redis Cache + BullMQ)]
    end

    %% Upload Flow
    Client -->|1. Upload| UploadSvc
    UploadSvc -->|Save| MinIO
    UploadSvc -->|Publish Event| Kafka

    %% Replication Flow (Phase 4)
    Kafka -->|Consume Event| ReplicationSvc
    HealthCheck -.->|Provides Healthy Nodes| ReplicationSvc
    ReplicationSvc -->|Push Job| Redis
    Redis -->|Pop Job| ReplicationSvc
    ReplicationSvc -->|Stream from Origin| MinIO
    ReplicationSvc -->|Push to Edge Cache| Redis
    ReplicationSvc -->|Record Metrics| DB

    %% Health Flow (Phase 4)
    HealthCheck -->|Poll TTL| Redis
    HealthCheck -->|Update State| DB
```
