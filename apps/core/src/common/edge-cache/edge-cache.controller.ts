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

  @Post('purge')
  @HttpCode(HttpStatus.OK)
  purgeCache(@Body('fileId') fileId: string) {
    if (!fileId) {
      return { success: false, message: 'fileId is required' };
    }

    this.kafkaService.emitCacheInvalidate(fileId);
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
