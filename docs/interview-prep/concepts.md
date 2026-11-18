# Pravah: Complete Technology & Concepts Syllabus

A comprehensive, detailed breakdown of all technologies, core concepts, algorithms, and architectural patterns implemented in **Pravah**.

---

## 1. NestJS Framework & Node.js Core

### A. Core Architecture & Decorators
* **Decorators & Metadata Reflection**: Class decorators (`@Controller`, `@Injectable`, `@Module`), Method decorators (`@Get`, `@Post`, `@Put`, `@Delete`), Parameter decorators (`@Param`, `@Query`, `@Body`, `@Headers`), and custom parameter decorators. How `reflect-metadata` attaches metadata at design time.
* **Dependency Injection (DI) & Inversion of Control (IoC)**: 
  * The IoC container lifecycle.
  * Injection tokens, constructor injection, and `@Inject()`.
  * **Provider Scopes**: `DEFAULT` (Singleton), `REQUEST` (created per incoming request), and `TRANSIENT` (new instance per injection).
  * Circular dependency resolution using `forwardRef()`.

### B. Request Lifecycle Pipeline
* **Middlewares**: Function-based vs class-based middlewares, execution before route handlers, request logging, and CORS headers.
* **Guards (`CanActivate`)**: Execution context inspection (`ExecutionContext`), extracting HTTP/WebSocket requests, reflector metadata checks (`Reflector.get()`), and returning boolean or throwing `UnauthorizedException` / `ForbiddenException`.
* **Pipes & Input Transformation (`PipeTransform`)**: 
  * `ValidationPipe` mechanics.
  * Data Transfer Objects (DTOs) with `class-validator` and `class-transformer`.
  * `whitelist: true` (stripping unknown properties), `forbidNonWhitelisted: true` (rejecting malicious fields), and automatic type coercion (`transform: true`).
* **Interceptors (`NestInterceptor`)**: Aspect-Oriented Programming (AOP), handling the RxJS `CallHandler` stream, response mapping, logging request/response latency, and global error handling.
* **Exception Filters (`ExceptionFilter`)**: Catching `HttpException`, standardizing API error responses (HTTP status, error message, timestamp, path).

### C. Advanced Protocols & Adapters
* **Express Adapter vs Fastify Adapter**: Differences in internal event loops, JSON serialization speeds (`fast-json-stringify` in Fastify), and why Fastify is used for high-throughput edge nodes.
* **Microservices Engine (`@nestjs/microservices`)**: Transport layers, Kafka microservice strategy, message pattern handlers (`@MessagePattern`), and event pattern handlers (`@EventPattern`).
* **WebSocket Gateways (`@WebSocketGateway`)**: Socket.IO integration, namespace/room isolation, client handshake authentication, and event broadcasting.

---

## 2. TypeScript & Advanced JavaScript Runtime

* **Type System**: Strict mode, `type` vs `interface`, Generics, Union and Intersection types, Discriminated unions, and Template Literal Types (`${number}m | ${number}h`).
* **Node.js Concurrency Model**: The Event Loop (Call Stack, Node APIs, Microtask Queue vs Macrotask Queue, `process.nextTick`, `setImmediate`), and `libuv` thread pool for file I/O and cryptographic operations.
* **Streams and Buffers**: Memory-efficient data handling, `Readable` and `Writable` streams, stream backpressure, chunked piping, and `Buffer` allocations.
* **Node.js Native Crypto**:
  * `crypto.createHash` (SHA-256 for integrity and checksums).
  * `crypto.createHmac` (HMAC-SHA256 for payload signing).
  * `crypto.timingSafeEqual` (preventing side-channel timing attacks).
  * `crypto.randomBytes` (cryptographically secure pseudorandom token generation).

---

## 3. PostgreSQL & Prisma ORM

### A. Database Design & Relational Modeling
* **Entity Relationships**: One-to-One, One-to-Many, and Many-to-Many relations.
* **Referential Integrity**: Primary Keys, Foreign Keys, cascading deletions (`onDelete: Cascade`), and `SET NULL` behaviors.
* **Constraints**: Unique constraints, composite unique constraints (e.g., `@@unique([fileId, chunkIndex])` to prevent duplicate chunk slots).
* **Indexing Mechanics**: 
  * B-Tree index structures.
  * Single-column vs Composite Indexes.
  * Trade-offs: Fast lookup queries (`SELECT`) vs write amplification overhead (`INSERT`/`UPDATE`).

