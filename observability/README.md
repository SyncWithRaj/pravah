# Pravah CDN — Observability & Telemetry Infrastructure

This directory contains the configuration, data sources, dashboard definitions, and log aggregation pipelines for the Pravah Distributed CDN observability stack (Prometheus, Grafana, Loki, Promtail, and OpenTelemetry/Jaeger).

---

## Directory Overview

```
observability/
├── grafana/
│   ├── dashboards/
│   │   └── pravah-cdn-overview.json      # Pre-built unified CDN monitoring dashboard
│   └── provisioning/
│       ├── dashboards/dashboards.yml     # Automated dashboard provider definition
│       └── datasources/datasources.yml   # Auto-provisioned Prometheus & Loki data sources
│
├── prometheus.yml                        # Prometheus scraping rules (Core and Edge targets)
├── loki-config.yml                       # Loki log aggregation and chunk storage settings
└── promtail-config.yml                   # Promtail log shipping and Docker socket parser
```

---

## Observability Architecture & Telemetry Pipeline

```
                           Pravah Edge & Core Microservices
                                          │
                 ┌────────────────────────┼────────────────────────┐
                 │                        │                        │
                 ▼                        ▼                        ▼
        Prometheus Exporters     OpenTelemetry SDK        Docker Container Logs
          (:3000 & :3001)        (W3C Traceparent)                 │
                 │                        │                        ▼
                 ▼                        ▼                     Promtail
             Prometheus                 Jaeger                     │
         (Metrics Collector)      (Distributed Tracing)            ▼
                 │                        │                      Loki
                 └────────────────────────┼────────────────────────┘
                                          │
                                          ▼
                                  Grafana Dashboard
                                    (Port: 3002)
```

---

## Network & Port Allocation Reference

| Service | Port | Protocol | Purpose | Access URL |
| :--- | :---: | :---: | :--- | :--- |
| **Grafana** | `3002` | HTTP | Visual control center and dashboards | `http://localhost:3002` |
| **Prometheus** | `9090` | HTTP | Time-series query interface and metrics store | `http://localhost:9090` |
| **Jaeger UI** | `16686` | HTTP | Distributed trace inspection and waterfall analysis | `http://localhost:16686` |
| **OTLP Receiver** | `4317` / `4318` | gRPC / HTTP | OpenTelemetry collector ingestion | Ingest Endpoint |
| **Loki** | `3100` | HTTP | Centralized log ingestion and query API | `http://localhost:3100` |

---

## Metrics Catalog

Pravah exports standardized Prometheus metrics from `apps/edge/src/metrics/metrics.service.ts`:

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `pravah_edge_cache_hits_total` | Counter | None | Total requests served directly from Edge Redis RAM cache. |
| `pravah_edge_cache_misses_total`| Counter | None | Total requests requiring an origin or peer tiered cache fill. |
| `pravah_edge_bytes_served_total`| Counter | `source` (`ram_cache`, `origin_stream`, `peer_cache`) | Total volume of payload bytes delivered to clients by source. |
| `pravah_edge_request_duration_seconds` | Histogram | `cache_result`, `status_code` | Latency distribution with buckets: `[0.001, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]`. |
| `pravah_edge_peer_fetches_total`| Counter | `peer_id`, `status` | Total peer-assisted cache fill attempts between edge nodes. |

---

## Distributed Tracing Specification

Distributed tracing is implemented via the OpenTelemetry Node SDK (`@opentelemetry/sdk-node`):
* Context propagation adheres to the **W3C Trace Context Specification** (`traceparent` header).
* Every incoming request receives an `X-Trace-Id` response header.
* Span attributes captured on the Edge:
  - `cdn.file_id`: Unique identifier of the requested object.
  - `cdn.version`: Object version number.
  - `cdn.edge_id`: Regional Edge Node identifier.
  - `cdn.cache_state`: `HIT`, `MISS`, `PEER_HIT`, or `PEER_MISS`.
  - `cdn.bytes_served`: Size of the delivered payload.

---

## Local Stack Execution

The observability stack runs automatically as part of the core local development environment:

```bash
# Start Core dependencies including Prometheus, Grafana, Loki, and Jaeger
docker compose -f infra/docker/docker-compose.core.yml up -d

# Open Grafana Dashboard
open http://localhost:3002
# Default credentials: admin / admin
```
