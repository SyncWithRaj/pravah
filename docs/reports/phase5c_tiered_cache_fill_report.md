# Phase 5C: Tiered / Peer-Assisted Cache Fill — Implementation Report

> **Date:** 2026-08-08
> **Status:** ✅ IMPLEMENTED — Pending Integration Testing
> **Scope:** `apps/core` (Placement API) + `apps/edge` (Tiered Cache Fill)

---

## 1. Executive Summary

Phase 5C closes the architectural gap between **Geo-Aware Routing (5A)** and **Consistent Hashing (5B)** by introducing a **Cache-Fill Strategy** — the missing third concept in the Pravah CDN pipeline.

### Before Phase 5C

```text
User (Ahmedabad)
     ↓
Geo Routing → Mumbai Edge
     ↓
Redis MISS
     ↓
MinIO Origin                    ← HashRing replicas ignored
```

The HashRing proactively placed files on Tokyo, NYC, and Frankfurt — but when Mumbai got a cache miss, it bypassed all of them and hit MinIO directly. The proactive replicas were effectively useless for serving users.

### After Phase 5C

```text
User (Ahmedabad)
     ↓
Geo Routing → Mumbai Edge
     ↓
Redis MISS
     ↓
Placement API → [Tokyo: 4850km, NYC: 13400km]
     ↓
Peer Fetch → Tokyo (HIT) → Mumbai caches → Serve
     ↓
(Only if all peers fail) → MinIO Origin
```

The HashRing replicas now act as an **Origin Shield**. Edge nodes fetch from each other before touching the central storage, dramatically reducing origin traffic.

---

## 2. The Three Separated Responsibilities

| Responsibility | Question | Answer | Mechanism |
|---|---|---|---|
| **Geo Routing** | Which Edge serves this USER? | Mumbai (nearest to Ahmedabad) | Haversine distance |
| **Consistent Hashing** | Which Edges permanently store this FILE? | Tokyo + NYC + Frankfurt | HashRing (MD5 → ring walk) |
| **Cache-Fill Strategy** | Where does Mumbai GET the file on a miss? | Tokyo → NYC → MinIO | Tiered peer fetch + origin fallback |

These three responsibilities remain strictly independent. Geo Routing never consults the HashRing. The HashRing never considers user location. The Cache-Fill Strategy bridges them at runtime.

---

## 3. Files Changed

### Core (`apps/core`) — 4 files

| File | Change Type | Purpose |
|---|---|---|
| `src/placement/placement.service.ts` | **NEW** | Combines Prisma metadata + HashRing topology + HealthCheck filtering + Haversine distance ranking |
| `src/placement/placement.controller.ts` | **NEW** | Exposes `GET /api/v1/internal/placement/:fileId/v/:version` |
| `src/placement/placement.module.ts` | **NEW** | Wires PrismaModule + HealthCheckModule |
| `src/app.module.ts` | **MODIFIED** | Registered `PlacementModule` in imports |

### Edge (`apps/edge`) — 1 file

| File | Change Type | Purpose |
|---|---|---|
| `src/content/edge-content.controller.ts` | **REWRITTEN** | Full 6-step tiered cache-fill algorithm |

---

## 4. New Endpoint: Placement API

### Route

```text
GET /api/v1/internal/placement/:fileId/v/:version
```

### Request

| Header | Required | Purpose |
|---|---|---|
| `X-Edge-Node-Id` | Yes | Identity of the requesting Edge (e.g., `edge-mumbai`). Used to calculate geographic distance for replica ranking. |

### Response

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

### Internal Logic

```text
1. Prisma: Fetch file + version metadata (storagePath, mimeType, checksum, size)
2. HashRing: syncTopology(ALL nodes) → getNodes(fileId, 3) → Responsible Replica Set
3. HealthCheck: Filter out DOWN/DEGRADED nodes
4. Remove: Exclude the requesting edge from candidates
5. Haversine: Calculate distance from requesting edge to each candidate
6. Sort: Ascending by distanceKm
7. Return: Combined placement response
```

### Key Design Decisions

- **HashRing syncs with ALL nodes** (not just healthy ones). Placement is permanent and topology-stable. Health filtering happens AFTER HashRing calculation.
- **Unhealthy replicas are filtered, never replaced.** If Frankfurt is DOWN, the response contains only Tokyo and NYC. No dynamic re-replication occurs during a request.
- **The requesting edge is excluded** from the response. Mumbai should never try to peer-fetch from itself.

