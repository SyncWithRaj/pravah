# Pravah CDN — Infrastructure Architecture & Automation

This directory contains the core infrastructure automation, container packaging, orchestration manifests, and Infrastructure as Code (IaC) tooling powering the Pravah Distributed CDN.

---

## Infrastructure Layers

```
infra/
├── docker/                    # Containerization & Local Development
│   ├── Dockerfile.*           # Multi-stage production containers with BuildKit cache mounts
│   ├── docker-compose.*       # Independent Core & Edge Compose service stacks
│   └── deploy-*.sh            # Production EC2 deployment scripts
│
├── k8s/                       # Kubernetes Production Orchestration
│   ├── 00-namespace.yaml      # Cluster namespace, configmaps, secrets, and RBAC
│   ├── 10-13 (Data Plane)     # PostgreSQL, Redis, RedPanda (Kafka), and MinIO (S3)
│   ├── 20-32 (Microservices)  # Core Control Plane and Multi-Region Edge Deployments
│   ├── 40-41 (Autoscaling)    # Horizontal Pod Autoscalers (HPA)
│   ├── 50-51 (Networking)     # Ingress path routing and zero-trust NetworkPolicies
│   └── benchmarks/            # Containerized k6 distributed load testing jobs
│
├── helm/                      # Cloud-Native Packaging
│   └── pravah-cdn/            # Production Helm chart (Chart.yaml & values.yaml)
│
└── terraform/                 # Cloud Infrastructure as Code (IaC)
    ├── ec2-multi-region/      # Standalone multi-region EC2 PoP infrastructure
    ├── eks-load-test/         # Historical single-region EKS benchmark cluster
    └── eks-multiregion-deployment/ # Production Multi-Region EKS Mesh (106k RPS Verified)
```

---

## Tooling Matrix & Usage Lifecycle

| Development Stage | Recommended Layer | Path | Execution Command |
| :--- | :--- | :--- | :--- |
| **Local Development** | Docker Compose | [`infra/docker/`](./docker/README.md) | `make dev` |
| **Kubernetes Validation** | K8s Manifests / Kind | [`infra/k8s/`](./k8s/README.md) | `bash scripts/k8s/start_cluster.sh` |
| **Cloud-Native Deployment** | Helm | [`infra/helm/`](./helm/README.md) | `helm upgrade --install pravah ./infra/helm/pravah-cdn` |
| **Multi-Region Cloud (AWS)**| Terraform (EKS Mesh) | [`infra/terraform/`](./terraform/README.md) | `terraform -chdir=infra/terraform/eks-multiregion-deployment apply` |
| **Distributed Benchmarking**| K8s k6 Jobs | [`infra/k8s/benchmarks/`](./k8s/benchmarks/README.md) | `kubectl apply -f infra/k8s/benchmarks/61-k6-mumbai-34k.yaml` |

---

## Subsystem Documentation

* [Docker & Container Packaging](./docker/README.md)
* [Kubernetes Manifests & Orchestration](./k8s/README.md)
* [Distributed k6 Load Testing Benchmarks](./k8s/benchmarks/README.md)
* [Helm Cloud-Native Packaging](./helm/README.md)
* [Terraform Multi-Region Infrastructure as Code](./terraform/README.md)
