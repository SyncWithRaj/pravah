# Pravah Distributed CDN — Complete HTTP Download Request Flow & Architecture Specification

> **File:** `docs/architecture_2.0.md`  
> **Status:** OFFICIAL SYSTEM SPECIFICATION & ARCHITECTURE REFERENCE  
> **Scope:** Multi-Region Ingress, Geo-Routing, Edge Cache Hits/Misses, Tiered Peer Fills, Kafka Event Streaming, WebSockets, and Observability  
> 🔗 **System Topology & Roadmap:** For the high-level microservices topology, sequence diagrams, and evolutionary roadmap, see [**`architecture.md`**](architecture.md).

---

## 1. Executive Overview

This document specifies the end-to-end lifecycle of an HTTP file download request (`GET /download/:fileId` or `GET /edge/content/:fileId`) across the **Pravah Distributed CDN**. 

It traces the request through every component of the architecture, including:
1. **Multi-Region GeoDNS & Client Ingress**: How clients in **Europe (Frankfurt)**, the **Americas (N. Virginia)**, and **Asia (Mumbai)** are routed to the optimal Edge Point of Presence (PoP).
2. **The Ultra-Fast Cache HIT Path**: Sub-millisecond binary retrieval from local Edge Redis RAM.
3. **The Cache MISS & Tiered Cache Fill Path**: Distributed stampede lock protection, peer-to-peer edge fetch, and Origin S3/MinIO streaming.
4. **Fault Tolerance & Dynamic Failover**: Automated rerouting when an edge node crashes or misses its 10-second heartbeat.
5. **Decoupled Telemetry & Observability**: OpenTelemetry distributed tracing, Prometheus metrics collection, Kafka event streaming, and real-time WebSocket dashboard broadcasts.

---

## 2. High-Level Multi-Region Request Flowchart

