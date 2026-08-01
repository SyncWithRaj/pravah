import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadChunkDto } from './dto/upload-chunk.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('init')
  async initUpload(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Body() dto: InitUploadDto,
  ) {
    return this.uploadService.initUpload(user.id, dto);
  }

  @Put(':fileId/chunk/:chunkIndex')
  @UseInterceptors(FileInterceptor('file'))
  async uploadChunk(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
    @Param('chunkIndex', ParseIntPipe) chunkIndex: number,
    @Body() dto: UploadChunkDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No chunk file uploaded in request body');
    }
    return this.uploadService.uploadChunk(user.id, fileId, chunkIndex, dto.checksum, file.buffer);
  }

  @Get('status/:fileId')
  async getUploadStatus(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Param('fileId') fileId: string,
  ) {
    return this.uploadService.getUploadStatus(user.id, fileId);
  }

  @Post('complete')
  async completeUpload(
    @CurrentUser() user: Omit<User, 'passwordHash'>,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.uploadService.completeUpload(user.id, dto);
  }
}
