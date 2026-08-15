import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AnalyticsService,
  CacheAccessMessage,
  HealthChangeMessage,
  ReplicationStatusMessage,
} from './analytics.service';

interface CacheInvalidateMessage {
  fileId: string;
  reason?: string;
}

@Controller()
export class TelemetryController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @MessagePattern('cache.access')
  handleCacheAccess(@Payload() message: CacheAccessMessage | string) {
    const data: CacheAccessMessage =
      typeof message === 'string'
        ? (JSON.parse(message) as CacheAccessMessage)
        : message;
    this.analyticsService.handleCacheAccess(data);
  }

  @MessagePattern('edge.health_changed')
  handleHealthChange(@Payload() message: HealthChangeMessage | string) {
    const data: HealthChangeMessage =
      typeof message === 'string'
        ? (JSON.parse(message) as HealthChangeMessage)
        : message;
    this.analyticsService.handleHealthChange(data);
  }

  @MessagePattern('replication.status_changed')
  handleReplicationStatus(
    @Payload() message: ReplicationStatusMessage | string,
  ) {
    const data: ReplicationStatusMessage =
      typeof message === 'string'
        ? (JSON.parse(message) as ReplicationStatusMessage)
        : message;
    this.analyticsService.handleReplicationStatus(data);
  }

  @MessagePattern('cache.invalidate')
  handleCacheInvalidate(@Payload() message: CacheInvalidateMessage | string) {
    const data: CacheInvalidateMessage =
      typeof message === 'string'
        ? (JSON.parse(message) as CacheInvalidateMessage)
        : message;
    this.analyticsService.handleCacheInvalidation(data.fileId, data.reason);
  }
}
