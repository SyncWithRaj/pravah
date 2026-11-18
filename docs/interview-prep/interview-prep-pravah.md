# Pravah CDN — Interview Preparation (Fresher)

Grounded in the actual code. Answers are written the way you should **say** them, not the way a textbook writes them.

---

## 0. First: how to present the project

### 30-second version (memorise this)

> "Pravah is a distributed CDN for video and static files. I built a NestJS **core control plane** that handles auth, resumable uploads, transcoding, metadata and replication scheduling, and a separate **edge node service** that serves content from a local Redis + disk cache. It uses PostgreSQL with Prisma for metadata, MinIO for object storage, Redis for caching and heartbeats, Kafka for events, and BullMQ for background jobs. On upload, the file is chunked, checksum-verified, assembled in MinIO, transcoded to HLS, and replicated to three edge nodes using consistent hashing. Downloads are geo-routed to the nearest healthy edge with a signed URL."

### 2-minute version — add these four points

1. **Two planes:** control plane (core) and data plane (edge). Core decides *where*; edge serves *what*.
2. **Failure handling:** edge health is tracked with Redis TTL heartbeats, replication failures go to a DLQ with retries, and the hash ring re-places replicas when a node dies.
3. **Security:** three auth modes — JWT for users, hashed API keys for machines, HMAC for service-to-service.
4. **Ops:** everything runs in Docker Compose locally; Kubernetes and Terraform (AWS) are the production path; Prometheus, Grafana, Loki and Jaeger for observability.

### If they ask "draw the architecture"

```
Client ──► Core :3000 ──► PostgreSQL (metadata)
   │            │──────► MinIO (origin objects)
   │            │──────► Redis (cache, heartbeats, rate limits)
   │            │──────► Kafka (file.uploaded, cache.invalidate)
   │            └──────► BullMQ (transcoding, replication)
   │
   └──302──► Edge :3001 ──► Redis + local disk cache
                             └── miss ──► peer edge ──► MinIO
```

---

## 1. Opening project questions (asked in ~every interview)

**Q1. Tell me about your project.**
Use the 30-second version. Then stop. Let them ask. Do not monologue for five minutes.

**Q2. What problem does it solve? Why a CDN?**
> "Serving large media from a single origin doesn't scale — every user pays the full network distance, and the origin becomes a bottleneck. A CDN puts copies near users, so latency drops and origin load falls. I also needed resumable uploads because multi-gigabyte uploads fail on flaky connections, and transcoding because one video must play on many devices and bandwidths."

**Q3. Why did you split core and edge instead of one service?**
> "They have different scaling and failure profiles. Core is stateful and low-throughput — one wrong write corrupts metadata. Edge is stateless-ish, read-heavy, and must run in many regions. Splitting means I can scale edges horizontally to hundreds of nodes without scaling the database, and an edge outage doesn't stop uploads or auth."

**Q4. Walk me through the upload flow.**
> "Client calls `POST /upload/init` with name, size and chunk count. Core creates a `File` row in `PENDING` and one `FileChunk` row per chunk. The client then sends each chunk to `PUT /upload/:fileId/chunk/:index`. The server recomputes SHA-256 and compares it with the client's checksum before storing the chunk in MinIO; mismatches are rejected. When all chunks are `VERIFIED`, the client calls `POST /upload/complete`. Core atomically claims the file by updating status from `PENDING`/`UPLOADING` to `ASSEMBLING` using `updateMany`, so two concurrent completes can't both proceed. It then assembles the chunks server-side using S3 multipart copy, creates a `FileVersion`, points `currentVersionId` at it, emits `file.uploaded` to Kafka, and queues transcoding."

**Follow-up: why not upload the whole file in one request?**
> "Three reasons: browsers and proxies have body-size limits, a failed 2 GB upload means starting over, and chunking lets me verify integrity per piece instead of trusting one giant checksum at the end."

**Q5. Walk me through the download/playback flow.**
> "The client requests a version from core. Core asks the routing service for the nearest healthy edge — exact region match first, otherwise Haversine distance. If an edge is available, core returns a 302 to the edge with a short-lived HMAC-signed URL. The edge checks its cache: metadata in Redis, small objects in Redis, large objects on local disk. On a miss it takes a Redis lock, tries up to three peer replicas, then falls back to MinIO through core. It caches the object and serves it."

