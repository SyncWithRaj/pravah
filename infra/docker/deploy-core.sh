#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=========================================================="
echo "Deploying Pravah Central Core Control Plane"
echo "=========================================================="

cd "$ROOT_DIR"

if [ ! -f .env ]; then
    echo "Notice: .env file not found in root. Creating from example if available..."
    if [ -f .env.example ]; then
        cp .env.example .env
    fi
fi

# Detect Public IP
PUBLIC_IP=$(curl -s https://checkip.amazonaws.com || echo "localhost")
export CORE_PUBLIC_IP="$PUBLIC_IP"
echo "Detected Core Server Public IP: $CORE_PUBLIC_IP"

echo "Building & Launching Core Stack (Postgres, Redis, Redpanda, MinIO, Core API, Prometheus, Loki, Grafana)..."
docker compose -f "$SCRIPT_DIR/docker-compose.core.yml" up -d --build

echo "=========================================================="
echo "Pravah Core successfully deployed."
echo "Core API:           http://$CORE_PUBLIC_IP:3000"
echo "Grafana Dashboard:  http://$CORE_PUBLIC_IP:3002"
echo "MinIO Console:      http://$CORE_PUBLIC_IP:9001"
echo "=========================================================="
