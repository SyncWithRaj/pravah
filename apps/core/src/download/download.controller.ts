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

@UseGuards(JwtAuthGuard)
@Controller('download')
export class DownloadController {
  constructor(private readonly downloadService: DownloadService) {}

  /**
   * Helper to apply standardized CDN headers
   */
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

  /**
   * GET /api/v1/download/:fileId
   * Streams the current version of a file. Supports Range requests and ETags.
   */
  @Get(':fileId')
  async downloadFile(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rangeHeader = req.headers.range;
    const ifNoneMatch = req.headers['if-none-match'];

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

  /**
   * GET /api/v1/download/:fileId/signed
   * Returns a short-lived pre-signed URL for direct MinIO download.
   */
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

  /**
   * GET /api/v1/download/:fileId/versions/:versionNumber
   * Downloads a specific version of a file.
   */
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
