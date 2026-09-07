# 🌐 Pravah CDN: Multi-Region EKS Architecture & Deployment Blueprint

---

## 1. Executive Architecture Summary

Pravah CDN is architected as an enterprise-grade, distributed video streaming Content Delivery Network built on **Kubernetes (AWS EKS)** across **three geographical continents**:
- 🇮🇳 **Asia-Pacific (APAC)**: Mumbai Hub (`ap-south-1`)
- 🇺🇸 **Americas (US)**: North Virginia Spoke (`us-east-1`)
- 🇩🇪 **Europe & Middle East (EMEA)**: Frankfurt Spoke (`eu-central-1`)

This architecture implements a **Hub-and-Spoke Topology** designed to achieve:
1. **Sub-10ms First-Byte Latency** for global viewers by caching hot video segments locally in RAM at each edge Point of Presence (PoP).
2. **100,000+ Requests Per Second (RPS)** elastic scalability via Kubernetes Horizontal Pod Autoscaling (HPA).
3. **Zero-Downtime Resilience** with automated Route 53 GeoDNS health check failover.
4. **Global Invalidation Propagation** under 5 milliseconds via cross-region Kafka event streaming.

---

## 2. Multi-Region Topological Blueprint

```mermaid
flowchart TB
    subgraph Clients["Global Viewers & Creators"]
        ViewerAPAC["Viewers (Asia/India)"]
        ViewerUS["Viewers (Americas)"]
        ViewerEU["Viewers (Europe/EMEA)"]
        Creator["Content Creators / Ingestion"]
    end

    subgraph DNS["Global Traffic Management (AWS Route 53)"]
        GeoDNS["Route 53 Latency-Based GeoDNS Routing\n(https://cdn.pravah.io)"]
    end

    ViewerAPAC -->|~8ms RTT| GeoDNS
    ViewerUS -->|~12ms RTT| GeoDNS
    ViewerEU -->|~10ms RTT| GeoDNS
    Creator -->|Ingest / API| GeoDNS

    subgraph MumbaiCluster["🇮🇳 Mumbai Region (ap-south-1) - Hub & APAC Edge"]
        MumbaiALB["AWS ALB (L7 Ingress Controller)"]
        
        subgraph MumbaiEdgeNS["Namespace: pravah-edge"]
            MumbaiEdgePods["pravah-edge Pods\n(HPA: 3-100 Replicas)\nL1 RAM Cache (tmpfs)"]
            MumbaiEdgeRedis["edge-redis\n(Stampede Mutex Lock)"]
        end

        subgraph MumbaiCoreNS["Namespace: pravah-core (Central Origin)"]
            CoreAPI["core-api-gateway Pods\n(HPA: 3-25 Replicas)"]
            DashboardUI["dashboard-ui Pod\n(Control Center)"]
            TranscoderWorkers["transcoder-worker Pods\n(Multi-threaded FFmpeg Ladders)"]
            PostgresDB[("PostgreSQL 16\n(Metadata, RBAC, Versions)\nEBS GP3 Volume")]
            MinIOS3[("MinIO S3 Object Storage\n(Master Videos & Transcoded Segments)\nEBS GP3 Volume")]
            RedpandaKafka["Redpanda Kafka (3-Node HA Cluster)\n(Cache Invalidation & Telemetry Bus)"]
            CoreRedis["redis-core\n(BullMQ Transcoding Queue)"]
        end
    end

    subgraph VirginiaCluster["🇺🇸 North Virginia Region (us-east-1) - Americas Edge"]
        VirginiaALB["AWS ALB (L7 Ingress Controller)"]
        subgraph VirginiaEdgeNS["Namespace: pravah-edge"]
            VirginiaEdgePods["pravah-edge Pods\n(HPA: 3-100 Replicas)\nL1 RAM Cache (tmpfs)"]
            VirginiaEdgeRedis["edge-redis\n(Stampede Mutex Lock)"]
        end
    end

    subgraph FrankfurtCluster["🇩🇪 Frankfurt Region (eu-central-1) - EMEA Edge"]
        FrankfurtALB["AWS ALB (L7 Ingress Controller)"]
        subgraph FrankfurtEdgeNS["Namespace: pravah-edge"]
            FrankfurtEdgePods["pravah-edge Pods\n(HPA: 3-100 Replicas)\nL1 RAM Cache (tmpfs)"]
            FrankfurtEdgeRedis["edge-redis\n(Stampede Mutex Lock)"]
        end
    end

    GeoDNS -->|Route APAC| MumbaiALB
    GeoDNS -->|Route Americas| VirginiaALB
    GeoDNS -->|Route EMEA| FrankfurtALB

    MumbaiALB --> MumbaiEdgePods
    MumbaiALB --> CoreAPI
    MumbaiALB --> DashboardUI

    VirginiaALB --> VirginiaEdgePods
    FrankfurtALB --> FrankfurtEdgePods

    VirginiaEdgePods -.->|Origin Fill on Cache Miss| MinIOS3
    FrankfurtEdgePods -.->|Origin Fill on Cache Miss| MinIOS3
    MumbaiEdgePods -.->|Internal ClusterIP Origin Fill| MinIOS3

    RedpandaKafka -.->|Kafka Event: cache.invalidate| VirginiaEdgePods
    RedpandaKafka -.->|Kafka Event: cache.invalidate| FrankfurtEdgePods
    RedpandaKafka -.->|Kafka Event: cache.invalidate| MumbaiEdgePods

    CoreAPI --> CoreRedis
    CoreRedis --> TranscoderWorkers
    TranscoderWorkers --> MinIOS3
    CoreAPI --> PostgresDB
```