**Q6. What was the hardest part?**
Pick one and be specific. Good answer:
> "Making upload completion safe under concurrency. My first version read the file status, checked it, then updated it — a classic check-then-act race. Two requests could both see `UPLOADING` and both assemble the file, creating duplicate versions. I fixed it with a conditional `updateMany` that only succeeds if the status is still `PENDING` or `UPLOADING`, and treats `count === 0` as a conflict. That taught me to push state transitions into the database instead of doing them in application code."

**Q7. What would you change if you rebuilt it?**
Say something honest but not self-destructive:
> "I'd add an outbox table for Kafka events. Right now the event is emitted after the database commit, so if the process crashes in between, replication never happens. An outbox with a relay worker would make that atomic. I'd also add integration tests that run against real Postgres, Redis and MinIO instead of mocked clients."

---

## 2. NestJS and backend fundamentals

**Q8. What is NestJS, and why did you use it over Express?**
> "Nest is a structured framework on top of Express. It gives me modules, dependency injection, guards, pipes and interceptors out of the box. With Express I'd hand-wire routing and middleware; with Nest, auth is a guard, validation is a pipe, and each domain is a module with explicit dependencies. For a project this size, the structure prevented circular imports and made testing easier."

**Q9. Explain modules, providers and dependency injection.**
> "A module groups related controllers and providers. A provider is a class Nest instantiates and injects via the constructor. `@Injectable()` marks it as injectable. DI means I depend on abstractions and let the container resolve them — in tests I can swap `PrismaService` for a mock without changing the service."

**Q10. What is the difference between a guard, an interceptor, a pipe and a middleware?**
- **Middleware** — raw request/response, runs before the route handler, no access to the handler's return value.
- **Guard** — decides whether the request may proceed (`canActivate`). Used for auth and rate limiting.
- **Pipe** — transforms or validates input (`ValidationPipe`, `ParseIntPipe`).
- **Interceptor** — wraps the handler; can transform the response, measure time, or catch errors.
- **Exception filter** — converts thrown exceptions into HTTP responses.

**Q11. How does validation work in your app?**
> "I use `class-validator` decorators on DTOs and a global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`. Whitelist strips unknown properties; forbidNonWhitelisted rejects them with 400. That closed a mass-assignment hole — earlier a client could send `role: ADMIN` at registration and it would be written."

**Q12. What is `APP_GUARD`?**
> "It registers a guard globally through the DI container instead of applying `@UseGuards()` on every controller. I use it for the rate limiter so no route can accidentally skip it."

**Q13. How do you handle errors?**
> "Domain errors are Nest HTTP exceptions — `NotFoundException`, `ForbiddenException`, `ConflictException` — so the status code is correct by construction. Unexpected errors bubble to the default filter, which returns 500 without leaking internals. One rule I follow: never return a stack trace or a database message to the client."

---

## 3. Database and Prisma

**Q14. Why PostgreSQL? Why not MongoDB?**
> "The data is highly relational: users own files, files have versions, versions have transcodes, replication is a many-to-many between files and edges with status. That's a natural fit for foreign keys and joins. I also need transactional state transitions for uploads — a document store makes those harder to guarantee. Postgres also gives me `BigInt` for file sizes and partial indexes if I need them."

**Q15. Why UUIDs instead of auto-increment IDs?**
> "Two reasons. First, IDs are exposed in URLs and API responses, so sequential integers leak volume and allow enumeration. Second, with multiple services and future sharding, a UUID can be generated client-side or service-side without a central sequence. The trade-off is index size — UUIDs are wider and less cache-friendly than integers."

**Q16. Why `BigInt` for size?**
> "A 32-bit int caps at about 2.1 GB. Video files exceed that. JavaScript numbers lose precision above 2^53, so Prisma maps `BigInt` to `bigint` and I convert to `Number` only when I know the value is safe or when serialising for JSON."

