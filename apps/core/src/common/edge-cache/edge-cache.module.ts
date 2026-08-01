import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EdgeCacheService } from './edge-cache.service';
import { KafkaModule } from '../kafka/kafka.module';

import { EdgeCacheController } from './edge-cache.controller';

@Module({
  imports: [ConfigModule, KafkaModule],
  controllers: [EdgeCacheController],
  providers: [EdgeCacheService],
  exports: [EdgeCacheService],
})
export class EdgeCacheModule {}