---

## 5. Edge Cache-Fill Algorithm (6 Steps)

### Step 0: Peer Mode Check

```text
Header: X-Cache-Fill-Mode: peer
  ├── Redis HIT → 200 + bytes
  └── Redis MISS → 404 immediately
       NEVER: fetch from peers, MinIO, or acquire lock
```

This is the **loop prevention mechanism**. When Edge A asks Edge B for a file, Edge B only checks its own local Redis. If it doesn't have it, it returns 404. It never cascades to another peer or to MinIO.

### Step 1: Local Cache Check

```text
Redis GET file:{fileId}:v{version}
  ├── HIT → serve immediately
  └── MISS → continue to Step 2
```

### Step 2: Stampede Lock

```text
Acquire lock:stampede:{fileId}:v{version}
  ├── Already held → wait 500ms → retry cache → fallback to direct MinIO stream
  └── Acquired → continue to Step 3 (we are responsible for populating cache)
```

### Step 3: Placement Lookup

```text
GET {CORE_API_URL}/api/v1/internal/placement/{fileId}/v/{version}
Headers: X-Edge-Node-Id: {EDGE_NODE_ID}
  ├── Success → extract responsibleReplicas + storagePath
  └── Failure → skip peers, jump to Step 5 (Origin Fallback)
```

### Step 4: Peer-Assisted Fetch

```text
For each peer in responsibleReplicas (sorted by distance, capped at PEER_MAX_ATTEMPTS):
  GET {peer.endpoint}/edge/content/{fileId}?v={version}
  Headers: X-Cache-Fill-Mode: peer
  Timeout: PEER_FETCH_TIMEOUT_MS
    ├── 200 → cache locally → serve → DONE
    ├── 404 → peer doesn't have this version → try next
    ├── 5xx → peer is broken → try next
    └── timeout → peer is slow → try next
```

### Step 5: Origin Fallback (MinIO)

```text
Fetch from MinIO using storagePath
  ├── Success → cache locally (if < 20MB) → serve → DONE
  └── Failure → Step 6
```

### Step 6: Total Failure

```text
Release stampede lock
Return 502 Bad Gateway
```

---

## 6. Loop Prevention

The `X-Cache-Fill-Mode: peer` header enforces a strict **single-hop** architecture:

```text
Mumbai ──(peer request)──→ Tokyo
                              │
                         Local Redis ONLY
                              │
                    ├── HIT → 200
                    └── MISS → 404
                         │
                    NEVER cascades
```

This means:
- **No peer chains:** Mumbai → Tokyo → Frankfurt is impossible.
- **No amplification:** A peer request generates zero additional network traffic.
- **No cross-edge stampede:** Peer requests are read-only and lock-free.

---

## 7. Stampede Protection

The existing local Redis lock serializes concurrent cache misses:

```text
100 concurrent requests for the same file
        ↓
Request #1 acquires lock:stampede:{fileId}:v{version}
        ↓
Request #1: Placement → Peer Fetch → Cache → Serve
        ↓
Requests #2-100: Wait → Retry cache → Serve from local Redis
```

No cross-edge locking is introduced. Each Edge's stampede lock is completely independent.

---

## 8. Failure Behavior Matrix

| Scenario | Behavior | Outcome |
|---|---|---|
| Peer returns 200 | Cache locally, serve user | ✅ Peer-assisted success |
| Peer returns 404 | Try next peer | Continues fallback chain |
| Peer returns 5xx | Try next peer | Continues fallback chain |
| Peer times out | Try next peer | Continues fallback chain |
| All peers exhausted | Fall back to MinIO | Origin serves as backstop |
| Placement lookup fails | Skip peers, fetch from MinIO | Graceful degradation |
| Core is unreachable | Use existing metadata endpoint for storagePath | Graceful degradation |
| MinIO is unavailable | Return 502 | User sees error |
| Version doesn't exist | Return 404 | Expected for invalid requests |
| Lock already held | Wait 500ms, retry cache, stream from MinIO | No duplicate fetches |

**Critical invariant:** Peer failure never makes a valid file permanently unavailable if MinIO is reachable.

---

## 9. Configurable Parameters

| Environment Variable | Default | Purpose |
|---|---|---|
| `CORE_API_URL` | `http://localhost:3000` | Base URL for Core internal APIs |
| `EDGE_NODE_ID` | `edge-node-01` | Identity of this Edge node |
| `PEER_FETCH_TIMEOUT_MS` | `2000` | Per-peer HTTP timeout (ms) |
| `PEER_MAX_ATTEMPTS` | `3` | Maximum peer candidates to try |

