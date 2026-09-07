# Pravah Route Computational Hierarchy & Bandwidth Saturation Analysis

> **Date:** September 7, 2026  
> **Status:** REFERENCE SPECIFICATION & BENCHMARK GUIDANCE  
> **Scope:** `apps/edge`, `apps/core`, Ingress/Egress Network Layers, Linux Kernel & V8 Runtime  
> **Classification:** High-Performance Distributed Systems Architecture  

---

## 1. Executive Summary

In high-concurrency distributed systems, **Throughput** cannot be measured by a single metric. A system's performance boundaries are governed by two distinct dimensions:
1. **Transaction Throughput (RPS - Requests Per Second)**: The number of distinct HTTP request/response lifecycles the CPU event loop, container networking, and operating system kernel can process per second.
2. **Data / Bandwidth Throughput (Egress Bitrate - MB/s or Gbps)**: The total volume of payload bytes the Network Interface Card (NIC), TCP stack, and physical wire transmit per second.

Having successfully benchmarked Pravah's Edge ingress layer to **106,000 RPS peak sustained with 0.0000% error rate** on `GET /health` across a 3-continent AWS EKS architecture, this document establishes a rigorous computational taxonomy of all routes in Pravah. 

It analyzes the trade-off between payload weight, I/O boundaries, and hardware saturation, demonstrating why **heavier payload routes consume drastically higher network bandwidth even at lower request rates**, and explains the architectural mechanics of how optimizing deeper system bottlenecks directly elevates the headroom for lighter routes.

---

## 2. Global Route Hierarchy: Lightest to Heaviest

