# Distributed CDN — Complete Project Specification (v2)

**A production-grade content delivery network, built solo, built real.**

---

## 1. Executive Summary

This document specifies a distributed Content Delivery Network (CDN) that stores, replicates, caches, and delivers content across multiple edge nodes, with real-time monitoring, event-driven cache invalidation, consistent-hashing-based edge assignment, and genuine multi-region deployment. It is designed to be built solo, over roughly 5–7 months, in sequential phases — with the explicit rule that no phase is "done" until it has been load-tested and deliberately broken to confirm its failure behavior.

**v2 changes:** core services now start as a monolith and split into microservices mid-build (not as a late stretch phase); added consistent hashing for edge assignment, an explicit CDN routing algorithm, compression, object versioning, a purge API, a dedicated health check service, a fuller real-time dashboard, and a benchmarks section for the README.

---

## 2. Problem & Motivation

Small-scale developers and learners rarely get hands-on experience with the mechanics that make large CDNs (Cloudflare, CloudFront, Fastly, Akamai) work — edge caching, replication consistency, event-driven invalidation, consistent-hashing-based placement, and graceful degradation under node failure. Most student projects that touch these ideas do so shallowly: a single cache layer, no real geographic distribution, no failure testing, and no real answer to "how do you decide which edge stores which file."

This project's motivation is to implement these mechanics for real, at a scale that's honest about being small, but with correctness and failure-handling that would hold up under real interrogation.

---

## 3. Goals & Non-Goals

**Goals**
- A working upload → replicate → cache → serve pipeline, with resumable chunked uploads, compression, and signed, range-request-capable downloads
- Real Redis-backed caching with a defensible eviction policy and measured hit ratios
- Event-driven cache invalidation and replication via Kafka, with provable failure/retry behavior
- A real, explainable answer to "which edge stores which file" (consistent hashing) and "how does a client get routed to an edge" (a named routing algorithm)
- Real replication across genuinely separate edge nodes, deployed to real EC2 instances in different regions, with measured latency differences
- Observability (metrics, logs, traces, live dashboard) sufficient to diagnose a slow or failing request
- Every claim in the README backed by a number you actually measured

**Non-Goals (for the core build — explicitly deferred to the stretch phase)**
- Kubernetes is not required to prove any of the above; it's a stretch phase, not a dependency
- A second message broker (RabbitMQ) is not used — one broker (Kafka), used well, is more defensible than two used shallowly
- Global-scale traffic — this is a small, honestly-scoped system; the goal is correct mechanics, not real-world load

---

## 4. Build Strategy: Monolith First, Microservices Later

The core API (Gateway routing, Auth, Upload, Download, Metadata) starts as **one deployable NestJS application**, organized internally as clean modules with clear boundaries — not as separate services communicating over HTTP. This is a deliberate sequencing choice, not a shortcut:

- It's dramatically easier to get the actual CDN mechanics right (chunked upload, caching, replication, invalidation) when you're not also debugging service-to-service networking, service discovery, and distributed transactions on day one.
- Because the modules are cleanly separated internally from the start (separate NestJS modules, separate database access patterns per domain), splitting them into real microservices later is a refactor, not a rewrite.
- **Cache Service is the one exception — it's separate from the start**, because it fundamentally has to run at each edge node; that's not a microservices decision, it's a physical requirement of the system.

The split into independent microservices happens deliberately in **Phase 5**, at the same time you introduce consistent hashing and the real routing algorithm — because that's exactly the point where the system genuinely needs independently deployable, independently scalable services (different edges, different regions, different load patterns per service).

---

## 5. System Overview

### Phase 0–4: Monolith Core

```
                          Client
                             │
                             ▼
                   Nginx / API Gateway
                             │
                             ▼
                ┌─────────────────────────┐
                │   Core API (NestJS)     │
                │  Gateway → Auth →       │
                │  Upload → Download →    │
                │        Metadata         │
                └────────────┬────────────┘
                             │
                       PostgreSQL
                             │
             ┌───────────────┼────────────────┐
             │                                │
           Redis                            Kafka
     (cache, locks,                  (invalidation, upload,
      rate limiting)                  replication events)
             │                                │
             ▼                                ▼
      Cache Service                  Replication Service
      (per edge node)                          │
             │                                 │
             └────────────────┬────────────────┘
                              │
                Edge-1 / Edge-2 / Edge-3
             (Compose containers, logical
                regions for now)
                              │
                       Origin Storage
                      (MinIO dev / S3 prod)
```

