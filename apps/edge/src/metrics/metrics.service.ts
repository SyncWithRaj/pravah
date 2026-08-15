import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry: client.Registry;

  public readonly cacheHitsTotal: client.Counter<string>;
  public readonly cacheMissesTotal: client.Counter<string>;
  public readonly peerFetchesTotal: client.Counter<string>;
  public readonly requestDuration: client.Histogram<string>;
  public readonly bytesServedTotal: client.Counter<string>;

  constructor() {
    this.registry = new client.Registry();

    // Default Node.js system metrics (CPU, RAM, Event Loop)
    client.collectDefaultMetrics({ register: this.registry, prefix: 'pravah_edge_' });

    // 1. Cache Hits Counter (Redis RAM)
    this.cacheHitsTotal = new client.Counter({
      name: 'pravah_edge_cache_hits_total',
      help: 'Total number of cache hits served directly from Edge Redis RAM',
      registers: [this.registry],
    });

    // 2. Cache Misses Counter (Origin & Peer fills)
    this.cacheMissesTotal = new client.Counter({
      name: 'pravah_edge_cache_misses_total',
      help: 'Total number of cache misses requiring origin or peer fetch',
      registers: [this.registry],
    });

    // 3. Peer Fetches Counter
    this.peerFetchesTotal = new client.Counter({
      name: 'pravah_edge_peer_fetches_total',
      help: 'Total number of peer-assisted cache fill attempts',
      labelNames: ['peer_id', 'status'],
      registers: [this.registry],
    });

    // 4. Request Duration Histogram (Latency in seconds)
    this.requestDuration = new client.Histogram({
      name: 'pravah_edge_request_duration_seconds',
      help: 'Edge request delivery duration in seconds',
      labelNames: ['cache_result', 'status_code'],
      buckets: [0.001, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    // 5. Bytes Served Counter (Bandwidth offload)
    this.bytesServedTotal = new client.Counter({
      name: 'pravah_edge_bytes_served_total',
      help: 'Total bytes delivered to clients by edge node',
      labelNames: ['source'], // 'ram_cache' vs 'origin_stream' vs 'peer_cache'
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