**Q17. Which indexes did you add and why?**
> "`file_chunks` has a unique composite on `(fileId, chunkIndex)` — that enforces one slot per chunk and makes the upload lookup O(log n). `files` has an index on `ownerId` because every listing query filters by owner, and one on `status` for cleanup queries. `replication_status` has `(fileId, edgeNodeId)` unique plus indexes on `status` and `isDeadLetter` for the DLQ screens."

**Follow-up: what index is missing?**
Say it — it shows maturity:
> "`files` is queried by `ownerId` and sorted by `createdAt`. Separate indexes mean Postgres filters then sorts. A composite `(ownerId, createdAt)` would serve both in one index scan."

**Q18. What is a transaction? Where did you use one?**
> "A transaction groups statements so they all commit or all roll back. I use one in `initVersionUpload`: deleting old chunk rows, updating the file, and recreating chunk slots must not partially apply. Prisma's `$transaction` gives me an interactive transaction with a scoped client."

**Q19. What is a race condition? Give an example from your code.**
> "Two operations interleave and the result depends on timing. Upload completion was the example: both requests read `UPLOADING`, both pass the check, both assemble. I made the transition conditional — `updateMany({ where: { id, status: { in: [PENDING, UPLOADING] } }, data: { status: ASSEMBLING } })`. Only one gets `count === 1`; the other gets `count === 0` and a 409. The database row is the lock."

**Q20. Optimistic vs pessimistic locking?**
> "Optimistic assumes conflicts are rare: read a version, write only if the version still matches. Pessimistic locks the row up front with `SELECT ... FOR UPDATE`. I used optimistic, because upload completion is rare and I didn't want to hold a row lock across a multi-second MinIO assembly."

**Q21. What is N+1 and did you hit it?**
> "It's issuing one query per item in a list instead of one query for the list. Prisma's `include` solves most cases by joining. I did find one in failover: it loops over files and runs a separate `replicationStatus.findMany` per file. That should be a single `findMany` with `fileId: { in: ids }`."

---

## 4. Redis

**Q22. What do you use Redis for?**
Five distinct jobs:
1. **Cache** — file metadata, small binaries, HLS playlists.
2. **Heartbeats** — `edge:{id}:heartbeat` with a 15-second TTL.
3. **Rate limiting** — `INCR` on a per-route, per-IP key.
4. **Refresh-token state** — `jti` keys and token families.
5. **Queue backing store** — BullMQ.

**Q23. Why Redis and not just Postgres?**
> "These are high-frequency, short-lived, and tolerate loss. A heartbeat write every 10 seconds per edge shouldn't hit the primary database. Redis gives sub-millisecond reads and native TTL, so expiry is automatic instead of a cron job."

**Q24. How does the heartbeat mechanism work?**
> "Each edge sends a heartbeat every 10 seconds. Core writes a Redis key with a 15-second TTL. A scanner runs every 5 seconds: if the key exists, the node is healthy; after one miss it becomes `DEGRADED`; after three consecutive misses it becomes `DOWN`, which removes it from routing and the hash ring. If it comes back, the key reappears and it's restored to `HEALTHY`."

**Q25. Why a TTL instead of storing a timestamp and comparing?**
> "With a TTL, absence *is* the signal. I don't need a cleanup job or a query that scans for stale timestamps. Redis expires the key for me."

**Q26. What is a cache stampede? How did you handle it?**
> "Many requests miss the same key simultaneously and all hit the origin. I use a per-version lock: `SET lock:stampede:{fileId}:v{version} <uuid> PX 10000 NX`. One request wins and fetches; the others wait for the cache to populate. The release uses a Lua compare-and-delete so a slow request can't delete a lock owned by someone else."

**Follow-up: why not just `DEL` the lock?**
> "Because the lock has a 10-second TTL. If my fetch takes 11 seconds, the lock expires and another request acquires it. A plain `DEL` would then delete *their* lock. Comparing the value first makes release safe."

**Q27. Why is `INCR` + `EXPIRE` a problem?**
> "They're two commands. If the process dies between them, the key never expires and that client is rate-limited forever. The fix is a Lua script that does both atomically, or `SET key 0 EX ttl NX` before `INCR`."

