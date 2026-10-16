import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TelemetryGateway } from './telemetry.gateway';
import { AnalyticsService } from './analytics.service';
import { TelemetryController } from './telemetry.controller';

@Global()
@Module({
  imports: [ConfigModule, JwtModule],
  controllers: [TelemetryController],
  providers: [TelemetryGateway, AnalyticsService],
  exports: [TelemetryGateway, AnalyticsService],
})
export class TelemetryModule {}