---

## 3. Pod Inventory & Responsibilities

| Pod / Service | Workload Type | Cluster & Namespace | Primary Responsibilities |
| :--- | :--- | :--- | :--- |
| **`pravah-edge`** | Deployment + HPA | All 3 Clusters (`pravah-edge`) | Serves HLS video streams (`.m3u8`, `.ts`) and byte-range downloads. Uses in-memory RAM cache (`medium: Memory`) for sub-10ms delivery. |
| **`edge-redis`** | StatefulSet / Pod | All 3 Clusters (`pravah-edge`) | Coordinates distributed mutex locks (`acquireStampedeLock`) to eliminate **Thundering Herd / Cache Stampedes**. |
| **`core-api-gateway`** | Deployment + HPA | Mumbai (`pravah-core`) | Handles user auth, scoped API keys (`ADMIN`, `STREAMER`, `VIEWER`), chunked resumable upload ingestion, and presigned S3 URLs. |
| **`transcoder-worker`** | Deployment + HPA | Mumbai (`pravah-core`) | Consumes BullMQ jobs to encode raw videos into 6 adaptive HLS resolution ladders (`1080p` to `144p`) via multi-threaded FFmpeg. |
| **`postgres-0`** | StatefulSet (EBS) | Mumbai (`pravah-core`) | Persistent relational database storing file metadata, version trees, SHA-256 hashes, user accounts, and API keys. |
| **`minio-0`** | StatefulSet (EBS) | Mumbai (`pravah-core`) | S3-compatible object storage repository storing master uploaded videos and transcoded chunks. |
| **`redpanda-0..2`** | StatefulSet (3 Nodes) | Mumbai (`pravah-core`) | High-throughput Kafka event streaming bus broadcasting `cache.invalidate`, telemetry metrics, and node heartbeats. |
| **`redis-core`** | StatefulSet / Pod | Mumbai (`pravah-core`) | BullMQ job queue manager for background transcoding orchestration. |
| **`dashboard-ui`** | Deployment | Mumbai (`pravah-core`) | Operational Web Control Center dashboard (Nginx alpine serving single-page application). |

---

## 4. Reverse Proxying & Traffic Routing Architecture

### Layer 7 Reverse Proxy (NGINX Ingress Controller)
In each EKS cluster, an **NGINX Ingress Controller** serves as the Layer 7 Reverse Proxy and front door:
- **Single Public Entrypoint**: Eliminates the need to expose raw internal container ports (`3000`, `3001`, `8080`, `9000`).
- **Path-Based Routing Rules**:
  - `/edge/*` $\to$ Forwards to `pravah-edge-service:3001` (Video streaming).
  - `/api/*`  $\to$ Forwards to `pravah-core-service:3000` (Core REST APIs).
  - `/`      $\to$ Forwards to `pravah-dashboard:80` (Web UI).
- **Streaming Optimizations**: Configured with `proxy-buffering: "off"` to stream live HLS video chunks with zero buffering delay.

### Multi-Region Latency GeoDNS (AWS Route 53)
- Global domain `cdn.pravah.io` is backed by **Route 53 Latency-Based Records**.
- Route 53 continuously measures global network latency from AWS edge locations to client IP blocks:
  - A user in **Frankfurt/Berlin** resolves to **Frankfurt EKS ALB** (9ms).
  - A user in **New York/San Francisco** resolves to **Virginia EKS ALB** (12ms).
  - A user in **Mumbai/Singapore** resolves to **Mumbai EKS ALB** (8ms).
- **Automated Health Check Failover**: If the Frankfurt cluster fails, Route 53 shifts European traffic to Virginia or Mumbai in $< 5\text{s}$.

---

## 5. End-to-End Operational Lifecycle Flows

### Flow A: Video Ingestion & Background Transcoding
```mermaid
sequenceDiagram
    autonumber
    actor Creator as Content Creator
    participant Gateway as Mumbai Core Gateway
    participant MinIO as MinIO S3 Origin
    participant Redis as BullMQ Redis
    participant Transcoder as FFmpeg Worker Pods
    participant Kafka as Redpanda Kafka

    Creator->>Gateway: POST /upload/init (Metadata & Chunks)
    Gateway->>MinIO: Store raw video parts
    Creator->>Gateway: POST /upload/complete (SHA-256 verify)
    Gateway->>MinIO: Assemble multipart upload
    Gateway->>Redis: Enqueue Transcode Job (fileId, resolutions)
    Gateway-->>Creator: 200 OK (Upload Complete)

    Redis->>Transcoder: Pick up Job
    Transcoder->>MinIO: Read raw video stream
    Transcoder->>Transcoder: Encode 6 ladders (1080p -> 144p HLS)
    Transcoder->>MinIO: Write master.m3u8, index.m3u8, segment_*.ts
    Transcoder->>Kafka: Publish event: transcoding.completed
```

