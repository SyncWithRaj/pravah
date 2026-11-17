import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { KafkaService } from '../kafka/kafka.service';
import { CacheManagerService, CacheMetadata } from './cache-manager.service';

type PipelineMock = {
  hset: jest.Mock;
  set: jest.Mock;
  zadd: jest.Mock;
  incrby: jest.Mock;
  sadd: jest.Mock;
  zrem: jest.Mock;
  eval: jest.Mock;
  del: jest.Mock;
  exec: jest.Mock;
};

type RedisMock = {
  set: jest.Mock;
  get: jest.Mock;
  getBuffer: jest.Mock;
  hgetall: jest.Mock;
  exists: jest.Mock;
  eval: jest.Mock;
  zadd: jest.Mock;
  strlen: jest.Mock;
  smembers: jest.Mock;
  pipeline: jest.Mock;
  on: jest.Mock;
  quit: jest.Mock;
};

type KafkaMock = {
  emitCacheAccess: jest.Mock;
};

type ConfigMock = {
  get: jest.Mock;
};

type ServiceInternals = {
  redis: Redis;
};

const metadata: CacheMetadata = {
  ownerId: 'user-1',
  contentType: 'text/plain',
  size: 11,
  checksum: 'checksum',
  etag: '"etag"',
  cacheControl: 'public, max-age=60',
  contentEncoding: 'gzip',
};

const createPipeline = (): PipelineMock => {
  const pipeline = {} as PipelineMock;
  pipeline.hset = jest.fn().mockReturnValue(pipeline);
  pipeline.set = jest.fn().mockReturnValue(pipeline);
  pipeline.zadd = jest.fn().mockReturnValue(pipeline);
  pipeline.incrby = jest.fn().mockReturnValue(pipeline);
  pipeline.sadd = jest.fn().mockReturnValue(pipeline);
  pipeline.zrem = jest.fn().mockReturnValue(pipeline);
  pipeline.eval = jest.fn().mockReturnValue(pipeline);
  pipeline.del = jest.fn().mockReturnValue(pipeline);
  pipeline.exec = jest.fn().mockResolvedValue([]);
  return pipeline;
};