**Q28. How does your rate limiter work?**
> "A global guard reads `@Throttle(limit, ttl)` metadata from the handler or controller, defaults to 120 requests per 60 seconds, and increments `ratelimit:{route}:{ip}` in Redis. If the count exceeds the limit it throws 429. If Redis is down it falls back to an in-memory `Map`, so availability wins over strictness."

**Q29. Redis vs Memcached?**
> "Memcached is a pure cache: simple, multi-threaded, no persistence. Redis has data structures, TTL, pub/sub, Lua, persistence and clustering. I needed sets for token families, sorted sets for LRU, and TTL — so Redis."

---

## 5. Kafka and event-driven design

**Q30. Why Kafka? Why not just call the edge with HTTP?**
> "Decoupling and durability. Upload completion shouldn't block on replicating to three edges. Kafka lets core publish `file.uploaded` once and any number of consumers react. It also buffers: if an edge is down, the event waits instead of failing the upload. Direct HTTP would make the upload path depend on every edge being healthy."

**Q31. Explain topics, partitions and consumer groups.**
> "A topic is a named log. It's split into partitions, and ordering is guaranteed only within a partition. A consumer group is a set of consumers that split partitions between them — each partition is read by exactly one consumer in the group. Different groups each get the full stream."

**Q32. At-least-once vs exactly-once?**
> "Kafka gives at-least-once by default: a consumer can process a message and crash before committing its offset, so it sees it again. Exactly-once needs transactions or idempotent consumers. I design consumers to be idempotent — replication upserts on `(fileId, edgeNodeId)`, so replaying the same event doesn't create duplicates."

**Q33. What happens if Kafka is down?**
Be honest:
> "Today, publishes are fire-and-forget. If Kafka is unavailable, the event is lost, and replication or cache invalidation silently doesn't happen. The correct fix is a transactional outbox: write the event to a Postgres table in the same transaction as the state change, then have a relay worker publish and mark it sent. That's the first thing I'd add."

**Q34. What is a DLQ? How does yours work?**
> "Dead Letter Queue. A job that fails repeatedly is moved aside instead of retried forever. Mine retries three times with exponential backoff, then records the failure with the error and a payload snapshot in Postgres and marks it dead-letter. An admin can inspect, replay one, or replay all. Replay resets the row and re-enqueues it."

**Q35. How do you ensure ordering?**
> "Kafka preserves order within a partition. If order matters for a file, the partition key should be `fileId`, so all events for that file land in the same partition. My replication jobs are keyed per file and per edge, and the database upsert makes out-of-order duplicates harmless."

---

## 6. Upload pipeline deep dive

**Q36. How do you make uploads resumable?**
> "The server keeps one `FileChunk` row per index with a status. The client can query `GET /upload/status/:fileId` and gets the list of `VERIFIED` indices. It re-sends only the missing ones. Nothing is stored in the client except the `fileId`."

**Q37. How do you verify integrity?**
> "Each chunk has a client-supplied SHA-256. The server recomputes it and compares with a constant-time-safe string compare before writing. A mismatch returns 400 and the chunk stays unverified. On completion the server also has the full-file checksum from init."

**Q38. Why assemble on the server with multipart copy?**
> "Concatenating multi-gigabyte chunks in Node means loading them into memory or writing a giant temp file. S3 multipart copy tells MinIO to stitch objects server-side on disk. Node only orchestrates — memory stays flat."

**Q39. What if the same chunk is uploaded twice?**
> "The unique constraint on `(fileId, chunkIndex)` means there's only one slot. The second write overwrites the object and updates the row. I guard the counter with `isNewVerification` so `uploadedChunks` only increments when the chunk wasn't already `VERIFIED`. Otherwise retries inflate the counter."

**Q40. What happens if the client disappears mid-upload?**
> "The file stays `UPLOADING` with chunks in MinIO. There's no reaper yet — that's a gap. I'd add a scheduled job that marks sessions older than N hours as `FAILED` and deletes their chunk objects."

---

## 7. CDN, caching and consistent hashing

**Q41. Explain consistent hashing.**
> "Map each node to many points on a 32-bit ring using a hash. To find where a key belongs, hash the key and walk clockwise to the first node. Adding or removing a node only moves the keys between it and its predecessor — roughly `1/N` of keys, not all of them. Virtual nodes (I use 100 per physical node) smooth the distribution and prevent hotspots."

