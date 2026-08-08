import { Module } from '@nestjs/common';
import { EdgeCacheService } from './cache.service';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [KafkaModule],
  providers: [EdgeCacheService],
  exports: [EdgeCacheService],
})
export class CacheModule {}
