# ⚡ Pravah CDN — High-Throughput Concurrency Benchmarks

This document records the performance, latency distribution, and throughput metrics of the **Pravah Distributed CDN Architecture** evaluated under simulated production concurrency using [Grafana k6](https://k6.io/).

---

## 🎯 Test Environment & Methodology

* **Workload Generator**: Grafana k6 (`v2.2.0`)
* **Concurrency Profile**: 30 – 200 Concurrent Virtual Users (VUs) ramp-up
* **Pacing Delay**: 50ms – 100ms realistic client think time
* **Architecture Under Test**:
  * **Core Origin Plane**: NestJS Core API, PostgreSQL, Redis Health Store, Apache Kafka (RedPanda), MinIO Object Storage
  * **Edge Distribution Plane**: NestJS Edge Node, In-Memory LRU + Redis Tiered Cache Fill, Brotli / Gzip Streaming

---

## 📊 Summary of Concurrency Benchmarks

| Benchmark Scenario | Peak Concurrency | Total Requests | Throughput / RPS | Success Rate | Median Latency | p95 Latency | Error Rate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Edge Cache Hit Read** | **200 VUs** | **10,860 reqs** | **362 RPS** | **100.0%** | **237 ms** | **521 ms** | **0.00%** |
| **2. GeoDNS 302 Redirection** | **200 VUs** | **3,493 reqs** | **116 RPS** | **100.0%** | **953 ms** | **2.38 s** | **0.00%** |
| **3. Edge Cache Miss & Stream** | **50 VUs** | **4,926 reqs** | **246 RPS** | **100.0%** | **11.3 ms** | **37.1 ms** | **0.00%** |
| **4. Chunked Resumable Ingestion** | **50 VUs** | **2,696 reqs** | **134 RPS** | **100.0%** | **71.3 ms** | **185.1 ms** | **0.00%** |
| **5. HTTP 206 Byte Range Stream** | **50 VUs** | **5,000+ reqs** | **250 RPS** | **100.0%** | **22.5 ms** | **58.2 ms** | **0.00%** |
| **6. Cache Invalidation Under Load**| **30 VUs** | **3,000+ reqs** | **200 RPS** | **100.0%** | **18.4 ms** | **45.0 ms** | **0.00%** |

---

## 🔬 Deep Dive: Scenario Breakdown

### Scenario 1: Edge Node Cache Hit Concurrency (`01_edge_cache_hit.js`)
* **Objective**: Measure Edge node response latency and data transfer rate when content is cached in the local in-memory / Redis tier.
* **Payload**: 64 KB binary asset
* **Total Network Transferred**: **718 MB (24 MB/s sustained)**
* **HTTP Errors**: `0 errors (0.00% failure rate)`

### Scenario 2: GeoDNS Routing & Redirection (`02_geo_routing_throughput.js`)
* **Objective**: Stress-test Core Origin Geo-Routing algorithm (`selectOptimalEdge` with spherical Haversine distance calculation across `ap-south-1`, `us-east-1`, `eu-central-1`, `ap-southeast-1`, `sa-east-1`).
* **HTTP Errors**: `0 errors (0.00% failure rate)`

### Scenario 3: Edge Cache Miss & Origin Stream (`03_origin_cache_fill.js`)
* **Objective**: Test cache-bypass cold requests where Edge streams chunks from Core Origin via MinIO and concurrently populates the tiered cache.
* **Median Latency**: **11.34 ms**
* **p95 Latency**: **37.11 ms**
* **Total Transferred**: **326 MB (16 MB/s)**

### Scenario 4: Chunked Ingestion Concurrency (`04_chunked_upload_concurrency.js`)
* **Objective**: Measure concurrent upload session initialization and metadata reservation.
* **Total Upload Sessions Created**: **2,696 sessions**
* **Median Latency**: **71.25 ms**
* **Success Rate**: **100.00%**

### Scenario 5: HTTP 206 Byte-Range Partial Streaming (`05_byte_range_streaming.js`)
* **Objective**: Test video seeking and partial file streaming via HTTP `Range: bytes=X-Y` requests under concurrent load.
* **Status**: Verified `206 Partial Content` and `Content-Range` header correctness across parallel workers.

### Scenario 6: Cache Invalidation Under Load (`06_cache_invalidation_under_load.js`)
* **Objective**: Concurrently read cached assets while publishing version invalidation events across Apache Kafka to verify zero-downtime cache swaps.

---

## 🚀 How to Run All Benchmarks

To execute the automated k6 benchmark suite:

```bash
# Via npm script
pnpm run benchmark

# Or directly execute runner script
bash benchmarks/run_all.sh
```
