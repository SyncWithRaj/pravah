import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { EdgeCacheService } from './edge-cache.service';
import { KafkaService } from '../kafka/kafka.service';

@Controller('admin/cache')
export class EdgeCacheController {
  private readonly logger = new Logger(EdgeCacheController.name);

  constructor(
    private readonly edgeCacheService: EdgeCacheService,
    private readonly kafkaService: KafkaService,
  ) {}

  /**
   * REST endpoint to manually trigger a cluster-wide cache invalidation.
   */
  @Post('purge')
  @HttpCode(HttpStatus.OK)
  purgeCache(@Body('fileId') fileId: string) {
    if (!fileId) {
      return { success: false, message: 'fileId is required' };
    }
    // Emit event so ALL edge nodes receive it, including ourselves.
    this.kafkaService.emitCacheInvalidate(fileId);
    return { success: true, message: 'Purge event broadcasted to cluster' };
  }

  /**
   * Kafka consumer for cache invalidation events.
   * Every edge node in the cluster will receive this simultaneously.
   */
  @MessagePattern('cache.invalidate')
  async handleCacheInvalidate(@Payload() message: unknown) {
    // Handle both plain objects and KafkaMessage payloads
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
