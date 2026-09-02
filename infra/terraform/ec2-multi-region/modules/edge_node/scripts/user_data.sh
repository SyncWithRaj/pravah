#!/usr/bin/env bash
set -ex

# Update package lists and install prerequisite utilities
apt-get update -y
apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    make \
    htop \
    jq

# Install official Docker CE and Docker Compose plugin
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Enable and start Docker service
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

# Setup application directory
APP_DIR="/opt/pravah"
mkdir -p "$APP_DIR"
cd /opt

if [ ! -d "$APP_DIR/.git" ]; then
    git clone "${github_repo_url}" "$APP_DIR"
fi

cd "$APP_DIR"

# Configure Edge Node environment variables
export EDGE_NODE_ID="${edge_node_id}"
export EDGE_REGION="${edge_region}"
export CORE_API_URL="http://${core_public_ip}:3000"
export KAFKA_BROKERS="${core_public_ip}:19092"
export MINIO_ENDPOINT="${core_public_ip}"
export MINIO_PORT="9000"
export MINIO_ACCESS_KEY="admin_minio"
export MINIO_SECRET_KEY="minio_password"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${core_public_ip}:4318"
export OTEL_SERVICE_NAME="pravah-${edge_node_id}"

# Launch Edge Data Plane Node & Edge Redis
docker compose -f infra/docker/docker-compose.edge.yml up -d --build

echo "=== Pravah Edge Node [${edge_node_id}] in [${edge_region}] Provisioning Complete at $(date) ==="
