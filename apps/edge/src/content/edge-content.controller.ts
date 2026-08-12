import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Headers,
  Logger,
  NotFoundException,
  ParseIntPipe,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EdgeCacheService, CacheMetadata } from '../cache/cache.service';
import { MinioService } from '../minio/minio.service';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

interface PlacementResponse {
  fileId: string;
  version: number;
  storagePath: string;
  mimeType: string;
  size: string;
  ownerId: string;
  checksum: string;
  responsibleReplicas: {
    edgeId: string;
    endpoint: string;
    region: string;
    distanceKm: number;
  }[];
}

@Controller('edge/content')
export class EdgeContentController {
  private readonly logger = new Logger(EdgeContentController.name);

  private readonly coreApiUrl: string;
  private readonly edgeNodeId: string;
  private readonly peerTimeout: number;
  private readonly peerMaxAttempts: number;

  constructor(
    private readonly edgeCacheService: EdgeCacheService,
    private readonly minioService: MinioService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.coreApiUrl = this.configService.get<string>('CORE_API_URL', 'http://localhost:3000');
    this.edgeNodeId = this.configService.get<string>('EDGE_NODE_ID', 'edge-node-01');
    this.peerTimeout = this.configService.get<number>('PEER_FETCH_TIMEOUT_MS', 2000);
    this.peerMaxAttempts = this.configService.get<number>('PEER_MAX_ATTEMPTS', 3);
  }

  @Get(':fileId')
  async getEdgeContent(
    @Param('fileId') fileId: string,
    @Query('v', ParseIntPipe) version: number,
    @Headers('x-cache-fill-mode') cacheFillMode: string,
    @Res() res: Response,
  ) {
    const versionStr = version.toString();

    
    
    
    if (cacheFillMode === 'peer') {
      const buffer = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
      if (buffer) {
        this.logger.log(`[Peer Mode] [Cache Hit] ${fileId} v${version}`);
        return res.status(HttpStatus.OK).end(buffer);
      }
      this.logger.log(`[Peer Mode] [Cache Miss] ${fileId} v${version} — returning 404`);
      throw new NotFoundException('Not found in local cache');
    }

    
    
    
    const cached = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
    if (cached) {
      this.logger.log(`[Cache Hit] Served ${fileId} v${version} from Edge Cache`);
      return res.status(HttpStatus.OK).end(cached);
    }

    this.logger.log(`[Cache Miss] ${fileId} v${version} — starting tiered cache fill`);

    
    
    
    const lockValue = uuidv4();
    const lockAcquired = await this.edgeCacheService.acquireStampedeLock(
      fileId,
      versionStr,
      lockValue,
    );

    if (!lockAcquired) {
      
      
      this.logger.log(`[Stampede] Lock held by another request for ${fileId} v${version}`);
      await this.sleep(500);
      const retryBuffer = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
      if (retryBuffer) {
        this.logger.log(`[Stampede] Resolved from cache after wait for ${fileId} v${version}`);
        return res.status(HttpStatus.OK).end(retryBuffer);
      }
      
      return this.streamFromOriginDirect(fileId, version, res);
    }

    
    try {
      
      
      
      let placement: PlacementResponse | null = null;

      try {
        const response = await firstValueFrom(
          this.httpService.get(
            `${this.coreApiUrl}/api/v1/internal/placement/${fileId}/v/${version}`,
            { headers: { 'X-Edge-Node-Id': this.edgeNodeId } },
          ),
        );
        placement = response.data;
      } catch (error: any) {
        this.logger.error(`[Placement] Lookup failed: ${error.message}`);
      }

      
      
      
      if (placement && placement.responsibleReplicas.length > 0) {
        const peers = placement.responsibleReplicas.slice(0, this.peerMaxAttempts);

        for (const peer of peers) {
          try {
            this.logger.log(
              `[Peer Fetch] Trying ${peer.edgeId} (${peer.region}, ${peer.distanceKm}km)`,
            );

            const peerResponse = await this.httpService.axiosRef.get(
              `${peer.endpoint}/edge/content/${fileId}?v=${version}`,
              {
                headers: { 'X-Cache-Fill-Mode': 'peer' },
                responseType: 'arraybuffer',
                timeout: this.peerTimeout,
                validateStatus: (status) => status === 200 || status === 404,
              },
            );

            if (peerResponse.status === 200) {
              const buffer = Buffer.from(peerResponse.data);
              this.logger.log(
                `[Peer Fetch] Success from ${peer.edgeId} (${buffer.length} bytes)`,
              );

              
              const metadata = this.buildCacheMetadata(placement);
              await this.edgeCacheService.cacheFile(fileId, versionStr, metadata, buffer);
              this.logger.log(`[Peer Fetch] Cached ${fileId} v${version} locally`);

              return res.status(HttpStatus.OK).end(buffer);
            }

            
            this.logger.log(`[Peer Fetch] ${peer.edgeId} returned 404, trying next`);
          } catch (error: any) {
            this.logger.warn(
              `[Peer Fetch] ${peer.edgeId} failed: ${error.message}, trying next`,
            );
          }
        }

        this.logger.log(`[Peer Fetch] All peers exhausted for ${fileId} v${version}`);
      }

      
      
      
      const storagePath = await this.resolveStoragePath(placement, fileId, version);

      if (!storagePath) {
        this.logger.error(`[Origin Fallback] No storage path for ${fileId} v${version}`);
        return res.status(HttpStatus.NOT_FOUND).send('File not found');
      }

      this.logger.log(`[Origin Fallback] Fetching ${fileId} v${version} from MinIO`);

      const stream = await this.minioService.getObjectStream(storagePath);
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });

      const fullBuffer = Buffer.concat(chunks);

      
      if (fullBuffer.length <= 20 * 1024 * 1024) {
        const metadata = placement
          ? this.buildCacheMetadata(placement)
          : this.buildFallbackMetadata();
        await this.edgeCacheService.cacheFile(fileId, versionStr, metadata, fullBuffer);
        this.logger.log(`[Origin Fallback] Cached ${fileId} v${version} locally (${fullBuffer.length} bytes)`);
      }

      return res.status(HttpStatus.OK).end(fullBuffer);
    } catch (error: any) {
      
      this.logger.error(`[Total Failure] ${fileId} v${version}: ${error.message}`);
      if (!res.headersSent) {
        return res.status(HttpStatus.BAD_GATEWAY).send('Failed to retrieve file');
      }
    } finally {
      
      await this.edgeCacheService.releaseStampedeLock(fileId, versionStr, lockValue);
    }
  }

  
  
  

  
  private async resolveStoragePath(
    placement: PlacementResponse | null,
    fileId: string,
    version: number,
  ): Promise<string | null> {
    if (placement?.storagePath) {
      return placement.storagePath;
    }

    
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.coreApiUrl}/api/v1/internal/metadata/files/${fileId}/versions/${version}`,
        ),
      );
      return response.data.storagePath;
    } catch {
      return null;
    }
  }

  
  private buildCacheMetadata(placement: PlacementResponse): CacheMetadata {
    return {
      ownerId: placement.ownerId,
      contentType: placement.mimeType,
      size: parseInt(placement.size, 10),
      checksum: placement.checksum,
      etag: `"${placement.checksum}"`,
      cacheControl: 'public, max-age=31536000, immutable',
    };
  }

  
  private buildFallbackMetadata(): CacheMetadata {
    return {
      ownerId: 'unknown',
      contentType: 'application/octet-stream',
      size: 0,
      checksum: '',
      etag: '""',
      cacheControl: 'public, max-age=31536000, immutable',
    };
  }

  
  private async streamFromOriginDirect(
    fileId: string,
    version: number,
    res: Response,
  ): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.coreApiUrl}/api/v1/internal/metadata/files/${fileId}/versions/${version}`,
        ),
      );
      const storagePath = response.data.storagePath;
      if (!storagePath) {
        res.status(HttpStatus.NOT_FOUND).send('File not found');
        return;
      }
      const stream = await this.minioService.getObjectStream(storagePath);
      stream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.status(HttpStatus.BAD_GATEWAY).send('Failed to retrieve file');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