All values are read from `ConfigService` at startup. No code changes needed to tune them.

---

## 10. Architecture Diagram

```text
                         USER (Ahmedabad)
                              │
                              ▼
                     ┌─────────────────┐
                     │  Core Router    │
                     │  (Geo Routing)  │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │   Mumbai Edge   │  ← Serving Edge
                     └────────┬────────┘
                              │
                         Local Redis
                        ┌─────┴─────┐
                       HIT         MISS
                        │            │
                     Serve     Stampede Lock
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
               │  (4850km)│   │ (13400km)│   │  (DOWN)  │
               └────┬─────┘   └────┬─────┘   └──────────┘
                    │              │
              Local Redis    Local Redis
               ┌────┴───┐    ┌────┴───┐
              HIT     MISS  (next)   ...
               │       │
            200+bytes  404
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
                     │ (Final Fallback)│
                     └────────┬────────┘
                              │
                        Mumbai caches
                        locally + serves
```

---

## 11. What This Means for the HashRing

Before Phase 5C, the HashRing determined **where proactive copies happened to exist**. After Phase 5C, the HashRing has a **real runtime role during cache misses**.

```text
BEFORE:
  HashRing → "Tokyo, NYC, Frankfurt store this file"
  (But nobody asks them during a cache miss)

AFTER:
  HashRing → "Tokyo, NYC, Frankfurt store this file"
  Cache Miss → "Let me ask Tokyo first, then NYC, then MinIO"
  (The proactive replicas become an Origin Shield)
```

The HashRing still determines permanent placement. Geo Routing still determines user-facing serving. But now the Cache-Fill Strategy bridges them at runtime.

---

## 12. Production Gaps (Not Addressed in Phase 5C)

This implementation is a complete distributed CDN pipeline for the current architectural scope. The following production concerns are explicitly deferred:

| Gap | Why Deferred |
|---|---|
| DNS/Anycast edge ingress | Currently using HTTP 302 redirects |
| Edge identity authentication | Using trusted internal header, no mTLS |
| Placement response caching | Designed for cacheability, but not caching yet (premature optimization) |
| GeoIP-based user location | Using mock region strings |
| Latency-based peer selection | Using geographic distance as proxy |
| Rebalancing worker | Unhealthy nodes are filtered, not replaced |
| Redis binary cache limits | 20MB cap, no disk-backed overflow |
| Service-to-service auth | All internal APIs are unauthenticated |

These will be addressed in future phases (6+) as the system moves toward production deployment.

---

## 13. Testing Guide

### Test 1: Verify Placement API

```bash
curl -s http://localhost:3000/api/v1/internal/placement/<fileId>/v/1 \
  -H "X-Edge-Node-Id: edge-node-01" | jq .
```

Expected: JSON with `responsibleReplicas` array sorted by `distanceKm`.

### Test 2: Peer-Assisted Cache Fill

1. Start all 4 edge nodes on ports 4001-4004.
2. Upload a file through Core.
3. Wait for proactive replication to complete (watch edge logs).
4. Hit an edge that is NOT a responsible replica:
   ```bash
   curl -i http://localhost:4001/edge/content/<fileId>?v=1
   ```
5. Watch the logs — you should see:
   ```text
   [Cache Miss] ... starting tiered cache fill
   [Peer Fetch] Trying edge-node-03 (us-east-1, 4850km)
   [Peer Fetch] Success from edge-node-03 (7101 bytes)
   [Peer Fetch] Cached ... locally
   ```

### Test 3: Peer Mode (Loop Prevention)

```bash
curl -i http://localhost:4001/edge/content/<fileId>?v=1 \
  -H "X-Cache-Fill-Mode: peer"
```

Expected: 200 if cached, 404 if not. No MinIO fallback, no peer cascade.

### Test 4: Origin Fallback

1. Stop all edge nodes except one.
2. Request a file that was NOT proactively replicated to that edge.
3. Watch logs — should see all peers fail, then:
   ```text
   [Origin Fallback] Fetching ... from MinIO
   ```

### Test 5: Stampede Protection

Use a load testing tool to send 50 concurrent requests for the same uncached file to one edge. Only 1 should trigger the peer/origin fetch. The other 49 should wait and serve from cache.
