import { Controller, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async getMetrics(@Res({ passthrough: true }) res: any) {
    const contentType = this.metricsService.getContentType();
    if (res.setHeader) {
      res.setHeader('Content-Type', contentType);
    } else if (res.header) {
      res.header('Content-Type', contentType);
    }
    return this.metricsService.getMetrics();
  }
}