### Phase 5+: Microservices

```
                          Client
                             │
                             ▼
                   Nginx / API Gateway
                             │
      ┌────────┬────────────┼────────────┬───────────┐
      │         │            │            │           │
   Auth      Upload      Download     Metadata   Replication
      │         │            │            │           │
      └─────────┴─────────────┼────────────┴───────────┘
                              │
                 Consistent Hashing Ring
              (decides which edge(s) store
                     which files)
                              │
                CDN Routing Algorithm
           (region-based / latency-based / weighted)
                              │
             ┌────────────────┼─────────────────┐
             │                │                  │
          Edge-1            Edge-2             Edge-3
       (Region A,         (Region B,         (Region C,
        real EC2)          real EC2)          real EC2)
             │                │                  │
             └────────────────┴──────────────────┘
                              │
                      Origin Storage (S3)

Health Check Service: heartbeat every 10s per edge → dead-node detection
Monitoring: Prometheus → Grafana | Logs: Loki | Tracing: OpenTelemetry
```

---

## 6. Service Breakdown

### 6.1 API Gateway (Nginx)
Routes incoming requests, terminates SSL, does basic load balancing. Pure Nginx configuration, not a NestJS service.

### 6.2 Auth Module → Auth Service (splits off in Phase 5)
Issues and validates JWTs, handles refresh tokens, manages API keys.

### 6.3 Upload Module → Upload Service (splits off in Phase 5)
Handles chunked, resumable uploads. Responsibilities:
- Accept file chunks, track upload session state (which chunks received, which are missing)
- **Compress the assembled file** (gzip, optionally brotli) before writing to origin storage — configurable per content type, since some formats (already-compressed media) shouldn't be recompressed
- On completion, write to origin storage (MinIO/S3)
- Emit a `file.uploaded` event to Kafka

Resumability is the detail worth getting right: a client should be able to disconnect mid-upload and resume from the last successfully received chunk, not restart from zero.

### 6.4 Download Module → Download Service (splits off in Phase 5)
Handles signed URL generation and validation, range requests (partial content / video seeking), decompression on the way out if needed, and — from Phase 5 onward — routes the request through the CDN Routing Algorithm rather than a hardcoded "nearest edge" guess.

### 6.5 Metadata Module → Metadata Service (splits off in Phase 5)
Owns file metadata in PostgreSQL: filename, size, checksum, owner, upload timestamp, **current version**, replication status per edge node, cache status.

### 6.6 Cache Service (separate from Phase 0 — runs per edge node)
Owns the Redis-backed cache layer at each edge. Responsibilities:
- Serve cached content on hit
- On miss, fetch from origin, populate cache, apply eviction policy (LRU or TTL)
- Consume `cache.invalidate` events from Kafka and evict accordingly — including invalidation triggered by a new object version

### 6.7 Replication Module → Replication Service (splits off in Phase 5)
Consumes `file.uploaded` events and propagates content to edge nodes. Responsibilities:
- Use the **consistent hashing ring** to decide which edge(s) a file belongs on
- Track replication status per edge node (pending/in-progress/complete/failed) in Postgres
- Retry failed replications with backoff; push failed-after-retries jobs to a dead-letter queue

### 6.8 Health Check Service (new, introduced Phase 4)
- Each edge node sends a heartbeat every 10 seconds (simple endpoint ping or a Redis key with a matching TTL)
- Health Check Service tracks last-seen time per node; if a node misses N consecutive heartbeats, it's marked `degraded`, then `down`
- Dead/degraded nodes are automatically excluded from the CDN Routing Algorithm's candidate list and from the consistent hashing ring's active set — this is what actually makes "fault tolerance" real instead of a word in the README

### 6.9 Analytics Service
Independently consumes the Kafka topics (this is your "multiple independent consumers of one event stream" story) to aggregate bandwidth, popular files, cache hit ratio, region-wise traffic. Writes rollups to Postgres.

