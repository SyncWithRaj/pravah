# 🐳 Pravah CDN — Docker & Container Infrastructure

This directory contains production-grade Dockerfiles, Compose configurations, and automated deployment scripts for containerizing and deploying the **Pravah Distributed CDN**.

---

## 📁 Directory Structure

```
infra/docker/
├── Dockerfile.core            # Multi-stage production container for Core Control Plane
├── Dockerfile.edge            # Multi-stage optimized container for Edge Data Plane
├── Dockerfile.dashboard       # Static web server container for the WebSocket Dashboard
│
├── docker-compose.core.yml    # Compose stack for Core (PostgreSQL, Redis, Kafka, MinIO, Core API)
├── docker-compose.edge.yml    # Compose stack for Edge (Local Redis, Edge Node, Promtail)
│
├── deploy-core.sh             # EC2 deployment automation for Central Core (Mumbai)
├── deploy-edge.sh             # EC2 deployment automation for Edge PoP nodes
└── setup-ec2.sh               # Base EC2 bootstrap script (Docker, Compose, kernel tuning)
```

---

## ⚡ BuildKit High-Speed Build Optimization

All Dockerfiles utilize **Docker BuildKit** with dedicated cache mounts for `pnpm`:

```dockerfile
# Uses host-level pnpm cache mount to prevent redundant network downloads
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

### Enabling BuildKit Locally
```bash
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
```

---

## 🚀 Local Development Stacks

### 1. Launch Central Core Dependencies
```bash
docker compose -f infra/docker/docker-compose.core.yml up -d
```
Starts:
* PostgreSQL 16 on port `5432`
* Redis Cache on port `6379`
* MinIO S3 on ports `9000` (API) and `9001` (Console)
* RedPanda (Kafka) on ports `9092` and `19092`
* Core API on port `3000`

### 2. Launch Local Edge Node
```bash
docker compose -f infra/docker/docker-compose.edge.yml up -d
```
Starts:
* Edge Redis Cache on port `6380`
* Edge Fastify Service on port `3001`

---

## 🌐 Production EC2 Deployment

* **Deploy Core Node:**
  ```bash
  bash infra/docker/deploy-core.sh
  ```
* **Deploy Edge PoP Node:**
  ```bash
  bash infra/docker/deploy-edge.sh
  ```
