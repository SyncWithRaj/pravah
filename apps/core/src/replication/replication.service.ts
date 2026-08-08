import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { HashRing } from '../common/replication/hash-ring';
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
  ) {}

  /**
   * Dispatches replication jobs for a newly uploaded file.
   * Called by the Kafka consumer when a 'file.uploaded' event arrives.
   *
   * Flow:
   *   1. Get all HEALTHY edge nodes from the in-memory map
   *   2. Create PENDING rows in ReplicationStatus (DB)
   *   3. Push jobs into the BullMQ 'replication.normal' queue
   */
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

    // Sync HashRing with the static topology (all nodes)
    const allNodes = this.healthCheckService.getAllNodes();
    this.hashRing.syncTopology(allNodes.map((n) => n.id));

    // Phase 5B: Find responsible replicas via Consistent Hashing Ring
    const REPLICATION_FACTOR = 3;
    const responsibleNodeIds = this.hashRing.getNodes(
      fileId,
      REPLICATION_FACTOR,
    );

    // Filter responsible nodes against LIVE HEALTHY availability
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

    // 5. Phase 5C Bugfix: We need the integer versionNumber for the Edge to cache correctly
    const fileVersion = await this.prisma.fileVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });

    const versionStr = fileVersion ? fileVersion.versionNumber.toString() : '1';

    for (const node of targetNodes) {
      // Create or update the replication status record
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

      // Push the job into BullMQ with exponential backoff + jitter
      const jobData: ReplicationJobData = {
        fileId,
        versionId: versionStr, // <--- Now passes integer string (e.g. "1") instead of UUID
        edgeNodeId: node.id,
        edgeEndpointUrl: node.endpointUrl,
        storagePath,
      };

      await this.replicationQueue.add('replicate-file', jobData, {
        attempts: 3,
        priority: 5, // Normal priority. Critical files could use priority: 1 later.
        backoff: {
          type: 'exponential',
          delay: 2000, // Base delay: 2s, then 4s, then 8s
        },
        removeOnComplete: true,
        removeOnFail: false, // Keep failed jobs for DLQ inspection
      });

      this.logger.log(
        `Queued replication job: ${fileId} -> ${node.name} (${node.region})`,
      );
    }
  }

  /**
   * Returns the replication status for a specific file across all edges.
   */
  async getReplicationStatus(
    fileId: string,
  ): Promise<ReplicationStatusWithNode[]> {
    return this.prisma.replicationStatus.findMany({
      where: { fileId },
      include: { edgeNode: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns all failed replication jobs (DLQ inspection).
   */
  async getFailedJobs(): Promise<FailedJobWithNodeAndFile[]> {
    return this.prisma.replicationStatus.findMany({
      where: { status: ReplicationJobStatus.FAILED },
      include: { edgeNode: true, file: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Retries a failed replication job by re-dispatching it to the queue.
   */
  async retryFailedJob(replicationId: string): Promise<void> {
    const record = await this.prisma.replicationStatus.findUnique({
      where: { id: replicationId },
      include: { edgeNode: true, file: true },
    });

    if (!record) {
      throw new Error(`Replication record ${replicationId} not found`);
    }

    if (record.status !== ReplicationJobStatus.FAILED) {
      throw new Error(
        `Replication record ${replicationId} is not in FAILED state`,
      );
    }

    // Find the latest version's storage path
    const latestVersion = await this.prisma.fileVersion.findFirst({
      where: { fileId: record.fileId },
      orderBy: { versionNumber: 'desc' },
    });

    if (!latestVersion) {
      throw new Error(`No version found for file ${record.fileId}`);
    }

    // Reset and re-dispatch
    await this.prisma.replicationStatus.update({
      where: { id: replicationId },
      data: {
        status: ReplicationJobStatus.PENDING,
        attempts: 0,
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
      `Retried replication job ${replicationId} -> ${record.edgeNode.name}`,
    );
  }
}