describe('CacheManagerService', () => {
  let service: CacheManagerService;
  let redis: RedisMock;
  let kafka: KafkaMock;
  let pipeline: PipelineMock;
  let config: ConfigMock;

  beforeEach(() => {
    pipeline = createPipeline();
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      getBuffer: jest.fn().mockResolvedValue(null),
      hgetall: jest.fn().mockResolvedValue({}),
      exists: jest.fn().mockResolvedValue(0),
      eval: jest.fn().mockResolvedValue(0),
      zadd: jest.fn().mockResolvedValue(1),
      strlen: jest.fn().mockResolvedValue(0),
      smembers: jest.fn().mockResolvedValue([]),
      pipeline: jest.fn().mockReturnValue(pipeline),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    kafka = { emitCacheAccess: jest.fn() };
    config = {
      get: jest.fn((key: string) =>
        key === 'MAX_CACHE_SIZE' ? 500 * 1024 * 1024 : undefined,
      ),
    };

    service = new CacheManagerService(
      config as unknown as ConfigService,
      kafka as unknown as KafkaService,
    );
    (service as unknown as ServiceInternals).redis = redis as unknown as Redis;
  });

  it('stores and reads the current version pointer', async () => {
    redis.get.mockResolvedValue('v2');

    await service.setCurrentVersion('file-1', 'v2');
    const version = await service.getCurrentVersion('file-1');

    expect(redis.set).toHaveBeenCalledWith('file:file-1:current', 'v2');
    expect(redis.get).toHaveBeenCalledWith('file:file-1:current');
    expect(version).toBe('v2');
  });

  it('acquires a stampede lock with NX and a ten second expiry', async () => {
    await expect(
      service.acquireStampedeLock('file-1', 'v1', 'owner'),
    ).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledWith(
      'file:file-1:v1:lock',
      'owner',
      'PX',
      10000,
      'NX',
    );

    redis.set.mockResolvedValue(null);
    await expect(
      service.acquireStampedeLock('file-1', 'v1', 'owner'),
    ).resolves.toBe(false);
  });

  it('releases only a lock owned by the caller', async () => {
    await service.releaseStampedeLock('file-1', 'v1', 'owner');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1]) == ARGV[1]'),
      1,
      'file:file-1:v1:lock',
      'owner',
    );
  });

  it('reports a cache wait as successful when the data key exists', async () => {
    redis.exists.mockResolvedValue(1);

    await expect(service.waitForCache('file-1', 'v1')).resolves.toBe(true);
    expect(redis.exists).toHaveBeenCalledWith('file:file-1:v1:data');
  });

  it('stops waiting when the lock disappears without data', async () => {
    redis.exists.mockResolvedValue(0);
    redis.get.mockResolvedValue(null);

    await expect(service.waitForCache('file-1', 'v1')).resolves.toBe(false);
  });

  it('returns null for empty cache metadata and parses populated metadata', async () => {
    await expect(service.getMetadata('file-1', 'v1')).resolves.toBeNull();

    redis.hgetall.mockResolvedValue({
      ownerId: 'user-1',
      contentType: 'text/plain',
      size: '11',
      checksum: 'checksum',
      etag: '"etag"',
      cacheControl: 'public, max-age=60',
      contentEncoding: 'gzip',
    });

    await expect(service.getMetadata('file-1', 'v1')).resolves.toEqual(
      metadata,
    );
  });

  it('returns cached binary data and records a cache hit', async () => {
    const binary = Buffer.from('hello world');
    redis.getBuffer.mockResolvedValue(binary);

    await expect(service.getBinary('file-1', 'v1', 11)).resolves.toBe(binary);

    expect(redis.getBuffer).toHaveBeenCalledWith('file:file-1:v1:data');
    expect(redis.zadd).toHaveBeenCalledWith(
      'cache:lru',
      expect.any(Number),
      'file:file-1:v1',
    );
    expect(kafka.emitCacheAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        eventType: 'hit',
        bytesServed: 11,
      }),
    );
  });

  it('returns null and does not emit a hit on a cache miss', async () => {
    await expect(service.getBinary('file-1', 'v1', 11)).resolves.toBeNull();

    expect(kafka.emitCacheAccess).not.toHaveBeenCalled();
  });

  it('caches file metadata, binary data, LRU order, and size accounting', async () => {
    const binary = Buffer.from('hello world');
    redis.get.mockResolvedValue('0');

    await service.cacheFile('file-1', 'v1', metadata, binary);

    expect(redis.strlen).toHaveBeenCalledWith('file:file-1:v1:data');
    expect(pipeline.hset).toHaveBeenCalledWith('file:file-1:v1:meta', {
      ownerId: 'user-1',
      contentType: 'text/plain',
      size: '11',
      checksum: 'checksum',
      etag: '"etag"',
      cacheControl: 'public, max-age=60',
      contentEncoding: 'gzip',
    });
    expect(pipeline.set).toHaveBeenCalledWith('file:file-1:v1:data', binary);
    expect(pipeline.zadd).toHaveBeenCalledWith(
      'cache:lru',
      expect.any(Number),
      'file:file-1:v1',
    );
    expect(pipeline.incrby).toHaveBeenCalledWith('cache:size', 11);
    expect(pipeline.sadd).toHaveBeenCalledWith(
      'file:file-1:keys',
      'file:file-1:v1',
    );
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('emits cache miss events', () => {
    service.emitCacheMiss('file-1', 12);

    expect(kafka.emitCacheAccess).toHaveBeenCalledWith({
      fileId: 'file-1',
      eventType: 'miss',
      bytesServed: 0,
      downloadLatencyMs: 12,
    });
  });

  it('evicts all cached versions of a file', async () => {
    redis.smembers.mockResolvedValue(['file:file-1:v1', 'file:file-1:v2']);

    await service.evictFile('file-1');

    expect(pipeline.zrem).toHaveBeenCalledTimes(2);
    expect(pipeline.eval).toHaveBeenCalledTimes(2);
    expect(pipeline.del).toHaveBeenCalledWith('file:file-1:current');
    expect(pipeline.del).toHaveBeenCalledWith('file:file-1:keys');
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('does nothing when there are no cached versions to evict', async () => {
    await service.evictFile('file-1');

    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it('reads and writes HLS content with a TTL', async () => {
    const buffer = Buffer.from('#EXTM3U');
    redis.getBuffer.mockResolvedValue(buffer);

    await expect(
      service.getHlsContent('file-1', 'v1', 'master.m3u8'),
    ).resolves.toBe(buffer);
    expect(redis.getBuffer).toHaveBeenCalledWith('hls:file-1:v1:master.m3u8');

    await service.cacheHlsContent('file-1', 'v1', 'master.m3u8', buffer, 60);

    expect(redis.set).toHaveBeenCalledWith(
      'hls:file-1:v1:master.m3u8',
      buffer,
      'EX',
      60,
    );
  });

  it('evicts the oldest entry when the cache exceeds its limit', async () => {
    const smallConfig: ConfigMock = {
      get: jest.fn((key: string, defaultValue?: unknown) =>
        key === 'MAX_CACHE_SIZE' ? 10 : defaultValue,
      ),
    };
    const smallService = new CacheManagerService(
      smallConfig as unknown as ConfigService,
      kafka as unknown as KafkaService,
    );
    (smallService as unknown as ServiceInternals).redis =
      redis as unknown as Redis;
    redis.get.mockResolvedValue('20');
    redis.eval.mockResolvedValue(15);

    await smallService.cacheFile(
      'file-1',
      'v1',
      metadata,
      Buffer.from('hello world'),
    );

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZRANGE', 'cache:lru'"),
      0,
    );
    expect(redis.set).not.toHaveBeenCalledWith('cache:size', '0');
  });

  it('resets cache size when the LRU index is empty', async () => {
    const smallConfig: ConfigMock = {
      get: jest.fn((key: string, defaultValue?: unknown) =>
        key === 'MAX_CACHE_SIZE' ? 10 : defaultValue,
      ),
    };
    const smallService = new CacheManagerService(
      smallConfig as unknown as ConfigService,
      kafka as unknown as KafkaService,
    );
    (smallService as unknown as ServiceInternals).redis =
      redis as unknown as Redis;
    redis.get.mockResolvedValue('20');
    redis.eval.mockResolvedValue(0);

    await smallService.cacheFile(
      'file-1',
      'v1',
      metadata,
      Buffer.from('hello world'),
    );

    expect(redis.set).toHaveBeenCalledWith('cache:size', '0');
  });

  it('closes the Redis connection on module destroy', async () => {
    await service.onModuleDestroy();

    expect(redis.quit).toHaveBeenCalled();
  });
});
