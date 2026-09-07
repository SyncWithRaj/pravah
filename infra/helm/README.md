# Pravah CDN — Helm Package Infrastructure

This directory contains cloud-native Helm Charts for packaging, templating, and deploying the Pravah Distributed CDN onto any standard Kubernetes cluster (Amazon EKS, Google GKE, Azure AKS, or local Kind/Minikube).

---

## Directory Structure

```
infra/helm/
└── pravah-cdn/
    ├── Chart.yaml             # Chart metadata (Version: 1.0.0)
    └── values.yaml            # Configurable deployment values & resource limits
```

---

## Installation & Usage

### 1. Dry Run / Template Inspection
```bash
helm template pravah ./infra/helm/pravah-cdn -n pravah-system
```

### 2. Install Chart into Kubernetes
```bash
helm upgrade --install pravah-cdn ./infra/helm/pravah-cdn \
  --namespace pravah-system \
  --create-namespace
```

### 3. Customizing Values for Regional Deployment
You can override default resource limits and replica counts using `--set` or a custom values file:

```bash
helm upgrade --install pravah-cdn ./infra/helm/pravah-cdn \
  --namespace pravah-system \
  --set edge.replicaCount=8 \
  --set edge.resources.limits.cpu=1000m \
  --set edge.resources.limits.memory=1024Mi
```

### 4. Uninstalling
```bash
helm uninstall pravah-cdn -n pravah-system
```