The following flowchart illustrates the complete decision tree from client DNS resolution to byte delivery:

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#1e293b', 'primaryTextColor': '#f8fafc', 'primaryBorderColor': '#3b82f6', 'lineColor': '#94a3b8', 'secondaryColor': '#0f172a', 'tertiaryColor': '#1e1e2e'}}}%%
flowchart TD
    subgraph GlobalClients["1. Multi-Region Clients"]
        ClientEU["Client in Europe (Frankfurt / Berlin)"]
        ClientUS["Client in US (Virginia / New York)"]
        ClientIN["Client in Asia (Mumbai / Delhi)"]
    end

    subgraph RoutingPlane["2. Control Plane & Geo-Routing (Mumbai Hub)"]
        CoreNLB["AWS Mumbai Network Load Balancer (NLB)"]
        CoreRouter["CDN Routing Engine (Haversine Geo-Distance)"]
        HealthScanner["Health Monitor (Active 10s Heartbeat Scanner)"]
        HashRing["Consistent Hashing Ring (150 Virtual Nodes)"]
    end

    subgraph EdgePoPs["3. Multi-Region Edge Data Plane"]
        subgraph EdgeFrankfurt["Frankfurt Edge PoP (eu-central-1)"]
            FastifyEU["Fastify Ingress Listener (:3001)"]
            RedisEU[("Edge Redis RAM Cache")]
        end

        subgraph EdgeVirginia["Virginia Edge PoP (us-east-1)"]
            FastifyUS["Fastify Ingress Listener (:3001)"]
            RedisUS[("Edge Redis RAM Cache")]
        end

        subgraph EdgeMumbai["Mumbai Edge PoP (ap-south-1)"]
            FastifyIN["Fastify Ingress Listener (:3001)"]
            RedisIN[("Edge Redis RAM Cache")]
        end
    end

    subgraph OriginStorage["4. Central Storage & Origin Plane (Mumbai)"]
        CoreApp["Pravah Core Service (NestJS)"]
        MinIOOrigin[("MinIO / AWS S3 Origin Bucket")]
        PostgresDB[("PostgreSQL DB (Metadata & State)")]
    end

    subgraph AsyncTelemetry["5. Decoupled Telemetry & Observability"]
        KafkaBroker[["Apache Kafka (RedPanda) Bus"]]
        Prometheus["Prometheus Time-Series Engine"]
        OTelJaeger["OpenTelemetry Distributed Tracing (Jaeger)"]
        WSGateway["WebSocket Gateway (Socket.io)"]
        LiveDashboard["Operator Real-Time Web Dashboard"]
    end

    %% Client Routing Connections
    ClientEU -->|"1. GET /download/:fileId"| CoreNLB
    ClientUS -->|"1. GET /download/:fileId"| CoreNLB
    ClientIN -->|"1. GET /download/:fileId"| CoreNLB
    CoreNLB --> CoreRouter

    %% Health Filter & Ring Selection
    HealthScanner -.->|"Filter Healthy Nodes"| CoreRouter
    HashRing -.->|"Verify Replica Set (N=3)"| CoreRouter
    CoreRouter -->|"HTTP 302 Redirect to Frankfurt"| ClientEU
    CoreRouter -->|"HTTP 302 Redirect to Virginia"| ClientUS
    CoreRouter -->|"HTTP 302 Redirect to Mumbai"| ClientIN

    %% Edge Ingress
    ClientEU -->|"2. GET /edge/content/:fileId?v=1"| FastifyEU
    ClientUS -->|"2. GET /edge/content/:fileId?v=1"| FastifyUS
    ClientIN -->|"2. GET /edge/content/:fileId?v=1"| FastifyIN

    %% Cache Hit or Miss Evaluation (Example on Frankfurt Edge)
    FastifyEU -->|"3. Redis GET binary chunk"| RedisEU

    %% Path A: Cache HIT
    RedisEU -->|"4a. CACHE HIT (Buffer Found)"| FastifyEU
    FastifyEU -->|"5a. Stream 200 OK + Chunk"| ClientEU

    %% Path B: Cache MISS & Tiered Fill
    RedisEU -->|"4b. CACHE MISS"| FastifyEU
    FastifyEU -->|"5b. Acquire Stampede Lock"| RedisEU
    FastifyEU -->|"6b. Tiered Peer Fetch (x-cache-fill-mode: peer)"| FastifyUS
    FastifyUS -.->|"Peer Hit / Miss"| FastifyEU
    FastifyEU -->|"7b. Fallback: Origin Fetch via Core NLB"| CoreNLB
    CoreNLB --> CoreApp
    CoreApp -->|"Read Original Object"| MinIOOrigin
    CoreApp -->|"Query Version & ETag"| PostgresDB
    CoreApp -->|"Stream Object Stream"| FastifyEU
    FastifyEU -->|"Write to Local RAM Cache (LRU)"| RedisEU
    FastifyEU -->|"Release Stampede Lock"| RedisEU
    FastifyEU -->|"8b. Stream 200 OK + Object"| ClientEU

    %% Observability Streams
    FastifyEU -.->|"Trace Context (X-Trace-Id)"| OTelJaeger
    FastifyEU -.->|"Increment cacheHitsTotal & latency"| Prometheus
    FastifyEU -.->|"Emit cdn.cache_access Event"| KafkaBroker
    KafkaBroker -->|"Consume Telemetry"| WSGateway
    WSGateway -->|"Push Live Hit-Ratio & Bandwidth"| LiveDashboard
