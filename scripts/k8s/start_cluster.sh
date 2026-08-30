#!/usr/bin/env bash
set -e

CLUSTER_NAME="pravah-cluster"
K8S_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/k8s" && pwd)"

echo "================================================================="
echo "☸️  PRAVAH CDN — LOCAL KUBERNETES CLUSTER (KIND) LAUNCHER"
echo "================================================================="

# 1. Check if kind cluster already exists
if kind get clusters 2>/dev/null | grep -q "^$CLUSTER_NAME$"; then
  echo "✓ Kind cluster '$CLUSTER_NAME' already exists and is running."
else
  echo "[1/4] 🚀 Creating lightweight Kubernetes cluster '$CLUSTER_NAME' via kind..."
  
  cat << EOF | kind create cluster --name "$CLUSTER_NAME" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  extraPortMappings:
  - containerPort: 80
    hostPort: 8080
    protocol: TCP
  - containerPort: 443
    hostPort: 8443
    protocol: TCP
- role: worker
- role: worker
EOF
  echo "✓ 3-Node Kubernetes Cluster (1 Control-Plane + 2 Workers) created!"
fi

# 2. Set kubectl context
kubectl cluster-info --context "kind-$CLUSTER_NAME"

# 3. Load local Docker images into kind nodes (avoids Docker Hub push)
echo "[2/4] 📦 Loading local Pravah container images into kind cluster..."
if docker image inspect pravah-core-app:latest >/dev/null 2>&1; then
  echo "      Loading pravah-core-app:latest..."
  kind load docker-image pravah-core-app:latest --name "$CLUSTER_NAME"
fi

if docker image inspect pravah-edge-app:latest >/dev/null 2>&1; then
  echo "      Loading pravah-edge-app:latest..."
  kind load docker-image pravah-edge-app:latest --name "$CLUSTER_NAME"
fi
echo "✓ Container images loaded into all cluster nodes!"

# 4. Deploy all Pravah Kubernetes manifests
echo "[3/4] 🚀 Deploying Pravah CDN manifests to Kubernetes..."
kubectl apply -f "$K8S_DIR/00-namespace.yaml"
kubectl apply -f "$K8S_DIR/01-configmap.yaml"
kubectl apply -f "$K8S_DIR/02-secrets.yaml"
kubectl apply -f "$K8S_DIR/03-rbac.yaml"
kubectl apply -f "$K8S_DIR/10-postgres-statefulset.yaml"
kubectl apply -f "$K8S_DIR/11-redis-cluster.yaml"
kubectl apply -f "$K8S_DIR/12-redpanda-kafka.yaml"
kubectl apply -f "$K8S_DIR/13-minio-s3.yaml"
kubectl apply -f "$K8S_DIR/20-core-deployment.yaml"
kubectl apply -f "$K8S_DIR/21-core-service.yaml"
kubectl apply -f "$K8S_DIR/30-edge-deployment.yaml"
kubectl apply -f "$K8S_DIR/31-edge-service.yaml"
kubectl apply -f "$K8S_DIR/40-edge-hpa.yaml"
kubectl apply -f "$K8S_DIR/41-core-hpa.yaml"
kubectl apply -f "$K8S_DIR/50-ingress.yaml"
kubectl apply -f "$K8S_DIR/51-network-policy.yaml"

echo ""
echo "================================================================="
echo "🎉 PRAVAH CDN KUBERNETES DEPLOYMENT COMPLETE!"
echo "================================================================="
echo ""
echo "📋 USEFUL COMMANDS TO EXPLORE YOUR K8S CLUSTER:"
echo "-----------------------------------------------------------------"
echo "  1. View all running Pods:"
echo "     👉 kubectl get pods -n pravah-system -o wide"
echo ""
echo "  2. View Services & Endpoints:"
echo "     👉 kubectl get svc -n pravah-system"
echo ""
echo "  3. View Horizontal Pod Autoscalers (HPA):"
echo "     👉 kubectl get hpa -n pravah-system"
echo ""
echo "  4. Stream logs from Core / Edge pods:"
echo "     👉 kubectl logs -n pravah-system -l app=pravah-core -f"
echo "     👉 kubectl logs -n pravah-system -l app=pravah-edge -f"
echo ""
echo "  5. Delete/Stop the cluster anytime:"
echo "     👉 kind delete cluster --name pravah-cluster"
echo "================================================================="
