# 🌍 Pravah CDN — Terraform Infrastructure

This directory contains the Infrastructure as Code (Terraform) modules and deployment configurations for Pravah CDN across different deployment architectures.

---

## 📁 Directory Structure

```
infra/terraform/
├── ec2-multi-region/              # 1. Multi-Region Standalone EC2 Infrastructure
│   ├── modules/
│   │   ├── core_node/             # Central Origin (Mumbai ap-south-1)
│   │   ├── edge_node/             # Distributed Edge PoPs (Mumbai, Virginia, Frankfurt)
│   │   ├── network/               # Multi-Region VPCs and Subnets
│   │   └── observability/         # Prometheus, Grafana, Jaeger Setup
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── README.md
│
├── eks-load-test/                 # 2. High-Scale EKS Load Benchmark Cluster
│   ├── eks.tf                     # AWS EKS Managed Cluster
│   ├── load-generator.tf          # Distributed k6 / Locust load generators
│   ├── deploy_and_test.sh         # Automated deploy and 100k RPS runner
│   └── BENCHMARK_ANALYSIS.md
│
└── eks-multiregion-deployment/    # 3. Production Multi-Region EKS Deployment
    └── .gitkeep                   # (To be populated with Multi-Geo EKS clusters)
```

---

## 🚀 Deployment Types

| Architecture | Directory | Use Case |
| :--- | :--- | :--- |
| **Multi-Region EC2 PoPs** | `ec2-multi-region/` | Real-world global Point-of-Presence (PoP) edge CDN delivery close to end users in Mumbai, Virginia, and Frankfurt. |
| **EKS Scale Benchmark** | `eks-load-test/` | High-density 100k RPS stress testing and bottleneck verification. |
| **Multi-Region EKS** | `eks-multiregion-deployment/` | Production multi-region Kubernetes clusters with auto-scaling edge pods and central Mumbai core. |
