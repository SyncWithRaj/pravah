import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRANSCODE_QUEUE_NAME,
  VIDEO_MIME_TYPES,
} from './transcoding.constants';
import { TranscodingJobData } from './transcoding.interfaces';

@Injectable()
export class TranscodingService {
  private readonly logger = new Logger(TranscodingService.name);

  constructor(
    @InjectQueue(TRANSCODE_QUEUE_NAME)
    private readonly transcodeQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Queues a video file for multi-quality HLS transcoding.
   * Only queues if the content type is a recognized video MIME type.
   */
  async queueTranscoding(
    fileId: string,
    versionId: string,
    ownerId: string,
    rawStoragePath: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<void> {
    if (!VIDEO_MIME_TYPES.includes(contentType.toLowerCase())) {
      this.logger.debug(
        `Skipping transcoding for non-video file ${fileId} (type: ${contentType})`,
      );
      return;
    }

    const jobData: TranscodingJobData = {
      fileId,
      versionId,
      ownerId,
      rawStoragePath,
      contentType,
      sizeBytes,
    };

    const job = await this.transcodeQueue.add('transcode', jobData, {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    this.logger.log(
      `Queued transcoding job ${job.id} for file ${fileId} version ${versionId} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  /**
   * Returns all transcode records for a given file across all versions.
   */
  async getTranscodeStatus(userId: string, userRole: Role, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    if (userRole !== Role.ADMIN && file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return this.prisma.videoTranscode.findMany({
      where: { fileId },
      orderBy: [{ createdAt: 'desc' }, { quality: 'asc' }],
    });
  }

  /**
   * Returns transcode records for a specific file version.
   */
  async getTranscodeByFileAndVersion(
    userId: string,
    userRole: Role,
    fileId: string,
    versionId: string,
  ) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    if (userRole !== Role.ADMIN && file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return this.prisma.videoTranscode.findMany({
      where: { fileId, versionId },
      orderBy: { quality: 'asc' },
    });
  }
}
