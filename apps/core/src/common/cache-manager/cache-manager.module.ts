import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheManagerService } from './cache-manager.service';
import { KafkaModule } from '../kafka/kafka.module';
import { TelemetryModule } from '../../telemetry/telemetry.module';
import { CacheManagerController } from './cache-manager.controller';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    KafkaModule,
    forwardRef(() => TelemetryModule),
    AuthModule,
  ],
  controllers: [CacheManagerController],
  providers: [CacheManagerService],
  exports: [CacheManagerService],
})
export class CacheManagerModule {}
