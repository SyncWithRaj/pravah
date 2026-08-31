import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly edgeNodeId: string;
  private readonly coreApiUrl: string;
  private readonly serviceSecret: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.edgeNodeId = this.configService.get<string>('EDGE_NODE_ID', 'edge-node-01');
    this.coreApiUrl = this.configService.get<string>('CORE_API_URL', 'http://localhost:3000');
    this.serviceSecret = this.configService.get<string>(
      'INTERNAL_SERVICE_SECRET',
      'pravah-internal-microservice-super-secret-2026',
    );
  }

  @Cron('*/10 * * * * *')
  async sendHeartbeat() {
    try {
      const path = '/api/v1/admin/health/heartbeat';
      const timestamp = Date.now();
      const payload = `${this.edgeNodeId}:POST:${path}:${timestamp}`;
      const signature = crypto
        .createHmac('sha256', this.serviceSecret)
        .update(payload)
        .digest('hex');

      await this.httpService.axiosRef.post(
        `${this.coreApiUrl}${path}`,
        { edgeId: this.edgeNodeId },
        {
          headers: {
            'x-service-id': this.edgeNodeId,
            'x-service-timestamp': timestamp.toString(),
            'x-service-signature': signature,
          },
        },
      );
      this.logger.debug(`Sent authenticated heartbeat for node: ${this.edgeNodeId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send heartbeat: ${error.message}`);
    }
  }
}
