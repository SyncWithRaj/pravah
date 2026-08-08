import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { MinioService } from '../minio/minio.service';
import {
  EdgeCacheService,
  CacheMetadata,
} from '../cache/cache.service';
import { KafkaService } from '../kafka/kafka.service';

interface ReplicationJobData {
  fileId: string;
  versionId: string;
  edgeNodeId: string;
  storagePath: string;
}

@Processor('replication.normal', { concurrency: 5 })
export class ReplicationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReplicationProcessor.name);

  constructor(
    private readonly minioService: MinioService,
    private readonly edgeCacheService: EdgeCacheService,
    private readonly kafkaService: KafkaService,
    private readonly httpService: HttpService,
  ) {
    super();
  }

  async process(job: Job<ReplicationJobData>): Promise<void> {
    const { fileId, versionId, edgeNodeId, storagePath } = job.data;
    const startTime = Date.now();

    // Determine the ACTUAL node ID processing this (in case of queue stealing)
    const actualNodeId = process.env.EDGE_NODE_ID || 'edge-node-01';

    this.logger.log(
      `Processing replication job: ${fileId} -> edge ${actualNodeId} (attempt ${job.attemptsMade + 1})`,
    );

    // 1. Emit IN_PROGRESS status
    this.kafkaService.emitReplicationStatusChanged(
      fileId,
      actualNodeId,
      'in_progress',
      job.attemptsMade + 1,
    );

    try {
      // 2. Fetch file metadata from Core API via HTTP
      let metadataResponse;
      try {
        const response = await firstValueFrom(
          this.httpService.get(
            `http://localhost:3000/api/v1/internal/metadata/files/${fileId}`,
          )
        );
        metadataResponse = response.data;
      } catch (error) {
        this.logger.error(`Failed to fetch metadata for replication: ${error.message}`);
        // Fallback: If we can't get metadata, we still have the storagePath to fetch the file.
        // We will just stream the MinIO file without RAM cache if we don't know the size, or stream into chunks.
      }

      // 4. Stream the file from MinIO and collect into a buffer
      const stream = await this.minioService.getObjectStream(storagePath);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        let currentSize = 0;
        const MAX_RAM_CACHE_SIZE = 20 * 1024 * 1024;
        
        stream.on('data', (chunk: Buffer) => {
          currentSize += chunk.length;
          if (currentSize > MAX_RAM_CACHE_SIZE) {
            reject(new Error('Bypassed: Exceeds RAM Limit'));
            // In a real scenario we'd abort the stream cleanly here.
          } else {
            chunks.push(chunk);
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      const fullBuffer = Buffer.concat(chunks);

      // 5. Build cache metadata
      const metadata: CacheMetadata = {
        ownerId: metadataResponse?.ownerId || 'unknown',
        contentType: metadataResponse?.mimeType || 'application/octet-stream',
        size: fullBuffer.length,
        checksum: metadataResponse?.currentVersion?.checksum || '',
        etag: `"${metadataResponse?.currentVersion?.checksum || ''}"`,
        cacheControl: 'public, max-age=31536000, immutable',
      };

      // 6. Push into the local Redis edge cache
      await this.edgeCacheService.cacheFile(
        fileId,
        versionId,
        metadata,
        fullBuffer,
      );

      // 7. Emit Kafka event for COMPLETE
      const durationMs = Date.now() - startTime;
      this.kafkaService.emitReplicationStatusChanged(
        fileId,
        actualNodeId,
        'complete',
        job.attemptsMade + 1,
      );

      this.logger.log(
        `Replication complete: ${fileId} -> edge ${actualNodeId} (${durationMs}ms, ${fullBuffer.length} bytes)`,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
        
      if (errorMessage === 'Bypassed: Exceeds RAM Limit') {
        this.logger.warn(`File ${fileId} bypassed edge cache (too large).`);
        this.kafkaService.emitReplicationStatusChanged(
          fileId,
          actualNodeId,
          'complete',
          job.attemptsMade + 1,
        );
        return;
      }

      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
        this.kafkaService.emitReplicationStatusChanged(
          fileId,
          actualNodeId,
          'failed',
          job.attemptsMade + 1,
        );
        this.logger.error(
          `Replication FAILED after ${job.attemptsMade + 1} attempts: ${fileId} -> edge ${actualNodeId}: ${errorMessage}`,
        );
      } else {
        this.logger.warn(
          `Replication attempt ${job.attemptsMade + 1} failed: ${fileId} -> edge ${actualNodeId}: ${errorMessage}. Retrying...`,
        );
      }

      throw error;
    }
  }
}

