import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: client.Registry;

  // Custom Metrics
  public readonly httpRequestsTotal: client.Counter<string>;
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly geoRoutingTotal: client.Counter<string>;
  public readonly edgeHealthStatus: client.Gauge<string>;
  public readonly replicationJobsTotal: client.Counter<string>;
  public readonly cacheInvalidationsTotal: client.Counter<string>;
  public readonly dlqEventsTotal: client.Counter<string>;

  constructor() {
    this.registry = new client.Registry();

    // Default Node.js system metrics (CPU, RAM, Event loop, Heap)
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: 'pravah_core_',
    });

    // 1. Total HTTP Requests
    this.httpRequestsTotal = new client.Counter({
      name: 'pravah_core_http_requests_total',
      help: 'Total number of HTTP requests processed by Core',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // 2. HTTP Request Duration (Latency)
    this.httpRequestDuration = new client.Histogram({
      name: 'pravah_core_http_request_duration_seconds',
      help: 'HTTP request duration in seconds for Core API',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    // 3. Geo-Routing Decisions
    this.geoRoutingTotal = new client.Counter({
      name: 'pravah_core_geo_routing_total',
      help: 'Total number of Geo-Routing decisions made by Core',
      labelNames: ['edge_name', 'edge_region', 'strategy'],
      registers: [this.registry],
    });

    // 4. Edge Node Health Gauge (1 = HEALTHY, 0.5 = DEGRADED, 0 = DOWN)
    this.edgeHealthStatus = new client.Gauge({
      name: 'pravah_core_edge_health_status',
      help: 'Health status of edge nodes (1=HEALTHY, 0.5=DEGRADED, 0=DOWN)',
      labelNames: ['edge_id', 'edge_name', 'region'],
      registers: [this.registry],
    });

    // 5. BullMQ Replication Jobs Counter
    this.replicationJobsTotal = new client.Counter({
      name: 'pravah_core_replication_jobs_total',
      help: 'Total number of proactive replication jobs dispatched',
      labelNames: ['status', 'edge_name'],
      registers: [this.registry],
    });

    // 6. Cache Invalidation Events Counter
    this.cacheInvalidationsTotal = new client.Counter({
      name: 'pravah_core_cache_invalidations_total',
      help: 'Total number of cache invalidation events emitted over Kafka',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    // 7. Dead Letter Queue (DLQ) Events Counter (Phase 7)
    this.dlqEventsTotal = new client.Counter({
      name: 'pravah_core_dlq_events_total',
      help: 'Total number of events routed to Dead Letter Queue (DLQ)',
      labelNames: ['topic', 'edge_id', 'action'],
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Initial setup if needed
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
