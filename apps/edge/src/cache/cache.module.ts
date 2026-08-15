import { Module } from '@nestjs/common';
import { EdgeCacheService } from './cache.service';

@Module({
  providers: [EdgeCacheService],
  exports: [EdgeCacheService],
})
export class CacheModule {}