### B. Transactions & Concurrency
* **ACID Guarantees**: Atomicity, Consistency, Isolation, Durability.
* **Transaction Isolation Levels**: Read Uncommitted, Read Committed, Repeatable Read, and Serializable (understanding Dirty Reads, Non-repeatable Reads, and Phantom Reads).
* **Pessimistic vs Optimistic Concurrency Control**:
  * Pessimistic: `SELECT ... FOR UPDATE` (row-level locking).
  * Optimistic: Conditional state updates (e.g., updating only if status is `PENDING`, returning 0 rows / 409 Conflict if another worker claimed it first).
* **Connection Pooling**: Managing database client connections, pool exhaustion, and connection timeouts.

### C. Prisma ORM Architecture
* **Schema Definition (`schema.prisma`)**: Models, fields, relations, attributes (`@id`, `@unique`, `@default`, `@relation`).
* **Prisma Migrations**: Declarative schema versioning (`prisma migrate dev`, `prisma migrate deploy`), migration history tracking.
* **Prisma Client**: Typed query generation, nested writes, relation inclusion (`include`), and transactional batches (`prisma.$transaction`).

---

## 4. Redis (In-Memory State, Caching & Mutex)

### A. Memory Architecture & Data Types
* **In-Memory Storage**: RAM-based data persistence (RDB snapshots vs AOF append-only logs).
* **Data Structures**:
  * **Strings**: Simple key-values and raw binary buffers (caching small files in RAM).
  * **Hashes (`HSET`, `HGET`)**: Storing object metadata.
  * **Sets (`SADD`, `SMEMBERS`)**: Storing unique collections without duplicates.
  * **Sorted Sets (`ZSET` with scores)**: Using timestamps as scores for Least-Recently-Used (LRU) cache ordering.

### B. Cache Strategies & Pitfalls
* **Cache Lifecycle**: TTL (Time-To-Live), `EXPIRE`, passive expiration vs active eviction.
* **Cache Invalidation Patterns**: Cache-Aside (Lazy Loading), Write-Through, and explicit cache purging.
* **Cache Anomalies**:
  * **Cache Stampede / Thundering Herd**: Thousands of requests hitting the database simultaneously when a hot key expires.
  * **Cache Breakdown / Penetration / Avalanche**: Strategies to prevent system crashes during cache misses.

### C. Distributed Locking & Lua Scripting
* **Distributed Mutex (Locks)**: Atomic acquisition using `SET lock_key uuid NX PX milliseconds`.
* **Safe Lock Release**: Verifying the unique UUID before releasing to prevent process A from releasing process B's expired lock.
* **Lua Scripting (`EVAL` / `EVALSHA`)**: Executing multi-step logic (e.g., "check lock owner, if valid delete, else return 0") atomically inside the Redis engine without client-server network roundtrips.

---

## 5. Apache Kafka / Redpanda (Distributed Event Streaming)

### A. Architecture & Event-Driven Patterns
* **Distributed Commit Log**: Immutable append-only log structure.
* **Topics & Partitions**: 
  * Partitioning keys and hashing algorithms.
  * Strict message ordering guarantees *within a single partition*.
  * Parallelism through partition scaling.
* **Producers**: Message dispatching, acknowledgment levels (`acks=0`, `acks=1`, `acks=all`), and message serialization.
* **Consumers & Consumer Groups**:
  * Consumer group coordinator and partition rebalancing.
  * Offset tracking: Committed offsets vs current offsets.
  * Consumer lag monitoring.
* **Message Delivery Semantics**: At-most-once, At-least-once, and Exactly-once semantics.

### B. Broker Security & Governance
* **Kafka SASL Authentication**: 
  * Mechanisms: PLAIN vs SCRAM-SHA-256 / SCRAM-SHA-512.
  * Salted Challenge Response Authentication Mechanism (SCRAM) handshake without plaintext password exposure.
* **Topic ACLs (Access Control Lists)**: Restricting Core and Edge nodes to specific operations (`READ`, `WRITE`, `DESCRIBE`) on specific topics (`file.uploaded`, `cache.invalidate`).

---

## 6. BullMQ (Distributed Asynchronous Job Queues)