The following matrix ranks the endpoints across `apps/edge` and `apps/core` from lowest computational and I/O cost (#1) to highest resource exhaustion (#12):

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PRAVAH ROUTE COMPLEXITY SPECTRUM                         │
│                                                                                          │
│  [Lightest] ───────────────────────────────────────────────────────────────► [Heaviest]  │
│                                                                                          │
│  /health      /purge     /metrics     /metadata     /:fileId      /heartbeat     /login  │
│  (In-Mem)    (Redis DEL)  (Prom-Dump)   (Cache/DB)   (RAM Stream)   (HMAC+DB)    (Bcrypt) │
│    │             │           │             │             │              │           │    │
│  106k RPS     40k RPS     12k RPS       15k RPS       12k RPS        5k RPS      1.2k RPS│
│  19 MB/s      2 MB/s      216 MB/s      9 MB/s        1.5 GB/s       0.6 MB/s    0.4 MB/s│
│                                                                                          │
│  ───────► [Tier 5: Distributed Cache Miss & Multipart] ──► [Tier 6: FFmpeg Transcoding]   │
│             /:fileId (MinIO Fetch) / /upload/chunk          Video Transcoding Worker     │
│             ~500 RPS | 2.5 GB/s (Disk/Network I/O)          1-4 Jobs | 100% Multi-Core   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Comprehensive Route Comparison Matrix

| Rank / Tier | Route & Method | Service | Primary Workload & Subsystems | Payload Wire Size | Estimated Max RPS (per 8 vCPUs) | Bandwidth Profile (Peak Egress) | Primary Hardware Bottleneck |
| :---: | :--- | :---: | :--- | :---: | :---: | :---: | :--- |
| **#1 (Lightest)** | `GET /health` | `apps/edge` | In-memory pointer return. Pre-cached timestamp. Zero I/O, zero DB, zero heap allocation. | **~180 B** | **~106,000 RPS** *(Verified)* | **~19.08 MB/s** (~152 Mbps) | Linux `nf_conntrack`, TCP PPS (Packets/Sec) |
| **#2** | `POST /:fileId/purge` | `apps/edge` | Direct Redis `DEL` command via socket connection. No DB interaction. | **~50 B** | **~35,000 – 45,000 RPS** | **~2.1 MB/s** (~17 Mbps) | Redis TCP connection multiplexing & event loop |
| **#3** | `GET /metrics` | `apps/edge` | No DB/disk, but CPU-bound Prometheus registry serialization, counter iteration, and V8 heap string concatenation. | **~18 KB** | **~8,000 – 14,000 RPS** | **~216 MB/s** (~1.73 Gbps) | **Network Bandwidth (Gbps) & V8 Garbage Collection** |
| **#4** | `GET /metadata/files/:fileId` | `apps/core` | Read-through cache. Redis `GET` hit; falls back to single indexed row lookup in PostgreSQL via Prisma. | **~600 B** | **~12,000 – 20,000 RPS** | **~10.8 MB/s** (~86 Mbps) | PostgreSQL connection pool size & Prisma serialization |
| **#5** | `GET /:fileId` *(Cache HIT)* | `apps/edge` | Reads binary chunk from local Redis RAM, dispatches Kafka access event, streams raw buffer to HTTP response. | **~256 KB** (Segment Chunk) | **~8,000 – 16,000 RPS** | **~2.04 GB/s** (~16.3 Gbps) | **NIC Bandwidth & Socket Buffer Saturation** |
| **#6** | `GET /:fileId/hls/manifest.m3u8`| `apps/edge` | In-memory / Redis cache text stream of HLS master or variant playlists. | **~1.5 KB** | **~15,000 – 25,000 RPS** | **~30 MB/s** (~240 Mbps) | Event loop string streaming & socket backpressure |
| **#7** | `POST /common/health-check/heartbeat` | `apps/core` | HMAC-SHA256 cryptographic verification (`timingSafeEqual`) + PostgreSQL `UPDATE edge_nodes` timestamp write. | **~120 B** | **~3,000 – 6,000 RPS** | **~0.6 MB/s** (~5 Mbps) | Database row-level write locks & connection contention |
| **#8** | `POST /auth/login` | `apps/core` | User DB query + **Bcrypt password hash calculation (Blowfish 10 rounds)** + asymmetric JWT signing. | **~350 B** | **~800 – 1,800 RPS** | **~0.4 MB/s** (~3.5 Mbps) | **CPU Compute (Bcrypt deliberately exhausts CPU cores)** |
| **#9** | `GET /:fileId` *(Cache MISS)* | `apps/edge` | Distributed Redis stampede lock + MinIO S3 origin fetch over network + Redis cache population + client stream. | **~1 MB – 5 MB** | **~250 – 800 RPS** | **~1.2 GB/s** (~9.6 Gbps) | Inter-service network latency, MinIO throughput, Disk I/O |
| **#10** | `PUT /upload/:fileId/chunk/:index`| `apps/core` | Streaming 5MB multipart binary chunk -> MinIO S3 streaming upload -> write chunk status to PostgreSQL. | **~5 MB** (Ingress) | **~100 – 350 RPS** | **~1.25 GB/s** (Ingress saturation) | Ingress network pipe, disk write throughput |
| **#11** | `POST /upload/complete` | `apps/core` | S3 multipart assembly API call + full-file SHA-256 integrity checksum calculation over gigabytes + Kafka event trigger. | **~300 B** | **~20 – 60 RPS** | Low Egress, High Storage IOPS | Disk read speed for hash checksum computation |
| **#12 (Heaviest)**| Transcoding Pipeline Worker | `apps/core` | **FFmpeg Subprocess Execution**: Decodes raw video, re-encodes into 1080p, 720p, 480p H.264/AAC, segments into `.ts` chunks. | **Multi-Gigabyte Video**| **~1 – 4 Concurrent Jobs** | High Disk/Storage I/O | **100% CPU multi-core & GPU encoder saturation** |

---

## 3. Deep-Dive Comparison: `GET /health` vs `GET /metrics`

The relationship between `GET /health` and `GET /metrics` is the textbook illustration of **Transaction Rate (RPS)** vs **Bandwidth Rate (Gbps)**:

```
                            BANDWIDTH VS RPS TRADE-OFF
   Throughput (Gbps)
        ▲
 2.0 G ─┤                                         ● /metrics (12,000 RPS @ 18 KB)
        │                                           High Bandwidth / Moderate RPS
 1.5 G ─┤
        │
 1.0 G ─┤
        │
 0.5 G ─┤
        │  ● /health (106,000 RPS @ 180 B)
 0.1 G ─┴──┴──────────────────────────────────────────────────────► Transaction Rate (RPS)
           0       20k      40k      60k      80k     100k    120k
```

### Mathematical Wire Analysis

#### 1. Ingress Health Check (`GET /health`)
- **Payload**: `{"status":"ok","service":"pravah-edge","timestamp":"..."}`
- **Average Wire Size**: 180 bytes (including HTTP headers).
- **At 106,000 RPS**:
  $$\text{Bandwidth} = 106,000 \text{ req/s} \times 180 \text{ bytes} = 19,080,000 \text{ B/s} \approx \mathbf{19.08 \text{ MB/s}} \ (\mathbf{152.64 \text{ Mbps}})$$
- **Hardware Bottleneck**: Packet processing overhead in the Linux kernel (`iptables`, `conntrack`, SoftIRQs). The network card's bandwidth is operating at barely **3%** of its capacity.

#### 2. Prometheus Telemetry (`GET /metrics`)
- **Payload**: Comprehensive diagnostic dump containing default Node.js V8 heap metrics, GC pause durations, event loop lag, and Pravah custom Prometheus counters/histograms with 11 latency buckets.
- **Average Wire Size**: ~18,000 bytes (18 KB).
- **At 12,000 RPS**:
  $$\text{Bandwidth} = 12,000 \text{ req/s} \times 18,000 \text{ bytes} = 216,000,000 \text{ B/s} \approx \mathbf{216 \text{ MB/s}} \ (\mathbf{1.728 \text{ Gbps}})$$
- **Hardware Bottleneck**: **Physical NIC Bandwidth and V8 Garbage Collection**. 
  - An AWS `t3.large` instance has a baseline network bandwidth cap of ~1 Gbps to 5 Gbps burst.
  - At just 12,000 RPS, `/metrics` consumes **1.7 Gbps**, which is **11.3x more network bandwidth** than `/health` at 106,000 RPS!
  - If a load test attempted to push `/metrics` to 50,000 RPS, it would require $\approx 7.2 \text{ Gbps}$, causing immediate AWS packet dropping and socket disconnects due to network interface card throttling.

---

## 4. Why `POST /auth/login` is Computationally "Heavy" Despite a Tiny Payload

A common pitfall in system design is equating "heavy" solely with payload byte size. 

Endpoint `POST /auth/login` returns a microscopic JWT response (~350 bytes), yet it is **~100x heavier computationally than `/health`**:

1. **Bcrypt Work Factor**: Bcrypt uses an intentionally expensive key derivation function (Eksblowfish). At work factor 10, verifying a single password executes $2^{10} = 1,024$ rounds of cryptographic key expansion.
2. **CPU Core Blocking**: A single Bcrypt verification consumes approximately **45ms to 80ms of dedicated CPU time**.
3. **Throughput Ceiling**:
   - On a single-threaded Node.js worker, 1 CPU core can process at most:
     $$\text{Max Throughput} = \frac{1000\text{ ms}}{60\text{ ms}} \approx 16.6 \text{ requests per second per core}$$
   - Even with an 8-vCPU cluster, `POST /auth/login` naturally saturates between **800 and 1,800 RPS**, reaching 100% CPU utilization while pushing less than **0.5 MB/s of bandwidth**.

---

## 5. The Compound Scaling Law: Why Scaling Heavy Routes Expands Light Route Capacity

Optimizing a "heavy" route does not just make that single endpoint faster; it directly elevates the performance ceiling of all other routes across the microservice. This occurs due to four shared-runtime dynamics:

### 1. V8 Event Loop Lag Reduction
In Node.js / NestJS, all routes share the same single-threaded V8 event loop. When a heavy route performs unoptimized string operations, large JSON parses, or synchronous buffer copies, it blocks the event loop for 10ms–50ms. During this blockage, incoming `/health` or `/metrics` requests queue in the OS kernel backlog (`SOMAXCONN`). Eliminating blocking operations in heavy routes reduces event loop lag to $< 1\text{ms}$, allowing `/health` to reach six-figure RPS.

### 2. Garbage Collection (GC) Pressure & Heap Allocations
When heavy routes allocate multi-megabyte temporary buffers or large strings, V8 triggers frequent **Scavenge (Minor GC)** and **Mark-Sweep-Compact (Major GC)** cycles. Major GC pauses ("Stop-the-World") halt all incoming request processing. Optimizing heavy routes with stream piping and buffer reuse eliminates GC pauses across the entire process.

### 3. Linux Ephemeral Port & Conntrack Conservation
When heavy routes make outbound calls (to Redis, PostgreSQL, or S3), they open outbound TCP sockets. If connections are not pooled with HTTP Keep-Alive or connection multiplexing, sockets enter `TIME_WAIT` state, exhausting Linux ephemeral ports (`net.ipv4.ip_local_port_range`) and overflowing `nf_conntrack`. By tuning connection pooling on heavy routes, the kernel maintains maximum capacity to accept inbound ingress connections.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      SHARED RUNTIME COUPLING                           │
│                                                                        │
│   Heavy Route Optimization                 System-Wide Impact          │
│  ┌─────────────────────────┐              ┌─────────────────────────┐  │
│  │ Zero-Copy Stream Buffers├─────────────►│ Zero GC Pauses in V8    │  │
│  └─────────────────────────┘              └───────────┬─────────────┘  │
│  ┌─────────────────────────┐                          │                │
│  │ Connection Pool Reuse   ├─────────────►            ▼                │
│  └─────────────────────────┘              ┌─────────────────────────┐  │
│  ┌─────────────────────────┐              │ Light Route Headroom    │  │
│  │ Asynchronous DB I/O     ├─────────────►│ Expands (106k -> 150k+) │  │
│  └─────────────────────────┘              └─────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Strategic Next Target: The CDN Edge Cache Hit (`GET /:fileId`)

Having demonstrated network and ingress mastery with `GET /health` (106k RPS), the most impactful route to benchmark and scale next is:

$$\mathbf{GET \ /:fileId \ \text{(Edge RAM Cache Hit)}}$$

### Why This Is the Gold Standard for Pravah:
1. **Validates CDN Core Value Proposition**: Proves Pravah operates as an ultra-low latency Content Delivery Network capable of serving cached media directly from memory at line speed.
2. **Stresses High-Bandwidth Streaming**: Delivers 256 KB – 1 MB video chunks, shifting the benchmark from purely packet rate (PPS) to **Multi-Gigabit Network Throughput (10 Gbps+)**.
3. **Exercised Components**:
   - Local Redis RAM binary cache retrieval (`edgeCacheService.getBinary`).
   - Fastify binary buffer streaming without chunk copying.
   - Asynchronous OpenTelemetry tracing and Kafka access event logging.

---

## 7. Recommended Local Profiling & Benchmark Roadmap ($0 AWS Cost)

Before launching any cloud infrastructure, all optimizations should be developed and verified locally:

1. **Phase 1: Local Docker Container Setup**
   - Start Edge node and Redis in Docker on `localhost`.
   - Seed a 256 KB test video segment into Redis cache.
2. **Phase 2: Local Load Profiling**
   - Run Autocannon or local k6 against `http://localhost:3000/:fileId?v=1`.
   - Profile event loop latency with `clinic.js` or Node `--prof`.
   - Eliminate any buffer-to-string conversions or blocking serialization.
3. **Phase 3: Production Cloud Multi-Region Verification**
   - Once the local route sustains $> 15,000\text{ RPS}$ per container, provision the AWS EKS multi-region topology for a targeted 15-minute verification run.
   - Benchmark across Mumbai, Virginia, and Frankfurt, capture telemetry, and execute immediate automated teardown.
