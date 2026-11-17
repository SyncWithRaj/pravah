import { ClientKafka } from '@nestjs/microservices';
import { KafkaService } from './kafka.service';
import { MetricsService } from '../../metrics/metrics.service';
import { FileUploadedEvent } from './events/file-uploaded.event';
import { CacheAccessEvent } from './events/cache-access.event';
import { ReplicationDLQEvent } from './events/replication-dlq.event';
import {
  VideoProcessingRequestedEvent,
  VideoTranscodedEvent,
} from './events/video-processing.event';

type KafkaClientMock = {
  connect: jest.Mock<Promise<void>, []>;
  emit: jest.Mock<void, [string, unknown]>;
};

type MetricsMock = {
  cacheInvalidationsTotal: { inc: jest.Mock };
};

describe('KafkaService', () => {
  let service: KafkaService;
  let client: KafkaClientMock;
  let metrics: MetricsMock;

  beforeEach(() => {
    client = {
      connect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      emit: jest.fn<void, [string, unknown]>(),
    };
    metrics = { cacheInvalidationsTotal: { inc: jest.fn() } };
    service = new KafkaService(
      client as unknown as ClientKafka,
      metrics as unknown as MetricsService,
    );
  });

  it('connects the producer on module init', async () => {
    await service.onModuleInit();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('emits file upload events', () => {
    const event = {
      eventType: 'file.uploaded',
      fileId: 'file-1',
    } as unknown as FileUploadedEvent;

    service.emitFileUploaded(event);

    expect(client.emit).toHaveBeenCalledWith('file.uploaded', event);
  });

  it('emits cache invalidation events and records the metric', () => {
    service.emitCacheInvalidate('file-1');

    expect(metrics.cacheInvalidationsTotal.inc).toHaveBeenCalledWith({
      reason: 'invalidation',
    });
    expect(client.emit).toHaveBeenCalledWith('cache.invalidate', {
      fileId: 'file-1',
    });
  });

  it('emits cache access events', () => {
    const event = {
      fileId: 'file-1',
      eventType: 'hit',
    } as unknown as CacheAccessEvent;

    service.emitCacheAccess(event);

    expect(client.emit).toHaveBeenCalledWith('cache.access', event);
  });

  it('emits edge health changes with a timestamp', () => {
    service.emitEdgeHealthChanged('edge-node-01', 'HEALTHY', 'DOWN');

    expect(client.emit).toHaveBeenCalledWith(
      'edge.health_changed',
      expect.objectContaining({
        edgeId: 'edge-node-01',
        oldStatus: 'HEALTHY',
        newStatus: 'DOWN',
      }),
    );
    const payload = client.emit.mock.calls[0][1] as {
      timestamp: string;
    };
    expect(typeof payload.timestamp).toBe('string');
  });

  it('emits replication status changes with a timestamp', () => {
    service.emitReplicationStatusChanged('file-1', 'edge-node-01', 'failed', 3);

    expect(client.emit).toHaveBeenCalledWith(
      'replication.status_changed',
      expect.objectContaining({
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        status: 'failed',
        attempts: 3,
      }),
    );
    const payload = client.emit.mock.calls[0][1] as {
      timestamp: string;
    };
    expect(typeof payload.timestamp).toBe('string');
  });

  it('emits DLQ events to both legacy and DLQ topics', () => {
    const event = {
      fileId: 'file-1',
      edgeNodeId: 'edge-node-01',
    } as unknown as ReplicationDLQEvent;

    service.emitReplicationDLQ(event);

    expect(client.emit).toHaveBeenNthCalledWith(1, 'file.uploaded.dlq', event);
    expect(client.emit).toHaveBeenNthCalledWith(2, 'replication.dlq', event);
  });

  it('emits video processing and transcoded events', () => {
    const requested = {
      fileId: 'file-1',
    } as unknown as VideoProcessingRequestedEvent;
    const transcoded = {
      fileId: 'file-1',
      resolutions: ['720p', '480p'],
      totalSegments: 12,
    } as unknown as VideoTranscodedEvent;

    service.emitVideoProcessingRequested(requested);
    service.emitVideoTranscoded(transcoded);

    expect(client.emit).toHaveBeenCalledWith(
      'video.processing_requested',
      requested,
    );
    expect(client.emit).toHaveBeenCalledWith('video.transcoded', transcoded);
  });

  it('works without the optional metrics service', () => {
    const withoutMetrics = new KafkaService(client as unknown as ClientKafka);

    expect(() => withoutMetrics.emitCacheInvalidate('file-1')).not.toThrow();
    expect(client.emit).toHaveBeenCalledWith('cache.invalidate', {
      fileId: 'file-1',
    });
  });
});
