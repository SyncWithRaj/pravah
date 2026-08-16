.PHONY: help dev stop restart ui seed migrate logs logs-core logs-edge clean build build-all build\:all lint format deploy-core deploy-edge


# Default target
help:
	@echo "=========================================================="
	@echo "Pravah CDN - Development & Operations Command Center"
	@echo "=========================================================="
	@echo "Local Development:"
	@echo "  make dev          - Start all local containers (Core, Edge, PLG Observability)"
	@echo "  make stop         - Stop all running containers"
	@echo "  make restart      - Restart all running containers"
	@echo "  make ui           - Launch Testing Playground Web UI (http://localhost:8080)"
	@echo "  make seed         - Seed deterministic Edge nodes & admin in PostgreSQL"
	@echo "  make migrate      - Run Prisma database migrations"
	@echo "  make clean        - Stop containers and purge all database & cache volumes"
	@echo ""
	@echo "Monitoring & Logs:"
	@echo "  make logs         - Stream real-time logs from all running containers"
	@echo "  make logs-core    - Stream real-time logs from Core Control Plane"
	@echo "  make logs-edge    - Stream real-time logs from Edge Node"
	@echo ""
	@echo "Code Quality:"
	@echo "  make build        - Compile all TypeScript packages in monorepo"
	@echo "  make build-all    - Format, lint, and build all packages (Full CI verification)"
	@echo "  make lint         - Run ESLint checks"
	@echo "  make format       - Run Prettier formatter"
	@echo ""
	@echo "Production AWS Deployment:"
	@echo "  make deploy-core  - Deploy Central Core Stack on AWS Mumbai EC2"
	@echo "  make deploy-edge  - Deploy Edge Node Stack on AWS Edge EC2"
	@echo "=========================================================="

dev:
	docker compose up -d --build

stop:
	docker compose down

restart:
	docker compose restart

ui:
	python3 -m http.server 8080 --directory dashboard

seed:
	pnpm --filter core exec prisma db push
	pnpm --filter core exec prisma db seed

migrate:
	pnpm --filter core exec prisma migrate dev

logs:
	docker compose logs -f

logs-core:
	docker compose logs -f core-app

logs-edge:
	docker compose logs -f edge-app

clean:
	docker compose down -v

build:
	pnpm -r build

build-all:
	pnpm run build:all

build\:all:
	pnpm run build:all

lint:
	pnpm run lint

format:
	pnpm run format

deploy-core:
	bash infra/docker/deploy-core.sh

deploy-edge:
	bash infra/docker/deploy-edge.sh
