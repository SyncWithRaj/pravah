import {
  Controller,
  Get,
  Post,
  HttpCode,
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

import { MetricsService } from '../metrics/metrics.service';
import { KafkaService } from '../kafka/kafka.service';
import { trace } from '@opentelemetry/api';

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
  private readonly edgeRegion: string;
  private readonly peerTimeout: number;
  private readonly peerMaxAttempts: number;

  constructor(
    private readonly edgeCacheService: EdgeCacheService,
    private readonly minioService: MinioService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    private readonly kafkaService: KafkaService,
  ) {
    this.coreApiUrl = this.configService.get<string>('CORE_API_URL', 'http://localhost:3000');
    this.edgeNodeId = this.configService.get<string>('EDGE_NODE_ID', 'edge-node-01');
    this.edgeRegion = this.configService.get<string>('EDGE_REGION', 'ap-south-1');
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
    const reqStart = performance.now();
    const versionStr = version.toString();

    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttribute('cdn.file_id', fileId);
      activeSpan.setAttribute('cdn.version', version);
      activeSpan.setAttribute('cdn.edge_id', this.edgeNodeId);
      activeSpan.setAttribute('cdn.region', this.edgeRegion);
      const traceId = activeSpan.spanContext().traceId;
      if (traceId) res.setHeader('X-Trace-Id', traceId);
    }

    // 1. Peer-to-peer fill request from another Edge Node
    if (cacheFillMode === 'peer') {
      const buffer = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
      if (buffer) {
        this.logger.log(`[Peer Mode] [Cache Hit] ${fileId} v${version}`);
        activeSpan?.setAttribute('cdn.cache_state', 'PEER_HIT');
        this.metricsService.cacheHitsTotal.inc();
        this.metricsService.bytesServedTotal.inc({ source: 'peer_cache' }, buffer.length);
        return res.status(HttpStatus.OK).end(buffer);
      }
      this.logger.log(`[Peer Mode] [Cache Miss] ${fileId} v${version} — returning 404`);
      activeSpan?.setAttribute('cdn.cache_state', 'PEER_MISS');
      throw new NotFoundException('Not found in local cache');
    }

    // 2. Direct RAM Cache Hit (Fast path)
    const cached = await this.edgeCacheService.getBinary(fileId, versionStr, 0);
    if (cached) {
      const durationSec = (performance.now() - reqStart) / 1000;
      this.logger.log(`[Cache Hit] Served ${fileId} v${version} from Edge Cache`);
      activeSpan?.setAttribute('cdn.cache_state', 'HIT');
      activeSpan?.setAttribute('cdn.bytes_served', cached.length);
      this.metricsService.cacheHitsTotal.inc();
      this.metricsService.bytesServedTotal.inc({ source: 'ram_cache' }, cached.length);
      this.metricsService.requestDuration.observe(
        { cache_result: 'hit', status_code: '200' },
        durationSec,
      );
      this.kafkaService.emitCacheAccess({
        fileId,
        version: versionStr,
        edgeId: this.edgeNodeId,
        region: this.edgeRegion,
        eventType: 'hit',
        bytesServed: cached.length,
        downloadLatencyMs: Math.round(performance.now() - reqStart),
        timestamp: new Date().toISOString(),
      });

      const meta = await this.edgeCacheService.getMetadata(fileId, versionStr);
      if (meta?.contentType) res.setHeader('Content-Type', meta.contentType);
      if (meta?.etag) res.setHeader('ETag', meta.etag);
      if (meta?.contentEncoding) res.setHeader('Content-Encoding', meta.contentEncoding);
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-CDN-Edge', this.edgeNodeId);
      res.setHeader('X-CDN-Region', this.edgeRegion);
      return res.status(HttpStatus.OK).end(cached);
    }

    this.logger.log(`[Cache Miss] ${fileId} v${version} — starting tiered cache fill`);
    activeSpan?.setAttribute('cdn.cache_state', 'MISS');
    this.metricsService.cacheMissesTotal.inc();

    // 3. Stampede Protection (Distributed Lock)
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
        this.metricsService.cacheHitsTotal.inc();
        return res.status(HttpStatus.OK).end(retryBuffer);
      }
      return this.streamFromOriginDirect(fileId, version, res);
    }

    try {
      // 4. Placement Lookup from Core
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

      // 5. Tiered Peer Fetch
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

              const durationSec = (performance.now() - reqStart) / 1000;
              this.metricsService.peerFetchesTotal.inc({ peer_id: peer.edgeId, status: 'success' });
              this.metricsService.bytesServedTotal.inc({ source: 'peer_cache' }, buffer.length);
              this.metricsService.requestDuration.observe(
                { cache_result: 'peer_fill', status_code: '200' },
                durationSec,
              );
              this.kafkaService.emitCacheAccess({
                fileId,
                version: versionStr,
                edgeId: this.edgeNodeId,
                region: this.edgeRegion,
                eventType: 'peer_fill',
                bytesServed: buffer.length,
                downloadLatencyMs: Math.round(performance.now() - reqStart),
                timestamp: new Date().toISOString(),
              });

              res.setHeader('X-Cache', 'PEER_HIT');
              return res.status(HttpStatus.OK).end(buffer);
            }

            this.logger.log(`[Peer Fetch] ${peer.edgeId} returned 404, trying next`);
            this.metricsService.peerFetchesTotal.inc({ peer_id: peer.edgeId, status: 'miss' });
          } catch (error: any) {
            this.logger.warn(
              `[Peer Fetch] ${peer.edgeId} failed: ${error.message}, trying next`,
            );
            this.metricsService.peerFetchesTotal.inc({ peer_id: peer.edgeId, status: 'error' });
          }
        }

        this.logger.log(`[Peer Fetch] All peers exhausted for ${fileId} v${version}`);
      }

      // 6. Origin MinIO Fallback
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

      if (fullBuffer.length <= 100 * 1024 * 1024) {
        const metadata = placement
          ? this.buildCacheMetadata(placement)
          : this.buildFallbackMetadata();
        await this.edgeCacheService.cacheFile(fileId, versionStr, metadata, fullBuffer);
        this.logger.log(`[Origin Fallback] Cached ${fileId} v${version} locally (${fullBuffer.length} bytes)`);
      }

      const durationSec = (performance.now() - reqStart) / 1000;
      this.metricsService.bytesServedTotal.inc({ source: 'origin_stream' }, fullBuffer.length);
      this.metricsService.requestDuration.observe(
        { cache_result: 'origin_fill', status_code: '200' },
        durationSec,
      );
      this.kafkaService.emitCacheAccess({
        fileId,
        version: versionStr,
        edgeId: this.edgeNodeId,
        region: this.edgeRegion,
        eventType: 'miss',
        bytesServed: fullBuffer.length,
        downloadLatencyMs: Math.round(performance.now() - reqStart),
        timestamp: new Date().toISOString(),
      });

      res.setHeader('X-Cache', 'MISS');
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

  @Post(':fileId/purge')
  @HttpCode(HttpStatus.OK)
  async purgeLocalCache(@Param('fileId') fileId: string) {
    const keys = await this.edgeCacheService.evictFile(fileId);
    this.logger.log(`[Cache Purged] Evicted file ${fileId} from Edge RAM cache`);
    return { success: true, edgeNodeId: this.edgeNodeId, fileId, message: 'Local RAM cache evicted' };
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
