# Pravah CDN — High-Concurrency AWS EKS Load Test Suite

This directory contains the production Terraform infrastructure and automated load testing pipeline for deploying Pravah CDN to Amazon EKS (`ap-south-1`) and executing stress benchmarks using Grafana k6.

---

## 📊 Benchmark Results

A detailed analysis report is available in [`BENCHMARK_ANALYSIS.md`](./BENCHMARK_ANALYSIS.md).

### Summary Highlights:
- **Total Requests Delivered:** 84,645 requests
- **Success Rate:** **98.48% (83,360 / 84,645 HTTP 200s)**
- **Peak Concurrency:** **2,000 Concurrent Virtual Users (VUs)**
- **Total Payload Delivered:** **993 MB (~1 GB data)**
- **Minimum Latency:** **1.77 ms**

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│                    AWS ap-south-1                    │
│                                                      │
│  ┌─────────────┐     ┌────────────────────────────┐  │
│  │ EC2 Load    │────▶│     EKS Cluster             │  │
│  │ Generator   │     │  ┌────────┐ ┌────────┐     │  │
│  │ (k6 2k VUs) │     │  │Edge x3 │ │Core x3 │     │  │
│  └─────────────┘     │  └────────┘ └────────┘     │  │
│                       │  ┌────┐┌─────┐┌─────┐     │  │
│                       │  │PG  ││Redis││Kafka│     │  │
│                       │  └────┘└─────┘└─────┘     │  │
│                       └────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Commands

### 1. Run Deployment & Test (1-Click)
```bash
bash deploy_and_test.sh
```

### 2. Destroy Everything (Stop Billing)
```bash
bash destroy.sh
```
