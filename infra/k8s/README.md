# Pravah CDN — Kubernetes (K8s) Production Manifests

This directory contains production-grade Kubernetes resource manifests for deploying the Pravah Distributed CDN control plane and edge data planes.

---

## Directory Structure & Execution Order

All manifests are strictly ordered by numeric prefix to guarantee correct dependency resolution:

```
infra/k8s/
├── 00-namespace.yaml             # Dedicated namespace: pravah-system
├── 01-configmap.yaml             # Cluster-wide environment configuration (CORS, URLs, Ports)
├── 02-secrets.yaml               # Sensitive database, S3, and JWT cryptographic credentials
├── 03-rbac.yaml                  # ServiceAccounts, Roles, and RoleBindings for microservices
│
├── 10-postgres-statefulset.yaml  # Central relational metadata store (PostgreSQL 16)
├── 11-redis-cluster.yaml         # In-memory edge cache & distributed mutex lock store
├── 12-redpanda-kafka.yaml        # High-performance event streaming bus (RedPanda)
├── 13-minio-s3.yaml              # Origin object storage (S3-compatible MinIO)
│
├── 20-core-deployment.yaml       # Central Control Plane API deployment (apps/core)
├── 21-core-service.yaml          # Core Service (type: LoadBalancer / ClusterIP)
├── 30-edge-deployment.yaml       # Hub Edge Node deployment (Mumbai ap-south-1)
├── 31-edge-service.yaml          # Edge Service (type: ClusterIP on port 3001)
├── 32-spoke-edge-deployment.yaml # Spoke Edge Node deployment (Virginia & Frankfurt)
│
├── 40-edge-hpa.yaml              # Horizontal Pod Autoscaler for Edge (CPU/Memory/RPS targets)
├── 41-core-hpa.yaml              # Horizontal Pod Autoscaler for Core Control Plane
│
├── 50-ingress.yaml               # Ingress router (Nginx / ALB path-based routing)
├── 51-network-policy.yaml        # Zero-trust network segmentation between pods
│
└── benchmarks/                   # Distributed k6 load testing jobs & manifests
    ├── 60-k6-benchmark-job.yaml  # Baseline 100k RPS k6 load generator
    ├── 61-k6-mumbai-*.yaml       # Mumbai hub load generator stages (34k to 55k RPS)
    └── 62-k6-spoke-*.yaml        # Spoke cluster load generator stages (22k to 36k RPS)
```

---

## Deployment Instructions

### 1. One-Command Cluster Rollout
```bash
# Apply all manifests in numerical order
kubectl apply -f infra/k8s/
```

### 2. Verify Pod Health
```bash
kubectl get pods -n pravah-system -o wide
```

Expected output:
```
NAME                                   READY   STATUS    RESTARTS   AGE
pravah-core-7f8d4bb8c5-x9z2p           1/1     Running   0          5m
pravah-edge-5c74996b7d-m4n8k           1/1     Running   0          5m
postgres-0                             1/1     Running   0          6m
redis-0                                1/1     Running   0          6m
redpanda-0                             1/1     Running   0          6m
minio-0                                1/1     Running   0          6m
```

### 3. Check Services & Ingress
```bash
kubectl get svc -n pravah-system
```

---

## Running Distributed k6 Load Tests

Benchmark manifests are located in [`infra/k8s/benchmarks/`](./benchmarks/):

```bash
# Deploy a distributed k6 load generator job targeting the Edge ingress
kubectl apply -f infra/k8s/benchmarks/60-k6-benchmark-job.yaml

# Stream live benchmark output
kubectl logs -f job/k6-load-test -n pravah-system
```

---

## Operations & Troubleshooting

* **Restart Edge Service:**
  ```bash
  kubectl rollout restart deployment/pravah-edge -n pravah-system
  ```
* **View Real-Time Logs:**
  ```bash
  kubectl logs -f -l app=pravah-edge -n pravah-system --tail=100
  ```
* **Port-Forward to Edge for Local Testing:**
  ```bash
  kubectl port-forward -n pravah-system svc/pravah-edge-service 3001:3001
  ```
