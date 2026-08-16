import {
  Controller,
  Get,
  Param,
  Res,
  Req,
  UseGuards,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { DownloadService, DownloadResult } from './download.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '@prisma/client';
import { RoutingService } from '../common/routing/routing.service';
import { trace } from '@opentelemetry/api';

@UseGuards(JwtAuthGuard)
@Controller('download')
export class DownloadController {
  constructor(
    private readonly downloadService: DownloadService,
    private readonly routingService: RoutingService,
  ) {}

  private applyHeaders(res: Response, result: DownloadResult, isRange = false) {
    if (result.etag) res.setHeader('ETag', result.etag);
    if (result.cacheControl)
      res.setHeader('Cache-Control', result.cacheControl);
    if (result.contentType) res.setHeader('Content-Type', result.contentType);
    if (result.contentEncoding)
      res.setHeader('Content-Encoding', result.contentEncoding);
    if (result.contentLength)
      res.setHeader('Content-Length', result.contentLength.toString());

    res.setHeader('Accept-Ranges', 'bytes');

    if (result.fileName) {
      const disposition = isRange ? 'inline' : 'attachment';
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${result.fileName}"`,
      );
    }

    if (isRange && result.contentRange) {
      res.setHeader('Content-Range', result.contentRange);
    }
  }

  @Get(':fileId')
  async downloadFile(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rangeHeader = req.headers.range;
    const ifNoneMatch = req.headers['if-none-match'];
    const clientRegion = req.headers['x-test-client-region'] as string;

    const routingDecision = this.routingService.selectBestEdge(clientRegion);

    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttribute('cdn.file_id', fileId);
      activeSpan.setAttribute('cdn.user_id', user.id);
      const traceId = activeSpan.spanContext().traceId;
      if (traceId) res.setHeader('X-Trace-Id', traceId);
    }

    if (routingDecision) {
      const { edge, distanceKm, strategy } = routingDecision;

      if (activeSpan) {
        activeSpan.setAttribute('cdn.edge_name', edge.name);
        activeSpan.setAttribute('cdn.edge_region', edge.region);
        activeSpan.setAttribute('cdn.strategy', strategy);
        activeSpan.setAttribute('cdn.distance_km', distanceKm ?? 0);
      }

      const currentVersion = await this.downloadService.getCurrentVersion(
        user.id,
        fileId,
      );
      const redirectUrl = `${edge.endpointUrl}/edge/content/${fileId}?v=${currentVersion}`;

      res.setHeader('X-CDN-Edge', edge.name);
      res.setHeader('X-CDN-Region', edge.region);
      res.setHeader(
        'X-CDN-Distance-Km',
        distanceKm === null ? 'N/A' : distanceKm.toString(),
      );
      res.setHeader('X-CDN-Strategy', strategy);

      return res.redirect(302, redirectUrl);
    }

    const result = await this.downloadService.downloadCurrentVersion(
      user.id,
      fileId,
      ifNoneMatch,
      rangeHeader,
    );

    if (result.isNotModified) {
      if (result.etag) res.setHeader('ETag', result.etag);
      if (result.cacheControl)
        res.setHeader('Cache-Control', result.cacheControl);
      return res.status(304).send();
    }

    this.applyHeaders(res, result, !!rangeHeader);
    res.status(rangeHeader ? 206 : 200);
    result.stream!.pipe(res);
  }

  @Get(':fileId/signed')
  async getSignedUrl(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Query('download') download?: string,
  ) {
    const forceDownload = download === 'true';
    return this.downloadService.getSignedDownloadUrl(
      user.id,
      fileId,
      forceDownload,
    );
  }

  @Get(':fileId/versions/:versionNumber')
  async downloadVersion(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rangeHeader = req.headers.range;
    const ifNoneMatch = req.headers['if-none-match'];
    const clientRegion = req.headers['x-test-client-region'] as string;

    const routingDecision = this.routingService.selectBestEdge(clientRegion);

    if (routingDecision) {
      const { edge, distanceKm, strategy } = routingDecision;
      const redirectUrl = `${edge.endpointUrl}/api/v1/edge/content/${fileId}?v=${versionNumber}`;

      res.setHeader('X-CDN-Edge', edge.name);
      res.setHeader('X-CDN-Region', edge.region);
      res.setHeader(
        'X-CDN-Distance-Km',
        distanceKm === null ? 'N/A' : distanceKm.toString(),
      );
      res.setHeader('X-CDN-Strategy', strategy);

      return res.redirect(302, redirectUrl);
    }

    const result = await this.downloadService.downloadSpecificVersion(
      user.id,
      fileId,
      versionNumber,
      ifNoneMatch,
      rangeHeader,
    );

    if (result.isNotModified) {
      if (result.etag) res.setHeader('ETag', result.etag);
      if (result.cacheControl)
        res.setHeader('Cache-Control', result.cacheControl);
      return res.status(304).send();
    }

    this.applyHeaders(res, result, !!rangeHeader);
    res.status(rangeHeader ? 206 : 200);
    result.stream!.pipe(res);
  }
}
