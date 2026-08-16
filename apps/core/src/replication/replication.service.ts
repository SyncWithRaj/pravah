import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { HashRing } from '../common/replication/hash-ring';
import { MetricsService } from '../metrics/metrics.service';
import { ReplicationJobStatus, Prisma, EdgeNodeStatus } from '@prisma/client';

type ReplicationStatusWithNode = Prisma.ReplicationStatusGetPayload<{
  include: { edgeNode: true };
}>;

type FailedJobWithNodeAndFile = Prisma.ReplicationStatusGetPayload<{
  include: { edgeNode: true; file: true };
}>;

export interface ReplicationJobData {
  fileId: string;
  versionId: string;
  edgeNodeId: string;
  edgeEndpointUrl: string;
  storagePath: string;
}

@Injectable()
export class ReplicationService {
  private readonly logger = new Logger(ReplicationService.name);
  private readonly hashRing = new HashRing();

  constructor(
    @InjectQueue('replication.normal')
    private readonly replicationQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly healthCheckService: HealthCheckService,
    private readonly metricsService: MetricsService,
  ) {}

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

    const allNodes = this.healthCheckService.getAllNodes();
    this.hashRing.syncTopology(allNodes.map((n) => n.id));

    const REPLICATION_FACTOR = 3;
    const responsibleNodeIds = this.hashRing.getNodes(
      fileId,
      REPLICATION_FACTOR,
    );

    const targetNodes = allNodes.filter(
      (node) =>
        responsibleNodeIds.includes(node.id) &&
        node.status === EdgeNodeStatus.HEALTHY,
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
        edgeEndpointUrl: node.endpointUrl,
        storagePath,
      };

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

  async getFailedJobs(): Promise<FailedJobWithNodeAndFile[]> {
    return this.prisma.replicationStatus.findMany({
      where: { status: ReplicationJobStatus.FAILED },
      include: { edgeNode: true, file: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DLQ MANAGEMENT (Phase 7: Diagram 9)
  // ─────────────────────────────────────────────────────────────────────────

  async getDLQEvents(): Promise<FailedJobWithNodeAndFile[]> {
    return this.prisma.replicationStatus.findMany({
      where: {
        OR: [{ isDeadLetter: true }, { status: ReplicationJobStatus.FAILED }],
      },
      include: { edgeNode: true, file: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getDLQEventById(id: string): Promise<FailedJobWithNodeAndFile | null> {
    return this.prisma.replicationStatus.findUnique({
      where: { id },
      include: { edgeNode: true, file: true },
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
      edgeEndpointUrl: record.edgeNode.endpointUrl,
      storagePath: latestVersion.storagePath,
    };

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

    return {
      success: true,
      message: `DLQ record ${replicationId} purged successfully`,
    };
  }

  async retryFailedJob(replicationId: string): Promise<void> {
    await this.replayDLQEvent(replicationId);
  }
}
