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
import { ReplicationJobStatus } from '@prisma/client';
import { ReplicationJobData } from './replication.service';

@Processor('replication.normal', { concurrency: 5 })
export class ReplicationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReplicationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly edgeCacheService: EdgeCacheService,
    private readonly kafkaService: KafkaService,
  ) {
    super();
  }

  async process(job: Job<ReplicationJobData>): Promise<void> {
    const { fileId, versionId, edgeNodeId, storagePath } = job.data;
    const startTime = Date.now();

    this.logger.log(
      `Processing replication job: ${fileId} -> edge ${edgeNodeId} (attempt ${job.attemptsMade + 1})`,
    );

    await this.prisma.replicationStatus.update({
      where: {
        fileId_edgeNodeId: { fileId, edgeNodeId },
      },
      data: {
        status: ReplicationJobStatus.IN_PROGRESS,
        startedAt: new Date(),
        attempts: job.attemptsMade + 1,
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
        },
      });

      this.kafkaService.emitReplicationStatusChanged(
        fileId,
        edgeNodeId,
        'complete',
        job.attemptsMade + 1,
      );

      this.logger.log(
        `Replication complete: ${fileId} -> edge ${edgeNodeId} (${durationMs}ms, ${fullBuffer.length} bytes)`,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      await this.prisma.replicationStatus.update({
        where: {
          fileId_edgeNodeId: { fileId, edgeNodeId },
        },
        data: {
          lastError: errorMessage,

          status:
            job.attemptsMade + 1 >= (job.opts.attempts ?? 3)
              ? ReplicationJobStatus.FAILED
              : ReplicationJobStatus.IN_PROGRESS,
        },
      });

      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
        this.kafkaService.emitReplicationStatusChanged(
          fileId,
          edgeNodeId,
          'failed',
          job.attemptsMade + 1,
        );
        this.logger.error(
          `Replication FAILED after ${job.attemptsMade + 1} attempts: ${fileId} -> edge ${edgeNodeId}: ${errorMessage}`,
        );
      } else {
        this.logger.warn(
          `Replication attempt ${job.attemptsMade + 1} failed: ${fileId} -> edge ${edgeNodeId}: ${errorMessage}. Retrying...`,
        );
      }

      throw error;
    }
  }
}