* **Job Queue vs Event Broker**: Task execution with retries and state vs immutable pub/sub event logs.
* **Job Lifecycle**: `waiting` $\rightarrow$ `active` $\rightarrow$ `completed` / `failed` / `delayed`.
* **Queue Components**: Producers (enqueuing jobs), Workers (processing jobs), and QueueEvents (monitoring completion).
* **Resilience & Backoff**: Fixed backoff, Exponential Backoff with jitter, retry attempt limits.
* **Dead-Letter Queue (DLQ)**: Isolating failed jobs after retry exhaustion, capturing error stack traces, and implementing admin manual replay APIs.
* **Queue Partitioning (Sharding)**: Creating isolated queues per edge node (`pravah:replication:edge-node-*`) to eliminate cross-worker lock contention on Redis.

---

## 7. MinIO / S3 (Distributed Object Storage)

* **Object Storage Concepts**: Flat namespace (no real folders), Buckets, Objects, and Keys.
* **S3 Multipart Upload Protocol**:
  1. `CreateMultipartUpload` $\rightarrow$ Get upload ID.
  2. `UploadPart` $\rightarrow$ Upload individual chunks with part numbers.
  3. `UploadPartCopy` $\rightarrow$ Instruct the storage engine to stitch chunks server-side without streaming bytes through Node.js RAM.
  4. `CompleteMultipartUpload` $\rightarrow$ Finalize assembly with Part ETags.
* **Presigned URLs**: Generating cryptographically signed, time-limited URLs for direct client uploads/downloads.
* **Consistency Model**: Read-after-write consistency for PUTs and DELETEs.

---

## 8. Distributed Systems Architecture & Algorithms

### A. Consistent Hashing & Placement
* **Modulo Hashing Limitations**: Why $hash(key) \pmod N$ causes complete cache invalidation when nodes are added or removed.
* **Consistent Hash Ring**: The $[0, 2^{32} - 1]$ circular key space.
* **Virtual Nodes (VNodes)**: Mapping multiple virtual positions (e.g., 100 vnodes) to one physical server to ensure uniform load distribution and eliminate hot spots.
* **Replica Selection**: Walking the ring clockwise to pick $K$ unique physical nodes for replication.

### B. Geo-Aware Proximity Routing
* **Haversine Formula**: Calculating the great-circle distance between two sets of spherical latitude/longitude coordinates:
  $$d = 2r \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)}\right)$$
* **Routing Decisions**: Nearest-neighbor selection, regional matching, and health-filtered candidate lists.

### C. Hierarchical (Tiered) Caching
* **L1 Memory Cache**: Ultra-low latency Fastify memory cache (< 2 MB files).
* **L2 Local Disk Cache**: Fast NVMe/SSD storage for large files ($\ge$ 2 MB).
* **L3 Peer-Assisted Cache**: Querying peer edge nodes over local networks before falling back to the origin.
* **Origin Fallback**: Pulling from MinIO/S3 only on complete tier misses.

### D. Node Health & Heartbeats
* **Heartbeat Mechanism**: Periodic edge pinging vs continuous origin polling.
* **TTL-Driven State Detection**: Using Redis key expiration rather than clock comparisons to detect dead nodes.
* **Health State Machine**: `HEALTHY` $\rightarrow$ `DEGRADED` (1 miss) $\rightarrow$ `DOWN` (3 misses) $\rightarrow$ automated failover and replica re-placement.

---

## 9. Cybersecurity, Cryptography & Application Hardening

### A. Authentication Architecture (Tri-Mode)
* **JWT (JSON Web Tokens)**: Header, Payload, Signature. Stateless verification, expiration (`exp`), and subject (`sub`).
* **Refresh Token Rotation (RTR)**:
  * Token Families and Unique Token IDs (`jti`).
  * Automatic family revocation upon reuse (Theft Detection).
* **API Key Infrastructure**: Key prefix for fast database lookup, SHA-256 key hashing for storage, and constant-time comparison (`crypto.timingSafeEqual`) to defeat timing attacks.
* **HMAC (Hash-based Message Authentication Code)**:
  * Creating signatures: $\text{HMAC-SHA256}(\text{Secret}, \text{CanonicalRequest})$.
  * Canonical request string: $\text{Method} + \text{Path} + \text{Timestamp} + \text{BodyHash}$.
  * Replay attack prevention using a strict clock-drift validation window ($\pm 5$ minutes).

