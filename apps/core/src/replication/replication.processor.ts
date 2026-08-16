import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import {
  EdgeCacheService,
  CacheMetadata,
} from '../common/edge-cache/edge-cache.service';
import { KafkaService } from '../common/kafka/kafka.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';
import { MetricsService } from '../metrics/metrics.service';
import { ReplicationJobStatus, Prisma } from '@prisma/client';
import { ReplicationJobData } from './replication.service';

@Processor('replication.normal', { concurrency: 5 })
export class ReplicationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReplicationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly edgeCacheService: EdgeCacheService,
    private readonly kafkaService: KafkaService,
    private readonly telemetryGateway: TelemetryGateway,
    private readonly metricsService: MetricsService,
  ) {
    super();
  }

  async process(job: Job<ReplicationJobData>): Promise<void> {
    const { fileId, versionId, edgeNodeId, storagePath } = job.data;
    const startTime = Date.now();
    const currentAttempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 3;

    this.logger.log(
      `Processing replication job: ${fileId} -> edge ${edgeNodeId} (attempt ${currentAttempt}/${maxAttempts})`,
    );

    await this.prisma.replicationStatus.update({
      where: {
        fileId_edgeNodeId: { fileId, edgeNodeId },
      },
      data: {
        status: ReplicationJobStatus.IN_PROGRESS,
        startedAt: new Date(),
        attempts: currentAttempt,
        payload: job.data as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      const version = await this.prisma.fileVersion.findUnique({
        where: { id: versionId },
        include: { file: true },
      });

      if (!version) {
        throw new Error(`Version ${versionId} not found for file ${fileId}`);
      }

      const MAX_RAM_CACHE_SIZE = 20 * 1024 * 1024;
      if (Number(version.size) > MAX_RAM_CACHE_SIZE) {
        this.logger.warn(
          `File ${fileId} exceeds RAM cache limit (${version.size} bytes). Bypassing Edge Cache replication.`,
        );

        await this.prisma.replicationStatus.update({
          where: { fileId_edgeNodeId: { fileId, edgeNodeId } },
          data: {
            status: ReplicationJobStatus.COMPLETE,
            completedAt: new Date(),
            durationMs: Date.now() - startTime,
            lastError: 'Bypassed: Exceeds RAM Limit',
            isDeadLetter: false,
          },
        });
        return;
      }

      const stream = await this.minioService.getObjectStream(storagePath);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      const fullBuffer = Buffer.concat(chunks);

      const metadata: CacheMetadata = {
        ownerId: version.file.ownerId,
        contentType: version.file.mimeType,
        size: fullBuffer.length,
        checksum: version.checksum,
        etag: `"${version.checksum}"`,
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: version.isCompressed ? 'gzip' : undefined,
      };

      await this.edgeCacheService.cacheFile(
        fileId,
        version.versionNumber.toString(),
        metadata,
        fullBuffer,
      );

      const durationMs = Date.now() - startTime;
      await this.prisma.replicationStatus.update({
        where: {
          fileId_edgeNodeId: { fileId, edgeNodeId },
        },
        data: {
          status: ReplicationJobStatus.COMPLETE,
          completedAt: new Date(),
          durationMs,
          lastError: null,
          isDeadLetter: false,
        },
      });

      this.kafkaService.emitReplicationStatusChanged(
        fileId,
        edgeNodeId,
        'complete',
        currentAttempt,
      );

      this.logger.log(
        `Replication complete: ${fileId} -> edge ${edgeNodeId} (${durationMs}ms, ${fullBuffer.length} bytes)`,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      const isFinalAttempt = currentAttempt >= maxAttempts;

      await this.prisma.replicationStatus.update({
        where: {
          fileId_edgeNodeId: { fileId, edgeNodeId },
        },
        data: {
          lastError: errorMessage,
          status: isFinalAttempt
            ? ReplicationJobStatus.FAILED
            : ReplicationJobStatus.IN_PROGRESS,
          isDeadLetter: isFinalAttempt,
          deadLetterAt: isFinalAttempt ? new Date() : null,
          deadLetterReason: isFinalAttempt ? errorMessage : null,
          payload: job.data as unknown as Prisma.InputJsonValue,
        },
      });

      if (isFinalAttempt) {
        // 1. Emit Kafka DLQ Event (Diagram 9: Step 10)
        this.kafkaService.emitReplicationDLQ({
          fileId,
          versionId,
          edgeNodeId,
          attempts: currentAttempt,
          maxAttempts,
          error: errorMessage,
          stack: errorStack,
          storagePath,
          failedAt: new Date().toISOString(),
          payload: job.data as unknown as Record<string, unknown>,
        });

        // 2. Emit Kafka Replication Status Changed
        this.kafkaService.emitReplicationStatusChanged(
          fileId,
          edgeNodeId,
          'failed',
          currentAttempt,
        );

        // 3. Emit Real-time WebSocket Alert to Connected Admin Dashboard
        this.telemetryGateway.broadcastDLQAlert({
          fileId,
          edgeNodeId,
          attempts: currentAttempt,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });

        // 4. Increment Prometheus DLQ Counter
        this.metricsService.dlqEventsTotal.inc({
          topic: 'file.uploaded.dlq',
          edge_id: edgeNodeId,
          action: 'queued',
        });

        this.logger.error(
          `Replication MOVED TO DLQ after ${currentAttempt} attempts: ${fileId} -> edge ${edgeNodeId}: ${errorMessage}`,
        );
      } else {
        this.logger.warn(
          `Replication attempt ${currentAttempt}/${maxAttempts} failed: ${fileId} -> edge ${edgeNodeId}: ${errorMessage}. Retrying with exponential backoff...`,
        );
      }

      throw error;
    }
  }
}
