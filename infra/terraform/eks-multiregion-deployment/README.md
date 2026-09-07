# 🌐 Pravah CDN — Multi-Region EKS Deployment Architecture

Production-grade Infrastructure as Code (Terraform) deploying **Pravah Video CDN across 3 global AWS EKS Clusters**:
- 🇮🇳 **Mumbai (`ap-south-1`)**: Central Origin Hub (Postgres, MinIO, Kafka, Transcoders) + APAC Edge
- 🇺🇸 **North Virginia (`us-east-1`)**: Americas Edge Spoke
- 🇩🇪 **Frankfurt (`eu-central-1`)**: EMEA Europe Edge Spoke

---

## 📁 Architecture Files

| File | Description |
| :--- | :--- |
| **`providers.tf`** | Configures multi-region AWS providers (`mumbai`, `virginia`, `frankfurt`). |
| **`network.tf`** | Provisions 3 isolated VPCs (`10.10.0.0/16`, `10.20.0.0/16`, `10.30.0.0/16`) with NAT Gateways and public/private subnets. |
| **`eks_mumbai.tf`** | Central Hub EKS Cluster with Core Stateful node group, FFmpeg Transcoder compute group, and APAC Edge group. |
| **`eks_virginia.tf`**| Americas Spoke EKS Cluster with auto-scaling Edge node group. |
| **`eks_frankfurt.tf`**| EMEA Europe Spoke EKS Cluster with auto-scaling Edge node group. |
| **`load_generator.tf`**| Dedicated high-bandwidth EC2 instance with k6 for 100,000 RPS benchmark execution. |
| **`variables.tf` / `outputs.tf`** | Configurable cluster parameters and kubeconfig connection commands. |

---

## 🚀 Deployment Instructions

### 1. Initialize Terraform
```bash
cd infra/terraform/eks-multiregion-deployment
terraform init
```

### 2. Validate Configuration
```bash
terraform validate
```

### 3. Review Plan & Deploy
```bash
terraform plan -out=tfplan
terraform apply tfplan
```

### 4. Connect `kubectl` to Regional Clusters
```bash
# Connect to Mumbai Hub
aws eks update-kubeconfig --region ap-south-1 --name pravah-mumbai --alias pravah-mumbai

# Connect to Virginia Americas Edge
aws eks update-kubeconfig --region us-east-1 --name pravah-virginia --alias pravah-virginia

# Connect to Frankfurt EMEA Edge
aws eks update-kubeconfig --region eu-central-1 --name pravah-frankfurt --alias pravah-frankfurt
```

### 5. Deploy Kubernetes Manifests / Helm Chart
```bash
# Deploy Core Origin to Mumbai
kubectl --context pravah-mumbai apply -f ../../k8s/

# Deploy Edge Pods to Virginia & Frankfurt
kubectl --context pravah-virginia apply -f ../../k8s/30-edge-deployment.yaml -f ../../k8s/31-edge-service.yaml -f ../../k8s/40-edge-hpa.yaml
kubectl --context pravah-frankfurt apply -f ../../k8s/30-edge-deployment.yaml -f ../../k8s/31-edge-service.yaml -f ../../k8s/40-edge-hpa.yaml
```

---

## ⚡ Running the 100k RPS Load Benchmark

Connect to the provisioned k6 load generator instance:
```bash
ssh -i loadgen-key.pem ec2-user@<LOAD_GENERATOR_IP>
TARGET_URL=http://<YOUR_ALB_ENDPOINT> k6 run pravah_100k_benchmark.js
```