```

---

## 3. End-to-End Sequence Diagram

The following sequence diagram details the exact message interactions, headers, cryptographic tokens, distributed locks, and telemetry events during both a **Cache HIT** and a **Cache MISS**:

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#1e293b', 'primaryTextColor': '#f8fafc', 'primaryBorderColor': '#3b82f6', 'lineColor': '#94a3b8', 'secondaryColor': '#0f172a', 'tertiaryColor': '#1e1e2e'}}}%%
sequenceDiagram
    autonumber
    actor Client as Client (Frankfurt, EU)
    participant CoreNLB as Core NLB (Mumbai)
    participant CoreRouter as Core Geo-Router
    participant EdgeFastify as Frankfurt Edge (Fastify)
    participant EdgeRedis as Frankfurt Edge Redis
    participant PeerEdge as Virginia Edge (Peer)
    participant CoreOrigin as Core Origin Service
    participant S3 as MinIO / S3 Storage
    participant Kafka as Kafka (RedPanda)
    participant WS as WebSocket Gateway
    participant Dashboard as Operator Dashboard

    %% Step 1: Geo-Routing
    Note over Client, CoreRouter: STEP 1: INITIAL REQUEST & GEODNS ROUTING
    Client->>CoreNLB: GET /download/file-9821 (Headers: X-Forwarded-For: 194.12.5.1)
    CoreNLB->>CoreRouter: Forward Request to Ingress Port 3000
    CoreRouter->>CoreRouter: Compute Haversine Distance (Frankfurt PoP: 18ms vs Mumbai: 120ms)
    CoreRouter->>CoreRouter: Verify Node Health (Last heartbeat < 10s ago)
    CoreRouter-->>Client: HTTP 302 Found (Location: http://edge-frankfurt.pravah.io:3001/edge/content/file-9821?v=1)

    %% Step 2: Edge Connection & Cache HIT
    Note over Client, EdgeRedis: STEP 2: EDGE INGRESS & CACHE HIT EVALUATION
    Client->>EdgeFastify: GET /edge/content/file-9821?v=1
    EdgeFastify->>EdgeFastify: Start OpenTelemetry Active Span ("cdn.edge_fetch")
    EdgeFastify->>EdgeRedis: GET binary:file-9821:v1:chunk0

    alt Case A: Cache HIT (Sub-Millisecond Path)
        EdgeRedis-->>EdgeFastify: Return Binary Buffer (256 KB)
        EdgeFastify->>EdgeRedis: GET meta:file-9821:v1 (ETag, Content-Type, Size)
        EdgeRedis-->>EdgeFastify: Return Cached Metadata
        
        %% Telemetry & Observability
        critical Asynchronous Telemetry Pipeline
            EdgeFastify-)Kafka: Produce "cdn.cache_access" (hit=true, bytes=262144, latency=1.2ms)
            EdgeFastify->>EdgeFastify: Prometheus: cacheHitsTotal.inc(), requestDuration.observe(0.0012)
            Kafka-)WS: Telemetry Consumer receives event
            WS-)Dashboard: Emit "metrics:update" (Live Hit Ratio: 98.4%, Bandwidth: +2.1 Gbps)
        end

        EdgeFastify-->>Client: HTTP 200 OK (Headers: X-Cache: HIT, X-CDN-Edge: edge-frankfurt, ETag: "a1b2c3", Buffer)

    else Case B: Cache MISS & Tiered Cache Fill
        EdgeRedis-->>EdgeFastify: Return NULL (Cache Miss)
        EdgeFastify->>EdgeFastify: Prometheus: cacheMissesTotal.inc()

        %% Distributed Stampede Lock
        Note over EdgeFastify, EdgeRedis: Distributed Stampede Lock (Thundering Herd Protection)
        EdgeFastify->>EdgeRedis: SET lock:stampede:file-9821:v1 <UUID> NX PX 5000
        
        alt Lock Held by Another Request
            EdgeRedis-->>EdgeFastify: Return 0 (Lock NOT Acquired)
            EdgeFastify->>EdgeFastify: Sleep 500ms (Wait for concurrent fill)
            EdgeFastify->>EdgeRedis: GET binary:file-9821:v1:chunk0
            EdgeRedis-->>EdgeFastify: Return Newly Populated Buffer
            EdgeFastify-->>Client: HTTP 200 OK (Headers: X-Cache: HIT-STAMPEDE-RESOLVED, Buffer)
        else Lock Successfully Acquired
            EdgeRedis-->>EdgeFastify: Return 1 (Lock Acquired)

            %% Tier 1 Fill: Peer Fetch
            Note over EdgeFastify, PeerEdge: Tier 1 Fill: Query Nearest Peer Edge (Virginia)
            EdgeFastify->>PeerEdge: GET /edge/content/file-9821?v=1 (Header: X-Cache-Fill-Mode: peer)
            
            alt Peer Cache Hit
                PeerEdge-->>EdgeFastify: HTTP 200 OK (Peer Buffer Stream)
            else Peer Cache Miss (404 Not Found)
                PeerEdge-->>EdgeFastify: HTTP 404 Not Found

                %% Tier 2 Fill: Core Origin Fetch
                Note over EdgeFastify, S3: Tier 2 Fill: Fetch from Origin Storage (Mumbai)
                EdgeFastify->>CoreNLB: GET /core/content/file-9821 (Header: X-Service-Signature: HMAC-SHA256)
                CoreNLB->>CoreOrigin: Route to Origin Core Pod
                CoreOrigin->>S3: GetObjectStream(bucket="pravah-origin", key="file-9821/v1")
                S3-->>CoreOrigin: Raw S3 Stream
                CoreOrigin-->>EdgeFastify: HTTP 200 OK (Streaming Binary Stream)
            end

            %% Cache Population & Release
            EdgeFastify->>EdgeRedis: SET binary:file-9821:v1:chunk0 <Buffer> EX 86400 (LRU)
            EdgeFastify->>EdgeRedis: DEL lock:stampede:file-9821:v1 (Release Mutex)

            %% Telemetry Dispatch
            EdgeFastify-)Kafka: Produce "cdn.cache_access" (hit=false, fill_source="origin", bytes=262144)
            Kafka-)WS: Telemetry Consumer receives event
            WS-)Dashboard: Emit "metrics:update" (Cache Miss Recorded)

            EdgeFastify-->>Client: HTTP 200 OK (Headers: X-Cache: MISS, X-CDN-Edge: edge-frankfurt, Buffer)
        end
    end
```

