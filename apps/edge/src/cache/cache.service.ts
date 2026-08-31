import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { KafkaService } from '../kafka/kafka.service';
import * as fs from 'fs';
import * as path from 'path';

export interface CacheMetadata {
  ownerId: string;
  contentType: string;
  size: number;
  checksum: string;
  etag: string;
  cacheControl: string;
  contentEncoding?: string;
  isDiskBacked?: boolean;
  diskPath?: string;
}

@Injectable()
export class EdgeCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EdgeCacheService.name);
  private redis!: Redis;
  private readonly maxCacheSize: number;
  private readonly diskCachePath: string;
  private readonly diskThresholdBytes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly kafkaService: KafkaService,
  ) {
    this.maxCacheSize =
      this.configService.get<number>('MAX_CACHE_SIZE') || 500 * 1024 * 1024;
    this.diskCachePath =
      this.configService.get<string>('CACHE_DISK_PATH') ||
      '/tmp/pravah-disk-cache';
    this.diskThresholdBytes =
      this.configService.get<number>('DISK_CACHE_THRESHOLD_BYTES') ||
      2 * 1024 * 1024; // 2MB
  }

  async onModuleInit() {
    const redisHost =
      this.configService.get<string>('REDIS_HOST') || 'localhost';
    const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;
    const redisDb = this.configService.get<number>('REDIS_DB') || 0;

    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      db: redisDb,
    });

    this.redis.on('connect', () => {
      this.logger.log(
        `Connected to Redis at ${redisHost}:${redisPort} (DB: ${redisDb})`,
      );
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`, err.stack);
    });

    // Ensure disk cache root directory exists
    try {
      await fs.promises.mkdir(this.diskCachePath, { recursive: true });
      this.logger.log(
        `Hybrid NVMe/Disk storage initialized at ${this.diskCachePath}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to create disk cache directory: ${err.message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CURRENT VERSION TRACKING
  // ─────────────────────────────────────────────────────────────────────────────

  async setCurrentVersion(fileId: string, version: string): Promise<void> {
    await this.redis.set(`file:${fileId}:current`, version);
  }

  async getCurrentVersion(fileId: string): Promise<string | null> {
    return this.redis.get(`file:${fileId}:current`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PER-VERSION STAMPEDE MUTEX LOCK
  // Refined lock key: lock:stampede:{fileId}:v{version}
  // ─────────────────────────────────────────────────────────────────────────────

  async acquireStampedeLock(
    fileId: string,
    version: string,
    lockValue: string,
  ): Promise<boolean> {
    const lockKey = `lock:stampede:${fileId}:v${version}`;
    const result = await this.redis.set(lockKey, lockValue, 'PX', 10000, 'NX');
    return result === 'OK';
  }

  async releaseStampedeLock(
    fileId: string,
    version: string,
    lockValue: string,
  ): Promise<void> {
    const lockKey = `lock:stampede:${fileId}:v${version}`;
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, lockKey, lockValue);
  }

  async waitForCache(fileId: string, version: string): Promise<boolean> {
    const maxWait = 11000;
    const start = Date.now();
    let delay = 100;

    const lockKey = `lock:stampede:${fileId}:v${version}`;
    const baseKey = `file:${fileId}:${version}`;

    while (Date.now() - start < maxWait) {
      const exists = await this.redis.exists(`${baseKey}:meta`);
      if (exists) return true;

      const lock = await this.redis.get(lockKey);
      if (!lock) {
        // Lock released by leader process
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 1000);
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // METADATA & BINARY RETRIEVAL (HYBRID DISK + RAM)
  // ─────────────────────────────────────────────────────────────────────────────

  async getMetadata(
    fileId: string,
    version: string,
  ): Promise<CacheMetadata | null> {
    const meta = await this.redis.hgetall(`file:${fileId}:${version}:meta`);
    if (!meta || Object.keys(meta).length === 0) {
      return null;
    }
    return {
      ownerId: meta.ownerId,
      contentType: meta.contentType,
      size: parseInt(meta.size, 10),
      checksum: meta.checksum,
      etag: meta.etag,
      cacheControl: meta.cacheControl,
      contentEncoding: meta.contentEncoding,
      isDiskBacked: meta.isDiskBacked === '1',
      diskPath: meta.diskPath || undefined,
    };
  }

  async getBinary(
    fileId: string,
    version: string,
    _size: number,
  ): Promise<Buffer | null> {
    const baseKey = `file:${fileId}:${version}`;
    const meta = await this.getMetadata(fileId, version);

    // If hybrid disk backed, read from local NVMe/SSD storage
    if (meta?.isDiskBacked && meta.diskPath) {
      try {
        const diskBuffer = await fs.promises.readFile(meta.diskPath);
        void this.redis
          .zadd('cache:lru', Date.now(), baseKey)
          .catch((e: Error) =>
            this.logger.error(`Failed to update LRU: ${e.message}`),
          );
        return diskBuffer;
      } catch (err: any) {
        this.logger.warn(
          `Disk cache read failed for ${meta.diskPath}: ${err.message}. Falling back to Redis.`,
        );
      }
    }

    // Otherwise read from in-memory Redis RAM
    const data = await this.redis.getBuffer(`${baseKey}:data`);
    if (data) {
      void this.redis
        .zadd('cache:lru', Date.now(), baseKey)
        .catch((e: Error) =>
          this.logger.error(`Failed to update LRU: ${e.message}`),
        );
    }

    return data;
  }

  async cacheFile(
    fileId: string,
    version: string,
    metadata: CacheMetadata,
    binary: Buffer,
  ): Promise<void> {
    const baseKey = `file:${fileId}:${version}`;
    const isLarge = binary.length >= this.diskThresholdBytes;

    let diskPath = '';
    if (isLarge) {
      const dirPath = path.join(this.diskCachePath, fileId, `v${version}`);
      await fs.promises.mkdir(dirPath, { recursive: true });
      diskPath = path.join(dirPath, 'content.bin');
      await fs.promises.writeFile(diskPath, binary);
    }

    const pipeline = this.redis.pipeline();

    // Store metadata in Redis
    pipeline.hset(`${baseKey}:meta`, {
      ownerId: metadata.ownerId,
      contentType: metadata.contentType,
      size: metadata.size.toString(),
      checksum: metadata.checksum,
      etag: metadata.etag,
      cacheControl: metadata.cacheControl,
      contentEncoding: metadata.contentEncoding || '',
      isDiskBacked: isLarge ? '1' : '0',
      diskPath: diskPath,
    });

    // If small, store in Redis RAM; if large, only store in RAM if configured
    if (!isLarge) {
      pipeline.set(`${baseKey}:data`, binary);
      pipeline.incrby('cache:size', binary.length);
    } else {
      // For disk backed, track virtual size for LRU
      pipeline.incrby('cache:size', Math.floor(binary.length / 10));
    }

    pipeline.zadd('cache:lru', Date.now(), baseKey);
    pipeline.sadd(`file:${fileId}:keys`, baseKey);

    await pipeline.exec();
    await this.enforceEvictionPolicy();
  }

  emitCacheMiss(fileId: string, latencyMs: number) {
    this.kafkaService.emitCacheAccess({
      fileId,
      eventType: 'miss',
      bytesServed: 0,
      downloadLatencyMs: latencyMs,
    });
  }

  private async enforceEvictionPolicy(): Promise<void> {
    const currentSizeStr = await this.redis.get('cache:size');
    const currentSize = currentSizeStr ? parseInt(currentSizeStr, 10) : 0;

    if (currentSize <= this.maxCacheSize) {
      return;
    }

    const luaScript = `
      local oldest = redis.call('ZRANGE', 'cache:lru', 0, 0)
      if #oldest == 0 then
        return 0
      end
      local baseKey = oldest[1]
      
      local sizeStr = redis.call('HGET', baseKey .. ':meta', 'size')
      local size = 0
      if sizeStr then
        size = tonumber(sizeStr)
      end
      
      redis.call('DEL', baseKey .. ':data')
      redis.call('DEL', baseKey .. ':meta')
      redis.call('ZREM', 'cache:lru', baseKey)
      
      if size > 0 then
        redis.call('DECRBY', 'cache:size', size)
      end
      
      return size
    `;

    try {
      let sizeToFree = currentSize - this.maxCacheSize;
      while (sizeToFree > 0) {
        const freedBytes = (await this.redis.eval(luaScript, 0)) as number;
        if (freedBytes === 0) {
          await this.redis.set('cache:size', '0');
          break;
        }
        sizeToFree -= freedBytes;
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(
          `Error during LRU eviction: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  async evictFile(fileId: string): Promise<void> {
    const setKey = `file:${fileId}:keys`;
    const versionKeys = await this.redis.smembers(setKey);

    if (!versionKeys || versionKeys.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const baseKey of versionKeys) {
      pipeline.zrem('cache:lru', baseKey);
      const luaScript = `
        local size = redis.call("HGET", KEYS[1], "size")
        if size then
          redis.call("DECRBY", "cache:size", tonumber(size))
        end
        redis.call("DEL", KEYS[1])
        redis.call("DEL", KEYS[2])
      `;
      pipeline.eval(luaScript, 2, `${baseKey}:meta`, `${baseKey}:data`);
    }

    pipeline.del(`file:${fileId}:current`);
    pipeline.del(setKey);

    await pipeline.exec();

    // Clean up disk files asynchronously
    const diskDir = path.join(this.diskCachePath, fileId);
    fs.promises.rm(diskDir, { recursive: true, force: true }).catch(() => {});

    this.logger.log(
      `Evicted file ${fileId} (${versionKeys.length} versions) from edge cache & disk`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HLS CONTENT CACHING (PLAYLISTS IN RAM, TS SEGMENTS ON DISK)
  // ─────────────────────────────────────────────────────────────────────────────

  async getHlsContent(
    fileId: string,
    version: string,
    subpath: string,
  ): Promise<Buffer | null> {
    const isTsSegment = subpath.endsWith('.ts');
    if (isTsSegment) {
      const diskPath = path.join(
        this.diskCachePath,
        fileId,
        `v${version}`,
        'hls',
        subpath,
      );
      try {
        return await fs.promises.readFile(diskPath);
      } catch {
        // Fallback to Redis RAM
      }
    }
    return this.redis.getBuffer(`hls:${fileId}:${version}:${subpath}`);
  }

  async cacheHlsContent(
    fileId: string,
    version: string,
    subpath: string,
    buffer: Buffer,
    ttlSeconds: number = 86400,
  ): Promise<void> {
    const isTsSegment = subpath.endsWith('.ts');
    if (isTsSegment) {
      const diskDir = path.join(
        this.diskCachePath,
        fileId,
        `v${version}`,
        'hls',
        path.dirname(subpath),
      );
      await fs.promises.mkdir(diskDir, { recursive: true });
      const diskFile = path.join(
        this.diskCachePath,
        fileId,
        `v${version}`,
        'hls',
        subpath,
      );
      await fs.promises.writeFile(diskFile, buffer);
    }

    await this.redis.set(
      `hls:${fileId}:${version}:${subpath}`,
      buffer,
      'EX',
      ttlSeconds,
    );
  }
}
