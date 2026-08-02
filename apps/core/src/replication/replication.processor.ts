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

/**
 * BullMQ Worker Process that consumes replication jobs from the 'replication.normal' queue.
 *
 * For each job:
 *   1. Marks the DB record as IN_PROGRESS
 *   2. Streams the file from MinIO origin
 *   3. Stores the object in the target edge node's Redis cache and updates its cache metadata (LRU, size counter).
 *   4. Marks the DB record as COMPLETE with timing metrics
 *
 * On failure, BullMQ automatically retries with exponential backoff + jitter (2s, 4s, 8s).
 * After 3 failed attempts, the job stays in BullMQ's failed queue for admin inspection.
 */
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

    // 1. Mark as IN_PROGRESS in DB
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
      // 2. Fetch file metadata from DB for cache population
      const version = await this.prisma.fileVersion.findUnique({
        where: { id: versionId },
        include: { file: true },
      });

      if (!version) {
        throw new Error(`Version ${versionId} not found for file ${fileId}`);
      }

      // 3. Prevent RAM Bloat (OOM Protection)
      // As noted, Redis is a hot-RAM cache. We explicitly refuse to stream massive files into RAM buffers.
      const MAX_RAM_CACHE_SIZE = 20 * 1024 * 1024; // 20 MB limit
      if (Number(version.size) > MAX_RAM_CACHE_SIZE) {
        this.logger.warn(
          `File ${fileId} exceeds RAM cache limit (${version.size} bytes). Bypassing Edge Cache replication.`,
        );

        // Mark complete early since we intentionally bypass RAM
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

      // 4. Stream the file from MinIO and collect into a buffer
      const stream = await this.minioService.getObjectStream(storagePath);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      const fullBuffer = Buffer.concat(chunks);

      // 5. Build cache metadata
      const metadata: CacheMetadata = {
        ownerId: version.file.ownerId,
        contentType: version.file.mimeType,
        size: fullBuffer.length,
        checksum: version.checksum,
        etag: `"${version.checksum}"`,
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: version.isCompressed ? 'gzip' : undefined,
      };

      // 6. Push into the local Redis edge cache
      await this.edgeCacheService.cacheFile(
        fileId,
        versionId,
        metadata,
        fullBuffer,
      );

      // 7. Mark as COMPLETE with timing metrics
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

      // 8. Emit Kafka event for analytics
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

      // Update DB with failure info
      await this.prisma.replicationStatus.update({
        where: {
          fileId_edgeNodeId: { fileId, edgeNodeId },
        },
        data: {
          lastError: errorMessage,
          // Only mark as FAILED if this is the last attempt
          status:
            job.attemptsMade + 1 >= (job.opts.attempts ?? 3)
              ? ReplicationJobStatus.FAILED
              : ReplicationJobStatus.IN_PROGRESS,
        },
      });

      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
        // Final failure — this will end up in BullMQ's failed queue (DLQ (Dead Letter Queue))
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

      // Re-throw so BullMQ knows to retry
      throw error;
    }
  }
}