---

## 4. Architectural Deep-Dive by Component

### 1. Ingress & Routing Plane
* **AWS Network Load Balancer (NLB)**:
  - Operates at **Layer 4 (TCP)** in the Mumbai central region.
  - Distributes ingress traffic across active Core replicas without decrypting or re-wrapping packets.
  - Bridges public internet clients to private Kubernetes worker node subnets.
* **CDN Geo-Routing Algorithm (`cdnRouter`)**:
  - Extracts client IP from `X-Forwarded-For` or socket address.
  - Resolves client geolocation (Latitude / Longitude).
  - Evaluates distance to all active edge nodes using the **Spherical Haversine Formula**:
    $$d = 2R \arcsin \left( \sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)} \right)$$
  - Filters candidate list against the **Health Monitor**: nodes marked `DEGRADED` or `DOWN` are excluded.
  - Returns an **HTTP 302 Found** redirect pointing the client directly to the chosen edge PoP's Fastify port (`3001`).

---

### 2. Multi-Region Edge Data Plane (`apps/edge`)
* **Fastify Ingress Engine**:
  - Binds to `0.0.0.0:3001` with `keepAliveTimeout: 65000`.
  - Configured for high-throughput stream piping (`res.status(200).end(buffer)`), avoiding V8 buffer copies.
* **Local Redis RAM Cache**:
  - Stores binary chunks under `binary:{fileId}:v{version}:{chunkIndex}`.
  - Enforces `maxmemory-policy: allkeys-lru` — least recently accessed files are evicted when RAM pressure rises.
* **Stampede Protection Mutex**:
  - Implements a distributed lock (`SET lock:stampede:{fileId}:v{version} {uuid} NX PX 5000`).
  - When 1,000 clients simultaneously request an uncached file, **only 1 request acquires the lock** to populate the cache. The remaining 999 requests sleep for 500ms and resolve directly from the newly populated RAM cache, preventing origin collapse.
* **Tiered Cache Fill (`X-Cache-Fill-Mode`)**:
  - **Peer Mode**: Edge nodes query neighboring edges over cloud VPC peer connections before escalating to the Origin.
  - **Origin Mode**: Fallback to Mumbai central MinIO/S3 origin storage.

---

### 3. Fault Tolerance & Self-Healing (Edge Node Crash Scenario)
What happens if an edge node (e.g., Frankfurt) suffers a catastrophic hardware failure?

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          DYNAMIC EDGE CRASH RECOVERY TIMELINE                          │
│                                                                                        │
│   T = 0s               T = 10s              T = 15s                 T = 16s            │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌────────────────┐  │
│  │ Frankfurt    │     │ Core Heartbeat│    │ Consistent Ring │     │ Incoming EU    │  │
│  │ Node Crashes ├────►│ Monitor Misses├────► Ejects Dead     ├────►│ Clients 302 to │  │
│  │ Hardware Halt│     │ Scan (x1)    │     │ 150 Virtual Keys│     │ Next Nearest   │  │
│  └──────────────┘     └──────────────┘     └─────────────────┘     │ (Mumbai/VA)    │  │
│                                                                    └────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Heartbeat Loss**: Frankfurt edge stops transmitting HMAC-SHA256 heartbeats to Mumbai Core NLB.
2. **Dead-Node Detection**: Core `HealthScanner` detects Frankfurt has missed its 10-second interval; updates PostgreSQL and Redis node state to `DOWN`.
3. **Consistent Hash Ring Rebalance**: The Consistent Hashing Ring ejects Frankfurt’s 150 virtual node keys. In accordance with consistent hashing theory:
   $$\text{Keys Remapped} \approx \frac{1}{N} = \frac{1}{3} \approx 33.3\%$$
   The remaining $66.7\%$ of cached files remain unaffected.
