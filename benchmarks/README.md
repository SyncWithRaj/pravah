# ⚡ Pravah CDN — Performance & Load Testing Suite

This directory contains all automated load testing suites, Grafana k6 scenarios, and performance benchmark reports for Pravah CDN.

---

## 📊 Benchmark Reports

| Report | Environment | Peak Load / Concurrency | Key Results |
|---|---|---|---|
| 📄 [**Local Microservice Benchmarks**](./reports/local_k6_benchmarks.md) | Local Kind / Docker | 200 Concurrent VUs | 100% Success, Cache Hit: 362 RPS, GeoDNS routing |
| 🚀 [**AWS EKS 100K RPS Load Test**](./reports/aws_eks_100k_load_test.md) | AWS EKS (`ap-south-1`) | 2,000 Concurrent VUs | 84,645 reqs delivered, 98.48% Success, **1.77ms min latency** |

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

## ☁️ Running AWS Cloud Load Tests:
See [`infra/terraform/eks-load-test/`](../infra/terraform/eks-load-test/README.md) for 1-click cloud provisioning and automated k6 runner.
