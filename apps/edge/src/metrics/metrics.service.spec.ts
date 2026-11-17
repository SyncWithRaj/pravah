import { MetricsService } from './metrics.service';

describe('Edge MetricsService', () => {
  it('registers edge metrics and exposes the Prometheus payload', async () => {
    const service = new MetricsService();

    expect(service.getContentType()).toContain('text/plain');

    service.cacheHitsTotal.inc();
    service.cacheMissesTotal.inc();
    service.peerFetchesTotal.inc({ peer_id: 'edge-node-02', status: 'success' });
    service.bytesServedTotal.inc({ source: 'ram_cache' }, 42);
    service.requestDuration.observe(
      { cache_result: 'hit', status_code: '200' },
      0.01,
    );

    const payload = await service.getMetrics();
    expect(payload).toContain('pravah_edge_cache_hits_total 1');
    expect(payload).toContain('pravah_edge_cache_misses_total 1');
    expect(payload).toContain('pravah_edge_bytes_served_total{source="ram_cache"} 42');
  });
});
