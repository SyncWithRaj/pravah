import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Req,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  UnauthorizedException,
  ParseIntPipe,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CacheManagerService } from '../common/cache-manager/cache-manager.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { verifyEdgeUrl } from '../common/security/edge-url.util';
import { verifyServiceSignature } from '../common/security/service-hmac.util';
import * as crypto from 'crypto';

@Controller('edge/content')
export class EdgeContentController {
  private readonly logger = new Logger(EdgeContentController.name);

  constructor(
    private readonly cacheManagerService: CacheManagerService,
    private readonly minioService: MinioService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  private async authenticateRequest(
    req: Request,
    fileId: string,
    versionStr: string,
  ): Promise<boolean> {
    // 1. Edge signed URL verification (?exp=...&sig=...)
    const expQuery = req.query.exp as string | undefined;
    const sigQuery = req.query.sig as string | undefined;
    const signingSecret =
      this.configService.get<string>('EDGE_URL_SIGNING_SECRET') ||
      process.env.EDGE_URL_SIGNING_SECRET;

    if (
      signingSecret &&
      expQuery &&
      sigQuery &&
      verifyEdgeUrl(fileId, versionStr, expQuery, sigQuery, signingSecret)
    ) {
      return true;
    }

    // 2. Inter-service HMAC headers (x-service-*)
    const serviceSecret =
      this.configService.get<string>('INTERNAL_SERVICE_SECRET') ||
      process.env.INTERNAL_SERVICE_SECRET;
    const serviceId = req.headers['x-service-id'] as string;
    const serviceTimestamp = req.headers['x-service-timestamp'] as string;
    const serviceSig = req.headers['x-service-signature'] as string;

    if (serviceSecret && serviceId && serviceTimestamp && serviceSig) {
      const ts = parseInt(serviceTimestamp, 10);
      if (
        !isNaN(ts) &&
        verifyServiceSignature(
          serviceId,
          req.method.toUpperCase(),
          req.originalUrl || req.url,
          ts,
          serviceSig,
          serviceSecret,
          req.body,
        )
      ) {
        return true;
      }
    }

    // 3. User JWT authentication (header or query param)
    const rawToken =
      (typeof req.headers.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : null) ||
      (typeof req.query.token === 'string' ? (req.query.token as string) : null);

    if (rawToken) {
      const jwtSecret = this.configService.get<string>('JWT_SECRET');
      try {
        const payload = await this.jwtService.verifyAsync<{
          sub: string;
          role?: string;
        }>(rawToken, { secret: jwtSecret });
        if (payload?.sub) {
          return true;
        }
      } catch {
        // Token invalid
      }
    }

    return false;
  }

  @Get(':fileId/hls/*')
  async getHlsContent(
    @Param('fileId') fileId: string,
    @Query('v') versionQuery: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const versionNum = versionQuery ? parseInt(versionQuery, 10) : 1;
    const versionStr = versionNum.toString();

    const isAuthed = await this.authenticateRequest(req, fileId, versionStr);
    if (!isAuthed) {
      throw new UnauthorizedException('Authentication required');
    }

    const urlParts = req.url.split('/hls/');
    const rawSubpath = urlParts[1]?.split('?')[0] || 'master.m3u8';

    if (
      rawSubpath.includes('..') ||
      rawSubpath.startsWith('/') ||
      rawSubpath.startsWith('\\')
    ) {
      return res.status(400).json({ error: 'Invalid HLS path' });
    }

    const isSegment = rawSubpath.endsWith('.ts');
    const isPlaylist = rawSubpath.endsWith('.m3u8');
    const contentType = isSegment
      ? 'video/MP2T'
      : isPlaylist
        ? 'application/vnd.apple.mpegurl'
        : 'application/octet-stream';
    const cacheControl = isSegment
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60';
    const ttlSeconds = isSegment ? 86400 : 60;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, X-Requested-With, Content-Type',
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);

    const cachedBuffer = await this.cacheManagerService.getHlsContent(
      fileId,
      versionStr,
      rawSubpath,
    );

    if (cachedBuffer) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).end(cachedBuffer);
    }

    res.setHeader('X-Cache', 'MISS');

    try {
      const file = await this.prisma.file.findUnique({
        where: { id: fileId },
        include: {
          versions: {
            where: { versionNumber: versionNum },
          },
        },
      });

      if (!file || !file.versions[0]) {
        throw new NotFoundException('File or version not found');
      }

      const versionId = file.versions[0].id;
      const minioKey = `hls/${file.ownerId}/${fileId}/${versionId}/${rawSubpath}`;

      const stream = await this.minioService.getObjectStream(minioKey);
      if (!stream) {
        throw new NotFoundException('HLS content not found at origin');
      }

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      const fullBuffer = Buffer.concat(chunks);

      void this.cacheManagerService
        .cacheHlsContent(fileId, versionStr, rawSubpath, fullBuffer, ttlSeconds)
        .catch((e: Error) =>
          this.logger.error(`Failed to cache HLS ${rawSubpath}: ${e.message}`),
        );

      return res.status(200).end(fullBuffer);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Not found';
      this.logger.warn(
        `HLS fetch failed for ${fileId}/${rawSubpath}: ${errMsg}`,
      );
      return res.status(404).json({ error: 'HLS stream not found' });
    }
  }

  @Get(':fileId')
  async getEdgeContent(
    @Param('fileId') fileId: string,
    @Query('v', ParseIntPipe) version: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!version) {
      throw new NotFoundException('Version is required');
    }

    const versionStr = version.toString();

    const isAuthed = await this.authenticateRequest(req, fileId, versionStr);
    if (!isAuthed) {
      throw new UnauthorizedException('Authentication required');
    }

    const buffer = await this.cacheManagerService.getBinary(
      fileId,
      versionStr,
      0,
    );
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

    const lockValue = crypto.randomUUID();
    const acquiredLock = await this.cacheManagerService.acquireStampedeLock(
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
                await this.cacheManagerService.cacheFile(
                  fileId,
                  versionStr,
                  metadata,
                  finalBuffer,
                );
                this.logger.log(
                  `Populated Edge Cache for ${fileId} v${version}`,
                );
              } finally {
                await this.cacheManagerService.releaseStampedeLock(
                  fileId,
                  versionStr,
                  lockValue,
                );
              }
            })();
          });
          minioStream.on('error', () => {
            void this.cacheManagerService.releaseStampedeLock(
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
          await this.cacheManagerService.releaseStampedeLock(
            fileId,
            versionStr,
            lockValue,
          );
          return minioStream.pipe(res);
        }
      } catch {
        await this.cacheManagerService.releaseStampedeLock(
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
