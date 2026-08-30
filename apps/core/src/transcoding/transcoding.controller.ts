import { Controller, Get, Param } from '@nestjs/common';
import { TranscodingService } from './transcoding.service';

@Controller('admin/transcoding')
export class TranscodingController {
  constructor(private readonly transcodingService: TranscodingService) {}

  /**
   * GET /api/v1/admin/transcoding/status/:fileId
   * Returns all transcode records for a file across all versions.
   */
  @Get('status/:fileId')
  async getTranscodeStatus(@Param('fileId') fileId: string) {
    const records = await this.transcodingService.getTranscodeStatus(fileId);
    return {
      fileId,
      totalRecords: records.length,
      transcodes: records,
    };
  }

  /**
   * GET /api/v1/admin/transcoding/status/:fileId/version/:versionId
   * Returns transcode records for a specific file version.
   */
  @Get('status/:fileId/version/:versionId')
  async getTranscodeByVersion(
    @Param('fileId') fileId: string,
    @Param('versionId') versionId: string,
  ) {
    const records = await this.transcodingService.getTranscodeByFileAndVersion(
      fileId,
      versionId,
    );
    return {
      fileId,
      versionId,
      totalRecords: records.length,
      transcodes: records,
    };
  }
}
