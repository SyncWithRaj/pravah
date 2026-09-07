# 🌍 Pravah CDN — Terraform Infrastructure as Code (IaC)

This directory contains production Infrastructure as Code (Terraform) modules and deployment blueprints for the **Pravah Distributed CDN** across multiple cloud topologies.

---

## 📁 Directory Structure

```
infra/terraform/
├── ec2-multi-region/              # 1. Multi-Region Standalone EC2 Infrastructure
│   ├── modules/
│   │   ├── core_node/             # Central Origin Control Plane (Mumbai ap-south-1)
│   │   ├── edge_node/             # Distributed Edge PoPs (Mumbai, Virginia, Frankfurt)
│   │   ├── network/               # Multi-Region VPCs, Subnets, and Peering
│   │   └── observability/         # Prometheus, Grafana, Jaeger Setup
│   ├── main.tf                    # Root multi-region module orchestration
│   ├── variables.tf               # Instance sizing, AWS regions, CIDR ranges
│   ├── outputs.tf                 # Public IPs, Web Console URLs, and API endpoints
│   ├── terraform.tfvars.example   # Example configuration variables
│   └── README.md
│
├── eks-load-test/                 # 2. Historical Single-Region EKS Benchmark
│   ├── vpc.tf                     # High-throughput benchmark VPC
│   ├── eks.tf                     # AWS EKS Managed Cluster (2x t3.medium)
│   ├── load-generator.tf          # Distributed k6 load generator instances
│   ├── deploy_and_test.sh         # Automated deploy and 100k RPS runner
│   ├── destroy.sh                 # Cluster teardown script
│   ├── BENCHMARK_ANALYSIS.md      # Historical single-region benchmark analysis
│   └── README.md
│
└── eks-multiregion-deployment/    # 3. Production Multi-Region EKS Architecture (106k RPS)
    ├── eks_mumbai.tf              # Hub Cluster (ap-south-1): 5 nodes (10 vCPUs), PostgreSQL, Kafka, MinIO, Core NLB
    ├── eks_virginia.tf            # Spoke Cluster (us-east-1): 4 nodes (8 vCPUs), 8 Edge Replicas
    ├── eks_frankfurt.tf           # Spoke Cluster (eu-central-1): 4 nodes (8 vCPUs), 8 Edge Replicas
    ├── network.tf                 # 3 Independent VPCs, Public/Private Subnets, NAT Gateways, EIPs
    ├── ecr.tf                     # AWS Elastic Container Registry repositories
    ├── load_generator.tf          # Distributed k6 benchmark runner EC2 instances
    ├── providers.tf               # Multi-region AWS providers (mumbai, virginia, frankfurt)
    ├── variables.tf               # Node sizing, quota tuning, cluster versions
    ├── outputs.tf                 # Cluster endpoints, Load Balancers, and kubeconfig helpers
    ├── terraform.tfvars.example   # Regional CIDR and instance configuration template
    └── README.md                  # Comprehensive multi-region guide
```

---

## 🚀 Deployment Topologies

| Architecture | Directory | Regions | Primary Use Case & Milestone | Status |
| :--- | :--- | :---: | :--- | :---: |
| **Multi-Region EC2 PoPs** | [`ec2-multi-region/`](./ec2-multi-region/README.md) | 🇮🇳 Mumbai<br/>🇺🇸 Virginia<br/>🇩🇪 Frankfurt | **Phase 6:** Real-world global Point-of-Presence (PoP) edge CDN delivery close to end users with measured geographic latency. | ✅ Validated |
| **Single-Region EKS Test**| [`eks-load-test/`](./eks-load-test/README.md) | 🇮🇳 Mumbai | **Phase 8B:** Initial cloud stress testing on Kubernetes with 2,000 VUs and HPA verification. | 📜 Historical Baseline |
| **Multi-Region EKS Mesh** | [`eks-multiregion-deployment/`](./eks-multiregion-deployment/README.md) | 🇮🇳 Mumbai (Hub)<br/>🇺🇸 Virginia (Spoke)<br/>🇩🇪 Frankfurt (Spoke) | **Phase 9:** 13-node, 26-vCPU production cluster. Achieved **106,000 RPS sustained peak** with **0.0000% error rate** across 2.76M requests with full Edge-to-Core HMAC telemetry. | 🏆 Production Reference |

---

## ⚙️ Quickstart Workflow

### Prerequisites
* Terraform `>= 1.5.0`
* AWS CLI `>= 2.0` configured with appropriate multi-region permissions (`ap-south-1`, `us-east-1`, `eu-central-1`)
* `kubectl` `>= 1.28`

### Deploying the Multi-Region EKS Architecture
```bash
cd infra/terraform/eks-multiregion-deployment

# 1. Initialize multi-region providers
terraform init

# 2. Plan resource deployment across Mumbai, Virginia, and Frankfurt
terraform plan -out=tfplan

# 3. Apply infrastructure
terraform apply tfplan

# 4. Configure local kubeconfig for all 3 clusters
aws eks update-kubeconfig --region ap-south-1 --name pravah-mumbai-cluster --alias pravah-mumbai
aws eks update-kubeconfig --region us-east-1 --name pravah-virginia-cluster --alias pravah-virginia
aws eks update-kubeconfig --region eu-central-1 --name pravah-frankfurt-cluster --alias pravah-frankfurt
```

### Complete Teardown & Cost Protection
```bash
terraform destroy -auto-approve
```
> [!IMPORTANT]
> Always execute `terraform destroy` when benchmarking is complete to ensure zero lingering NAT Gateways, Elastic IPs, or Load Balancers.
