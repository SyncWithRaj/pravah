import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('exposes the Prometheus content type', () => {
    expect(service.getContentType()).toContain('text/plain');
  });

  it('records HTTP request counters and durations with labels', async () => {
    service.httpRequestsTotal.inc({
      method: 'GET',
      route: '/api/v1/health',
      status_code: '200',
    });
    service.httpRequestDuration.observe(
      { method: 'GET', route: '/api/v1/health', status_code: '200' },
      0.012,
    );

    const output = await service.getMetrics();

    expect(output).toContain('pravah_core_http_requests_total');
    expect(output).toContain('pravah_core_http_request_duration_seconds');
    expect(output).toContain('route="/api/v1/health"');
    expect(output).toContain('status_code="200"');
  });

  it('records geo-routing, replication, and cache invalidation counters', async () => {
    service.geoRoutingTotal.inc({
      edge_name: 'Mumbai Edge',
      edge_region: 'ap-south-1',
      strategy: 'exact-region',
    });
    service.replicationJobsTotal.inc({
      status: 'dispatched',
      edge_name: 'Mumbai Edge',
    });
    service.cacheInvalidationsTotal.inc({ reason: 'invalidation' });
    service.replicationRepairsTotal.inc({
      dead_edge_id: 'edge-node-01',
      target_edge_id: 'edge-node-02',
    });

    const output = await service.getMetrics();

    expect(output).toContain('pravah_core_geo_routing_total');
    expect(output).toContain('pravah_core_replication_jobs_total');
    expect(output).toContain('pravah_core_cache_invalidations_total');
    expect(output).toContain('pravah_core_replication_repairs_total');
  });

  it('tracks edge health and DLQ gauges', async () => {
    service.edgeHealthStatus.set(
      {
        edge_id: 'edge-node-01',
        edge_name: 'Mumbai Edge',
        region: 'ap-south-1',
      },
      1,
    );
    service.dlqActiveItems.set(4);

    const output = await service.getMetrics();

    expect(output).toContain('pravah_core_edge_health_status');
    expect(output).toContain('edge_id="edge-node-01"');
    expect(output).toContain('pravah_core_dlq_active_items 4');
  });
});
