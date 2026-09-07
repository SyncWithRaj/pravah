# Phase 5C: Tiered / Peer-Assisted Cache Fill — Design Specification

> **Status:** APPROVED (Architecture) · NOT YET IMPLEMENTED
>
> **Prerequisite:** Phase 5A (Geo-Aware Routing), Phase 5B (Consistent Hashing), Phase 5C Edge Extraction (Complete)

---

## 1. Problem Statement

Pravah currently has three independent mechanisms that do not interact:

| Mechanism | Question It Answers | Current Behavior |
|---|---|---|
| Geo Routing (5A) | Which Edge should serve this user? | Haversine → nearest healthy Edge |
| Consistent Hashing (5B) | Which Edges permanently store this file? | HashRing → Responsible Replica Set |
| Cache Miss Handling | Where does a serving Edge get the file? | Always MinIO Origin |

The architectural gap:

```text
User in Ahmedabad
        ↓
Geo Routing selects Mumbai (nearest)
        ↓
Mumbai has a Cache Miss
        ↓
Mumbai fetches from MinIO Origin          ← PROBLEM
        ↓
Meanwhile, Tokyo already has the file     ← WASTED
(Tokyo is a responsible replica)
```

The Responsible Replica Set (Tokyo, NYC, Frankfurt) was proactively populated by the HashRing, but the serving Edge (Mumbai) bypasses them entirely and hits the central Origin on every miss. This means:

1. The Origin absorbs traffic that could have been served by peers.
2. The proactive replicas provide no benefit for geographically misaligned requests.
3. Origin bandwidth becomes the bottleneck under viral load.

**This design introduces the missing third concept: Cache-Fill Strategy.**

---

## 2. The Three Responsibilities (Strictly Separated)

These three responsibilities MUST remain independent. They never merge.

```text
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Geo Routing                                                   │
│  ──────────                                                    │
│  Question: Which Edge should serve this USER?                  │
│  Answer:   Mumbai (nearest healthy Edge to Ahmedabad)          │
│  Scope:    User-facing. Geography-based. Per-request.          │
│                                                                │
│  Geo Routing does NOT consult the HashRing.                    │
│  Geo Routing does NOT consider which Edges have the file.      │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Consistent Hashing (HashRing)                                 │
│  ─────────────────────────────                                 │
│  Question: Which Edges are responsible for storing this FILE?  │
│  Answer:   Tokyo + NYC + Frankfurt (deterministic placement)   │
│  Scope:    File-facing. Math-based. Stable across requests.    │
│                                                                │
│  HashRing does NOT consider user location.                     │
│  HashRing does NOT choose the serving Edge.                    │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Cache-Fill Strategy (NEW)                                     │
│  ─────────────────────────                                     │
│  Question: Where does the serving Edge obtain the FILE         │
│            after a local cache miss?                           │
│  Answer:   Healthy responsible replica → MinIO Origin fallback │
│  Scope:    Infrastructure-facing. Bridges Geo Routing and      │
│            HashRing. Per-miss.                                 │
│                                                                │
│  Cache-Fill Strategy is the missing link.                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Canonical Cache-Fill Algorithm

When a Geo-selected Edge receives a user request and encounters a local Redis MISS, the following algorithm executes:

```text
Step 1: LOCAL CACHE CHECK
        ↓
        Redis GET file:{fileId}:v{version}
        ├── HIT → Serve immediately. DONE.
        └── MISS → Continue to Step 2.

Step 2: STAMPEDE LOCK
        ↓
        Acquire lock:stampede:{fileId}:v{version}
        ├── Lock already held by another request
        │     → Wait/poll for local Redis population
        │     → Serve from local cache. DONE.
        └── Lock acquired → Continue to Step 3.

