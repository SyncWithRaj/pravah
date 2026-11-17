import { AnalyticsService, CacheAccessMessage } from './analytics.service';
import { TelemetryController } from './telemetry.controller';

type AnalyticsMock = {
  handleCacheAccess: jest.Mock;
  handleHealthChange: jest.Mock;
  handleReplicationStatus: jest.Mock;
  handleCacheInvalidation: jest.Mock;
};

describe('TelemetryController', () => {
  let controller: TelemetryController;
  let analytics: AnalyticsMock;

  beforeEach(() => {
    analytics = {
      handleCacheAccess: jest.fn(),
      handleHealthChange: jest.fn(),
      handleReplicationStatus: jest.fn(),
      handleCacheInvalidation: jest.fn(),
    };
    controller = new TelemetryController(
      analytics as unknown as AnalyticsService,
    );
  });

  it('forwards cache access objects', () => {
    const message: CacheAccessMessage = {
      fileId: 'file-1',
      version: 'v1',
      edgeId: 'edge-node-01',
      region: 'ap-south-1',
      eventType: 'hit',
      bytesServed: 10,
      downloadLatencyMs: 2,
      timestamp: 'ts',
    };

    controller.handleCacheAccess(message);

    expect(analytics.handleCacheAccess).toHaveBeenCalledWith(message);
  });

  it('parses JSON string cache access messages', () => {
    const message = JSON.stringify({ fileId: 'file-2', eventType: 'miss' });

    controller.handleCacheAccess(message);

    expect(analytics.handleCacheAccess).toHaveBeenCalledWith({
      fileId: 'file-2',
      eventType: 'miss',
    });
  });

  it('forwards health changes and replication statuses', () => {
    const health = {
      edgeId: 'edge-node-01',
      oldStatus: 'HEALTHY',
      newStatus: 'DOWN',
      timestamp: 'ts',
    };
    const replication = {
      fileId: 'file-1',
      edgeNodeId: 'edge-node-01',
      status: 'failed',
      attempts: 3,
    };

    controller.handleHealthChange(health);
    controller.handleReplicationStatus(JSON.stringify(replication));

    expect(analytics.handleHealthChange).toHaveBeenCalledWith(health);
    expect(analytics.handleReplicationStatus).toHaveBeenCalledWith(replication);
  });

  it('forwards cache invalidations from objects and JSON strings', () => {
    controller.handleCacheInvalidate({
      fileId: 'file-1',
      reason: 'owner-delete',
    });
    controller.handleCacheInvalidate(
      JSON.stringify({ fileId: 'file-2', reason: 'ttl' }),
    );

    expect(analytics.handleCacheInvalidation).toHaveBeenNthCalledWith(
      1,
      'file-1',
      'owner-delete',
    );
    expect(analytics.handleCacheInvalidation).toHaveBeenNthCalledWith(
      2,
      'file-2',
      'ttl',
    );
  });
});
