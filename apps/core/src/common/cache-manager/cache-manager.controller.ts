import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  forwardRef,
  UseGuards,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CacheManagerService } from './cache-manager.service';
import { KafkaService } from '../kafka/kafka.service';
import { TelemetryGateway } from '../../telemetry/telemetry.gateway';
import { UnifiedAuthGuard, RolesGuard, Roles } from '../../auth';
import { Role } from '@prisma/client';
import { Throttle } from '../decorators/throttle.decorator';

@Controller(['admin/cache', 'metadata'])
@UseGuards(UnifiedAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.INTERNAL)
@Throttle(10, 60)
export class CacheManagerController {
  private readonly logger = new Logger(CacheManagerController.name);

  constructor(
    private readonly cacheManagerService: CacheManagerService,
    private readonly kafkaService: KafkaService,
    @Inject(forwardRef(() => TelemetryGateway))
    private readonly telemetryGateway: TelemetryGateway,
  ) {}

  @Post('purge')
  @HttpCode(HttpStatus.OK)
  purgeCache(@Body('fileId') fileId: string) {
    if (!fileId) {
      return { success: false, message: 'fileId is required' };
    }

    this.kafkaService.emitCacheInvalidate(fileId);
    this.telemetryGateway.broadcastCacheInvalidated({
      fileId,
      reason: 'Manual Cluster Purge',
      timestamp: new Date().toISOString(),
    });
    this.logger.log(
      `[Purge] Broadcasted cache invalidation for file ${fileId} over Kafka`,
    );
    return { success: true, message: 'Purge event broadcasted to cluster' };
  }

  @MessagePattern('cache.invalidate')
  async handleCacheInvalidate(@Payload() message: unknown) {
    let fileId: string | undefined;

    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>;
      if (typeof msg.fileId === 'string') {
        fileId = msg.fileId;
      } else if (typeof msg.value === 'object' && msg.value !== null) {
        const val = msg.value as Record<string, unknown>;
        if (typeof val.fileId === 'string') {
          fileId = val.fileId;
        }
      }
    }

    if (fileId) {
      this.logger.log(
        `Received cache.invalidate event for file: ${fileId}. Evicting from RAM...`,
      );
      await this.cacheManagerService.evictFile(fileId);
    }
  }
}