Step 3: PLACEMENT LOOKUP
        ↓
        GET /api/v1/internal/placement/{fileId}/v/{version}
        Headers: X-Edge-Node-Id: {this edge's ID}
        ├── Success → Receive responsibleReplicas + storagePath
        │              Continue to Step 4.
        └── Failure (timeout / 5xx / Core unreachable)
               → Skip to Step 6 (Origin Fallback).
               → Use existing internal metadata endpoint
                  for storagePath if needed.

Step 4: PEER-ASSISTED FETCH
        ↓
        For each candidate in responsibleReplicas (sorted by distance):
          GET http://{candidate.endpoint}/edge/content/{fileId}?v={version}
          Headers: X-Cache-Fill-Mode: peer
          Timeout: PEER_FETCH_TIMEOUT_MS (configurable, default 2000ms)
          ├── 200 → Received file bytes. Continue to Step 5.
          ├── 404 → Candidate does not have this version. Try next.
          ├── 5xx → Candidate is broken. Try next.
          └── Timeout → Candidate is slow/unreachable. Try next.

Step 5: CACHE + SERVE (Peer Success)
        ↓
        Store file in local Redis.
        Release stampede lock.
        Serve to user. DONE.

Step 6: ORIGIN FALLBACK (MinIO)
        ↓
        Fetch file from MinIO using storagePath.
        ├── Success → Store in local Redis.
        │              Release stampede lock.
        │              Serve to user. DONE.
        └── Failure → Release stampede lock.
                       Return 502 to user. DONE.
```

---

## 4. Placement API Design

### New Endpoint on Core

```text
GET /api/v1/internal/placement/{fileId}/v/{version}
```

**Request Headers:**

| Header | Purpose |
|---|---|
| `X-Edge-Node-Id` | Identity of the requesting Edge (e.g., `edge-mumbai`). Used to calculate geographic distance for replica ranking. Treated as trusted internal infrastructure metadata. |

**Response:**

```json
{
  "fileId": "abc-123",
  "version": 2,
  "storagePath": "files/abc-123/v2/master",
  "mimeType": "video/mp4",
  "size": "7101",
  "ownerId": "user-456",
  "checksum": "sha256-abc...",
  "responsibleReplicas": [
    {
      "edgeId": "edge-tokyo",
      "endpoint": "http://tokyo-cdn:4003",
      "region": "ap-northeast-1",
      "distanceKm": 4850
    },
    {
      "edgeId": "edge-nyc",
      "endpoint": "http://nyc-cdn:4002",
      "region": "us-east-1",
      "distanceKm": 13400
    }
  ]
}
```

**Core-side logic for this endpoint:**

```text
1. Fetch file metadata from Prisma
   (storagePath, mimeType, ownerId, checksum, size)

2. HashRing.getNodes(fileId, REPLICATION_FACTOR)
   → [edge-tokyo, edge-nyc, edge-frankfurt]

3. HealthCheckService.getAllNodes()
   → Filter: remove DOWN/DEGRADED nodes
   → [edge-tokyo, edge-nyc]                     (Frankfurt is DOWN)

4. Remove the requesting Edge from the list
   → If Mumbai is requesting, don't include Mumbai as its own peer

5. RoutingService.haversine(requestingEdge, each candidate)
   → Sort by ascending distance from requesting Edge

6. Return combined response
```

### Important Design Decisions

**Unhealthy replica handling:**

```text
HashRing returns: [Tokyo, NYC, Frankfurt]
Frankfurt is DOWN.

Phase 5C response: [Tokyo, NYC]

We do NOT dynamically replace Frankfurt with another node.
Re-replication / rebalancing is a separate future responsibility.
```

**Security of `storagePath`:**

The `storagePath` is derived from trusted Core metadata (Prisma), never from user input. The Edge uses it solely for MinIO fallback retrieval. The Edge cannot construct arbitrary MinIO paths.

**Future cacheability:**

The response structure is designed so it can later be cached by the Edge in local Redis (e.g., `placement:{fileId}:v{version}` with configurable TTL) without changing the Edge's fundamental behavior. This is an optimization, NOT a Phase 5C requirement. We do not prematurely optimize until Core is measured as a bottleneck.

---

## 5. Peer Request Behavior (Loop Prevention)

When an Edge receives a request with the header `X-Cache-Fill-Mode: peer`, it operates in **local-cache-only mode**:

```text
┌────────────────────────────────────────────────────┐
│                                                    │
│  PEER REQUEST (X-Cache-Fill-Mode: peer)            │
│                                                    │
│  Redis HIT → 200 + file bytes                      │
│                                                    │
│  Redis MISS → 404 immediately                      │
│                                                    │
│  NEVER:                                            │
│    → Fetch from another peer                       │
│    → Fetch from MinIO                              │
│    → Acquire a stampede lock                        │
│    → Make any outbound HTTP request                │
│    → Trigger any cache-fill logic                  │
│                                                    │
└────────────────────────────────────────────────────┘
```

This guarantees:

1. **No cascading chains:** Mumbai → Tokyo → Frankfurt → Mumbai is impossible.
2. **Single-hop only:** The peer fetch is always exactly one hop.
3. **No amplification:** A peer request cannot generate additional network traffic.
4. **Bounded latency:** The worst case is a fast 404 from local Redis.

The resulting architecture is **hierarchical**, not peer-to-peer mesh:

```text
Serving Edge ──(single hop)──→ Responsible Replica
                                    │
                               LOCAL CACHE ONLY
```

---

## 6. Version Handling

All peer requests are strictly version-specific.

**Cache key format (unchanged):**

```text
file:{fileId}:v{version}
```

**Peer request format:**

```text
GET /edge/content/{fileId}?v={version}
X-Cache-Fill-Mode: peer
```

**Version mismatch scenario:**

```text
Mumbai wants file:abc-123 v2
        ↓
Tokyo has file:abc-123 v1 only (v2 replication not yet complete)
        ↓
Tokyo checks Redis: file:abc-123:v2
        ↓
MISS
        ↓
Tokyo returns 404
        ↓
Mumbai tries next peer or falls back to MinIO
```

A peer MUST NEVER return a different version than requested. Our objects are immutable and versioned. Returning v1 when v2 was requested would be a data integrity violation.

---

## 7. Stampede Protection

The existing local stampede lock is sufficient. No cross-edge locking is introduced.

**100 concurrent requests to Mumbai for the same file:**

```text
Request #1:  Acquires lock:stampede:{fileId}:v{version}
             → Placement lookup → Peer fetch from Tokyo → Cache in Redis
             → Release lock → Serve

Requests #2-100:
             → Lock already held
             → Wait/poll for Redis population
             → Redis populated by Request #1
             → Serve from local cache
```

**Why no cross-edge stampede:**

1. Mumbai's lock exists only in Mumbai's Redis.
2. The peer request to Tokyo is a pure read (no lock, no writes, no cache-fill on Tokyo's side).
3. If 100 different users simultaneously hit 100 different Edges for the same file, each Edge independently handles its own stampede lock. These are fully decoupled.

---

## 8. Edge Identity & Authentication

**Phase 5C (Local Development):**

The Edge identifies itself via a trusted header:

```text
X-Edge-Node-Id: edge-mumbai
```

sourced from the `EDGE_NODE_ID` environment variable. Core uses this to:
1. Look up the requesting Edge's geographic coordinates.
2. Calculate Haversine distance to each responsible replica.
3. Sort replicas by proximity to the requesting Edge.

**Future (Production):**

Edge identity should be authenticated via internal infrastructure credentials (e.g., mutual TLS, internal API key, service mesh identity). Core should validate that the caller is actually the registered Edge it claims to be. Source IP inference is unreliable due to proxies/load balancers.

This is NOT a Phase 5C requirement but must be addressed before production deployment.

---

## 9. Failure Behavior Matrix

| Scenario | Behavior | Outcome |
|---|---|---|
| Peer returns 200 | Cache locally, serve user | ✅ Peer-assisted success |
| Peer returns 404 | Try next peer in sorted list | Continues fallback chain |
| Peer returns 5xx | Try next peer in sorted list | Continues fallback chain |
| Peer times out | Try next peer in sorted list | Continues fallback chain |
| All peers exhausted | Fall back to MinIO Origin | Origin serves as final backstop |
| Core placement call fails | Skip peer phase entirely, fall back to MinIO | Graceful degradation |
| Core is completely unreachable | Use existing internal metadata endpoint for storagePath, fetch from MinIO | Graceful degradation |
| MinIO is unavailable | Return 502 to user, release lock | User sees error |
| Requested version doesn't exist anywhere | Return 404 to user | Expected for invalid requests |
| Concurrent cache misses (same file, same Edge) | Stampede lock serializes; only 1 request performs the fetch | Prevents thundering herd |

**Critical invariant:**

> Peer failure MUST NEVER make a valid file permanently unavailable if MinIO Origin is reachable.

---

## 10. Configurable Parameters

The following values MUST be configurable via environment variables, not hardcoded:

| Parameter | Default | Purpose |
|---|---|---|
| `PEER_FETCH_TIMEOUT_MS` | `2000` | Per-peer HTTP timeout before trying the next candidate |
| `PEER_MAX_ATTEMPTS` | `3` | Maximum number of peer candidates to try (capped by REPLICATION_FACTOR) |
| `CORE_API_URL` | `http://localhost:3000` | Base URL for Core internal APIs |
| `EDGE_NODE_ID` | `edge-node-01` | Identity of this Edge node |

These can be benchmarked and tuned after implementation without code changes.

---

## 11. Origin Traffic Characterization

> [!IMPORTANT]
> Do NOT claim "The Origin will only serve the file exactly 3 times."
>
> That is not guaranteed. Proactive replication and peer-assisted caching **reduce repeated Origin traffic and provide an intermediate cache hierarchy, while retaining Origin as the final fallback.**

Scenarios where Origin is still accessed despite peer-assisted caching:

1. All responsible replicas are DOWN.
2. The version hasn't finished replicating to any replica yet (upload just completed).
3. All responsible replicas have evicted the file from their Redis (LRU eviction under memory pressure).
4. Core placement lookup fails (graceful degradation skips peers).

Origin remains the source of truth. Peer-assisted caching is an optimization layer, not a replacement for Origin access.

---

## 12. Architecture Diagram

```text
                         USER (Ahmedabad)
                              │
                              ▼
                        Core Router
                              │
                         Geo Routing
                         (Haversine)
                              │
                              ▼
                     ┌─────────────────┐
                     │   Mumbai Edge   │ ← Serving Edge
                     │   (Port 4001)   │
                     └────────┬────────┘
                              │
                         Local Redis
                        ┌─────┴─────┐
                       HIT         MISS
                        │            │
                     Serve      Acquire Lock
                                     │
                              Placement API
                              (Core HTTP)
                                     │
                              ┌──────┴──────┐
                              │  HashRing   │
                              │  + Health   │
                              │  + Distance │
                              └──────┬──────┘
                                     │
                          responsibleReplicas
                          (sorted by distance)
                                     │
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
               ┌──────────┐   ┌──────────┐   ┌──────────┐
               │  Tokyo   │   │   NYC    │   │ Frankfurt│
               │  Edge    │   │  Edge    │   │  Edge    │
               └────┬─────┘   └────┬─────┘   └────┬─────┘
                    │              │              │
              Local Redis    Local Redis     (DOWN)
               ┌────┴───┐    ┌────┴───┐
              HIT     MISS  HIT     MISS
               │       │    │       │
            200+bytes  404  ...     ...
               │
               ▼
         Mumbai caches
         locally + serves
                              │
                    ┌─────────┴──────────┐
                    │  ALL PEERS FAILED  │
                    └─────────┬──────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  MinIO Origin   │
                     │  (Final Fallback)│
                     └────────┬────────┘
                              │
                        Mumbai caches
                        locally + serves
```

---

## 13. What Changes Are Needed

### On Core (`apps/core`)

| Change | Description |
|---|---|
| New endpoint | `GET /api/v1/internal/placement/{fileId}/v/{version}` — combines metadata lookup + HashRing + health filtering + distance ranking |
| New method in `MetadataService` | `findPlacementInfo(fileId, version)` — returns file metadata + storagePath |
| New method in `ReplicationService` or standalone | Calculates responsible replicas, filters health, ranks by distance |
| Reuses existing | `HashRing`, `HealthCheckService`, `RoutingService` (Haversine) |

### On Edge (`apps/edge`)

| Change | Description |
|---|---|
| Modified `EdgeContentController` cache-miss path | Before MinIO fallback, try peer-assisted fetch using responsibleReplicas from placement response |
| New peer-request mode | When `X-Cache-Fill-Mode: peer` header is present, return local Redis result only (200 or 404) |
| Configurable timeouts | `PEER_FETCH_TIMEOUT_MS`, `PEER_MAX_ATTEMPTS` from environment |

### No New Services

Zero new microservices. Zero new databases. Zero new message queues. The change is confined to one new Core endpoint and a modified cache-miss path on the Edge.

---

## 14. Phase Boundary

This design completes Phase 5C by bridging the gap between:

- **Phase 5A** (Geo-Aware Routing — where the user goes)
- **Phase 5B** (Consistent Hashing — where the file lives)
- **Phase 5C** (Edge Extraction + Tiered Cache Fill — how they interact)

After this, the Pravah CDN has a complete distributed CDN pipeline for the current architectural scope:

```text
Upload → Origin → HashRing → Proactive Replicas
Download → Geo Route → Edge → Peer Fill → Origin Fallback
```
