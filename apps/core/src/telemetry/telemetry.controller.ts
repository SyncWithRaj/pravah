import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AnalyticsService } from './analytics.service';

@Controller()
export class TelemetryController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @MessagePattern('cache.access')
  handleCacheAccess(@Payload() message: any) {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    this.analyticsService.handleCacheAccess(data);
  }

  @MessagePattern('edge.health_changed')
  handleHealthChange(@Payload() message: any) {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    this.analyticsService.handleHealthChange(data);
  }

  @MessagePattern('replication.status_changed')
  handleReplicationStatus(@Payload() message: any) {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    this.analyticsService.handleReplicationStatus(data);
  }

  @MessagePattern('cache.invalidate')
  handleCacheInvalidate(@Payload() message: any) {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    this.analyticsService.handleCacheInvalidation(data.fileId, data.reason);
  }
}
