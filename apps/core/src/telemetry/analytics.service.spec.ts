import { AnalyticsService, CacheAccessMessage } from './analytics.service';
import { TelemetryGateway } from './telemetry.gateway';

type BroadcastPayload = Record<string, unknown>;

type TelemetryMock = {
  broadcastDownloadActivity: jest.Mock<void, [BroadcastPayload]>;
  broadcastCacheAccess: jest.Mock<void, [CacheAccessMessage]>;
  broadcastHealthChange: jest.Mock<void, [BroadcastPayload]>;
  broadcastReplicationStatus: jest.Mock<void, [BroadcastPayload]>;
  broadcastCacheInvalidated: jest.Mock<void, [BroadcastPayload]>;
  broadcastThroughput: jest.Mock<void, [BroadcastPayload]>;
};

const cacheAccess = (
  overrides: Partial<CacheAccessMessage> = {},
): CacheAccessMessage => ({
  fileId: 'file-1',
  version: 'v1',
  edgeId: 'edge-node-01',
  region: 'ap-south-1',
  eventType: 'hit',
  bytesServed: 100,
  downloadLatencyMs: 12,
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let telemetry: TelemetryMock;

  beforeEach(() => {
    telemetry = {
      broadcastDownloadActivity: jest.fn<void, [BroadcastPayload]>(),
      broadcastCacheAccess: jest.fn<void, [CacheAccessMessage]>(),
      broadcastHealthChange: jest.fn<void, [BroadcastPayload]>(),
      broadcastReplicationStatus: jest.fn<void, [BroadcastPayload]>(),
      broadcastCacheInvalidated: jest.fn<void, [BroadcastPayload]>(),
      broadcastThroughput: jest.fn<void, [BroadcastPayload]>(),
    };
    service = new AnalyticsService(telemetry as unknown as TelemetryGateway);
  });

  describe('handleCacheAccess', () => {
    it('counts hits, bytes, and broadcasts both feeds', () => {
      const message = cacheAccess();

      service.handleCacheAccess(message);

      expect(telemetry.broadcastDownloadActivity).toHaveBeenCalledWith({
        fileId: 'file-1',
        edgeId: 'edge-node-01',
        region: 'ap-south-1',
        status: 'hit',
        latencyMs: 12,
        bytes: 100,
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      expect(telemetry.broadcastCacheAccess).toHaveBeenCalledWith(message);
    });

    it('adds a timestamp when the edge omits one', () => {
      service.handleCacheAccess(cacheAccess({ timestamp: '' }));

      const activity = telemetry.broadcastDownloadActivity.mock.calls[0][0] as {
        timestamp: string;
      };
      expect(typeof activity.timestamp).toBe('string');
      expect(activity.timestamp.length).toBeGreaterThan(0);
    });

    it('counts misses and peer fills', () => {
      service.handleCacheAccess(cacheAccess({ eventType: 'miss' }));
      service.handleCacheAccess(
        cacheAccess({ eventType: 'peer_fill', bytesServed: 200 }),
      );

      service.computeAndBroadcastThroughput();

      const throughput = telemetry.broadcastThroughput.mock.calls[0][0];
      expect(throughput).toEqual({
        bandwidthBps: 150,
        totalBytesDelivered: 300,
        requestsPerSecond: 1,
        totalHits: 1,
        totalMisses: 1,
        hitRatio: 50,
      });
    });

    it('uses zero bytes when the event omits bytesServed', () => {
      service.handleCacheAccess(
        cacheAccess({ bytesServed: undefined as unknown as number }),
      );

      service.computeAndBroadcastThroughput();

      expect(telemetry.broadcastThroughput).toHaveBeenCalledWith(
        expect.objectContaining({
          bandwidthBps: 0,
          totalBytesDelivered: 0,
          totalHits: 1,
        }),
      );
    });
  });

  describe('throughput computation', () => {
    it('resets the interval window after broadcasting', () => {
      service.handleCacheAccess(cacheAccess({ bytesServed: 400 }));

      service.computeAndBroadcastThroughput();
      service.computeAndBroadcastThroughput();

      const first = telemetry.broadcastThroughput.mock.calls[0][0];
      const second = telemetry.broadcastThroughput.mock.calls[1][0];
      expect(first).toEqual(
        expect.objectContaining({
          bandwidthBps: 200,
          totalBytesDelivered: 400,
          requestsPerSecond: 0.5,
        }),
      );
      expect(second).toEqual(
        expect.objectContaining({
          bandwidthBps: 0,
          totalBytesDelivered: 400,
          requestsPerSecond: 0,
        }),
      );
    });

    it('reports a 100 percent hit ratio when there are no requests yet', () => {
      service.computeAndBroadcastThroughput();

      expect(telemetry.broadcastThroughput).toHaveBeenCalledWith({
        bandwidthBps: 0,
        totalBytesDelivered: 0,
        requestsPerSecond: 0,
        totalHits: 0,
        totalMisses: 0,
        hitRatio: 100,
      });
    });
  });

  it('broadcasts edge health changes', () => {
    const event = {
      edgeId: 'edge-node-01',
      oldStatus: 'HEALTHY',
      newStatus: 'DOWN',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    service.handleHealthChange(event);

    expect(telemetry.broadcastHealthChange).toHaveBeenCalledWith(event);
  });

  it('adds a timestamp to replication status events', () => {
    service.handleReplicationStatus({
      fileId: 'file-1',
      edgeNodeId: 'edge-node-01',
      status: 'failed',
      attempts: 3,
    });

    expect(telemetry.broadcastReplicationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        status: 'failed',
        attempts: 3,
      }),
    );
    const payload = telemetry.broadcastReplicationStatus.mock.calls[0][0] as {
      timestamp: string;
    };
    expect(typeof payload.timestamp).toBe('string');
  });

  it('broadcasts cache invalidations with a timestamp', () => {
    service.handleCacheInvalidation('file-1', 'owner-delete');

    expect(telemetry.broadcastCacheInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        reason: 'owner-delete',
      }),
    );
    const payload = telemetry.broadcastCacheInvalidated.mock.calls[0][0] as {
      timestamp: string;
    };
    expect(typeof payload.timestamp).toBe('string');
  });
});