4. **Traffic Rerouting**: Future requests from European clients are automatically redirected to the next nearest healthy PoP (e.g., Virginia or Mumbai) with zero 500 errors.

---

### 4. Telemetry, Event Bus & Observability Pipeline

Every request is observed through four coordinated telemetry layers:

```
                          REQUEST EXECUTION ON EDGE
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
 ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
 │ OpenTelemetry │           │  Prometheus   │           │ Apache Kafka  │
 │ (Tracing)     │           │   (Metrics)   │           │ (Event Bus)   │
 └───────┬───────┘           └───────┬───────┘           └───────┬───────┘
         │                           │                           │
         ▼                           ▼                           ▼
  Trace Context               Histogram Bucket            Topic: cdn.cache_access
  (traceparent /              (requestDuration /          (hit, bytes, latency)
  X-Trace-Id)                 cacheHitsTotal)                    │
         │                           │                           ▼
         ▼                           ▼                   ┌───────────────┐
   Jaeger / Tempo                Prometheus              │ WebSocket     │
   Distributed UI             Scrape Endpoint            │ Gateway       │
                             (GET /metrics:3001)         └───────┬───────┘
                                                                 │
                                                                 ▼
                                                         Operator Dashboard
                                                         (Live Hit Ratio & Gbps)
```

1. **OpenTelemetry Distributed Tracing**:
   - Each request generates a W3C trace context (`traceparent` header).
   - Attributes captured: `cdn.file_id`, `cdn.version`, `cdn.cache_state` (`HIT` vs `MISS`), `cdn.bytes_served`, `cdn.edge_id`.
   - Spans propagate across HTTP boundaries via `X-Trace-Id`.
2. **Prometheus Metrics Engine**:
   - `pravah_edge_cache_hits_total`: Counter tracking successful RAM cache hits.
   - `pravah_edge_cache_misses_total`: Counter tracking origin fills.
   - `pravah_edge_bytes_served_total`: Counter tracking delivered bandwidth by source (`ram_cache`, `origin_stream`, `peer_cache`).
   - `pravah_edge_request_duration_seconds`: Histogram with 11 buckets measuring latency percentiles ($p50, p90, p99$).
3. **Kafka (RedPanda) Event Streaming**:
   - Edge asynchronously produces a `cdn.cache_access` JSON payload onto the Kafka cluster.
   - Decoupled from the client response path to guarantee zero latency penalty.
4. **Real-Time WebSocket Gateway (`apps/core`)**:
   - Consumes `cdn.cache_access` events from Kafka.
   - Calculates 1-second rolling hit-ratios and bandwidth offload figures.
   - Broadcasts real-time Socket.io packets to connected browser operators at `dashboard/index.html`.

---

## 5. Summary Matrix: Cache HIT vs Cache MISS

| Metric / Dimension | Cache HIT Path | Cache MISS Path |
| :--- | :--- | :--- |
| **Typical Latency** | **$0.8\text{ms} - 2.5\text{ms}$** | **$45\text{ms} - 180\text{ms}$** (Origin round-trip dependent) |
| **Network Path** | Client $\leftrightarrow$ Local Edge Redis RAM | Client $\rightarrow$ Edge $\rightarrow$ [Peer Edge] $\rightarrow$ Core NLB $\rightarrow$ S3 Origin |
| **I/O Operations** | 1 Redis Memory Read (`getBinary`) | 1 Stampede Lock + 1 S3 Stream Read + 1 Redis Write (`setBinary`) |
| **CPU Impact** | Ultra-low (Zero-copy stream buffer) | Moderate (HTTP stream piping, lock mutex, checksum validation) |
| **Bandwidth Consumption** | Saturated Edge Egress (up to 10 Gbps) | Ingress from Origin + Egress to Client |
| **Headers Returned** | `X-Cache: HIT`, `X-CDN-Edge: <node-id>` | `X-Cache: MISS`, `X-CDN-Edge: <node-id>`, `ETag: "<hash>"` |
| **Telemetry Dispatched** | `hit: true`, `source: "ram_cache"` | `hit: false`, `source: "origin"` |
