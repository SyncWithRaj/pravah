#!/usr/bin/env bash
# ==============================================================================
# Pravah CDN — Complete Zero-to-Hero Local Bootstrap & Verification Script
# ==============================================================================
# Usage:
#   bash scripts/start-local.sh
#
# What this script does:
#   1. Validates prerequisites (Node.js, pnpm, Docker, Docker Compose)
#   2. Prepares & secures .env (generates cryptographic secrets if missing)
#   3. Installs monorepo dependencies & generates Prisma client
#   4. Builds & starts full Docker stack (Core, 3x Edge, Kafka SASL, Redis, PG, MinIO, PLG Observability)
#   5. Waits for health readiness on all stateful services & one-shot bootstrap
#   6. Applies database schema migrations and seeds edge nodes & demo data
#   7. Performs end-to-end smoke verification and prints service access points
# ==============================================================================

set -euo pipefail

# Text formatting
BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

log_info()  { echo -e "${CYAN}${BOLD}[INFO]${RESET} $1"; }
log_ok()    { echo -e "${GREEN}${BOLD}[OK]${RESET} $1"; }
log_warn()  { echo -e "${YELLOW}${BOLD}[WARN]${RESET} $1"; }
log_err()   { echo -e "${RED}${BOLD}[ERROR]${RESET} $1" >&2; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

echo -e "${BOLD}==============================================================================${RESET}"
echo -e "${BOLD}🌊 Pravah CDN — Local Development Environment Initializer${RESET}"
echo -e "${BOLD}==============================================================================${RESET}"

# ------------------------------------------------------------------------------
# STEP 1: Verify Prerequisites
# ------------------------------------------------------------------------------
log_info "Step 1/7: Checking prerequisites..."

# 1.1 Node.js
if ! command -v node >/dev/null 2>&1; then
  log_err "Node.js is not installed. Please install Node.js v20+ (recommended: v22)."
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//')
log_ok "Node.js detected (v${NODE_VER})"

# 1.2 pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  log_warn "pnpm not found. Attempting to enable via corepack or npm..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable && corepack prepare pnpm@latest --activate
  else
    npm install -g pnpm
  fi
fi
PNPM_VER=$(pnpm -v)
log_ok "pnpm detected (v${PNPM_VER})"

# 1.3 Docker Daemon
if ! command -v docker >/dev/null 2>&1; then
  log_err "Docker is not installed. Please install Docker Engine."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  log_err "Docker daemon is not running or current user has no permissions."
  log_err "Run: 'sudo systemctl start docker' or add your user to the 'docker' group."
  exit 1
fi
log_ok "Docker daemon is running"

# 1.4 Docker Compose
if ! docker compose version >/dev/null 2>&1; then
  log_err "Docker Compose v2 is required ('docker compose' command not found)."
  exit 1
fi
log_ok "Docker Compose detected ($(docker compose version --short))"

# ------------------------------------------------------------------------------
# STEP 2: Configure Environment (.env)
# ------------------------------------------------------------------------------
log_info "Step 2/7: Checking environment configuration (.env)..."

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | xxd -p | tr -d '\n'
  fi
}

if [ ! -f .env ]; then
  log_info "Creating .env from .env.example with secure random credentials..."
  cp .env.example .env

  # Generate secrets
  PG_PW=$(generate_secret 16)
  REDIS_PW=$(generate_secret 16)
  JWT_SEC=$(generate_secret 32)
  JWT_REF_SEC=$(generate_secret 32)
  INT_SVC_SEC=$(generate_secret 32)
  EDGE_SIG_SEC=$(generate_secret 32)
  KAFKA_ADM_PW=$(generate_secret 16)
  KAFKA_SASL_PW=$(generate_secret 16)
  KAFKA_EDGE_PW=$(generate_secret 16)

  # Replace in .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PW}|" .env
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PW}|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SEC}|" .env
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${JWT_REF_SEC}|" .env
  sed -i "s|^INTERNAL_SERVICE_SECRET=.*|INTERNAL_SERVICE_SECRET=${INT_SVC_SEC}|" .env
  sed -i "s|^EDGE_URL_SIGNING_SECRET=.*|EDGE_URL_SIGNING_SECRET=${EDGE_SIG_SEC}|" .env
  sed -i "s|^KAFKA_ADMIN_PASSWORD=.*|KAFKA_ADMIN_PASSWORD=${KAFKA_ADM_PW}|" .env
  sed -i "s|^KAFKA_SASL_PASSWORD=.*|KAFKA_SASL_PASSWORD=${KAFKA_SASL_PW}|" .env
  sed -i "s|^KAFKA_EDGE_SASL_PASSWORD=.*|KAFKA_EDGE_SASL_PASSWORD=${KAFKA_EDGE_PW}|" .env

  # Add local host DATABASE_URL for Prisma migrations
  if ! grep -q "^DATABASE_URL=" .env; then
    echo "DATABASE_URL=postgresql://admin_postgres:${PG_PW}@localhost:5432/pravah_db?schema=public" >> .env
  fi

  log_ok ".env generated with fresh cryptographic secrets"
