import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaService } from '../kafka/kafka.service';
import { EdgeNodeStatus } from '@prisma/client';

export interface EdgeNodeRecord {
  id: string;
  name: string;
  region: string;
  endpointUrl: string;
  status: EdgeNodeStatus;
  missedCycles: number;
}

@Injectable()
export class HealthCheckService implements OnModuleInit {
  private readonly logger = new Logger(HealthCheckService.name);
  private redis!: Redis;

  /**
   * In-memory node map — avoids querying PostgreSQL every 5 seconds.
   * Refreshed from DB every 5 minutes. The monitor loop reads only from this map.
   */
  private nodeMap = new Map<string, EdgeNodeRecord>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly kafkaService: KafkaService,
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

    // Initial load of all edge nodes into memory
    await this.refreshNodeMap();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HEARTBEAT (Called by each Edge Node every 10 seconds)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a heartbeat for a given edge node.
   * Sets a Redis key with a 15-second TTL — if the node crashes, the key
   * naturally expires and the monitor detects it as missing.
   */
  async sendHeartbeat(edgeId: string): Promise<void> {
    const key = `edge:${edgeId}:heartbeat`;
    await this.redis.set(key, Date.now().toString(), 'EX', 15);
    this.logger.debug(`Heartbeat received from edge: ${edgeId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MONITOR (Runs every 5 seconds via @Interval)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Non-blocking health monitor that checks Redis heartbeat keys for all
   * known edge nodes. Uses the in-memory nodeMap to avoid DB queries.
   *
   * State Machine:
   *   Heartbeat exists   -> HEALTHY (recovers from DOWN/DEGRADED)
   *   Missing 1 cycle    -> DEGRADED
   *   Missing 3+ cycles  -> DOWN
   */
  @Interval(5000)
  async monitorEdgeHealth(): Promise<void> {
    if (this.nodeMap.size === 0) return;

    for (const [edgeId, node] of this.nodeMap) {
      const heartbeat = await this.redis.get(`edge:${edgeId}:heartbeat`);

      if (heartbeat) {
        // Heartbeat present — node is alive
        if (node.status !== EdgeNodeStatus.HEALTHY) {
          // Recovery: node was DEGRADED or DOWN, now it's back
          this.logger.log(
            `Edge ${node.name} recovered: ${node.status} -> HEALTHY`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.HEALTHY);
          node.missedCycles = 0;
        }
      } else {
        // Heartbeat missing
        node.missedCycles += 1;

        if (node.missedCycles >= 3 && node.status !== EdgeNodeStatus.DOWN) {
          // 3+ misses -> DOWN
          this.logger.warn(
            `Edge ${node.name} is DOWN (missed ${node.missedCycles} cycles)`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.DOWN);
        } else if (
          node.missedCycles >= 1 &&
          node.status === EdgeNodeStatus.HEALTHY
        ) {
          // 1 miss -> DEGRADED
          this.logger.warn(
            `Edge ${node.name} DEGRADED (missed ${node.missedCycles} cycle)`,
          );
          await this.transitionStatus(edgeId, EdgeNodeStatus.DEGRADED);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NODE MAP REFRESH (Runs every 5 minutes via @Interval)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reloads the full list of edge nodes from PostgreSQL into memory.
   * This runs infrequently (every 5 minutes) to keep the in-memory map
   * in sync without hammering the database.
   */
  @Interval(300000)
  async refreshNodeMap(): Promise<void> {
    const nodes = await this.prisma.edgeNode.findMany();

    // Preserve missedCycles from existing map entries
    const newMap = new Map<string, EdgeNodeRecord>();
    for (const node of nodes) {
      const existing = this.nodeMap.get(node.id);
      newMap.set(node.id, {
        id: node.id,
        name: node.name,
        region: node.region,
        endpointUrl: node.endpointUrl,
        status: node.status,
        missedCycles: existing?.missedCycles ?? 0,
      });
    }

    this.nodeMap = newMap;
    this.logger.log(`Refreshed node map: ${nodes.length} edge nodes loaded`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS TRANSITIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transitions an edge node to a new status in both the in-memory map
   * and PostgreSQL. Emits a Kafka event for downstream consumers
   * (Replication Service, Admin Dashboard, Routing Layer).
   */
  private async transitionStatus(
    edgeId: string,
    newStatus: EdgeNodeStatus,
  ): Promise<void> {
    const node = this.nodeMap.get(edgeId);
    if (!node) return;

    const oldStatus = node.status;
    node.status = newStatus;

    // Persist to PostgreSQL
    await this.prisma.edgeNode.update({
      where: { id: edgeId },
      data: {
        status: newStatus,
        lastHeartbeat:
          newStatus === EdgeNodeStatus.HEALTHY ? new Date() : undefined,
      },
    });

    // Emit Kafka event for downstream consumers
    this.kafkaService.emitEdgeHealthChanged(edgeId, oldStatus, newStatus);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY HELPERS (Used by Routing Layer, Admin APIs)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all edge nodes that are currently marked as HEALTHY.
   * Reads from the in-memory map for zero-latency lookups.
   */
  getHealthyNodes(): EdgeNodeRecord[] {
    return Array.from(this.nodeMap.values()).filter(
      (node) => node.status === EdgeNodeStatus.HEALTHY,
    );
  }

  /**
   * Returns the full list of edge nodes with their current status.
   */
  getAllNodes(): EdgeNodeRecord[] {
    return Array.from(this.nodeMap.values());
  }
}
