import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { HealthCheckModule } from '../health-check/health-check.module';

@Module({
  imports: [HealthCheckModule],
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