**Q42. Why 100 virtual nodes? Why not 1?**
> "With one point per node the ring is lumpy — one node can own 60% of the keyspace by luck. More virtual nodes approximate a uniform distribution. The trade-off is memory and lookup time. 100–200 is the usual sweet spot."

**Q43. Why replication factor 3?**
> "It tolerates two simultaneous edge failures while still serving. One replica means any failure is an outage; two means you can't lose one during a repair. Three is the standard balance between durability and storage cost."

**Q44. What is Haversine and why use it?**
> "It computes great-circle distance between two lat/long points on a sphere: `2R·asin(√(sin²(Δφ/2) + cosφ₁·cosφ₂·sin²(Δλ/2)))`. I use it to pick the nearest edge when no node exists in the client's exact region. It's accurate enough for routing and far cheaper than a routing-service call."

**Q45. Cache invalidation — how?**
> "On a new version, core emits `cache.invalidate`. The cache manager deletes the local keys and the edge purge endpoint clears that file's keys. In the edge cache, each file has a set `file:{id}:keys` so I can find every version's keys without a scan."

**Follow-up: is it reliable?** Be honest:
> "Not fully. The edge Kafka client is producer-only, so edges don't consume the invalidate event today — purge has to be called explicitly. That's a gap I'd close with a consumer group per edge."

**Q46. What is an ETag and how did you use it?**
> "A validator for a resource — usually a hash of the content. The client sends `If-None-Match`; if it matches, I return `304 Not Modified` with no body, saving bandwidth. I derive it from the version checksum."

**Q47. How do range requests work?**
> "The client sends `Range: bytes=start-end`. The server returns `206 Partial Content` with `Content-Range` and only those bytes. Video players use it to seek without downloading the whole file. My implementation handles the common `start-end` form; suffix ranges like `bytes=-500` aren't handled yet."

**Q48. Why a 302 redirect instead of proxying through core?**
> "Proxying doubles the bandwidth — core downloads from MinIO and re-uploads to the client. A redirect lets the client fetch directly from the edge, so core only makes the routing decision. The cost is that the edge URL must be trusted, which is why it's HMAC-signed and expires in 120 seconds."

---

## 8. Security

**Q49. JWT vs session cookies?**
> "JWTs are stateless — the server verifies a signature instead of looking up a session. That scales horizontally without shared session storage. The downside is revocation: a valid JWT stays valid until it expires. I mitigate that with a 15-minute access token and a refresh token whose state is tracked in Redis, so I can revoke a family."

**Q50. Access vs refresh token?**
> "Access token: short-lived (15 minutes), sent on every request. Refresh token: long-lived (7 days), sent only to `/auth/refresh`, and rotated on every use. If an attacker steals an access token, it dies quickly. If they steal a refresh token and use it, the legitimate client's next refresh fails, which signals compromise."

**Q51. How does refresh rotation work?**
> "Each refresh token has a `jti` stored in Redis under `auth:refresh:{userId}:{jti}`. On refresh I check it exists, mint a new pair, then atomically mark the old one `consumed:{familyId}` in the same pipeline. If a consumed token is presented again, I revoke the whole family — every token descended from that login — because reuse means it leaked."

**Q52. Why Argon2 and not bcrypt or SHA-256?**
> "SHA-256 is fast, which is exactly wrong for passwords — it makes brute force cheap. bcrypt is memory-light and has a 72-byte limit. Argon2id is memory-hard, so an attacker needs large amounts of RAM per guess, which blunts GPU attacks. It also won the Password Hashing Competition."

**Q53. How are API keys stored?**
> "Only the SHA-256 hash. The plaintext is shown once at creation. On each request I hash the presented key and look it up. If the database leaks, the keys aren't usable. I also store a prefix for display so users can identify a key without seeing it."

**Q54. What is HMAC and why use it between services?**
> "HMAC is a keyed hash: `HMAC(secret, message)`. It proves both integrity and authenticity — only someone with the secret could produce it. I sign `serviceId:method:path:timestamp` plus a hash of the body, so a captured signature can't be reused for a different route or a modified payload. A five-minute window limits replay."

