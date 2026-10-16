import {
  Controller,
  Post,
  Get,
  Body,
  Logger,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { HealthCheckService } from './health-check.service';
import {
  UnifiedAuthGuard,
  RolesGuard,
  Roles,
  InterServiceGuard,
} from '../../auth';
import { Role } from '@prisma/client';
import { Throttle } from '../decorators/throttle.decorator';

@Controller('admin/health')
export class HealthCheckController {
  private readonly logger = new Logger(HealthCheckController.name);

  constructor(private readonly healthCheckService: HealthCheckService) {}

  @Post('heartbeat')
  @UseGuards(InterServiceGuard, RolesGuard)
  @Roles(Role.INTERNAL)
  @Throttle(120, 60)
  async receiveHeartbeat(@Body() body: { edgeId: string }) {
    if (!body?.edgeId) {
      throw new BadRequestException('edgeId is required');
    }
    if (!this.healthCheckService.isRegistered(body.edgeId)) {
      throw new NotFoundException('Unknown edge node');
    }
    await this.healthCheckService.sendHeartbeat(body.edgeId);
    return { status: 'ok' };
  }

  @Get('nodes')
  @UseGuards(UnifiedAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.STREAMER, Role.USER)
  getAllNodes() {
    const nodes = this.healthCheckService.getAllNodes();
    return {
      total: nodes.length,
      healthy: nodes.filter((n) => n.status === 'HEALTHY').length,
      degraded: nodes.filter((n) => n.status === 'DEGRADED').length,
      down: nodes.filter((n) => n.status === 'DOWN').length,
      nodes,
    };
  }

  @Get('nodes/healthy')
  @UseGuards(UnifiedAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.STREAMER, Role.USER)
  getHealthyNodes() {
    return this.healthCheckService.getHealthyNodes();
  }
}
