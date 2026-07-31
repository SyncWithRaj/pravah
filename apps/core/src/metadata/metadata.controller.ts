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
