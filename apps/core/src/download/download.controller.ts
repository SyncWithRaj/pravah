import {
  Controller,
  Get,
  Param,
  Res,
  Req,
  UseGuards,
  ParseIntPipe,
  Header,
  Query,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { DownloadService } from './download.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('download')
export class DownloadController {
  constructor(private readonly downloadService: DownloadService) {}

  /**
   * GET /api/v1/download/:fileId
   * Streams the latest version of a file. Supports Range requests (HTTP 206).
   */
  @Get(':fileId')
  @Header('Accept-Ranges', 'bytes')
  async downloadFile(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // Range Request → HTTP 206 Partial Content
      const result = await this.downloadService.downloadFileRange(
        user.id,
        fileId,
        rangeHeader,
      );

      res.status(206);
      res.set({
        'Content-Type': result.contentType,
        'Content-Length': result.contentLength.toString(),
        'Content-Range': result.contentRange,
        'Content-Disposition': `inline; filename="${result.fileName}"`,
        'Accept-Ranges': 'bytes',
      });

      result.stream.pipe(res);
    } else {
      // Full Download → HTTP 200
      const result = await this.downloadService.downloadFile(user.id, fileId);

      res.status(200);
      res.set({
        'Content-Type': result.contentType,
        'Content-Length': result.contentLength.toString(),
        'Content-Disposition': `attachment; filename="${result.fileName}"`,
        'Accept-Ranges': 'bytes',
      });

      result.stream.pipe(res);
    }
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
   * Downloads a specific version of a file. Supports Range requests.
   */
  @Get(':fileId/versions/:versionNumber')
  @Header('Accept-Ranges', 'bytes')
  async downloadVersion(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Param('versionNumber', ParseIntPipe) versionNumber: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const result = await this.downloadService.downloadVersionRange(
        user.id,
        fileId,
        versionNumber,
        rangeHeader,
      );

      res.status(206);
      res.set({
        'Content-Type': result.contentType,
        'Content-Length': result.contentLength.toString(),
        'Content-Range': result.contentRange,
        'Content-Disposition': `inline; filename="${result.fileName}"`,
        'Accept-Ranges': 'bytes',
      });

      result.stream.pipe(res);
    } else {
      const result = await this.downloadService.downloadVersion(
        user.id,
        fileId,
        versionNumber,
      );

      res.status(200);
      res.set({
        'Content-Type': result.contentType,
        'Content-Length': result.contentLength.toString(),
        'Content-Disposition': `attachment; filename="${result.fileName}"`,
        'Accept-Ranges': 'bytes',
      });

      result.stream.pipe(res);
    }
  }
}
