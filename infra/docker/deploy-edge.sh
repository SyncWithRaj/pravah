#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default parameters
NODE_ID=${1:-${EDGE_NODE_ID:-"edge-node-01"}}
REGION=${2:-${EDGE_REGION:-"ap-south-1"}}
CORE_URL=${3:-${CORE_API_URL:-"http://localhost:3000"}}
KAFKA=${4:-${KAFKA_BROKERS:-"localhost:19092"}}
MINIO=${5:-${MINIO_ENDPOINT:-"localhost"}}

echo "=========================================================="
echo "Deploying Pravah Edge Node"
echo "=========================================================="
echo "Node ID:       $NODE_ID"
echo "Region:        $REGION"
echo "Core API URL:  $CORE_URL"
echo "Kafka Brokers: $KAFKA"
echo "MinIO Host:    $MINIO"
echo "=========================================================="

cd "$ROOT_DIR"

export EDGE_NODE_ID="$NODE_ID"
export EDGE_REGION="$REGION"
export CORE_API_URL="$CORE_URL"
export KAFKA_BROKERS="$KAFKA"
export MINIO_ENDPOINT="$MINIO"

docker compose -f "$SCRIPT_DIR/docker-compose.edge.yml" up -d --build

echo "=========================================================="
echo "Edge Node [$NODE_ID] successfully started in region [$REGION]."
echo "Serving on Port 3001"
echo "=========================================================="