### 6.10 Notification Service (stretch)
Optional — notifies admins of replication failures, node health changes, or unusual traffic patterns.

---

## 7. Data Layer

### 7.1 PostgreSQL — Core Schema

```
users
  id, email, password_hash, api_key, role, created_at

files
  id, owner_id, filename, size_bytes, checksum, content_type,
  storage_path, current_version, is_compressed, compression_type,
  status (uploading/complete/failed), created_at

file_versions
  id, file_id, version_number, storage_path, checksum, size_bytes,
  created_at, superseded_at

file_chunks
  id, file_id, chunk_index, chunk_checksum, received_at

edge_nodes
  id, name, region, endpoint_url, hash_ring_position,
  status (healthy/degraded/down), last_heartbeat

replication_status
  id, file_id, edge_node_id, status (pending/in_progress/complete/failed),
  attempts, last_attempt_at, completed_at

cache_events
  id, edge_node_id, file_id, event_type (hit/miss/evict), created_at
```

### 7.2 Redis — Usage Patterns

| Use case | Redis structure |
|---|---|
| Cached file metadata | String/Hash, TTL set per eviction policy |
| LRU tracking | Sorted set, score = last-access timestamp |
| Distributed lock (prevent duplicate replication jobs) | `SET key value NX PX <ttl>` |
| Rate limiting | Sliding window via sorted set of timestamps per client |
| Idempotency (dedupe event processing) | `SETNX` on event ID, short TTL |
| Edge node heartbeat | `SET edge:{id}:heartbeat <ts> EX 15` — natural expiry doubles as dead-node signal |

### 7.3 Object Storage Layout

```
bucket/
  {user_id}/
    {file_id}/
      v1/
        original.{ext}.gz
      v2/
        original.{ext}.gz
      chunks/           (temporary, deleted after assembly)
        chunk-0
        chunk-1
        ...
```

---

## 8. Event-Driven Architecture (Kafka)

### 8.1 Topics & Event Schemas

**`file.uploaded`**
```json
{ "event_id": "uuid", "file_id": "uuid", "owner_id": "uuid", "size_bytes": 10485760, "checksum": "sha256...", "timestamp": "iso8601" }
```

**`file.version_created`**
```json
{ "event_id": "uuid", "file_id": "uuid", "version_number": 2, "checksum": "sha256...", "timestamp": "iso8601" }
```

**`cache.invalidate`**
```json
{ "event_id": "uuid", "file_id": "uuid", "reason": "updated | deleted | manual_purge", "timestamp": "iso8601" }
```

**`replication.status_changed`**
```json
{ "event_id": "uuid", "file_id": "uuid", "edge_node_id": "uuid", "status": "complete | failed", "attempts": 2, "timestamp": "iso8601" }
```

**`edge.health_changed`**
```json
{ "event_id": "uuid", "edge_node_id": "uuid", "status": "healthy | degraded | down", "timestamp": "iso8601" }
```

### 8.2 Consumer Groups
- `replication-service` consumes `file.uploaded` and `file.version_created`
- `cache-service` (one instance per edge node) consumes `cache.invalidate`
- `analytics-service` consumes all topics independently
- `routing-layer` consumes `edge.health_changed` to keep its candidate list current

### 8.3 Failure Handling
- Consumer processing failure → retry with exponential backoff (3 attempts)
- Still failing → publish to `{topic}.dlq` for manual review
- Be ready to answer: what happens if a consumer crashes mid-message — reprocessed (at-least-once) or lost? This should be a deliberate decision.

---

## 9. Caching Strategy

- **Eviction policy:** pick LRU or TTL-based, implement it correctly rather than half-implementing both.
- **Invalidation flow:** file updated/deleted at origin, or a new version created → `cache.invalidate` event → every edge node's Cache Service evicts the entry → next request is a cache miss that repopulates from the current version at origin.
- **Metrics to track:** hit ratio overall, hit ratio for "hot" vs "cold" files, how hit ratio changes as you tune TTL or cache size.

---

## 10. Compression

