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
    
    this.maxCacheSize =
      this.configService.get<number>('MAX_CACHE_SIZE') || 500 * 1024 * 1024;
  }

  onModuleInit() {
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
      this.logger.log(`Connected to Redis at ${redisHost}:${redisPort} (DB: ${redisDb})`);
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`, err.stack);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  
  async setCurrentVersion(fileId: string, version: string): Promise<void> {
    await this.redis.set(`file:${fileId}:current`, version);
  }

  
  async getCurrentVersion(fileId: string): Promise<string | null> {
    return this.redis.get(`file:${fileId}:current`);
  }

  
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

  
  async waitForCache(fileId: string, version: string): Promise<boolean> {
    const maxWait = 11000; 
    const start = Date.now();
    let delay = 100;

    while (Date.now() - start < maxWait) {
      const exists = await this.redis.exists(`file:${fileId}:${version}:data`);
      if (exists) return true;

      const lock = await this.redis.get(`file:${fileId}:${version}:lock`);
      if (!lock) {
        
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 1000); 
    }
    return false;
  }

  
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

  
  async getBinary(
    fileId: string,
    version: string,
    _size: number,
  ): Promise<Buffer | null> {
    const startTime = Date.now();
    const data = await this.redis.getBuffer(`file:${fileId}:${version}:data`);

    if (data) {
      const latency = Date.now() - startTime;

      
      void this.redis
        .zadd('cache:lru', Date.now(), `file:${fileId}:${version}`)
        .catch((e: Error) =>
          this.logger.error(`Failed to update LRU: ${e.message}`),
        );

      
      this.kafkaService.emitCacheAccess({
        fileId,
        eventType: 'hit',
        bytesServed: data.length,
        downloadLatencyMs: latency,
      });
    }

    return data;
  }

  
  async cacheFile(
    fileId: string,
    version: string,
    metadata: CacheMetadata,
    binary: Buffer,
  ): Promise<void> {
    const pipeline = this.redis.pipeline(); 
    const baseKey = `file:${fileId}:${version}`;

    
    pipeline.hset(`${baseKey}:meta`, {
      ownerId: metadata.ownerId,
      contentType: metadata.contentType,
      size: metadata.size.toString(),
      checksum: metadata.checksum,
      etag: metadata.etag,
      cacheControl: metadata.cacheControl,
      contentEncoding: metadata.contentEncoding || '',
    });

    
    pipeline.set(`${baseKey}:data`, binary);

    
    pipeline.zadd('cache:lru', Date.now(), baseKey);

    
    pipeline.incrby('cache:size', binary.length);

    
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

      
      while (sizeToFree > 0) {
        
        const freedBytes = (await this.redis.eval(luaScript, 0)) as number;

        if (freedBytes === 0) {
          
          
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
    this.logger.log(
      `Evicted file ${fileId} (${versionKeys.length} versions) from edge cache`,
    );
  }
}
