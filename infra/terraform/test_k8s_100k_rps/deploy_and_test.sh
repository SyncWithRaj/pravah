#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR"
K8S_DIR="$(cd "$SCRIPT_DIR/../../k8s" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "================================================================="
echo "🚀 PRAVAH CDN — AWS EKS 100K RPS DEPLOYMENT & LOAD TEST"
echo "================================================================="

# ---------------------------------------------------------------
# PHASE 1: Terraform — Provision AWS Infrastructure
# ---------------------------------------------------------------
echo ""
echo "[1/6] ☁️  Provisioning AWS Infrastructure (EKS + ECR + Load Generator)..."
echo "       This takes ~15-20 minutes (EKS cluster creation)."
echo ""

cd "$TF_DIR"
terraform init
terraform apply -auto-approve

# Capture Terraform outputs
EKS_CLUSTER=$(terraform output -raw eks_cluster_name)
ECR_CORE_URL=$(terraform output -raw ecr_core_repo_url)
ECR_EDGE_URL=$(terraform output -raw ecr_edge_repo_url)
LOADGEN_IP=$(terraform output -raw load_generator_public_ip)
AWS_REGION=$(terraform output -raw 2>/dev/null || echo "ap-south-1")
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "✓ EKS Cluster: $EKS_CLUSTER"
echo "✓ ECR Core:    $ECR_CORE_URL"
echo "✓ ECR Edge:    $ECR_EDGE_URL"
echo "✓ Load Gen IP: $LOADGEN_IP"

# ---------------------------------------------------------------
# PHASE 2: Push Docker Images to ECR
# ---------------------------------------------------------------
echo ""
echo "[2/6] 📦 Pushing Pravah Docker images to Amazon ECR..."

aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com"

# Tag and push Core App
docker tag pravah-core-app:latest "$ECR_CORE_URL:latest"
docker push "$ECR_CORE_URL:latest"
echo "✓ Pushed pravah-core-app → ECR"

# Tag and push Edge App
docker tag pravah-edge-app:latest "$ECR_EDGE_URL:latest"
docker push "$ECR_EDGE_URL:latest"
echo "✓ Pushed pravah-edge-app → ECR"

# ---------------------------------------------------------------
# PHASE 3: Configure kubectl for EKS
# ---------------------------------------------------------------
echo ""
echo "[3/6] ☸️  Configuring kubectl for EKS cluster..."
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region ap-south-1
kubectl get nodes

# ---------------------------------------------------------------
# PHASE 4: Update K8s manifests with ECR image URLs and deploy
# ---------------------------------------------------------------
echo ""
echo "[4/6] 🚀 Deploying Pravah CDN to AWS EKS..."

# Create temp copies with updated image references
TEMP_K8S="/tmp/pravah-k8s-deploy"
rm -rf "$TEMP_K8S"
cp -r "$K8S_DIR" "$TEMP_K8S"

# Update Core deployment image to ECR
sed -i "s|image: pravah-core-app:latest|image: ${ECR_CORE_URL}:latest|g" "$TEMP_K8S/20-core-deployment.yaml"

# Update Edge deployment image to ECR
sed -i "s|image: pravah-edge-app:latest|image: ${ECR_EDGE_URL}:latest|g" "$TEMP_K8S/30-edge-deployment.yaml"

# Update initContainer busybox to use IfNotPresent
sed -i "s|imagePullPolicy: IfNotPresent|imagePullPolicy: Always|g" "$TEMP_K8S/20-core-deployment.yaml"

# Apply all manifests
kubectl apply -f "$TEMP_K8S/"

echo "✓ All Pravah manifests deployed to EKS!"

# Run Prisma migration
echo "   Running Prisma DB migration on EKS PostgreSQL..."
kubectl wait --for=condition=ready pod -l app=pravah-postgres -n pravah-system --timeout=120s
kubectl port-forward -n pravah-system svc/pravah-postgres 5433:5432 &
PF_PID=$!
sleep 3
cd "$PROJECT_DIR"
DATABASE_URL="postgresql://pravah_admin:PravahProductionSecurePassword2026!@127.0.0.1:5433/pravah_db?schema=public&sslmode=disable" pnpm --filter core exec prisma db push
kill $PF_PID || true

# ---------------------------------------------------------------
# PHASE 5: Wait for all pods to be ready
# ---------------------------------------------------------------
echo ""
echo "[5/6] ⏳ Waiting for all pods to reach Running state..."
kubectl wait --for=condition=ready pod -l app=pravah-edge -n pravah-system --timeout=300s
kubectl wait --for=condition=ready pod -l app=pravah-core -n pravah-system --timeout=300s
kubectl get pods -n pravah-system -o wide

# Get the Edge service ClusterIP for load testing
EDGE_SVC_IP=$(kubectl get svc pravah-edge-service -n pravah-system -o jsonpath='{.spec.clusterIP}')

# ---------------------------------------------------------------
# PHASE 6: Fire 100K RPS Load Test from EC2
# ---------------------------------------------------------------
echo ""
echo "[6/6] ⚡ Launching 100K RPS Load Test from EC2 ($LOADGEN_IP)..."

# Port-forward Edge service to load generator can reach it
# Instead, we expose via NodePort for the load test
kubectl patch svc pravah-edge-service -n pravah-system -p '{"spec":{"type":"NodePort"}}'
NODE_PORT=$(kubectl get svc pravah-edge-service -n pravah-system -o jsonpath='{.spec.ports[0].nodePort}')
WORKER_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

echo "  Edge NodePort: $WORKER_IP:$NODE_PORT"

# Wait for EC2 Load Generator user_data setup to complete
echo "  Waiting for EC2 Load Generator setup to finish..."
until ssh -i "$TF_DIR/loadgen-key.pem" -o StrictHostKeyChecking=no -o ConnectTimeout=5 ec2-user@"$LOADGEN_IP" "test -f /home/ec2-user/setup-done.txt" 2>/dev/null; do
  echo -ne "  Waiting for k6 installation on EC2...\r"
  sleep 5
done
echo "✓ Load generator ready with k6!"

# SSH into load generator and run k6
ssh -i "$TF_DIR/loadgen-key.pem" -o StrictHostKeyChecking=no ec2-user@"$LOADGEN_IP" \
  "EDGE_URL=http://${WORKER_IP}:${NODE_PORT} k6 run /home/ec2-user/pravah_100k_load_test.js 2>&1" | tee "$TF_DIR/load-test-results.txt"

echo ""
echo "================================================================="
echo "🎉 100K RPS LOAD TEST COMPLETE!"
echo "================================================================="
echo ""
echo "📊 Full results saved to: $TF_DIR/load-test-results.txt"
echo ""
echo "📋 USEFUL COMMANDS:"
echo "  • View pods:     kubectl get pods -n pravah-system -o wide"
echo "  • View HPA:      kubectl get hpa -n pravah-system"
echo "  • Stream logs:   kubectl logs -n pravah-system -l app=pravah-edge -f"
echo "  • SSH to loadgen: ssh -i $TF_DIR/loadgen-key.pem ec2-user@$LOADGEN_IP"
echo ""
echo "⚠️  IMPORTANT: Run 'bash destroy.sh' when done to stop AWS charges!"
echo "================================================================="
