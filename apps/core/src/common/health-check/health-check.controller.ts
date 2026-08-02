import { Controller, Post, Get, Body, Logger } from '@nestjs/common';
import { HealthCheckService } from './health-check.service';

@Controller('admin/health')
export class HealthCheckController {
  private readonly logger = new Logger(HealthCheckController.name);

  constructor(private readonly healthCheckService: HealthCheckService) {}

  /**
   * POST /api/v1/admin/health/heartbeat
   * Called by each edge node every 10 seconds to report liveness.
   */
  @Post('heartbeat')
  async receiveHeartbeat(@Body() body: { edgeId: string }) {
    await this.healthCheckService.sendHeartbeat(body.edgeId);
    return { status: 'ok' };
  }

  /**
   * GET /api/v1/admin/health/nodes
   * Returns the current status of all registered edge nodes.
   */
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

  /**
   * GET /api/v1/admin/health/nodes/healthy
   * Returns only HEALTHY nodes (used by routing layer).
   */
  @Get('nodes/healthy')
  getHealthyNodes() {
    return this.healthCheckService.getHealthyNodes();
  }
}