**Follow-up: is replay fully solved?** No — say so:
> "Not completely. Within five minutes the exact same request can be replayed. A nonce cache in Redis would close it."

**Q55. What is path traversal and how did you fix it?**
> "A user supplies `../../etc/passwd` as a filename, and naive `path.join` escapes the cache directory. I resolve the final path with `path.resolve` and verify it still starts with the resolved base directory plus a separator. I also validate `fileId` and `version` against a strict `[A-Za-z0-9_-]+` regex before touching the filesystem."

**Q56. XSS — what is it and where could it happen?**
> "Untrusted input rendered as HTML executes script in another user's browser. In my dashboard, a filename is inserted into an `<option>` via `innerHTML`, so a file named `<img src=x onerror=...>` executes. Since tokens are in `localStorage`, that's account takeover. The fix is `textContent` or an escape function, plus a real CSP header — a `<meta>` tag is not enough."

**Q57. What is a CSP?**
> "Content Security Policy — a response header that tells the browser which sources may load scripts, styles, images and connections. A strict policy blocks inline script, which neutralises most XSS. Mine is currently permissive because the dashboard uses inline `onclick` handlers."

**Q58. How do you store secrets?**
> "Never in the repo. Local development reads `.env`, which is gitignored. Kubernetes uses External Secrets Operator pulling from AWS Secrets Manager; Terraform generates random values instead of hardcoding them. I also scrubbed leaked values from git history and rotated the affected credentials."

**Q59. What is IDOR / BOLA?**
> "Insecure Direct Object Reference / Broken Object Level Authorization — the API checks that you're logged in but not that the object is yours. If `GET /files/:id` returns any file for any valid token, changing the ID reads other tenants' data. The fix is an ownership check on every object read, not just authentication."

---

## 9. System design and scaling

**Q60. What breaks first at 10x traffic?**
> "The database. Every download still does a metadata lookup, and every upload writes chunk rows. I'd add read replicas, cache metadata aggressively, and move the hottest reads entirely to Redis. After that, MinIO egress becomes the cost and bandwidth bottleneck."

**Q61. How would you scale to 1 million users?**
> "Horizontally: stateless core behind a load balancer, many edge nodes, Postgres primary with read replicas, Redis Cluster, Kafka partitioned by fileId. Then the hard parts: cache coherence across regions, cross-region replication bandwidth, and cost per byte served. I'd also add a proper CDN peering layer rather than building every PoP myself."

**Q62. What is a hot partition?**
> "One partition key gets disproportionate traffic — for example, a viral video whose `fileId` maps to one Kafka partition or one edge. Fixes: more partitions, salting the key, or serving hot objects from more replicas than the standard factor."

**Q63. How do you monitor this system?**
> "Prometheus metrics for request rate, latency, error rate, cache hit ratio, queue depth and edge health; Grafana dashboards; Loki for logs; Jaeger for traces via OpenTelemetry. The most important CDN metric is cache hit ratio — if it drops, origin load spikes."

**Q64. What is the difference between availability and durability?**
> "Availability is whether the system answers right now. Durability is whether data survives. A cache is available but not durable. Postgres with backups is durable but can be unavailable during failover. Replicating to three edges improves availability, not durability — the origin is still the source of truth."

---

## 10. Docker and DevOps

**Q65. What is a multi-stage Docker build?**
> "One stage installs dependencies and compiles TypeScript; the final stage copies only `dist` and production `node_modules`. The image ships without compilers or dev dependencies — smaller and a smaller attack surface."

**Q66. Docker Compose vs Kubernetes?**
> "Compose runs containers on one host with a simple YAML file — great for local development. Kubernetes schedules across a cluster, restarts failed pods, scales replicas, and handles service discovery and rolling deploys. Compose has no real self-healing or horizontal scaling."

**Q67. What is a healthcheck?**
> "A command the platform runs to decide whether a container is alive. Docker uses it for `depends_on: condition: service_healthy`; Kubernetes uses liveness, readiness and startup probes. Readiness controls traffic; liveness restarts; startup gives slow apps time before liveness begins."

