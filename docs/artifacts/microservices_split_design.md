# Phase 5C: Microservices Split Design

## 1. Architectural Objective
Phase 5C completes the transition from a **Modular Monolith** to a fully **Distributed Microservices** architecture. We will use the **Strangler Fig Pattern** to systematically extract the `apps/core` monolith into independent, isolated microservices organized by strict domain responsibilities.

---

## 2. Target Architecture

The following diagram represents the exact topology we are building towards:

```text
                         INTERNET
                            │
                            ▼
                    ┌──────────────┐
                    │ NGINX GATEWAY│
                    └──────┬───────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          Auth          Upload        Download
          Service       Service        Service
                            │             │
                            │             ├────── HTTP ──────┐
                            │             │                  │
                            ▼             │                  ▼
                         Kafka            │               Metadata
                            │             │               Service
                            ▼             │                  │
                      Replication         │               PostgreSQL
                       Service            │
                            │             │
                         HashRing         │
                            │             │
                         BullMQ           │
                            │             │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
           Mumbai        Virginia       Frankfurt
            Edge           Edge            Edge
              │             │               │
            Local         Local           Local
            Redis         Redis           Redis
              │             │               │
              └─────────────┼───────────────┘
                            │
                          MinIO
                         ORIGIN

        Edge ───────── HTTP heartbeat ───────→ Health Service
```

### Ingress vs. Internal Services
- **Public (via Nginx):** `Auth`, `Upload`, `Download`.
- **Internal Only:** `Metadata` (owns PostgreSQL schema), `Health` (receives edge heartbeats), `Replication` (Kafka worker + HashRing + BullMQ producer).

---

## 3. The New Monorepo Structure

| App Name | Domain Responsibility |
|---|---|
| `apps/auth` | **Identity.** Issues/validates JWTs, manages users. |
| `apps/upload` | **Ingestion.** Resumable chunks, assembly, compression, emits events. |
| `apps/download` | **Download Orchestration.** Asks Metadata for version, asks Health for active nodes, performs Geo Routing internally, issues 302s. |
| `apps/metadata` | **File Metadata.** The *only* service that queries Postgres file tables. |
| `apps/replication` | **Data Placement.** Owns the `HashRing`, consumes Kafka events, dispatches jobs. |
| `apps/health` | **Edge Availability.** Monitors heartbeats and exposes liveness state. |
| `apps/edge` | **Actual Bytes (Data Plane).** Caches in isolated local Redis, streams files to users. |

---

## 4. Internal Workflows

### UPLOAD FLOW:
`Client` → `Nginx` → `Upload` → `Metadata/PostgreSQL` → `Kafka: file.uploaded` → `Replication` → `HashRing` → `Responsible Replica Set` → `BullMQ` → `Edges`

### DOWNLOAD FLOW:
```text
Client
  ↓
Nginx
  ↓
Download
  ├──→ Metadata
  │      ↓
  │   currentVersion
  │
  └──→ Health
         ↓
      healthy edges
         ↓
      Geo Routing
         ↓
       302
         ↓
       Edge
         ↓
      Local Redis
       ↙   ↘
     HIT   MISS
            ↓
          MinIO
            ↓
          Local Redis
```

---

## 5. Shared Libraries (`libs/`) & Logical Data Ownership

To maintain strict service boundaries:
- **Logical Data Ownership:** Services only own their specific schemas. `DownloadService` will not query the DB directly to find a file; it makes an internal HTTP request to `MetadataService`.
- **`libs/contracts`**: Shared Kafka event schemas and message interfaces.
- **`libs/kafka`**: Kafka client connection setup.
- **`libs/common`**: Genuinely reusable logic (`HashRing`, `Haversine` util).

*Service-specific HTTP DTOs will NOT be shared globally to avoid tight coupling.*

---

## 6. Implementation Steps (Strangler Fig Pattern)

We will NOT start by deleting `core`. We will extract services one by one, keeping the legacy `apps/core` running throughout the migration.

1. **Extract `apps/edge`**: Pull the Data Plane out first.
2. **Integration Test**: Verify Core can dispatch jobs to the extracted Edge via BullMQ and redirect via 302.
3. **Iterative Extraction**: Extract `Upload`, test. Extract `Download`, test. (Switching Nginx routes dynamically).
4. **Deprecate Monolith**: Only when all services are extracted, tested, and routed independently will `apps/core` be safely deleted.
