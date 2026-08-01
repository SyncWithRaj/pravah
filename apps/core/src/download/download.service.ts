import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { ConfigService } from '@nestjs/config';
import { Readable, PassThrough } from 'stream';
import { EdgeCacheService } from '../common/edge-cache/edge-cache.service';
import { v4 as uuidv4 } from 'uuid';

export interface DownloadResult {
  isNotModified?: boolean;
  stream?: Readable;
  contentLength?: number;
  contentType?: string;
  contentRange?: string;
  fileName?: string;
  totalSize?: number;
  isCompressed?: boolean;
  etag?: string;
  cacheControl?: string;
  contentEncoding?: string;
}

@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly edgeCacheService: EdgeCacheService,
  ) {}

  /**
   * Helper to check if a file is eligible for Redis caching.
   */
  private isCacheable(mimeType: string, size: number): boolean {
    const MAX_CACHE_SIZE =
      this.configService.get<number>('MAX_CACHE_SIZE') || 20 * 1024 * 1024; // Default 20MB

    if (size > MAX_CACHE_SIZE) {
      return false;
    }

    const cacheablePrefixes = [
      'image/',
      'text/',
      'application/javascript',
      'application/json',
      'application/pdf',
      'font/',
    ];

    return cacheablePrefixes.some((prefix) => mimeType.startsWith(prefix));
  }

  /**
   * Helper to format a cache hit into a DownloadResult.
   */
  private formatCacheHit(
    cachedBinary: Buffer,
    metadata: {
      contentType: string;
      size: number;
      etag: string;
      cacheControl: string;
      contentEncoding?: string;
    },
    rangeHeader?: string,
  ): DownloadResult {
    let stream: Readable;
    let contentLength = cachedBinary.length;
    let contentRange: string | undefined;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;

      if (start >= contentLength || end >= contentLength) {
        throw new BadRequestException('Requested range not satisfiable');
      }

      const chunk = cachedBinary.subarray(start, end + 1);
      stream = Readable.from(chunk);
      contentLength = chunk.length;
      contentRange = `bytes ${start}-${end}/${cachedBinary.length}`;
    } else {
      stream = Readable.from(cachedBinary);
    }

    return {
      stream,
      contentLength,
      contentRange,
      contentType: metadata.contentType,
      totalSize: metadata.size,
      etag: metadata.etag,
      cacheControl: metadata.cacheControl,
      contentEncoding: metadata.contentEncoding,
    };
  }

  /**
   * Determines the current active version of a file.
   * Uses Redis as primary, falls back to Postgres on miss.
   */
  private async resolveCurrentVersion(userId: string, fileId: string) {
    let currentVersion = await this.edgeCacheService.getCurrentVersion(fileId);

    if (!currentVersion) {
      // Fallback to PostgreSQL (Source of Truth)
      const file = await this.prisma.file.findUnique({
        where: { id: fileId },
        include: { currentVersion: true },
      });

      if (!file) {
        throw new NotFoundException('File not found');
      }

      if (file.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }

      if (file.status !== 'COMPLETED' && !file.currentVersionId) {
        throw new BadRequestException('File upload is not yet complete');
      }

      currentVersion = file.currentVersionId || 'v1'; // Default if versioning not fully set up yet

      // Lazy load pointer back into Redis
      await this.edgeCacheService.setCurrentVersion(fileId, currentVersion);
    }

    return currentVersion;
  }

  /**
   * Centralized download logic handling ETag, Caching, Stampede Protection, and Range.
   */
  async processDownload(
    userId: string,
    fileId: string,
    versionId: string,
    ifNoneMatch?: string,
    rangeHeader?: string,
  ): Promise<DownloadResult> {
    // 1. Check Metadata in Redis
    let metadata = await this.edgeCacheService.getMetadata(fileId, versionId);

    if (metadata) {
      // DB-less Authorization
      if (metadata.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }

      // 2. Evaluate Conditional      // 3. ETag Match (304 Not Modified)
      const cleanEtag = metadata.etag.replace(/^"+|"+$/g, '');
      const cleanIfNoneMatch = ifNoneMatch
        ? ifNoneMatch.replace(/^"+|"+$/g, '')
        : null;

      if (cleanIfNoneMatch && cleanEtag === cleanIfNoneMatch) {
        return {
          isNotModified: true,
          etag: metadata.etag,
          cacheControl: metadata.cacheControl,
        };
      }
    } else {
      // Fetch metadata from DB if missing in cache
      const versionRec = await this.prisma.fileVersion.findUnique({
        where: { id: versionId },
        include: { file: true },
      });

      if (!versionRec || !versionRec.file) {
        throw new NotFoundException('Version not found');
      }

      if (versionRec.file.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }

      const minioMeta = await this.minioService.getObjectMetadata(
        versionRec.storagePath,
      );

      metadata = {
        ownerId: versionRec.file.ownerId,
        contentType: versionRec.file.mimeType || minioMeta.contentType,
        size: Number(versionRec.size),
        checksum: versionRec.checksum,
        etag: minioMeta.etag
          ? minioMeta.etag.startsWith('"')
            ? minioMeta.etag
            : `"${minioMeta.etag}"`
          : `"${versionRec.checksum}"`,
        cacheControl: 'public, max-age=86400',
        contentEncoding: versionRec.isCompressed ? 'gzip' : undefined,
      };

      // Evaluate ETag safely (stripping arbitrary extra quotes from Redis or client)
      const cleanEtag = metadata.etag.replace(/^"+|"+$/g, '');
      const cleanIfNoneMatch = ifNoneMatch
        ? ifNoneMatch.replace(/^"+|"+$/g, '')
        : null;

      if (cleanIfNoneMatch && cleanEtag === cleanIfNoneMatch) {
        return {
          isNotModified: true,
          etag: metadata.etag,
          cacheControl: metadata.cacheControl,
        };
      }
    }

    // 3. Attempt Cache Binary Fetch
    let cachedBinary = await this.edgeCacheService.getBinary(
      fileId,
      versionId,
      metadata.size,
    );

    if (cachedBinary) {
      return this.formatCacheHit(cachedBinary, metadata, rangeHeader);
    }

    // 4. CACHE MISS -> Fetch from Origin (MinIO)
    const startTime = Date.now();
    const isEligible =
      this.isCacheable(metadata.contentType, metadata.size) && !rangeHeader;
    let locked = false;
    const lockValue = uuidv4();

    if (isEligible) {
      locked = await this.edgeCacheService.acquireStampedeLock(
        fileId,
        versionId,
        lockValue,
      );

      if (!locked) {
        // Someone else is fetching. Wait for the cache.
        const cacheAppeared = await this.edgeCacheService.waitForCache(
          fileId,
          versionId,
        );

        if (cacheAppeared) {
          cachedBinary = await this.edgeCacheService.getBinary(
            fileId,
            versionId,
            metadata.size,
          );
          if (cachedBinary) {
            return this.formatCacheHit(cachedBinary, metadata, rangeHeader);
          }
        }

        // Lock dropped (origin fetch failed) or timed out. Try to become the new leader to prevent stampede.
        locked = await this.edgeCacheService.acquireStampedeLock(
          fileId,
          versionId,
          lockValue,
        );
        if (!locked) {
          this.logger.warn(
            `Failed to acquire stampede lock for ${fileId}:${versionId} after wait, falling back to MinIO.`,
          );
        }
      }
    }

    // Need storage path. If we didn't hit DB earlier, we need it now.
    const versionRec = await this.prisma.fileVersion.findUnique({
      where: { id: versionId },
      include: { file: true },
    });
    const storagePath = versionRec!.storagePath;
    const fileName = versionRec!.file.name;

    let resultStream: Readable;
    let contentLength = metadata.size;
    let contentRange: string | undefined;

    try {
      if (rangeHeader) {
        const minioResult = await this.minioService.getObjectStreamWithRange(
          storagePath,
          rangeHeader,
        );
        resultStream = minioResult.stream;
        contentLength = minioResult.contentLength;
        contentRange = minioResult.contentRange;
      } else {
        resultStream = await this.minioService.getObjectStream(storagePath);
      }
    } catch (err) {
      // If MinIO fetch fails instantly, leader must release the lock!
      if (locked) {
        await this.edgeCacheService.releaseStampedeLock(
          fileId,
          versionId,
          lockValue,
        );
      }
      throw err;
    }

    // 5. Populate Cache Concurrently (if eligible and locked)
    if (locked) {
      const cacheStream = new PassThrough();
      const clientStream = new PassThrough();

      // Decouple the streams so client disconnects don't kill the cache population
      resultStream.on('data', (chunk) => {
        cacheStream.write(chunk);
        clientStream.write(chunk);
      });
      resultStream.on('end', () => {
        cacheStream.end();
        clientStream.end();
      });
      resultStream.on('error', (err) => {
        cacheStream.destroy(err);
        clientStream.destroy(err);
      });

      const chunks: Buffer[] = [];
      cacheStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      cacheStream.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        this.edgeCacheService
          .cacheFile(fileId, versionId, metadata, fullBuffer)
          .catch((e: Error) => {
            this.logger.error(`Background cache populate failed: ${e.message}`);
          })
          .finally(() => {
            // Guaranteed lock release by the owner
            void this.edgeCacheService.releaseStampedeLock(
              fileId,
              versionId,
              lockValue,
            );
          });
      });
      cacheStream.on('error', () => {
        void this.edgeCacheService.releaseStampedeLock(
          fileId,
          versionId,
          lockValue,
        );
      });

      resultStream = clientStream;
    }

    // Record miss telemetry
    this.edgeCacheService.emitCacheMiss(fileId, Date.now() - startTime);

    return {
      stream: resultStream,
      contentLength,
      contentRange,
      contentType: metadata.contentType,
      fileName,
      totalSize: metadata.size,
      etag: metadata.etag,
      cacheControl: metadata.cacheControl,
      contentEncoding: metadata.contentEncoding,
    };
  }

  /**
   * Helper exposed for controllers to download current version
   */
  async downloadCurrentVersion(
    userId: string,
    fileId: string,
    ifNoneMatch?: string,
    rangeHeader?: string,
  ): Promise<DownloadResult> {
    const currentVersionId = await this.resolveCurrentVersion(userId, fileId);
    return this.processDownload(
      userId,
      fileId,
      currentVersionId,
      ifNoneMatch,
      rangeHeader,
    );
  }

  /**
   * Helper exposed for controllers to download specific version
   */
  async downloadSpecificVersion(
    userId: string,
    fileId: string,
    versionNumber: number,
    ifNoneMatch?: string,
    rangeHeader?: string,
  ): Promise<DownloadResult> {
    // Need to resolve versionNumber to versionId
    const version = await this.prisma.fileVersion.findUnique({
      where: { fileId_versionNumber: { fileId, versionNumber } },
    });

    if (!version) {
      throw new NotFoundException(`Version ${versionNumber} not found`);
    }

    return this.processDownload(
      userId,
      fileId,
      version.id,
      ifNoneMatch,
      rangeHeader,
    );
  }

  /**
   * Generates a short-lived pre-signed URL for direct MinIO download.
   */
  async getSignedDownloadUrl(
    userId: string,
    fileId: string,
    forceDownload = false,
  ): Promise<{ url: string; expiresIn: number; fileName: string }> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { currentVersion: true },
    });

    if (!file || file.ownerId !== userId) {
      throw new NotFoundException('File not found or access denied');
    }

    const storagePath = file.currentVersion?.storagePath ?? file.storagePath;
    const expiresIn = parseInt(
      this.configService.get<string>('SIGNED_URL_EXPIRES_IN', '900'),
      10,
    );

    const url = await this.minioService.generateSignedUrl(
      storagePath!,
      expiresIn,
      forceDownload ? file.name : undefined,
    );

    return { url, expiresIn, fileName: file.name };
  }
}
