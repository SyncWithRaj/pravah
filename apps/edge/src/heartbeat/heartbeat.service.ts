import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly edgeNodeId: string;
  private readonly coreApiUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.edgeNodeId = this.configService.get<string>('EDGE_NODE_ID', 'edge-node-01');
    this.coreApiUrl = this.configService.get<string>('CORE_API_URL', 'http://localhost:3000');
  }

  
  @Cron('*/10 * * * * *')
  async sendHeartbeat() {
    try {
      await this.httpService.axiosRef.post(`${this.coreApiUrl}/api/v1/admin/health/heartbeat`, {
        edgeId: this.edgeNodeId,
      });
      this.logger.debug(`Sent heartbeat for node: ${this.edgeNodeId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send heartbeat: ${error.message}`);
    }
  }
}
