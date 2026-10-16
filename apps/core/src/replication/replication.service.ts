import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { HashRing } from '../common/replication/hash-ring';
import { MetricsService } from '../metrics/metrics.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';
import { ReplicationJobStatus, Prisma, FileStatus } from '@prisma/client';
import { REDIS_PASSWORD } from '../common/redis/redis.constants';

type ReplicationStatusWithNode = Prisma.ReplicationStatusGetPayload<{
  include: { edgeNode: true };
}>;

export const safeFailedJobSelect =
  Prisma.validator<Prisma.ReplicationStatusSelect>()({
    id: true,
    status: true,
    attempts: true,
    lastError: true,
    isDeadLetter: true,
    deadLetterAt: true,
    deadLetterReason: true,
    replayedAt: true,
    startedAt: true,
    completedAt: true,
    durationMs: true,
    fileId: true,
    edgeNodeId: true,
    createdAt: true,
    updatedAt: true,
    edgeNode: true,
    file: true,
  });

export type SafeFailedJob = Prisma.ReplicationStatusGetPayload<{
  select: typeof safeFailedJobSelect;
}>;

export interface ReplicationJobData {
  fileId: string;
  versionId: string;
  edgeNodeId: string;
  storagePath: string;
}

@Injectable()
export class ReplicationService implements OnModuleInit {
  private readonly logger = new Logger(ReplicationService.name);
  private readonly hashRing = new HashRing();
  private readonly edgeQueues = new Map<string, Queue>();