**Q68. What does CI do in your project?**
> "On every push and PR: Prettier check, ESLint, unit tests, build, Terraform format and validate, and Docker builds for core, edge and nginx. Gaps: no secret scanning, no dependency audit, no `docker compose config` validation, and no integration tests."

---

## 11. Coding questions they may ask around this project

### Implement an LRU cache
```ts
class LRUCache {
  private map = new Map<number, number>();
  constructor(private capacity: number) {}

  get(key: number): number {
    if (!this.map.has(key)) return -1;
    const value = this.map.get(key)!;
    this.map.delete(key);      // re-insert to mark most-recent
    this.map.set(key, value);
    return value;
  }

  put(key: number, value: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value; // first inserted
      this.map.delete(oldest);
    }
  }
}
```
**Why it works:** JS `Map` preserves insertion order. Deleting and re-inserting moves a key to the end. `O(1)` average.

### Implement consistent hashing (simplified)
```ts
function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

class Ring {
  private points: { hash: number; node: string }[] = [];

  add(node: string, vnodes = 100) {
    for (let i = 0; i < vnodes; i++) this.points.push({ hash: hash(`${node}:${i}`), node });
    this.points.sort((a, b) => a.hash - b.hash);
  }

  get(key: string): string | undefined {
    if (!this.points.length) return undefined;
    const h = hash(key);
    // first point clockwise
    for (const p of this.points) if (p.hash >= h) return p.node;
    return this.points[0].node; // wrap around
  }
}
```
Mention the improvement: binary search instead of linear scan — that's what the real `HashRing` does.

### Implement a fixed-window rate limiter
```ts
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = store.get(key);
  if (!rec || rec.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
}
```
Then mention its flaw: bursty at window boundaries. Sliding window or token bucket fixes it.

### Chunked upload resume
```
init(file) -> fileId, chunkCount
for i in 0..chunkCount:
    if i in verifiedChunks: continue
    PUT chunk i with sha256
    on failure: retry with backoff
complete(fileId)
```
Mention: idempotent chunk writes, server-side status as the source of truth.

### Classic DSA they still ask freshers
- Reverse a string / linked list
- Check palindrome
- Two-sum
- Fibonacci (iterative + memo)
- Count frequencies with a hash map
- Binary search
- Merge two sorted arrays
- Find duplicates in an array
- Explain time/space complexity of each

---

## 12. Non-project fundamentals (rapid fire)