- Applied at upload time, before writing to origin storage: gzip by default, brotli optional for better ratios on text-heavy content
- Skip recompression for already-compressed formats (jpg, mp4, zip, etc.) — detect via content-type and skip the step, don't just compress everything blindly
- Decompress transparently on download unless the client explicitly requests the compressed form (`Accept-Encoding` handling)
- Worth measuring and reporting: average size reduction by content type — this is a concrete, easy benchmark

---

## 11. Object Versioning

- Every update to a file creates a new row in `file_versions` rather than overwriting the original
- `files.current_version` points to the active version; old versions remain retrievable (useful for rollback, and a nice thing to demo)
- On new version creation: emit `file.version_created` → triggers `cache.invalidate` for that file_id across all edges → next request is a guaranteed miss that repopulates with the new version
- Decide and document a retention policy (keep last N versions, or keep forever) — an unbounded version history is a realistic storage-cost problem worth acknowledging even if you don't solve it

---

## 12. Consistent Hashing — Edge Assignment

This answers the question an interviewer will ask almost immediately: **how do you decide which edge stores which file?**

- Build a hash ring: each edge node is hashed to one or more points on the ring (multiple virtual nodes per physical edge — typically 100–200 — for better load distribution)
- Each file is hashed (by `file_id`) to a point on the same ring; it's assigned to the first edge node found going clockwise from that point
- For replication factor > 1 (recommended: replicate to 2 edges minimum), assign to the next N distinct physical nodes clockwise from that point
- **Why this matters over a naive modulo/round-robin assignment:** when an edge node is added or removed, only the files whose ring position falls in that node's range need to move — not the entire dataset. This is the property you should be ready to explain precisely, with a concrete example ("if I remove Edge-2, only ~1/3 of files remap, not all of them").
- Implementation: either use an existing library (e.g. `hashring` on npm) or implement it yourself with a sorted-map/BST-like structure — implementing it yourself is more defensible in an interview if you can explain the trade-offs you hit.

---

## 13. CDN Routing Algorithm

This answers the second question an interviewer will ask: **once you know which edges have the file, how does a specific client get routed to one of them?**

