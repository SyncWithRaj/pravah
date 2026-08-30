#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================================="
echo "💣 PRAVAH CDN — DESTROY ALL AWS RESOURCES (STOP BILLING)"
echo "================================================================="
echo ""
echo "⚠️  This will permanently destroy:"
echo "    • EKS Kubernetes Cluster & all pods"
echo "    • ECR Container Registry & all images"
echo "    • VPC, Subnets, NAT Gateway, Internet Gateway"
echo "    • EC2 Load Generator instance"
echo "    • All associated IAM Roles & Security Groups"
echo ""

read -p "Type 'destroy' to confirm: " CONFIRM
if [ "$CONFIRM" != "destroy" ]; then
  echo "Aborted."
  exit 1
fi

cd "$SCRIPT_DIR"

# Delete K8s resources first (releases ALBs/ELBs that Terraform can't track)
echo ""
echo "[1/2] 🗑️  Deleting Kubernetes resources..."
aws eks update-kubeconfig --name pravah-load-test --region ap-south-1 2>/dev/null || true
kubectl delete namespace pravah-system --timeout=60s 2>/dev/null || true

echo ""
echo "[2/2] 💥 Destroying Terraform infrastructure..."
terraform destroy -auto-approve

# Cleanup local files
rm -f loadgen-key.pem load-test-results.txt

echo ""
echo "================================================================="
echo "✅ ALL AWS RESOURCES DESTROYED — NO MORE CHARGES!"
echo "================================================================="
