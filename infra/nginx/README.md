# Pravah Zero-Copy Edge Reverse Proxy

This directory contains the production configuration and Docker packaging for the high-performance Linux Nginx reverse proxy layer deployed in front of the NestJS Edge service (`apps/edge`).

---

## 1. Overview and Architectural Purpose

In a distributed video CDN, raw streaming throughput and sub-millisecond response latency are critical. While the NestJS Edge service excels at token validation, distributed peer discovery, and cache stampede mutex orchestration, serving large video segments (`.ts`, `.m4s`) directly from the Node.js V8 runtime introduces unnecessary user-space buffer copying, context switching, and garbage collection pauses.

The Linux Nginx layer serves as the high-throughput **data plane**:
- **Zero-Copy Static Segment Delivery**: Employs the Linux kernel `sendfile` system call to stream cached video segments directly from the operating system page cache to the network interface controller (NIC) with Direct Memory Access (DMA).
- **Playlist Microcaching**: Microcaches live HLS playlists (`.m3u8`) for 1 second, collapsing thousands of concurrent client manifest polls into a single upstream NestJS request.
- **Connection Pooling**: Maintains persistent HTTP Keep-Alive connection pools to NestJS, eliminating TCP handshake overhead between the proxy and the application runtime.
- **Request Shielding**: Nginx enforces cache locks (`proxy_cache_lock on`) so that even if thousands of clients request an uncached chunk at the exact same millisecond, only one request passes upstream.

---

## 2. Linux Kernel Optimization Directives

The proxy configuration in `nginx.conf` enables low-level Linux kernel optimizations:

### `sendfile on;`
Invokes the `sendfile(2)` system call. Instead of reading file data into a user-space memory buffer and subsequently writing it back to the socket buffer (4 context switches and 2-3 memory copies), the Linux kernel coordinates DMA transfer directly between disk page cache and socket buffers. Video payloads never touch user-space memory.

### `tcp_nopush on;`
Enables the `TCP_CORK` socket option on Linux. When combined with `sendfile`, Nginx instructs the kernel to accumulate data chunks and transmit full TCP packets (up to Maximum Transmission Unit, MTU) rather than sending undersized frames, significantly reducing packet headers and network fragmentation.

### `tcp_nodelay on;`
Disables Nagle's algorithm for Keep-Alive connections. Small control packets, HTTP headers, and initial playlist bytes are transmitted immediately without artificial 200ms ACK delays.

### `use epoll;`
Configures Nginx to use the Linux asynchronous I/O multiplexer `epoll(7)`. Allows a single worker process to handle tens of thousands of concurrent connections with O(1) event scaling.

---

## 3. Cache Zone Hierarchy

Two independent disk cache zones are configured to balance retention and memory usage:

| Cache Zone | Directory Path | Target Files | Key Allocation | Retention Policy | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SEGMENT_CACHE` | `/var/cache/nginx/edge_segments` | `.ts`, `.m4s`, `.mp4` | 256MB RAM (keys) / 20GB SSD | `inactive=7d` | High-capacity persistence for static immutable video segments. |
| `MANIFEST_CACHE` | `/var/cache/nginx/edge_manifests` | `.m3u8`, `.mpd` | 32MB RAM (keys) / 1GB SSD | `inactive=10m` | Ultra-short microcaching (1-2s TTL) for dynamic live stream playlists. |

---

## 4. Upstream Connection to NestJS

The proxy defines an upstream block connecting to the local NestJS Edge service:

```nginx
upstream nestjs_edge_upstream {
    server 127.0.0.1:4001;
    keepalive 64;
}
```

Every `proxy_pass` directive sets `proxy_http_version 1.1;` and `proxy_set_header Connection "";` to ensure connections remain open and reused across thousands of subsequent client requests.

---

## 5. Deployment Models

### Model A: Kubernetes Pod Sidecar (Recommended for Production)
In Kubernetes, Nginx and the NestJS Edge container run in the same Pod:
- Both containers share the `localhost` network namespace (`127.0.0.1`).
- Traffic enters the Pod via Nginx on port 80.
- Cache hits are returned immediately by Nginx.
- Cache misses route internally over the loopback interface (`127.0.0.1:4001`) with near-zero latency.
- Both containers mount a shared volume (`emptyDir` or persistent NVMe volume) for disk cache persistence.

### Model B: Docker Compose (Local Development and Testing)
When deployed via `infra/docker/docker-compose.edge.yml`:
- Nginx runs in a dedicated container or shares the edge application network namespace (`network_mode: "service:edge-app"`).
- Developers inspect cache hit metrics via response header `X-Proxy-Cache: HIT` or `X-Proxy-Cache: MISS`.

---

## 6. Observability and Diagnostics

Every response returned through Nginx includes diagnostic headers:
- `X-Proxy-Cache`: Reports `HIT`, `MISS`, `EXPIRED`, `UPDATING`, `STALE`, or `BYPASS`.
- `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing vulnerabilities.
- Structured access logs are generated in JSON format (`cdn_json`) recording:
  - `client_ip`
  - `request_uri`
  - `status`
  - `bytes_sent`
  - `request_time`
  - `upstream_addr`
  - `upstream_response_time`
  - `upstream_cache_status`
