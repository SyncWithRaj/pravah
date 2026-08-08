import { Module } from '@nestjs/common';
import { PlacementController } from './placement.controller';
import { PlacementService } from './placement.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthCheckModule } from '../common/health-check/health-check.module';

@Module({
  imports: [PrismaModule, HealthCheckModule],
  controllers: [PlacementController],
  providers: [PlacementService],
})
export class PlacementModule {}
