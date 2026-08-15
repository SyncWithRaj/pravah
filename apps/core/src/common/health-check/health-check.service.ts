import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaService } from '../kafka/kafka.service';
import { EdgeNodeStatus } from '@prisma/client';
import { MetricsService } from '../../metrics/metrics.service';

export interface EdgeNodeRecord {
  id: string;
  name: string;
  region: string;
  endpointUrl: string;
  latitude: number;
  longitude: number;
  status: EdgeNodeStatus;
  missedCycles: number;
}

@Injectable()
export class HealthCheckService implements OnModuleInit {
  private readonly logger = new Logger(HealthCheckService.name);
  private redis!: Redis;

  private nodeMap = new Map<string, EdgeNodeRecord>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly kafkaService: KafkaService,
    private readonly metricsService: MetricsService,
  ) {}

  async onModuleInit() {
    const redisHost =
      this.configService.get<string>('REDIS_HOST') || 'localhost';
    const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;

    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
    });

    this.redis.on('connect', () => {
      this.logger.log(
        `HealthCheck Redis connected at ${redisHost}:${redisPort}`,
      );
    });

    this.redis.on('error', (err) => {
      this.logger.error(`HealthCheck Redis error: ${err.message}`, err.stack);
    });

    await this.refreshNodeMap();
  }

  async sendHeartbeat(edgeId: string): Promise<void> {
    const key = `edge:${edgeId}:heartbeat`;
    await this.redis.set(key, Date.now().toString(), 'EX', 15);
    this.logger.debug(`Heartbeat received from edge: ${edgeId}`);
  }

  @Interval(5000)
  async monitorEdgeHealth(): Promise<void> {
    if (this.nodeMap.size === 0) return;

    for (const [edgeId, node] of this.nodeMap) {
      const heartbeat = await this.redis.get(`edge:${edgeId}:heartbeat`);

      if (heartbeat) {
        if (node.status !== EdgeNodeStatus.HEALTHY) {
          this.logger.log(
            `Edge ${node.name} recovered: ${node.status} -> HEALTHY`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.HEALTHY);
          node.missedCycles = 0;
        }
      } else {
        node.missedCycles += 1;

        if (node.missedCycles >= 3 && node.status !== EdgeNodeStatus.DOWN) {
          this.logger.warn(
            `Edge ${node.name} is DOWN (missed ${node.missedCycles} cycles)`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.DOWN);
        } else if (
          node.missedCycles >= 1 &&
          node.status === EdgeNodeStatus.HEALTHY
        ) {
          this.logger.warn(
            `Edge ${node.name} DEGRADED (missed ${node.missedCycles} cycle)`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.DEGRADED);
        }
      }
    }
  }

  @Interval(300000)
  async refreshNodeMap(): Promise<void> {
    const nodes = await this.prisma.edgeNode.findMany();

    const newMap = new Map<string, EdgeNodeRecord>();
    for (const node of nodes) {
      const existing = this.nodeMap.get(node.id);
      const record: EdgeNodeRecord = {
        id: node.id,
        name: node.name,
        region: node.region,
        endpointUrl: node.endpointUrl,
        latitude: node.latitude,
        longitude: node.longitude,
        status: node.status,
        missedCycles: existing?.missedCycles ?? 0,
      };
      newMap.set(node.id, record);
      const gaugeVal =
        node.status === EdgeNodeStatus.HEALTHY
          ? 1
          : node.status === EdgeNodeStatus.DEGRADED
            ? 0.5
            : 0;
      this.metricsService.edgeHealthStatus.set(
        {
          edge_id: node.id,
          edge_name: node.name,
          region: node.region,
        },
        gaugeVal,
      );
    }

    this.nodeMap = newMap;
    this.logger.log(`Refreshed node map: ${nodes.length} edge nodes loaded`);
  }

  private async transitionStatus(
    edgeId: string,
    newStatus: EdgeNodeStatus,
  ): Promise<void> {
    const node = this.nodeMap.get(edgeId);
    if (!node) return;

    const oldStatus = node.status;
    node.status = newStatus;

    // Update Prometheus Gauge: 1 = HEALTHY, 0.5 = DEGRADED, 0 = DOWN
    const gaugeVal =
      newStatus === EdgeNodeStatus.HEALTHY
        ? 1
        : newStatus === EdgeNodeStatus.DEGRADED
          ? 0.5
          : 0;
    this.metricsService.edgeHealthStatus.set(
      {
        edge_id: node.id,
        edge_name: node.name,
        region: node.region,
      },
      gaugeVal,
    );

    await this.prisma.edgeNode.update({
      where: { id: edgeId },
      data: {
        status: newStatus,
        lastHeartbeat:
          newStatus === EdgeNodeStatus.HEALTHY ? new Date() : undefined,
      },
    });

    this.kafkaService.emitEdgeHealthChanged(edgeId, oldStatus, newStatus);
  }

  getHealthyNodes(): EdgeNodeRecord[] {
    return Array.from(this.nodeMap.values()).filter(
      (node) => node.status === EdgeNodeStatus.HEALTHY,
    );
  }

  getAllNodes(): EdgeNodeRecord[] {
    return Array.from(this.nodeMap.values());
  }
}
