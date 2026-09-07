# Pravah CDN — Performance and Load Testing Suite

This directory contains automated load testing suites, distributed Grafana k6 scenarios, and performance benchmark reports for the Pravah Distributed CDN.

---

## Benchmark Reports

| Report | Target Environment | Peak Load / Concurrency | Key Results | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| [**Multi-Region 100k+ RPS Benchmark Report**](./reports/multiregion_100k_benchmark_report.md) | AWS EKS Multi-Region (Mumbai, Virginia, Frankfurt) | **106,000 RPS Sustained Peak** | **2,761,567 requests, 0.0000% Error Rate, Full Edge-to-Core HMAC Telemetry** | Verified Production Reference |
| [**Local Microservice Benchmarks**](./reports/local_k6_benchmarks.md) | Local Kind / Docker | 200 Concurrent VUs | 100% Success, Cache Hit: 362 RPS, GeoDNS routing | Archived Local Baseline |
| [**Historical Single-Region Load Test**](./reports/aws_eks_100k_load_test.md) | AWS EKS (Mumbai, 2x t3.medium) | 2,000 Concurrent VUs | 84,645 requests delivered, 98.48% Success | Superseded Single-Region Baseline |

---

## Test Scenarios (`benchmarks/k6/`)

```
benchmarks/k6/
├── 01_edge_cache_hit.js              # In-memory Redis cached asset delivery
├── 02_geo_routing_throughput.js      # GeoDNS Haversine latency calculation
├── 03_origin_cache_fill.js           # Cache miss and tiered fill from MinIO S3
├── 04_chunked_upload_concurrency.js  # Resumable multipart chunked ingestion
├── 05_byte_range_streaming.js        # HTTP 206 Partial Content video seeking
└── 06_cache_invalidation_under_load.js # Zero-downtime Kafka cache purge
```

---

## Local Benchmark Execution

All 6 scenarios can be executed locally against a running development stack:

### 1. Run Complete Local Suite
```bash
# Uses local k6 CLI if installed, or falls back to grafana/k6 Docker container
bash benchmarks/run_all.sh
```

### 2. Run an Individual Scenario
```bash
# Example: Testing in-memory edge cache hits with 200 VUs
k6 run benchmarks/k6/01_edge_cache_hit.js \
  -e CORE_URL="http://localhost:3000" \
  -e EDGE_URL="http://localhost:3001" \
  -e FILE_ID="<file-id>" \
  -e AUTH_TOKEN="<jwt-token>"
```

---

## In-Cluster Kubernetes Benchmark Execution

For cloud-scale multi-region testing without client-side bandwidth or socket bottlenecks, containerized k6 jobs run directly inside Kubernetes clusters:

```bash
# Mumbai Hub Cluster (Target: 34,000 RPS)
kubectl apply -f infra/k8s/benchmarks/61-k6-mumbai-34k.yaml

# Virginia or Frankfurt Spoke Cluster (Target: 36,000 RPS each)
kubectl apply -f infra/k8s/benchmarks/62-k6-spoke-36k.yaml
```

For complete deployment details and telemetry analysis, refer to [multiregion_100k_benchmark_report.md](./reports/multiregion_100k_benchmark_report.md).
