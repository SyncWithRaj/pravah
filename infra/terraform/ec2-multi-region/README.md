# Pravah Distributed CDN — Multi-Region AWS Terraform Deployment

This directory contains production Infrastructure-as-Code (IaC) using Terraform to provision a distributed multi-region Content Delivery Network across AWS.

---

## 1. Cloud Architecture & Region Topology

```
                               ┌────────────────────────────────────────────────────────┐
                               │               AWS MULTI-REGION TOPOLOGY                │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │
              ┌───────────────────────────────────────────┼───────────────────────────────────────────┐
              │                                           │                                           │
              ▼                                           ▼                                           ▼
┌───────────────────────────┐               ┌───────────────────────────┐               ┌───────────────────────────┐
│   ASIA PACIFIC (MUMBAI)   │               │   US EAST (N. VIRGINIA)   │               │      EUROPE (FRANKFURT)   │
│       (ap-south-1)        │               │        (us-east-1)        │               │       (eu-central-1)      │
├───────────────────────────┤               ├───────────────────────────┤               ├───────────────────────────┤
│ • EC2: Core Node          │               │ • EC2: Edge Node 02       │               │ • EC2: Edge Node 03       │
│   (t3.medium)             │               │   (t3.small)              │               │   (t3.small)              │
│ • PostgreSQL (DB & Meta)  │               │ • Edge Content API (:3001)│               │ • Edge Content API (:3001)│
│ • MinIO S3 Origin Store   │               │ • Edge Redis RAM Cache    │               │ • Edge Redis RAM Cache    │
│ • Redpanda / Kafka Bus    │               │ • Promtail Log Shipper    │               │ • Promtail Log Shipper    │
│ • Prometheus & Grafana    │               └───────────────────────────┘               └───────────────────────────┘
│ • Jaeger Distributed Trace│
│ • EC2: Edge Node 01       │
│   (t3.small - Local Edge) │
└───────────────────────────┘
```

---

## 2. Prerequisites

1. **AWS CLI** installed and authenticated:
   ```bash
   aws configure
   ```
2. **Terraform CLI** ($\ge 1.5.0$):
   ```bash
   terraform version
   ```
3. **AWS EC2 Key Pair**:
   Create an EC2 Key Pair (e.g. `pravah-key`) in `ap-south-1`, `us-east-1`, and `eu-central-1` (or import your public key).

---

## 3. Quickstart Deployment

### Step 1: Configure Variables
```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```
Edit `terraform.tfvars` with your key name:
```hcl
aws_key_name       = "pravah-key"
core_instance_type = "t3.medium"
edge_instance_type = "t3.small"
```

### Step 2: Initialize & Validate
```bash
terraform init
terraform validate
```

### Step 3: Review Plan & Deploy
```bash
terraform plan
terraform apply
```

---

## 4. Verification & Testing

Once deployment completes, Terraform outputs the public endpoints:

```bash
# 1. Health check Core Control Plane
curl http://<CORE_PUBLIC_IP>:3000/api/v1/health

# 2. Access Grafana Dashboards
open http://<CORE_PUBLIC_IP>:3002

# 3. Access Jaeger Distributed Request Waterfall
open http://<CORE_PUBLIC_IP>:16686

# 4. Test Multi-Region GeoDNS Routing from US
curl -s -D - -H "x-test-client-region: us-east-1" \
  http://<CORE_PUBLIC_IP>:3000/api/v1/download/<FILE_ID>

# 5. Test Multi-Region GeoDNS Routing from Europe
curl -s -D - -H "x-test-client-region: eu-central-1" \
  http://<CORE_PUBLIC_IP>:3000/api/v1/download/<FILE_ID>
```

---

## 5. Cleanup / Teardown

To tear down all AWS resources and stop billing:
```bash
terraform destroy
```
