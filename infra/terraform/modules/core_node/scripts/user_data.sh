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

# Detect public IP
PUBLIC_IP=$(curl -s https://checkip.amazonaws.com || curl -s http://169.254.169.254/latest/meta-data/public-ipv4 || echo "localhost")
export CORE_PUBLIC_IP="$PUBLIC_IP"

# Generate production .env from example or defaults
if [ ! -f .env ]; then
    cat <<EOF > .env
PORT=3000
DATABASE_URL=postgresql://admin_postgres:postgres_password@postgres:5432/pravah_db?schema=public
REDIS_HOST=redis
REDIS_PORT=6379
KAFKA_BROKERS=redpanda:9092
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ROOT_USER=admin_minio
MINIO_ROOT_PASSWORD=minio_password
MINIO_ACCESS_KEY=admin_minio
MINIO_SECRET_KEY=minio_password
JWT_SECRET=super_secret_jwt_key_for_pravah_cdn_production_2026
CORE_PUBLIC_IP=$PUBLIC_IP
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
OTEL_SERVICE_NAME=pravah-core
EOF
fi

# 1. Start database, storage & core dependencies first
docker compose -f infra/docker/docker-compose.core.yml up -d postgres minio redis redpanda jaeger loki promtail

# 2. Wait for PostgreSQL to be ready to accept connections
for i in {1..30}; do
  if docker compose -f infra/docker/docker-compose.core.yml exec -T postgres pg_isready -U admin_postgres -d pravah_db; then
    echo "PostgreSQL is ready!"
    break
  fi
  sleep 1
done

# 3. Create database tables and seed initial RBAC & Phase 5A edge nodes
docker compose -f infra/docker/docker-compose.core.yml run --rm core-app pnpm --filter core exec prisma db push --schema=prisma/schema.prisma
docker compose -f infra/docker/docker-compose.core.yml run --rm core-app pnpm --filter core exec prisma db seed

# 4. Launch Core Control Plane, Observability & Dashboard UI on top of prepared DB
docker compose -f infra/docker/docker-compose.core.yml up -d --build

echo "=== Pravah Core Provisioning Complete at $(date) ==="


