import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  ParseIntPipe,
} from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'stream';
import { EdgeCacheService } from '../common/edge-cache/edge-cache.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

@Controller('edge/content')
export class EdgeContentController {
  private readonly logger = new Logger(EdgeContentController.name);

  constructor(
    private readonly edgeCacheService: EdgeCacheService,
    private readonly minioService: MinioService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':fileId')
  async getEdgeContent(
    @Param('fileId') fileId: string,
    @Query('v', ParseIntPipe) version: number,
    @Res() res: Response,
  ) {
    if (!version) {
      throw new NotFoundException('Version is required');
    }

    const versionStr = version.toString();

    const buffer = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
    if (buffer) {
      this.logger.log(
        `[Cache Hit] Served file ${fileId} v${version} from Edge Cache`,
      );
      return Readable.from(buffer).pipe(res);
    }

    this.logger.log(
      `[Cache Miss] Fetching file ${fileId} v${version} from Origin`,
    );

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    const fileVersion = await this.prisma.fileVersion.findFirst({
      where: { fileId, versionNumber: version },
    });

    if (!fileVersion) {
      throw new NotFoundException(`File version not found`);
    }

    const lockValue = uuidv4();
    const acquiredLock = await this.edgeCacheService.acquireStampedeLock(
      fileId,
      versionStr,
      lockValue,
    );

    if (acquiredLock) {
      try {
        const minioStream = await this.minioService.getObjectStream(
          fileVersion.storagePath,
        );

        if (!minioStream) {
          throw new NotFoundException('File content missing at origin');
        }

        if (fileVersion.size <= 20 * 1024 * 1024) {
          const chunks: Buffer[] = [];
          minioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          minioStream.on('end', () => {
            const finalBuffer = Buffer.concat(chunks);
            const metadata = {
              ownerId: file.ownerId,
              contentType: file.mimeType,
              size: Number(fileVersion.size),
              checksum: fileVersion.checksum,
              etag: `"${fileVersion.checksum}"`,
              cacheControl: 'public, max-age=31536000',
            };
            void (async () => {
              try {
                await this.edgeCacheService.cacheFile(
                  fileId,
                  versionStr,
                  metadata,
                  finalBuffer,
                );
                this.logger.log(
                  `Populated Edge Cache for ${fileId} v${version}`,
                );
              } finally {
                await this.edgeCacheService.releaseStampedeLock(
                  fileId,
                  versionStr,
                  lockValue,
                );
              }
            })();
          });
          minioStream.on('error', () => {
            void this.edgeCacheService.releaseStampedeLock(
              fileId,
              versionStr,
              lockValue,
            );
          });

          const responseStream = await this.minioService.getObjectStream(
            fileVersion.storagePath,
          );
          return responseStream.pipe(res);
        } else {
          await this.edgeCacheService.releaseStampedeLock(
            fileId,
            versionStr,
            lockValue,
          );
          return minioStream.pipe(res);
        }
      } catch {
        await this.edgeCacheService.releaseStampedeLock(
          fileId,
          versionStr,
          lockValue,
        );
        throw new InternalServerErrorException('Failed to fetch from origin');
      }
    } else {
      const minioStream = await this.minioService.getObjectStream(
        fileVersion.storagePath,
      );
      return minioStream.pipe(res);
    }
  }
}