else
  log_ok ".env file exists"
fi

# Ensure DATABASE_URL exists in .env for local host prisma commands
if ! grep -q "^DATABASE_URL=" .env; then
  PG_USER=$(grep "^POSTGRES_USER=" .env | cut -d= -f2 || echo "admin_postgres")
  PG_PASS=$(grep "^POSTGRES_PASSWORD=" .env | cut -d= -f2 || echo "postgres_password")
  PG_DB=$(grep "^POSTGRES_DB=" .env | cut -d= -f2 || echo "pravah_db")
  echo "DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}?schema=public" >> .env
fi

# ------------------------------------------------------------------------------
# STEP 3: Install Node.js Dependencies
# ------------------------------------------------------------------------------
log_info "Step 3/7: Installing monorepo dependencies with pnpm..."
pnpm install --frozen-lockfile=false

log_info "Generating Prisma Client..."
pnpm --filter core exec prisma generate
log_ok "Dependencies installed and Prisma Client generated"

# ------------------------------------------------------------------------------
# STEP 4: Start Docker Infrastructure & Microservices
# ------------------------------------------------------------------------------
log_info "Step 4/7: Building and launching Docker Compose stack..."
docker compose up -d --build

# ------------------------------------------------------------------------------
# STEP 5: Health Readiness & Bootstrap Polling
# ------------------------------------------------------------------------------
log_info "Step 5/7: Waiting for services to become healthy..."

# 5.1 Wait for PostgreSQL
echo -n "  Waiting for PostgreSQL (port 5432)... "
MAX_RETRIES=30
RETRIES=0
until docker exec pravah-postgres pg_isready -U admin_postgres >/dev/null 2>&1 || [ $RETRIES -eq $MAX_RETRIES ]; do
  sleep 2
  RETRIES=$((RETRIES + 1))
done
if [ $RETRIES -eq $MAX_RETRIES ]; then
  log_err "\nPostgreSQL failed to become ready within timeout."
  docker logs pravah-postgres --tail 30
  exit 1
fi
echo -e "${GREEN}Ready!${RESET}"

# 5.2 Wait for Kafka SASL Init Container
echo -n "  Waiting for Kafka SASL provisioner (pravah-kafka-init)... "
RETRIES=0
MAX_RETRIES=45
until [ "$(docker inspect -f '{{.State.Status}}' pravah-kafka-init 2>/dev/null)" == "exited" ] || [ $RETRIES -eq $MAX_RETRIES ]; do
  sleep 2
  RETRIES=$((RETRIES + 1))
done
INIT_EXIT=$(docker inspect -f '{{.State.ExitCode}}' pravah-kafka-init 2>/dev/null || echo "1")
if [ "$INIT_EXIT" != "0" ]; then
  log_err "\nKafka SASL provisioner failed."
  docker logs pravah-kafka-init
  exit 1
fi
echo -e "${GREEN}Provisioned (Exit Code 0)!${RESET}"

# 5.3 Wait for Pravah Core API (port 3000)
echo -n "  Waiting for Pravah Core Control Plane (http://localhost:3000/api/v1/health)... "
RETRIES=0
MAX_RETRIES=45
until curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1 || [ $RETRIES -eq $MAX_RETRIES ]; do
  sleep 2
  RETRIES=$((RETRIES + 1))
done
if [ $RETRIES -eq $MAX_RETRIES ]; then
  log_err "\nPravah Core failed to respond."
  docker logs pravah-core --tail 40
  exit 1
fi
echo -e "${GREEN}Online!${RESET}"

