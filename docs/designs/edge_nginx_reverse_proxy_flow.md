# Pravah Request Flow Architecture

This document illustrates the end-to-end request lifecycle for video streaming traffic, highlighting the interaction between the Linux Nginx Zero-Copy reverse proxy and the NestJS Edge application.

---

## 1. High-Level Architecture Flow

```mermaid
flowchart TD
    Client["Client / Video Player"] -->|"1. HTTP/2 GET /stream/video-1/720p_001.ts"| Nginx["Linux Nginx Reverse Proxy\n(Port 80/443)"]

    subgraph Linux_Data_Plane ["Linux Kernel & Nginx Data Plane"]
        Nginx -->|"2. Check Local Disk Cache"| CacheDecision{"Cache Hit?"}
        CacheDecision -->|"YES (95%+ Traffic)"| SendfileCall["Linux Kernel sendfile()\nDirect Page Cache to NIC DMA"]
    end

    SendfileCall -->|"3. Zero-Copy 200 OK\n(Sub-millisecond latency)"| Client

    subgraph NestJS_Control_Plane ["NestJS Edge Application Plane (Port 4001)"]
        CacheDecision -->|"NO (Cache Miss)"| UpstreamReq["4. Upstream HTTP/1.1 Keep-Alive\nProxy Pass to NestJS"]
        UpstreamReq --> AuthGuard["5. NestJS Auth & HMAC Guard"]
        AuthGuard --> StampedeLock["6. Single-Flight Promise Lock\n(Mutex for concurrent requests)"]
        StampedeLock --> PeerCheck{"7. Sibling Edge Node\nhas segment?"}

        PeerCheck -->|"YES"| FetchPeer["8. Fetch from Peer Edge Node\n(Internal Network)"]
        PeerCheck -->|"NO"| FetchOrigin["9. Fetch from Origin Storage\n(MinIO / AWS S3)"]

        FetchPeer --> SaveLocal["10. Write Segment to Local Cache Volume"]
        FetchOrigin --> SaveLocal
        SaveLocal --> StreamToNginx["11. Stream Segment Response to Nginx"]
    end

    StreamToNginx --> NginxCommit["12. Nginx Caches File on Disk"]
    NginxCommit --> DeliverMiss["13. Deliver 200 OK to Client"]
    DeliverMiss --> Client
```

---

## 2. End-to-End Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Player as Client / Player
    participant Nginx as Linux Nginx (Port 80/443)
    participant Kernel as Linux Kernel (Page Cache / NIC)
    participant Nest as NestJS Edge (Port 4001)
    participant Peer as Sibling Edge Node
    participant Origin as MinIO / AWS S3 Origin

    Note over Player, Origin: SCENARIO 1: ZERO-COPY CACHE HIT
    Player->>Nginx: GET /stream/live/720p_010.ts
    Nginx->>Nginx: Lookup local cache index
    Nginx->>Kernel: sendfile(socket_fd, file_fd, offset, length)
    Kernel-->>Player: Direct DMA transfer to NIC (Zero user-space memory copies)

    Note over Player, Origin: SCENARIO 2: CACHE MISS WITH NESTJS RESOLUTION
    Player->>Nginx: GET /stream/live/720p_011.ts
    Nginx->>Nginx: Cache miss
    Nginx->>Nest: HTTP/1.1 GET /stream/live/720p_011.ts (Keep-Alive)
    Nest->>Nest: Validate HMAC token & headers
    Nest->>Nest: Acquire Single-Flight lock (deduplicate concurrent requests)
    
    alt Sibling Peer Edge Hit
        Nest->>Peer: GET /internal/chunks/720p_011.ts
        Peer-->>Nest: Return chunk bytes
    else Sibling Peer Edge Miss
        Nest->>Origin: GET /storage/buckets/live/720p_011.ts
        Origin-->>Nest: Return object payload
    end

    Nest->>Nest: Write chunk to shared cache volume
    Nest->>Nest: Release Single-Flight lock
    Nest-->>Nginx: 200 OK (Stream chunk bytes)
    Nginx->>Nginx: Store in local cache directory
    Nginx-->>Player: 200 OK (Stream segment to player)

    Note over Player, Nginx: SUBSEQUENT REQUEST FOR SAME CHUNK
    Player->>Nginx: GET /stream/live/720p_011.ts
    Nginx->>Kernel: sendfile() -> Zero-Copy directly to client
```
