# Pravah CDN — Operations & Automation Scripts

This directory contains utility, verification, and orchestration scripts for testing, managing, and validating the Pravah Distributed CDN across local and Kubernetes environments.

---

## Directory Overview

```
scripts/
├── dev/                       # Local Development & Verification
│   ├── test_rbac_live.sh      # Multi-role RBAC and API security test suite
│   └── test_transcode_live.sh # End-to-end video upload, transcoding, and HLS check
│
└── k8s/                       # Kubernetes Cluster Orchestration & Testing
    ├── start_cluster.sh       # 1-command lightweight local Kind cluster launcher
    ├── validate.sh            # Cluster health, pod readiness, and service validator
    └── load_test.sh           # High-concurrency Node.js load runner with latency stats
```

---

## Script Catalog & Usage

### 1. Local Development Verification (`scripts/dev/`)

#### Multi-Role RBAC Security Suite (`test_rbac_live.sh`)
Executes an automated security audit across all protected Core and Edge routes:
* Verifies `UnifiedAuthGuard`, `ApiKeyGuard`, and `InterServiceGuard`.
* Tests role escalation defenses against `ADMIN`, `STREAMER`, `VIEWER`, and unauthenticated callers.
* Confirms HMAC-SHA256 timestamp anti-replay validation.

```bash
bash scripts/dev/test_rbac_live.sh
```

#### Video Transcoding Pipeline Test (`test_transcode_live.sh`)
Tests the complete Phase 8A video pipeline:
* Uploads a sample MP4 video chunk-by-chunk to the Core service.
* Polls the BullMQ worker status until FFmpeg finishes transcoding.
* Verifies the generation of `master.m3u8` playlists and multi-bitrate `.ts` segments.
* Performs an HTTP GET request to the Edge service to verify sub-10ms cached playback.

```bash
bash scripts/dev/test_transcode_live.sh
```

---

### 2. Kubernetes Cluster Operations (`scripts/k8s/`)

#### Start Local Cluster (`start_cluster.sh`)
* Provisions a 3-node Kubernetes cluster using `kind` (1 control plane + 2 workers).
* Pre-loads local Docker images (`pravah-core-app:latest` and `pravah-edge-app:latest`) into the cluster nodes without requiring a Docker Hub push.
* Applies all production Kubernetes manifests in numerical sequence (`00` to `51`).

```bash
bash scripts/k8s/start_cluster.sh
```

#### Validate Cluster Health (`validate.sh`)
* Inspects all pods, stateful sets, services, and HPAs in the `pravah-system` namespace.
* Asserts that all database, storage, event bus, and application pods are in `Running` state.

```bash
bash scripts/k8s/validate.sh
```

#### High-Concurrency Load Runner (`load_test.sh`)
* Opens a high-speed background port-forward to the Edge service.
* Launches 100 concurrent workers executing 5,000 requests using an optimized Node.js Keep-Alive HTTP agent.
* Computes and prints full latency distributions ($p50, p95, p99$), requests per second (RPS), and HPA scaling metrics.

```bash
bash scripts/k8s/load_test.sh
```