| Question | Answer in one or two lines |
|---|---|
| ACID? | Atomicity (all or nothing), Consistency (valid state), Isolation (concurrent transactions don't interfere), Durability (survives crash). |
| Normalization? | 1NF: atomic columns. 2NF: no partial dependency on a composite key. 3NF: no transitive dependency. Denormalise for read performance. |
| SQL vs NoSQL? | SQL: schema, joins, strong consistency. NoSQL: flexible schema, horizontal scale, eventual consistency. Choose by access pattern. |
| TCP vs UDP? | TCP: ordered, reliable, connection-oriented, retransmits. UDP: connectionless, no ordering, no retransmit — good for live video. |
| HTTP status codes? | 200 OK, 201 Created, 204 No Content, 301/302 redirect, 304 Not Modified, 400 bad input, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 429 rate limited, 500 server error, 502 bad gateway, 503 unavailable. |
| Process vs thread? | Process has its own memory; threads share memory within a process. Threads are cheaper but need synchronisation. |
| Deadlock? | Two processes each hold a resource the other needs. Prevent with ordering, timeouts, or detection. |
| REST vs GraphQL? | REST: fixed endpoints, over/under-fetching. GraphQL: one endpoint, client selects fields, but caching and N+1 are harder. |
| Idempotency? | Same request repeated has the same effect. GET/PUT/DELETE should be idempotent; POST usually isn't. |
| CAP theorem? | Under a partition you choose consistency or availability. A CDN leans AP; the metadata DB leans CP. |
| Index trade-off? | Faster reads, slower writes, extra storage. Index the columns you filter and sort by. |
| Sharding? | Splitting data across databases by a key. Improves scale, complicates joins and transactions. |
| Cache eviction policies? | LRU (least recently used), LFU (least frequently used), FIFO, TTL. |
| Load balancer algorithms? | Round robin, least connections, IP hash, weighted. |
| CDN edge vs origin? | Edge caches near users; origin is the source of truth. |

---

## 13. Behavioural questions

Prepare one concrete story for each. Use **STAR**: Situation, Task, Action, Result.

1. **"Tell me about a difficult bug."** → the upload race condition: symptom, how you diagnosed it, the `updateMany` fix, and what you learned.
2. **"Tell me about a time you disagreed with someone."** → pick something technical, stay respectful, show you changed your mind or convinced with evidence.
3. **"What are you most proud of in this project?"** → pick the security remediation: you found real vulnerabilities and fixed them systematically.
4. **"What's a weakness of your project?"** → the outbox gap or the lack of integration tests. Always pair it with a fix.
5. **"How do you learn new technology?"** → docs first, then a small spike, then integrate. Reference Kafka SASL or Prisma migrations.
6. **"Why should we hire you?"** → you ship end-to-end and you verify. You didn't just write code; you ran the stack, tested the failure modes, and fixed what broke.

---

## 14. Numbers to memorise

| Thing | Value |
|---|---|
| Access token TTL | 15 minutes |
| Refresh token TTL | 7 days |
| Signed edge URL TTL | 120 seconds |
| HMAC replay window | 5 minutes |
| Heartbeat interval / Redis TTL | 10s / 15s |
| Health scan interval | 5 seconds |
| Misses before DOWN | 3 (1 = DEGRADED) |
| Replication factor | 3 |
| Virtual nodes per edge | 100 |
| Transcode profiles | 6 (1080p → 144p) |
| HLS segment length | 4 seconds |
| Edge disk-cache threshold | 2 MB |
| Default edge cache size | 500 MB |
| Stampede lock TTL | 10 seconds |
| Default rate limit | 120 requests / 60s |
| Auth rate limit | 10 requests / 60s |
| Upload chunk rate limit | 3000 requests / 60s |
| Max upload chunks | 10,000 |
| DB | PostgreSQL 16 |
| Object store | MinIO (S3 API) |
| Runtime | Node.js 22, NestJS 11, Prisma 7 |

---

## 15. Traps — things NOT to claim

Interviewers probe. These are false or misleading in the current code, and saying them will backfire:

| Don't say | Reality |
|---|---|
| "150 virtual nodes" | Code default is **100**. The README is stale. Say 100. |
| "API keys use `timingSafeEqual`" | They use a SHA-256 hash lookup. Say "hashed lookup", not constant-time compare. |
| "Refresh tokens are stored in PostgreSQL" | They're in **Redis**. |
| "Exactly-once delivery" | It's at-least-once with idempotent consumers. |
| "Everything is fully tested" | 94 unit tests, but no integration tests for upload/download/edge. Say "unit tested, integration tests are the next step". |
| "Kafka events are guaranteed" | They're fire-and-forget today; an outbox is the fix. |
| "The system is production-ready at scale" | Say "it's a working prototype with production-shaped architecture". |

---

## 16. Questions YOU should ask them

Ask two or three. It signals seriousness.

1. "What does your deployment pipeline look like — how often do you ship?"
2. "How do you handle on-call and incident review?"
3. "What does a junior engineer own in their first six months?"
4. "What's the biggest source of technical debt right now?"
5. "How do you decide between building and buying infrastructure?"

---

## 17. One-page cheat sheet

**Elevator pitch:** distributed video CDN; NestJS core + edge nodes; Postgres/Prisma, Redis, MinIO, Kafka, BullMQ; resumable uploads, HLS transcoding, consistent-hash replication, signed URLs, JWT + API keys + HMAC.

**Three stories to have ready:**
1. Upload race → atomic `updateMany` claim.
2. Security audit → 21 findings, fixed and verified live.
3. Cache stampede → Redis `SET NX PX` + Lua release.

**Three trade-offs to mention:**
1. 302 redirect vs proxy → bandwidth vs control.
2. Kafka vs direct HTTP → decoupling vs eventual consistency.
3. Redis cache vs Postgres → speed vs durability.

**Three gaps to admit (with fixes):**
1. No outbox for Kafka events → add one.
2. No integration tests → add Testcontainers.
3. Weak CSP in dashboard → real header + remove inline handlers.
