import { ClientKafka } from '@nestjs/microservices';
import { KafkaService } from './kafka.service';

type KafkaClientMock = {
  connect: jest.Mock;
  emit: jest.Mock;
};

describe('Edge KafkaService', () => {
  let service: KafkaService;
  let client: KafkaClientMock;

  beforeEach(() => {
    client = {
      connect: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
    };
    service = new KafkaService(client as unknown as ClientKafka);
  });

  it('connects the Kafka producer on module init', async () => {
    await service.onModuleInit();

    expect(client.connect).toHaveBeenCalled();
  });

  it('emits file and cache events', () => {
    service.emitFileUploaded({
      eventType: 'file.uploaded',
      fileId: 'file-1',
    } as Parameters<KafkaService['emitFileUploaded']>[0]);
    service.emitCacheInvalidate('file-1');
    service.emitCacheAccess({
      fileId: 'file-1',
      version: 'v1',
      edgeId: 'edge-node-01',
      region: 'ap-south-1',
      eventType: 'hit',
      bytesServed: 10,
      downloadLatencyMs: 2,
      timestamp: 'ts',
    });

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      'file.uploaded',
      expect.objectContaining({ fileId: 'file-1' }),
    );
    expect(client.emit).toHaveBeenNthCalledWith(2, 'cache.invalidate', {
      fileId: 'file-1',
    });
    expect(client.emit).toHaveBeenNthCalledWith(
      3,
      'cache.access',
      expect.objectContaining({ fileId: 'file-1', eventType: 'hit' }),
    );
  });

  it('emits health and replication status events with timestamps', () => {
    service.emitEdgeHealthChanged('edge-node-01', 'HEALTHY', 'DOWN');
    service.emitReplicationStatusChanged(
      'file-1',
      'edge-node-01',
      'complete',
      1,
    );

    expect(client.emit).toHaveBeenNthCalledWith(
      1,
      'edge.health_changed',
      expect.objectContaining({
        edgeId: 'edge-node-01',
        oldStatus: 'HEALTHY',
        newStatus: 'DOWN',
      }),
    );
    expect(client.emit).toHaveBeenNthCalledWith(
      2,
      'replication.status_changed',
      expect.objectContaining({
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        status: 'complete',
        attempts: 1,
      }),
    );
    const healthPayload = client.emit.mock.calls[0][1] as {
      timestamp: string;
    };
    expect(typeof healthPayload.timestamp).toBe('string');
  });
});
