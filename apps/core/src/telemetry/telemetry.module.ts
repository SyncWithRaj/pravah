import { Module, Global } from '@nestjs/common';
import { TelemetryGateway } from './telemetry.gateway';
import { AnalyticsService } from './analytics.service';
import { TelemetryController } from './telemetry.controller';

@Global()
@Module({
  controllers: [TelemetryController],
  providers: [TelemetryGateway, AnalyticsService],
  exports: [TelemetryGateway, AnalyticsService],
})
export class TelemetryModule {}
