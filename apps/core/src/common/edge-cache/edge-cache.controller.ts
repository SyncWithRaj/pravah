import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { EdgeCacheService } from './edge-cache.service';
import { KafkaService } from '../kafka/kafka.service';
import { TelemetryGateway } from '../../telemetry/telemetry.gateway';

@Controller(['admin/cache', 'metadata'])
export class EdgeCacheController {
  private readonly logger = new Logger(EdgeCacheController.name);

  constructor(
    private readonly edgeCacheService: EdgeCacheService,
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
      await this.edgeCacheService.evictFile(fileId);
    }
  }
}
