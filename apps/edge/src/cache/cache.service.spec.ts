import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EdgeCacheService, CacheMetadata } from './cache.service';
import { KafkaService } from '../kafka/kafka.service';
import * as fs from 'fs';
import * as path from 'path';

describe('EdgeCacheService - Phase 8C Features', () => {
  let service: EdgeCacheService;
  let mockRedis: any;
  const testDiskPath = '/tmp/pravah-test-disk-cache';

  beforeEach(async () => {
    mockRedis = {
      set: jest.fn(),
      get: jest.fn(),
      getBuffer: jest.fn(),
      hset: jest.fn(),
      hgetall: jest.fn(),
      exists: jest.fn(),
      eval: jest.fn(),
      zadd: jest.fn().mockResolvedValue(1),
      incrby: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      on: jest.fn(),
      pipeline: jest.fn().mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        sadd: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
      quit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCacheService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'CACHE_DISK_PATH') return testDiskPath;
              if (key === 'DISK_CACHE_THRESHOLD_BYTES') return 1024; // 1 KB threshold for testing
              if (key === 'MAX_CACHE_SIZE') return 500 * 1024 * 1024;
              return defaultValue;
            }),
          },
        },
        {
          provide: KafkaService,
          useValue: {
            emitCacheAccess: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<EdgeCacheService>(EdgeCacheService);
    (service as any).redis = mockRedis;
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(testDiskPath, { recursive: true, force: true });
    } catch {}
  });

  describe('Per-Version Stampede Mutex Lock', () => {
    it('should acquire lock with key format lock:stampede:{fileId}:v{version}', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const acquired = await service.acquireStampedeLock(
        'file-101',
        '2',
        'lock-owner-uuid',
      );

      expect(acquired).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'lock:stampede:file-101:v2',
        'lock-owner-uuid',
        'PX',
        10000,
        'NX',
      );
    });

    it('should release stampede lock using safe Lua script', async () => {
      mockRedis.eval.mockResolvedValue(1);

      await service.releaseStampedeLock(
        'file-101',
        '2',
        'lock-owner-uuid',
      );

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'lock:stampede:file-101:v2',
        'lock-owner-uuid',
      );
    });
  });

  describe('Hybrid NVMe/Disk + Redis RAM Tiering', () => {
    const meta: CacheMetadata = {
      ownerId: 'user-1',
      contentType: 'video/mp4',
      size: 5000,
      checksum: 'sha256checksum',
      etag: '"etag123"',
      cacheControl: 'public, max-age=31536000, immutable',
    };

    it('should write large binary to NVMe/Disk filesystem when exceeding threshold', async () => {
      const largePayload = Buffer.alloc(5000, 'A'); // 5KB > 1KB threshold

      await service.cacheFile('file-large-1', '1', meta, largePayload);

      const expectedDiskFile = path.join(
        testDiskPath,
        'file-large-1',
        'v1',
        'content.bin',
      );
      const exists = fs.existsSync(expectedDiskFile);
      expect(exists).toBe(true);

      const writtenData = await fs.promises.readFile(expectedDiskFile);
      expect(writtenData.length).toBe(5000);
    });

    it('should read from NVMe/Disk when metadata indicates disk-backed storage', async () => {
      const diskDir = path.join(testDiskPath, 'file-read-1', 'v1');
      await fs.promises.mkdir(diskDir, { recursive: true });
      const diskFile = path.join(diskDir, 'content.bin');
      const testContent = Buffer.from('disk-backed-streaming-content');
      await fs.promises.writeFile(diskFile, testContent);

      mockRedis.hgetall.mockResolvedValue({
        ownerId: 'user-1',
        contentType: 'video/mp4',
        size: testContent.length.toString(),
        checksum: 'checksum',
        etag: '"etag"',
        cacheControl: 'public',
        isDiskBacked: '1',
        diskPath: diskFile,
      });

      const retrievedBuffer = await service.getBinary('file-read-1', '1', testContent.length);

      expect(retrievedBuffer).not.toBeNull();
      expect(retrievedBuffer?.toString()).toBe('disk-backed-streaming-content');
    });
  });
});
