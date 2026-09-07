# ⚡ Pravah CDN — Kubernetes k6 Distributed Load Testing Jobs

This directory contains containerized **k6 distributed load testing jobs** designed to run inside Kubernetes clusters directly targeting the Edge Data Plane without SSH or external network bottlenecks.

---

## 📁 Manifest Directory

```
infra/k8s/benchmarks/
├── 60-k6-benchmark-job.yaml   # Baseline distributed k6 benchmark runner
│
├── 61-k6-mumbai-34k.yaml      # Mumbai Hub: 4 k6 pods @ 350 maxVUs (Target: 34,000 RPS)
├── 61-k6-mumbai-40k.yaml      # Mumbai Hub: 4 k6 pods @ 450 maxVUs (Target: 40,000 RPS)
├── 61-k6-mumbai-45k.yaml      # Mumbai Hub: 4 k6 pods @ 500 maxVUs (Target: 45,000 RPS)
├── 61-k6-mumbai-55k.yaml      # Mumbai Hub: 5 k6 pods @ 1,000 maxVUs (Trial 4 conntrack test)
│
├── 62-k6-spoke-22k.yaml       # Spoke Cluster: 4 k6 pods @ 300 maxVUs (Target: 22,000 RPS)
├── 62-k6-spoke-30k.yaml       # Spoke Cluster: 4 k6 pods @ 400 maxVUs (Target: 30,000 RPS)
├── 62-k6-spoke-32k.yaml       # Spoke Cluster: 4 k6 pods @ 450 maxVUs (Target: 32,000 RPS)
├── 62-k6-spoke-35k.yaml       # Spoke Cluster: 4 k6 pods @ 480 maxVUs (Target: 35,000 RPS)
└── 62-k6-spoke-36k.yaml       # Spoke Cluster: 4 k6 pods @ 500 maxVUs (Target: 36,000 RPS - Trial 5 Winner)
```

---

## 🏆 The 106,000 RPS Winning Formula (Trial 5 Configuration)

To achieve **106,000 sustained RPS with 0.0000% error rate** across Mumbai, Virginia, and Frankfurt:

| Region | Cluster Role | Load Generator Manifest | k6 Pods | maxVUs per Pod | Target RPS | Result |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **Mumbai (`ap-south-1`)** | Central Hub | `61-k6-mumbai-34k.yaml` | 4 | 350 | ~34,000 RPS | **34,000 RPS (0 errors)** |
| **Virginia (`us-east-1`)** | Western Spoke | `62-k6-spoke-36k.yaml` | 4 | 500 | ~36,000 RPS | **36,000 RPS (0 errors)** |
| **Frankfurt (`eu-central-1`)**| European Spoke | `62-k6-spoke-36k.yaml` | 4 | 500 | ~36,000 RPS | **36,000 RPS (0 errors)** |
| **GLOBAL TOTAL** | **3 Continents** | **Distributed Mesh** | **12 Pods** | **--** | **106,000 RPS** | **106,000 RPS (0.0000% Errors)** |

---

## 🚀 Execution Guide

### Launching in Mumbai (Hub)
```bash
kubectl apply -f infra/k8s/benchmarks/61-k6-mumbai-34k.yaml
```

### Launching in Virginia or Frankfurt (Spoke)
```bash
kubectl apply -f infra/k8s/benchmarks/62-k6-spoke-36k.yaml
```

### Deleting Jobs After Completion
```bash
kubectl delete -f infra/k8s/benchmarks/61-k6-mumbai-34k.yaml
kubectl delete -f infra/k8s/benchmarks/62-k6-spoke-36k.yaml
```
