import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EdgeCacheService } from './edge-cache.service';
import { KafkaModule } from '../kafka/kafka.module';
import { TelemetryModule } from '../../telemetry/telemetry.module';
import { EdgeCacheController } from './edge-cache.controller';

@Module({
  imports: [ConfigModule, KafkaModule, forwardRef(() => TelemetryModule)],
  controllers: [EdgeCacheController],
  providers: [EdgeCacheService],
  exports: [EdgeCacheService],
})
export class EdgeCacheModule {}
