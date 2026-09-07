# ⚡ Pravah CDN — Performance & Load Testing Suite

This directory contains all automated load testing suites, Grafana k6 scenarios, and performance benchmark reports for Pravah CDN.

---

## 📊 Benchmark Reports

| Report | Environment | Peak Load / Concurrency | Key Results | Status |
|---|---|---|---|---|
| 🏆 [**Multi-Region 100k+ RPS Benchmark Report**](./reports/multiregion_100k_benchmark_report.md) | **AWS EKS Multi-Region (Mumbai, Virginia, Frankfurt)** | **106,000 RPS Sustained Peak** | **2,761,567 requests, 0.0000% Error Rate, Full Edge-to-Core Connectivity** |  **VERIFIED (Current)** |
| 📄 [**Local Microservice Benchmarks**](./reports/local_k6_benchmarks.md) | Local Kind / Docker | 200 Concurrent VUs | 100% Success, Cache Hit: 362 RPS, GeoDNS routing |  Archived |
| 📜 [**Historical Single-Region Load Test**](./reports/aws_eks_100k_load_test.md) | AWS EKS (`ap-south-1`, 2x `t3.medium`) | 2,000 Concurrent VUs | 84,645 reqs delivered, 98.48% Success (Old Baseline) |  Superseded |

---

## 🔬 Test Scenarios (`benchmarks/k6/`)

```
benchmarks/k6/
├── 01_edge_cache_hit.js              # In-memory Redis cached asset delivery
├── 02_geo_routing_throughput.js      # GeoDNS Haversine latency calculation
├── 03_origin_cache_fill.js           # Cache miss & tiered fill from MinIO S3
├── 04_chunked_upload_concurrency.js  # Resumable multipart chunked ingestion
├── 05_byte_range_streaming.js        # HTTP 206 Partial Content video seeking
└── 06_cache_invalidation_under_load.js # Zero-downtime Kafka cache purge
```

### Running Local Benchmarks:
```bash
bash benchmarks/run_all.sh
```

---

## ☁️ Running AWS Multi-Region 100k+ RPS Load Tests:
See [`benchmarks/reports/multiregion_100k_benchmark_report.md`](./reports/multiregion_100k_benchmark_report.md) and [`infra/terraform/eks-multiregion-deployment/`](../infra/terraform/eks-multiregion-deployment/README.md) for full multi-region EKS deployment, cluster topology, and k6 load manifests.
