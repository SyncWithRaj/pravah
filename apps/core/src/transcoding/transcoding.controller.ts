import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TranscodingService } from './transcoding.service';
import { UnifiedAuthGuard, RolesGuard, Roles, CurrentUser } from '../auth';
import { Role } from '@prisma/client';

@Controller('admin/transcoding')
@UseGuards(UnifiedAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.STREAMER)
export class TranscodingController {
  constructor(private readonly transcodingService: TranscodingService) {}

  /**
   * GET /api/v1/admin/transcoding/status/:fileId
   * Returns all transcode records for a file across all versions.
   */
  @Get('status/:fileId')
  async getTranscodeStatus(
    @CurrentUser() user: { id: string; role: Role },
    @Param('fileId') fileId: string,
  ) {
    const records = await this.transcodingService.getTranscodeStatus(
      user.id,
      user.role,
      fileId,
    );
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
    @CurrentUser() user: { id: string; role: Role },
    @Param('fileId') fileId: string,
    @Param('versionId') versionId: string,
  ) {
    const records = await this.transcodingService.getTranscodeByFileAndVersion(
      user.id,
      user.role,
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