  private getEdgeQueue(edgeNodeId: string): Queue {
    if (process.env.NODE_ENV === 'test' && this.replicationQueue) {
      return this.replicationQueue;
    }
    let q = this.edgeQueues.get(edgeNodeId);
    if (!q) {
      const password = REDIS_PASSWORD();
      q = new Queue('replication.normal', {
        prefix: edgeNodeId,
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: Number(process.env.REDIS_PORT) || 6379,
          ...(password ? { password } : {}),
        },
      });
      this.edgeQueues.set(edgeNodeId, q);
    }
    return q;
  }

  constructor(
    @InjectQueue('replication.normal')
    private readonly replicationQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly healthCheckService: HealthCheckService,
    private readonly metricsService: MetricsService,
    private readonly telemetryGateway: TelemetryGateway,
  ) {}

  async onModuleInit() {
    await this.syncDlqGauge();
  }

  async syncDlqGauge() {
    try {
      const count = await this.prisma.replicationStatus.count({
        where: { isDeadLetter: true },
      });
      this.metricsService.dlqActiveItems.set(count);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to sync DLQ gauge: ${msg}`);
    }
  }

  async dispatchReplication(
    fileId: string,
    versionId: string,
    storagePath: string,
  ): Promise<void> {
    const healthyNodes = this.healthCheckService.getHealthyNodes();

    if (healthyNodes.length === 0) {
      this.logger.warn(
        `No healthy edge nodes available for replication of file: ${fileId}`,
      );
      return;
    }

    this.hashRing.syncTopology(healthyNodes.map((n) => n.id));

    const REPLICATION_FACTOR = 3;
    const responsibleNodeIds = this.hashRing.getNodes(
      fileId,
      REPLICATION_FACTOR,
    );

    const targetNodes = healthyNodes.filter((node) =>
      responsibleNodeIds.includes(node.id),
    );

    if (targetNodes.length < REPLICATION_FACTOR) {
      this.logger.warn(
        `[ReplicationWarning] desired=${REPLICATION_FACTOR}, actual=${targetNodes.length} for file ${fileId}`,
      );
    }

    if (targetNodes.length === 0) {
      this.logger.error(
        `Failed to dispatch replication for file ${fileId} - no responsible replicas are healthy`,
      );
      return;
    }

    this.logger.log(
      `Dispatching replication for file ${fileId} to ${targetNodes.length} edge nodes (Factor: ${REPLICATION_FACTOR})`,
    );

    const fileVersion = await this.prisma.fileVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });

    const versionStr = fileVersion ? fileVersion.versionNumber.toString() : '1';

    for (const node of targetNodes) {
      await this.prisma.replicationStatus.upsert({
        where: {
          fileId_edgeNodeId: { fileId, edgeNodeId: node.id },
        },
        create: {
          fileId,
          edgeNodeId: node.id,
          status: ReplicationJobStatus.PENDING,
        },
        update: {
          status: ReplicationJobStatus.PENDING,
          attempts: 0,
          lastError: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });

      const jobData: ReplicationJobData = {
        fileId,
        versionId: versionStr,
        edgeNodeId: node.id,
        storagePath,
      };

      try {
        await this.getEdgeQueue(node.id).add('replicate-file', jobData, {
          attempts: 3,
          priority: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error(
          `Failed to dispatch replication job to edge queue for ${node.id}: ${msg}`,
        );
      }

      await this.replicationQueue.add('replicate-file', jobData, {
        attempts: 3,
        priority: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });

      this.logger.log(
        `Queued replication job: ${fileId} -> ${node.name} (${node.region})`,
      );
    }
  }

  async getReplicationStatus(
    fileId: string,
  ): Promise<ReplicationStatusWithNode[]> {
    return this.prisma.replicationStatus.findMany({
      where: { fileId },
      include: { edgeNode: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getFailedJobs(): Promise<SafeFailedJob[]> {
    return this.prisma.replicationStatus.findMany({
      where: { status: ReplicationJobStatus.FAILED },
      select: safeFailedJobSelect,
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DLQ MANAGEMENT (Phase 7: Diagram 9)
  // ─────────────────────────────────────────────────────────────────────────

  async getDLQEvents(): Promise<SafeFailedJob[]> {
    return this.prisma.replicationStatus.findMany({
      where: {
        OR: [{ isDeadLetter: true }, { status: ReplicationJobStatus.FAILED }],
      },
      select: safeFailedJobSelect,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getDLQEventById(id: string): Promise<SafeFailedJob | null> {
    return this.prisma.replicationStatus.findUnique({
      where: { id },
      select: safeFailedJobSelect,
    });
  }

  async replayDLQEvent(
    replicationId: string,
  ): Promise<{ success: boolean; message: string; replicationId: string }> {
    const record = await this.prisma.replicationStatus.findUnique({
      where: { id: replicationId },
      include: { edgeNode: true, file: true },
    });

    if (!record) {
      throw new Error(`DLQ record ${replicationId} not found`);
    }

    const latestVersion = await this.prisma.fileVersion.findFirst({
      where: { fileId: record.fileId },
      orderBy: { versionNumber: 'desc' },
    });

    if (!latestVersion) {
      throw new Error(`No file version found for file ${record.fileId}`);
    }

    await this.prisma.replicationStatus.update({
      where: { id: replicationId },
      data: {
        status: ReplicationJobStatus.PENDING,
        attempts: 0,
        isDeadLetter: false,
        replayedAt: new Date(),
        lastError: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    });

    const jobData: ReplicationJobData = {
      fileId: record.fileId,
      versionId: latestVersion.id,
      edgeNodeId: record.edgeNodeId,
      storagePath: latestVersion.storagePath,
    };

    try {
      await this.getEdgeQueue(record.edgeNodeId).add(
        'replicate-file',
        jobData,
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Failed to dispatch retry job to edge queue for ${record.edgeNodeId}: ${msg}`,
      );
    }

    await this.replicationQueue.add('replicate-file', jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.log(
      `Replayed DLQ replication job ${replicationId} for file ${record.fileId} -> ${record.edgeNode.name}`,
    );

    this.metricsService.dlqEventsTotal.inc({
      topic: 'file.uploaded.dlq',
      edge_id: record.edgeNodeId,
      action: 'replayed',
    });

    await this.syncDlqGauge();

    return {
      success: true,
      message: `Replication job for file ${record.fileId} replayed to ${record.edgeNode.name}`,
      replicationId,
    };
  }

  async replayAllDLQEvents(): Promise<{
    replayedCount: number;
    replayedIds: string[];
  }> {
    const deadItems = await this.getDLQEvents();
    const replayedIds: string[] = [];

    for (const item of deadItems) {
      try {
        await this.replayDLQEvent(item.id);
        replayedIds.push(item.id);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error(`Failed to replay DLQ item ${item.id}: ${errorMsg}`);
      }
    }

    await this.syncDlqGauge();

    return {
      replayedCount: replayedIds.length,
      replayedIds,
    };
  }

  async purgeDLQEvent(
    replicationId: string,
  ): Promise<{ success: boolean; message: string }> {
    const record = await this.prisma.replicationStatus.findUnique({
      where: { id: replicationId },
    });

    if (!record) {
      throw new Error(`DLQ record ${replicationId} not found`);
    }

    await this.prisma.replicationStatus.update({
      where: { id: replicationId },
      data: {
        isDeadLetter: false,
        deadLetterReason: 'Purged by Admin',
      },
    });

    await this.syncDlqGauge();

    return {
      success: true,
      message: `DLQ record ${replicationId} purged successfully`,
    };
  }

  async retryFailedJob(replicationId: string): Promise<void> {
    await this.replayDLQEvent(replicationId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FAILURE FLOW 2: DYNAMIC REPLICATION REPAIR (Phase 7: Diagram 10)
  // ─────────────────────────────────────────────────────────────────────────

  async handleEdgeCrashFailover(deadEdgeId: string): Promise<{
    repairedFilesCount: number;
    dispatchedJobsCount: number;
  }> {
    this.logger.warn(
      `[Self-Healing] Edge node ${deadEdgeId} crashed or went DOWN. Initiating dynamic replication repair...`,
    );

    // 1. Get all currently healthy nodes
    const healthyNodes = this.healthCheckService.getHealthyNodes();
    const healthyNodeIds = healthyNodes.map((n) => n.id);

    // 2. Eject the dead node and sync Hash Ring with only healthy nodes
    this.hashRing.syncTopology(healthyNodeIds);

    if (healthyNodes.length === 0) {
      this.logger.error(
        `[Self-Healing] Cannot repair replication: No healthy edge nodes remain in the cluster!`,
      );
      return { repairedFilesCount: 0, dispatchedJobsCount: 0 };
    }

    // 3. Find all files that were placed on the dead node
    const affectedReplications = await this.prisma.replicationStatus.findMany({
      where: {
        edgeNodeId: deadEdgeId,
      },
      include: {
        file: {
          include: {
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (affectedReplications.length === 0) {
      this.logger.log(
        `[Self-Healing] No files were assigned to crashed node ${deadEdgeId}. Repair complete.`,
      );
      return { repairedFilesCount: 0, dispatchedJobsCount: 0 };
    }

    const REPLICATION_FACTOR = 3;
    let dispatchedJobsCount = 0;
    const uniqueFiles = new Set<string>();

    for (const rep of affectedReplications) {
      const file = rep.file;
      if (!file || file.status !== FileStatus.COMPLETED || !file.storagePath) {
        continue;
      }

      uniqueFiles.add(file.id);

      // Re-evaluate target nodes on the updated healthy hash ring
      const targetNodeIds = this.hashRing.getNodes(file.id, REPLICATION_FACTOR);

      // Find existing replication records for this file across all nodes
      const existingRecords = await this.prisma.replicationStatus.findMany({
        where: { fileId: file.id },
      });

      const completedOrPendingNodeIds = new Set(
        existingRecords
          .filter(
            (r) =>
              r.edgeNodeId !== deadEdgeId &&
              (r.status === ReplicationJobStatus.COMPLETE ||
                r.status === ReplicationJobStatus.PENDING ||
                r.status === ReplicationJobStatus.IN_PROGRESS),
          )
          .map((r) => r.edgeNodeId),
      );

      // Determine replacement nodes that need replication
      const nodesNeedingReplication = healthyNodes.filter(
        (node) =>
          targetNodeIds.includes(node.id) &&
          !completedOrPendingNodeIds.has(node.id),
      );

      const latestVersion = file.versions[0];
      const versionStr = latestVersion
        ? latestVersion.versionNumber.toString()
        : '1';

      for (const targetNode of nodesNeedingReplication) {
        await this.prisma.replicationStatus.upsert({
          where: {
            fileId_edgeNodeId: {
              fileId: file.id,
              edgeNodeId: targetNode.id,
            },
          },
          create: {
            fileId: file.id,
            edgeNodeId: targetNode.id,
            status: ReplicationJobStatus.PENDING,
          },
          update: {
            status: ReplicationJobStatus.PENDING,
            attempts: 0,
            lastError: null,
            isDeadLetter: false,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        });

        const jobData: ReplicationJobData = {
          fileId: file.id,
          versionId: versionStr,
          edgeNodeId: targetNode.id,
          storagePath: file.storagePath,
        };

        try {
          await this.getEdgeQueue(targetNode.id).add(
            'replicate-file',
            jobData,
            {
              attempts: 3,
              priority: 3,
              backoff: {
                type: 'exponential',
                delay: 2000,
              },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          this.logger.error(
            `Failed to dispatch repair job to edge queue for ${targetNode.id}: ${msg}`,
          );
        }

        await this.replicationQueue.add('replicate-file', jobData, {
          attempts: 3,
          priority: 3, // higher priority for self-healing repair
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        });

        dispatchedJobsCount++;

        // Broadcast telemetry event
        this.telemetryGateway.broadcastReplicationRepaired({
          fileId: file.id,
          deadNodeId: deadEdgeId,
          replacementNodeId: targetNode.id,
          timestamp: new Date().toISOString(),
        });

        // Record Prometheus metric
        this.metricsService.replicationRepairsTotal.inc({
          dead_edge_id: deadEdgeId,
          target_edge_id: targetNode.id,
        });

        this.logger.log(
          `[Self-Healing] Dispatched repair replication for file ${file.name} (${file.id}) -> replacement node ${targetNode.name} (${targetNode.region})`,
        );
      }
    }

    this.logger.log(
      `[Self-Healing] Finished repair for dead node ${deadEdgeId}: ${uniqueFiles.size} files evaluated, ${dispatchedJobsCount} repair jobs dispatched.`,
    );

    return {
      repairedFilesCount: uniqueFiles.size,
      dispatchedJobsCount,
    };
  }
}