### B. Authorization & Access Control
* **Hierarchical Role-Based Access Control (RBAC)**: Role inheritance (`ADMIN` $\rightarrow$ `STREAMER` $\rightarrow$ `VIEWER` $\rightarrow$ `USER`).
* **Machine Role Isolation**: `Role.INTERNAL` reserved exclusively for authenticated service-to-service calls.
* **Resource Ownership**: Enforcing that users can only access their own files unless they have the `ADMIN` role.

### C. Defensive Hardening & OWASP
* **Distributed Rate Limiting**: Token-Bucket / Leaky-Bucket algorithms implemented via Redis to prevent DDoS and brute-force attacks.
* **Path Traversal Guards**: Using `path.resolve` with directory boundary containment checks and strict filename/ID regex allow-lists.
* **Cross-Site Scripting (XSS) & CSP**: Content Security Policy HTTP headers, avoiding `eval()`, and escaping output.

---

## 10. Media Engineering & Adaptive Video Streaming (HLS)

### A. Digital Video Fundamentals
* **Containers vs Codecs**: MP4 / MPEG-TS containers vs H.264 (AVC) video codecs and AAC audio codecs.
* **Video Metrics**: Resolution (dimensions), Framerate (FPS), Bitrate (kbps), and Aspect Ratio.

### B. Transcoding Pipeline (FFmpeg / FFprobe)
* **Media Inspection (`ffprobe`)**: Probing input files for streams, durations, and dimensions.
* **Transcoding Ladder**: Generating multiple resolution profiles (1080p, 720p, 480p, 360p, 240p, 144p) without upscaling lower-resolution originals.
* **Segmentation**: Chopping continuous video into discrete 4-second `.ts` transport stream chunks.

### C. HLS Protocol (RFC 8216) & Media Security
* **Master Playlist (`master.m3u8`)**: Declaring bandwidth variants, codecs, and resolution rungs using `#EXT-X-STREAM-INF`.
* **Media Playlist (`index.m3u8`)**: Declaring segment duration and chunk URLs using `#EXTINF`.
* **Adaptive Bitrate Streaming (ABR)**: Client-side video players dynamically switching quality rungs based on network throughput.
* **Dynamic HMAC Segment Signing**: On-the-fly rewriting of `.m3u8` playlists to inject time-expiring HMAC query tokens into `.ts` URLs, preventing hotlinking and piracy.

---

## 11. DevOps, Infrastructure & Observability

### A. Containerization (Docker & Compose)
* **Multi-Stage Builds**: Builder container (compiling TypeScript) vs Runner container (minimal production Alpine image).
* **Docker Networking**: User-defined bridge networks (`pravah-net`), container DNS resolution, and port binding vs port publishing.
* **Docker Volumes**: Named volume persistence and read-only host bind mounts.

### B. Infrastructure as Code (Terraform)
* **Terraform Core**: Providers, State files (`terraform.tfstate`), Variables, Outputs, and Modules.
* **Multi-Region Deployments**: Multi-region AWS topologies (EC2, VPCs, Security Groups).
* **HCL Syntax**: Variable interpolations and escaping bash syntax (`$${...}`) inside `templatefile()` scripts.

### C. Kubernetes (K8s) Architecture
* **Workloads**: Deployments (stateless apps), StatefulSets (databases/Kafka with persistent volume claims), Services (ClusterIP), and Ingress.
* **Autoscaling**: Horizontal Pod Autoscalers (HPA) using CPU/Memory metrics.
* **Secret Management**: External Secrets Operator syncing secrets from AWS Secrets Manager into Kubernetes native secrets.

### D. Observability (OpenTelemetry & PLG Stack)
* **Distributed Tracing (OpenTelemetry + Jaeger)**: Trace IDs, Span IDs, parent-child spans, W3C `traceparent` context propagation across HTTP/Kafka boundaries, and OTLP exporters.
* **Metrics (Prometheus)**: Pull-based scraping model, `/metrics` endpoint, Counter, Gauge, and Histogram metrics.
* **Logging (Grafana Loki & Promtail)**: Log shippers reading container stdout via Docker sockets, labels, and LogQL queries.
* **Dashboards (Grafana)**: Unified visualization querying Prometheus and Loki datasources.
