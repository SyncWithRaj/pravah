import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { signServiceRequest } from '../common/security/service-hmac.util';

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
    this.serviceSecret = this.configService.get<string>('INTERNAL_SERVICE_SECRET') || '';
  }

  @Cron('*/10 * * * * *')
  async sendHeartbeat() {
    try {
      const coreBase = this.coreApiUrl.replace(/\/+$/, '').replace(/\/api\/v1\/?$/, '');
      const path = '/api/v1/admin/health/heartbeat';
      const body = { edgeId: this.edgeNodeId };
      const headers = signServiceRequest(
        this.edgeNodeId,
        'POST',
        path,
        this.serviceSecret,
        body,
      );

      await this.httpService.axiosRef.post(
        `${coreBase}${path}`,
        body,
        {
          headers,
          timeout: 3000,
        },
      );
      this.logger.debug(`Sent authenticated heartbeat for node: ${this.edgeNodeId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send heartbeat: ${error.message}`);
    }
  }
}
