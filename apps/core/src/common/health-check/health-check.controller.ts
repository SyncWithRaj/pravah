import { Controller, Post, Get, Body, Logger, UseGuards } from '@nestjs/common';
import { HealthCheckService } from './health-check.service';
import { UnifiedAuthGuard, RolesGuard, Roles } from '../../auth';
import { Role } from '@prisma/client';

@Controller('admin/health')
@UseGuards(UnifiedAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class HealthCheckController {
  private readonly logger = new Logger(HealthCheckController.name);

  constructor(private readonly healthCheckService: HealthCheckService) {}

  @Post('heartbeat')
  async receiveHeartbeat(@Body() body: { edgeId: string }) {
    await this.healthCheckService.sendHeartbeat(body.edgeId);
    return { status: 'ok' };
  }

  @Get('nodes')
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
  getHealthyNodes() {
    return this.healthCheckService.getHealthyNodes();
  }
}