### Flow B: Global Edge Streaming & Autonomous Cache Fill
```mermaid
sequenceDiagram
    autonumber
    actor Viewer as European Viewer (Berlin)
    participant DNS as Route 53 Latency DNS
    participant Ingress as Frankfurt NGINX Ingress
    participant Edge as Frankfurt Edge Pod
    participant Mutex as Frankfurt Edge Redis
    participant Origin as Mumbai MinIO S3 Origin

    Viewer->>DNS: Resolve cdn.pravah.io
    DNS-->>Viewer: Frankfurt ALB IP (~9ms)
    Viewer->>Ingress: GET /edge/content/vid-1/hls/master.m3u8
    Ingress->>Edge: Route to Edge Pod

    alt Cache Hit (99.9% of Traffic)
        Edge-->>Viewer: Return from In-Memory RAM Cache (< 2ms)
    else Cache Miss (First Viewer Only)
        Edge->>Mutex: Acquire Stampede Lock (fileId:version)
        Edge->>Origin: Fetch segment from Mumbai MinIO S3
        Origin-->>Edge: Binary stream
        Edge->>Edge: Store in Local RAM Cache (tmpfs)
        Edge->>Mutex: Release Lock
        Edge-->>Viewer: Stream segment (12ms)
    end
```

### Flow C: Deletion & Instant Global Cache Eviction
```mermaid
sequenceDiagram
    autonumber
    actor Admin as Admin / Creator
    participant Gateway as Mumbai Core Gateway
    participant DB as PostgreSQL DB
    participant MinIO as MinIO S3 Origin
    participant Kafka as Redpanda Kafka
    participant MumbaiEdge as Mumbai Edge Pods
    participant VirginiaEdge as Virginia Edge Pods
    participant FrankfurtEdge as Frankfurt Edge Pods

    Admin->>Gateway: DELETE /metadata/files/:fileId
    Gateway->>MinIO: Delete S3 master & HLS chunks
    Gateway->>DB: Delete file records & versions
    Gateway->>Kafka: Broadcast event: cache.invalidate (fileId)
    
    par Instant Eviction (< 5ms)
        Kafka->>MumbaiEdge: Invalidate RAM/NVMe cache
        Kafka->>VirginiaEdge: Invalidate RAM/NVMe cache
        Kafka->>FrankfurtEdge: Invalidate RAM/NVMe cache
    end
    
    Gateway-->>Admin: 200 OK (Cascade Invalidation Completed)
```

---

## 6. Terraform Directory Structure (`infra/terraform/eks-multiregion-deployment/`)

```
infra/terraform/eks-multiregion-deployment/
├── providers.tf             # Multi-region AWS providers (mumbai, virginia, frankfurt) + K8s/Helm
├── versions.tf              # Terraform & provider version constraints
├── network.tf               # 3 isolated VPCs (10.10.0.0/16, 10.20.0.0/16, 10.30.0.0/16)
├── eks_core_mumbai.tf       # Central Core EKS Hub in ap-south-1 (Postgres, MinIO, Kafka, Transcoder)
├── eks_edge_mumbai.tf       # APAC Edge Node Group in Mumbai
├── eks_edge_virginia.tf     # Americas Edge EKS Spoke in us-east-1
├── eks_edge_frankfurt.tf    # EMEA Edge EKS Spoke in eu-central-1
├── route53.tf               # Latency-based DNS routing & automated health checks
├── helm_bootstrap.tf        # Automated deployment of Helm charts onto each regional cluster
├── variables.tf             # Configurable node types, autoscaling thresholds, and cluster sizes
├── outputs.tf               # Kubeconfig connect commands, ALB endpoints, and URLs
└── README.md                # Operations and deployment runbook
```

---

## 7. High-Scale 100k RPS Benchmarking Strategy

To verify the architecture under maximum enterprise load:
1. **Edge Pod Sizing**: Each `pravah-edge` pod handles ~1,500 – 2,000 requests/sec with $< 5\text{ms}$ latency.
2. **HPA Scaling**: Configured with `minReplicas: 3` and `maxReplicas: 100` per regional cluster.
3. **Capacity Under Surge**: $3 \text{ clusters} \times 100 \text{ pods} \times 1,500 \text{ RPS} = \mathbf{450,000\text{ RPS}}$ global peak capacity.
4. **Cloud Load Testing**: Distributed k6 / Locust load generators running in AWS EC2 instances trigger realistic HLS player traffic patterns to validate zero packet drops, 0% CPU degradation on core origin, and sub-10ms edge delivery.