Pick one as your primary implementation (don't build all three shallowly):

| Strategy | How it works | Trade-off |
|---|---|---|
| **Region-based** (recommended primary) | Client IP is geo-mapped to a coarse region tag; request routed to the edge tagged with the matching (or nearest) region | Simple, deterministic, easy to test and demo — doesn't account for real network conditions |
| **Latency-based** | Either active RTT probing from client to each candidate edge, or DNS-level latency routing (Route53) | More accurate, but needs either client-side probing logic or real DNS infrastructure — good Phase 6 stretch once region-based is solid |
| **Weighted** | Traffic split by configured percentage across edges regardless of geography | Useful for load balancing or canary-testing a new edge — worth mentioning as a variant even if not your primary strategy |

- The routing layer should only ever consider edges the Health Check Service currently reports as `healthy` — a routing algorithm that can route to a dead node isn't actually finished.
- Be ready to explain what happens when a client's "best" edge (by your chosen strategy) doesn't yet have the file replicated — do you fall back to origin, or to the next-best edge on the hash ring?

---

## 14. Replication & Multi-Region

- **Consistency model:** eventual consistency — a file becomes available at each assigned edge asynchronously after upload. Be explicit this was a choice, and be ready to explain the alternative (synchronous replication) and why you didn't pick it (latency cost on upload).
- **Replication flow:** `file.uploaded`/`file.version_created` event → Replication Service consults the consistent hashing ring for target edges → pushes to each → updates `replication_status` per node → emits `replication.status_changed`.
- **Real deployment:** Phase 6 moves edges from Compose containers to real EC2 instances in 2–3 actual regions, at which point routing-algorithm and replication-time numbers become real rather than simulated.

---

## 15. API Design (core endpoints)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Issue JWT + refresh token |
| POST | `/uploads` | Initiate upload session |
| PUT | `/uploads/{id}/chunk/{index}` | Upload a chunk |
| POST | `/uploads/{id}/complete` | Finalize upload, trigger assembly + compression |
| GET | `/files/{id}` | Get file metadata (current version) |
| PUT | `/files/{id}` | Upload a new version of an existing file |
| GET | `/files/{id}/versions` | List version history |
| GET | `/download/{id}` | Signed, range-request-capable download |
| DELETE | `/files/{id}` | Delete file, trigger cache invalidation |
| POST | `/purge` | CDN purge — force cache invalidation for a file across all edges |
| GET | `/admin/nodes` | Edge node health status |
| GET | `/admin/analytics` | Aggregated usage stats |

---

## 16. Real-Time Layer (WebSockets)

A dashboard socket namespace pushing, at minimum:
- Upload progress (per active upload, chunk-by-chunk)
- Download activity
- Cache hit/miss events as they happen
- **Replication progress** — per file, per edge, live status as it moves pending → in-progress → complete
- **Active edge nodes** — live list with health status
- **Kafka consumer lag** — per consumer group, so you can visually show the system falling behind under load and catching up
- **Replication queue depth** — how many jobs are pending/in-flight
- **Current bandwidth** — aggregate throughput being served, updated on an interval

This is the layer that makes the system feel alive in a demo — worth building out fully once the core pipeline is solid, since it's also one of the most interview-visual parts of the project.

---

## 17. Security

- JWT (short-lived) + refresh tokens (longer-lived, rotated on use)
- Password hashing via argon2 or bcrypt
- Signed URLs for downloads (time-limited, tied to file ID and version)
- API keys for programmatic/service-to-service upload access
- Rate limiting on all public endpoints (Redis sliding window)
- CORS configured explicitly, not wide open
- HTTPS via Nginx/Let's Encrypt in production

---

## 18. Observability & Monitoring

- **Prometheus** scrapes: request rate, latency percentiles (p50/p95/p99), cache hit ratio, edge node health, replication queue depth, consumer lag
- **Grafana** dashboards visualizing the above, plus a "system overview" board suitable for demoing
- **Loki + Promtail** for centralized log aggregation across all services
- **OpenTelemetry** for distributed tracing — at minimum, trace a request from Gateway → Metadata → Cache → Edge

---

## 19. CI/CD Pipeline (GitHub Actions)

```
Push → Run Tests → Build Docker Images → Push Images → Deploy → Health Check
```
Each stage should actually gate the next.

---

## 20. Testing & Load Testing Strategy

- **Unit tests** per module/service for core logic (chunk assembly, hash ring placement, cache eviction, event handlers)
- **Integration tests** for the full upload → replicate → cache → download flow, including a version-update-then-invalidate cycle
- **Load testing (k6 or autocannon)** at specific points: after caching (Phase 2), after replication + consistent hashing (Phase 4–5), after hardening (Phase 8) — simulate node add/remove during load and confirm the hash ring only remaps the expected fraction of files

---

## 21. Benchmarks to Publish in the README

Every one of these should be a real, measured number with the test conditions stated (file size, concurrency, region):

- **Cache hit latency** (p50/p95)
- **Cache miss latency** (p50/p95) — should clearly show the cost of the origin round-trip
- **Replication time** — seconds from upload complete to a file being available at each assigned edge
- **Uploads/sec** sustained under load test
- **Bandwidth served**, measured, aggregate and per-edge
- **Hash ring remap fraction** on node add/remove — e.g. "removing 1 of 3 edges remapped 31% of files, consistent with the ~1/3 theoretical expectation"

---

## 22. Full Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | NestJS + TypeScript |
| Database | PostgreSQL |
| Cache | Redis |
| Event streaming | Apache Kafka (single broker) |
| Object storage | MinIO (dev), Amazon S3 (prod) |
| Compression | gzip (default), brotli (optional) |
| Consistent hashing | `hashring` (npm) or custom ring implementation |
| Reverse proxy | Nginx |
| Containers | Docker, Docker Compose |
| Orchestration | Kubernetes (stretch phase) |
| CI/CD | GitHub Actions |
| Metrics | Prometheus |
| Dashboards | Grafana |
| Logs | Loki + Promtail |
| Tracing | OpenTelemetry + Jaeger/Tempo |
| Real-time | WebSockets (Socket.io via NestJS Gateway) |
| Auth | JWT, refresh tokens, argon2/bcrypt |
| Load testing | k6 or autocannon |
| Cloud infra | AWS EC2 (multi-region), Terraform (optional), Route53 (optional, latency routing) |

---

## 23. Phased Build Plan

| Phase | Focus | Est. duration |
|---|---|---|
| 0 | Repo, Docker Compose skeleton, CI pipeline, monolith app skeleton | 1–2 weeks |
| 1 | Core upload/download loop (monolith): resumable chunks, signed URLs, compression | 2–3 weeks |
| 2 | Real Redis caching, measured hit ratio, object versioning + invalidation | 2–3 weeks |
| 3 | Kafka event-driven invalidation, purge API | 2–3 weeks |
| 4 | Replication across (logical) edge nodes, Health Check Service, consistency model proven | 3–4 weeks |
| 5 | **Split monolith into microservices** + consistent hashing ring + CDN routing algorithm | 3–4 weeks |
| 6 | Real multi-region EC2 deployment, measured latency with real routing | 2–3 weeks |
| 7 | Observability: Prometheus, Grafana, Loki, tracing, full WebSocket dashboard | 2–3 weeks |
| 8 | Hardening: rate limiting, DLQ, retries, auth, admin APIs, benchmarks written up | 2–3 weeks |
| 9 (stretch) | Kubernetes | 3–4 weeks |

**Total: ~22–28 weeks at a steady solo pace.** Run phases sequentially — a finished Phase 5 beats a half-working Phase 5 and a half-working Phase 9 running at the same time.

---

## 24. Distributed Systems Concepts — What's Implemented Where

| Concept | Where it lives | Question to be ready for |
|---|---|---|
| Distributed caching | Cache Service, Redis | "What's your eviction policy and why?" |
| Event-driven architecture | Kafka topics across services | "What happens if a consumer crashes mid-message?" |
| Consistent hashing | Consistent hashing ring, Replication Service | "How much data moves when you add/remove a node, and why?" |
| CDN routing | Routing layer (region/latency/weighted) | "What happens if the 'best' edge doesn't have the file yet?" |
| Replication | Replication Service, edge nodes | "What's your consistency model, and what did you not pick?" |
| Cache invalidation | `cache.invalidate` event flow | "How do you avoid a stale read right after invalidation?" |
| Object versioning | `file_versions`, invalidation-on-new-version | "How do you handle a request mid-flight when a new version lands?" |
| Distributed locking | Redis `SET NX` for replication jobs | "How do you prevent two workers replicating the same file twice?" |
| Rate limiting | Redis sliding window | "What happens right at the boundary of the window?" |
| Dead-letter queue | Kafka `.dlq` topics | "How do failed jobs get reprocessed?" |
| Health checks | Heartbeat every 10s, K8s liveness (stretch) | "How do you detect a degraded, not fully down, node?" |
| Horizontal scaling | Multiple edge nodes, stateless services | "What state would break if you added a 4th edge right now?" |

---

## 25. Deployment Architecture

- **Development:** Docker Compose, single machine, monolith core + per-edge Cache Service containers
- **Production:** AWS EC2 instances in 2–3 real regions, each running the split microservices relevant to that edge (Cache Service + local Redis), Health Check Service pinging all of them
- **Origin:** S3, single region, source of truth for all content and versions
- **Stretch:** Kubernetes (EKS or self-managed) once EC2 deployment is proven

---

## 26. Appendix — Pitfalls to Avoid

- **Don't half-implement two eviction policies.** Pick one, make it correct, measure it.
- **Don't split into microservices before the monolith core actually works.** The split is a Phase 5 refactor of something proven, not a day-one architecture decision.
- **Don't fake the hash ring.** If you're doing naive modulo assignment instead of a real ring with virtual nodes, don't call it consistent hashing — it doesn't have the node-add/remove property that makes it worth mentioning.
- **Don't fake multi-region.** Say so honestly until Region A/B/C are real EC2 instances — the latency numbers only mean something once they're real.
- **Don't skip the "break it on purpose" step.** Killing a container, cutting a connection mid-upload, removing a node from the hash ring under load — that's what turns each phase into a defensible engineering claim.
- **Don't parallelize phases.** One finished phase is worth more than two unfinished ones.

---

*This document is the reference to build against. Update it as decisions change during the build — a spec that drifts from the actual system is worse than no spec at all.*
