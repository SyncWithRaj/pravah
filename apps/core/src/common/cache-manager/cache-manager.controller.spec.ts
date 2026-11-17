import { CacheManagerController } from './cache-manager.controller';
import { CacheManagerService } from './cache-manager.service';
import { KafkaService } from '../kafka/kafka.service';
import { TelemetryGateway } from '../../telemetry/telemetry.gateway';

type CacheMock = { evictFile: jest.Mock };
type KafkaMock = { emitCacheInvalidate: jest.Mock };
type CacheInvalidation = {
  fileId: string;
  reason: string;
  timestamp: string;
};
type TelemetryMock = {
  broadcastCacheInvalidated: jest.Mock<void, [CacheInvalidation]>;
};

describe('CacheManagerController', () => {
  let controller: CacheManagerController;
  let cache: CacheMock;
  let kafka: KafkaMock;
  let telemetry: TelemetryMock;

  beforeEach(() => {
    cache = { evictFile: jest.fn().mockResolvedValue(['file:file-1:v1']) };
    kafka = { emitCacheInvalidate: jest.fn() };
    telemetry = {
      broadcastCacheInvalidated: jest.fn<void, [CacheInvalidation]>(),
    };
    controller = new CacheManagerController(
      cache as unknown as CacheManagerService,
      kafka as unknown as KafkaService,
      telemetry as unknown as TelemetryGateway,
    );
  });

  it('refuses to purge without a file id', () => {
    expect(controller.purgeCache('')).toEqual({
      success: false,
      message: 'fileId is required',
    });
    expect(kafka.emitCacheInvalidate).not.toHaveBeenCalled();
    expect(telemetry.broadcastCacheInvalidated).not.toHaveBeenCalled();
  });

  it('broadcasts a manual cluster purge', () => {
    const result = controller.purgeCache('file-1');

    expect(kafka.emitCacheInvalidate).toHaveBeenCalledWith('file-1');
    expect(telemetry.broadcastCacheInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        reason: 'Manual Cluster Purge',
      }),
    );
    const payload = telemetry.broadcastCacheInvalidated.mock
      .calls[0][0] as unknown as { timestamp: string };
    expect(typeof payload.timestamp).toBe('string');
    expect(result).toEqual({
      success: true,
      message: 'Purge event broadcasted to cluster',
    });
  });

  it('evicts a file from a direct cache.invalidate message', async () => {
    await controller.handleCacheInvalidate({ fileId: 'file-1' });

    expect(cache.evictFile).toHaveBeenCalledWith('file-1');
  });

  it('unwraps a Kafka payload envelope', async () => {
    await controller.handleCacheInvalidate({ value: { fileId: 'file-2' } });

    expect(cache.evictFile).toHaveBeenCalledWith('file-2');
  });

  it('ignores messages without a usable file id', async () => {
    await controller.handleCacheInvalidate({ value: { fileId: 42 } });
    await controller.handleCacheInvalidate('not-an-object');
    await controller.handleCacheInvalidate(null);

    expect(cache.evictFile).not.toHaveBeenCalled();
  });
});
