import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { KafkaService } from '../kafka/kafka.service';

export interface CacheMetadata {
  ownerId: string;
  contentType: string;
  size: number;
  checksum: string;
  etag: string;
  cacheControl: string;
  contentEncoding?: string;
}

@Injectable()
export class EdgeCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EdgeCacheService.name);
  private redis!: Redis;
  private readonly maxCacheSize: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly kafkaService: KafkaService,
  ) {
    // Default max cache size to 500MB if not specified
    this.maxCacheSize =
      this.configService.get<number>('MAX_CACHE_SIZE') || 500 * 1024 * 1024;
  }

  onModuleInit() {
    const redisHost =
      this.configService.get<string>('REDIS_HOST') || 'localhost';
    const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;

    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
    });

    this.redis.on('connect', () => {
      this.logger.log(`Connected to Redis at ${redisHost}:${redisPort}`);
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`, err.stack);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  /**
   * Caches the active version pointer.
   * If Redis restarts, this pointer will be lazily loaded from Postgres on the next miss.
   */
  async setCurrentVersion(fileId: string, version: string): Promise<void> {
    await this.redis.set(`file:${fileId}:current`, version);
  }

  /**
   * Retrieves the cached active version pointer.
   */
  async getCurrentVersion(fileId: string): Promise<string | null> {
    return this.redis.get(`file:${fileId}:current`);
  }

  /**
   * Attempts to acquire an atomic lock for fetching a file from the origin.
   * Uses a UUID to ensure only the owner can release it.
   */
  async acquireStampedeLock(
    fileId: string,
    version: string,
    lockValue: string,
  ): Promise<boolean> {
    const result = await this.redis.set(
      `file:${fileId}:${version}:lock`,
      lockValue,
      'PX',
      10000,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * Safely releases the stampede lock using a Lua script to ensure ownership.
   */
  async releaseStampedeLock(
    fileId: string,
    version: string,
    lockValue: string,
  ): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(
      script,
      1,
      `file:${fileId}:${version}:lock`,
      lockValue,
    );
  }

  /**
   * Waits for the cache to be populated by another request, checking for binary existence.
   */
  async waitForCache(fileId: string, version: string): Promise<boolean> {
    const maxWait = 11000; // slightly longer than 10s lock TTL
    const start = Date.now();
    let delay = 100;

    while (Date.now() - start < maxWait) {
      const exists = await this.redis.exists(`file:${fileId}:${version}:data`);
      if (exists) return true;

      const lock = await this.redis.get(`file:${fileId}:${version}:lock`);
      if (!lock) {
        // Lock dropped but binary not here -> origin fetch failed. Abort wait.
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 1000); // Exponential backoff up to 1s max
    }
    return false;
  }

  /**
   * Retrieves metadata for a cached file version.
   */
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
    };
  }

  /**
   * Retrieves the binary payload for a cached file version.
   * Also asynchronously updates LRU and emits a cache hit event.
   */
  async getBinary(
    fileId: string,
    version: string,
    _size: number,
  ): Promise<Buffer | null> {
    const startTime = Date.now();
    const data = await this.redis.getBuffer(`file:${fileId}:${version}:data`);

    if (data) {
      const latency = Date.now() - startTime;

      // Update LRU tracking (fire and forget)
      void this.redis
        .zadd('cache:lru', Date.now(), `file:${fileId}:${version}`)
        .catch((e: Error) =>
          this.logger.error(`Failed to update LRU: ${e.message}`),
        );

      // Emit Kafka metrics (fire and forget)
      this.kafkaService.emitCacheAccess({
        fileId,
        eventType: 'hit',
        bytesServed: data.length,
        downloadLatencyMs: latency,
      });
    }

    return data;
  }

  /**
   * Caches a file's metadata and binary payload, and updates the global cache size.
   */
  async cacheFile(
    fileId: string,
    version: string,
    metadata: CacheMetadata,
    binary: Buffer,
  ): Promise<void> {
    const pipeline = this.redis.pipeline(); // Redis Pipeline (executing multiple commands in one atomic network round-trip)
    const baseKey = `file:${fileId}:${version}`;

    // 1. Store metadata
    pipeline.hset(`${baseKey}:meta`, {
      ownerId: metadata.ownerId,
      contentType: metadata.contentType,
      size: metadata.size.toString(),
      checksum: metadata.checksum,
      etag: metadata.etag,
      cacheControl: metadata.cacheControl,
      contentEncoding: metadata.contentEncoding || '',
    });

    // 2. Store binary
    pipeline.set(`${baseKey}:data`, binary);

    // 3. Track LRU
    pipeline.zadd('cache:lru', Date.now(), baseKey);

    // 4. Track Size
    pipeline.incrby('cache:size', binary.length);

    // 2. Track this version base key in the file's set for O(1) eviction
    pipeline.sadd(`file:${fileId}:keys`, baseKey);

    await pipeline.exec();

    // After caching, enforce LRU limits
    await this.enforceEvictionPolicy();
  }

  /**
   * Emits a cache miss event.
   */
  emitCacheMiss(fileId: string, latencyMs: number) {
    this.kafkaService.emitCacheAccess({
      fileId,
      eventType: 'miss',
      bytesServed: 0,
      downloadLatencyMs: latencyMs,
    });
  }

  /**
   * Enforces the cache size limit by evicting the oldest items via a Lua script.
   */
  private async enforceEvictionPolicy(): Promise<void> {
    const currentSizeStr = await this.redis.get('cache:size');
    const currentSize = currentSizeStr ? parseInt(currentSizeStr, 10) : 0;

    if (currentSize <= this.maxCacheSize) {
      return; // Under limit, nothing to do
    }

    // Lua script to atomically pop the oldest item from ZSET, delete its keys, and decrement cache:size
    const luaScript = `
      local oldest = redis.call('ZRANGE', 'cache:lru', 0, 0)
      if #oldest == 0 then
        return 0
      end
      local baseKey = oldest[1]
      
      -- Get size from metadata before deleting
      local sizeStr = redis.call('HGET', baseKey .. ':meta', 'size')
      local size = 0
      if sizeStr then
        size = tonumber(sizeStr)
      end
      
      -- Delete binary, meta, and remove from ZSET
      redis.call('DEL', baseKey .. ':data')
      redis.call('DEL', baseKey .. ':meta')
      redis.call('ZREM', 'cache:lru', baseKey)
      
      -- Decrement size
      if size > 0 then
        redis.call('DECRBY', 'cache:size', size)
      end
      
      return size
    `;

    try {
      let sizeToFree = currentSize - this.maxCacheSize;

      // Loop until we are under the limit
      while (sizeToFree > 0) {
        // Evaluate the Lua script. Returns the bytes freed.
        const freedBytes = (await this.redis.eval(luaScript, 0)) as number;

        if (freedBytes === 0) {
          // Nothing left to evict but size is still high?
          // Reset cache:size to 0 to fix drift.
          this.logger.warn(
            'LRU cache is empty but cache:size was > 0. Resetting cache:size.',
          );
          await this.redis.set('cache:size', '0');
          break;
        }

        sizeToFree -= freedBytes;
        this.logger.log(`Evicted item from cache, freed ${freedBytes} bytes.`);
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

  /**
   * Instantly evicts all versions of a file from the edge cache cluster node.
   * O(1) operation using tracking sets, avoids blocking KEYS command.
   */
  async evictFile(fileId: string): Promise<void> {
    const setKey = `file:${fileId}:keys`;
    const versionKeys = await this.redis.smembers(setKey);

    if (!versionKeys || versionKeys.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    // Iterate through all known version bases on this edge node
    for (const baseKey of versionKeys) {
      // 1. Remove from LRU tracking
      pipeline.zrem('cache:lru', baseKey);

      // 2. We need the size to decrement cache:size accurately
      // Since it's a pipeline, we could use a Lua script for precise atomic deduction.
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

    // Finally delete the pointer and the set itself
    pipeline.del(`file:${fileId}:current`);
    pipeline.del(setKey);

    await pipeline.exec();
    this.logger.log(
      `Evicted file ${fileId} (${versionKeys.length} versions) from edge cache`,
    );
  }
}
