import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheManagerService } from './cache-manager.service';
import { KafkaModule } from '../kafka/kafka.module';
import { TelemetryModule } from '../../telemetry/telemetry.module';
import { CacheManagerController } from './cache-manager.controller';

@Module({
  imports: [ConfigModule, KafkaModule, forwardRef(() => TelemetryModule)],
  controllers: [CacheManagerController],
  providers: [CacheManagerService],
  exports: [CacheManagerService],
})
export class CacheManagerModule {}