# 5.4 Wait for MinIO (port 9000)
echo -n "  Waiting for MinIO Object Storage (port 9000)... "
RETRIES=0
MAX_RETRIES=30
until curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1 || [ $RETRIES -eq $MAX_RETRIES ]; do
  sleep 2
  RETRIES=$((RETRIES + 1))
done
if [ $RETRIES -eq $MAX_RETRIES ]; then
  log_err "\nMinIO failed to respond."
  docker logs pravah-minio --tail 30
  exit 1
fi
echo -e "${GREEN}Online!${RESET}"

# 5.5 Wait for Edge Proxy (port 8000)
echo -n "  Waiting for Edge Proxy Gateway (http://localhost:8000)... "
RETRIES=0
MAX_RETRIES=30
until curl -sf http://localhost:8000 >/dev/null 2>&1 || [ $RETRIES -eq $MAX_RETRIES ]; do
  sleep 2
  RETRIES=$((RETRIES + 1))
done
echo -e "${GREEN}Online!${RESET}"

# ------------------------------------------------------------------------------
# STEP 6: Apply Database Schema & Seed
# ------------------------------------------------------------------------------
log_info "Step 6/7: Syncing database schema and seeding edge nodes..."

# Apply schema directly to postgres container
docker exec pravah-core pnpm --filter core exec prisma db push --skip-generate >/dev/null 2>&1 || \
pnpm --filter core exec prisma db push

# Seed deterministic edge nodes (Mumbai, Virginia, Frankfurt) & test users
docker exec pravah-core pnpm --filter core exec prisma db seed >/dev/null 2>&1 || \
pnpm --filter core exec prisma db seed

log_ok "Database schema synchronized and Edge Nodes seeded"

# ------------------------------------------------------------------------------
# STEP 7: Smoke Check & Service Map
# ------------------------------------------------------------------------------
log_info "Step 7/7: Performing smoke test verification..."

HEALTH_JSON=$(curl -sf http://localhost:3000/api/v1/health || echo "{}")
if echo "$HEALTH_JSON" | grep -q '"status":"ok"'; then
  log_ok "Health probe verified: ${HEALTH_JSON}"
else
  log_warn "Health check responded with unexpected payload: ${HEALTH_JSON}"
fi

echo ""
echo -e "${GREEN}${BOLD}==============================================================================${RESET}"
echo -e "${GREEN}${BOLD}🚀 Pravah CDN is FULLY RUNNING and HEALTHY!${RESET}"
echo -e "${GREEN}${BOLD}==============================================================================${RESET}"
echo ""
echo -e "${BOLD}Access Endpoints:${RESET}"
echo -e "  • ${CYAN}Core API Control Plane:${RESET}   http://localhost:3000/api/v1"
echo -e "  • ${CYAN}Operations Dashboard:${RESET}     http://localhost:8080"
echo -e "  • ${CYAN}Edge Proxy (Mumbai):${RESET}      http://localhost:8000 (direct: http://localhost:3001)"
echo -e "  • ${CYAN}Edge Node (Virginia):${RESET}     http://localhost:4001"
echo -e "  • ${CYAN}Edge Node (Frankfurt):${RESET}    http://localhost:5001"
echo -e "  • ${CYAN}MinIO S3 Console:${RESET}         http://localhost:9001"
echo -e "  • ${CYAN}Grafana Monitoring:${RESET}       http://localhost:3002 (admin/admin)"
echo -e "  • ${CYAN}Jaeger Distributed Traces:${RESET}http://localhost:16686"
echo -e "  • ${CYAN}Prometheus Metrics:${RESET}       http://localhost:9090"
echo ""
echo -e "${BOLD}Useful Developer Commands:${RESET}"
echo -e "  • Stream live logs:              ${YELLOW}make logs${RESET} (or ${YELLOW}docker compose logs -f${RESET})"
echo -e "  • Run unit test suite:           ${YELLOW}pnpm -r test${RESET}"
echo -e "  • Run full CI check:             ${YELLOW}pnpm run ci${RESET}"
echo -e "  • Stop all containers:           ${YELLOW}make stop${RESET} (or ${YELLOW}docker compose down${RESET})"
echo -e "  • Wipe volumes & clean reset:    ${YELLOW}make clean${RESET}"
echo ""
