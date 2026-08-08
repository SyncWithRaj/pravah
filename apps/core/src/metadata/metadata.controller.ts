import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MetadataService } from './metadata.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '@prisma/client';
import { GetFilesQueryDto } from './dto/get-files-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('metadata')
export class MetadataController {
  constructor(private readonly metadataService: MetadataService) {}

  @Get('files')
  async getFiles(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Query() query: GetFilesQueryDto,
  ) {
    return this.metadataService.findAll(user.id, query);
  }

  @Get('files/:fileId')
  async getFileDetails(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
  ) {
    return this.metadataService.findOne(user.id, fileId);
  }

  @Get('files/:fileId/versions')
  async getFileVersions(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
  ) {
    return this.metadataService.findVersions(user.id, fileId);
  }

  @Delete('files/:fileId')
  async deleteFile(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
  ) {
    return this.metadataService.remove(user.id, fileId);
  }
}

// INTERNAL API: Used by Edge nodes to fetch file version metadata for cache misses
// Excluded from global JwtAuthGuard using metadata if needed, but since guard is on class,
// we must move this to a separate controller or bypass the guard.
// Actually, let's create a new InternalMetadataController to avoid guard issues.


@Controller('internal/metadata')
export class InternalMetadataController {
  constructor(private readonly metadataService: MetadataService) {}

  @Get('files/:fileId/versions/:version')
  async getInternalFileVersion(
    @Param('fileId') fileId: string,
    @Param('version') version: string,
  ) {
    return this.metadataService.findInternalVersion(fileId, parseInt(version, 10));
  }

  @Get('files/:fileId')
  async getInternalFile(@Param('fileId') fileId: string) {
    return this.metadataService.findInternalFile(fileId);
  }
}
