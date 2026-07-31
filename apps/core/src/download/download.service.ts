import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';

export interface DownloadStreamResult {
  stream: Readable;
  contentLength: number;
  contentType: string;
  fileName: string;
  totalSize: number;
}

export interface PartialDownloadResult extends DownloadStreamResult {
  contentRange: string;
}

@Injectable()
export class DownloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolves the storage path for the current (latest) version of a file.
   * Validates ownership before returning.
   */
  private async resolveFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        currentVersion: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (file.status !== 'COMPLETED') {
      throw new BadRequestException(
        'File upload is not yet complete. Current status: ' + file.status,
      );
    }

    // Use currentVersion's storagePath, fallback to file's storagePath
    const storagePath = file.currentVersion?.storagePath ?? file.storagePath;

    if (!storagePath) {
      throw new NotFoundException('File storage path not found');
    }

    return {
      file,
      storagePath,
      mimeType: file.mimeType,
      fileName: file.name,
      totalSize: Number(file.totalSize),
    };
  }

  /**
   * Streams the full file from MinIO (HTTP 200).
   */
  async downloadFile(
    userId: string,
    fileId: string,
  ): Promise<DownloadStreamResult> {
    const { storagePath, mimeType, fileName, totalSize } =
      await this.resolveFile(userId, fileId);

    const metadata = await this.minioService.getObjectMetadata(storagePath);
    const stream = await this.minioService.getObjectStream(storagePath);

    return {
      stream,
      contentLength: metadata.contentLength,
      contentType: mimeType || metadata.contentType,
      fileName,
      totalSize,
    };
  }

  /**
   * Streams a partial byte range from MinIO (HTTP 206 Partial Content).
   * Used for video seeking / scrubbing.
   */
  async downloadFileRange(
    userId: string,
    fileId: string,
    rangeHeader: string,
  ): Promise<PartialDownloadResult> {
    const { storagePath, mimeType, fileName, totalSize } =
      await this.resolveFile(userId, fileId);

    const result = await this.minioService.getObjectStreamWithRange(
      storagePath,
      rangeHeader,
    );

    return {
      stream: result.stream,
      contentLength: result.contentLength,
      contentRange: result.contentRange,
      contentType: mimeType || 'application/octet-stream',
      fileName,
      totalSize,
    };
  }

  /**
   * Generates a short-lived pre-signed URL for direct MinIO download.
   * No JWT token needed on the actual download — the URL IS the authentication.
   */
  async getSignedDownloadUrl(
    userId: string,
    fileId: string,
    forceDownload = false,
  ): Promise<{ url: string; expiresIn: number; fileName: string }> {
    const { storagePath, fileName } = await this.resolveFile(userId, fileId);

    const expiresIn = parseInt(
      this.configService.get<string>('SIGNED_URL_EXPIRES_IN', '900'),
      10,
    );

    const url = await this.minioService.generateSignedUrl(
      storagePath,
      expiresIn,
      forceDownload ? fileName : undefined,
    );

    return {
      url,
      expiresIn,
      fileName,
    };
  }

  /**
   * Downloads a specific version of a file (e.g., v1 while v2 is current).
   */
  async downloadVersion(
    userId: string,
    fileId: string,
    versionNumber: number,
  ): Promise<DownloadStreamResult> {
    // 1. Verify file ownership
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // 2. Find the specific version
    const version = await this.prisma.fileVersion.findUnique({
      where: {
        fileId_versionNumber: {
          fileId,
          versionNumber,
        },
      },
    });

    if (!version) {
      throw new NotFoundException(
        `Version ${versionNumber} not found for this file`,
      );
    }

    // 3. Stream from MinIO
    const metadata = await this.minioService.getObjectMetadata(
      version.storagePath,
    );
    const stream = await this.minioService.getObjectStream(version.storagePath);

    return {
      stream,
      contentLength: metadata.contentLength,
      contentType: file.mimeType || metadata.contentType,
      fileName: file.name,
      totalSize: Number(version.size),
    };
  }

  /**
   * Downloads a specific version with Range support.
   */
  async downloadVersionRange(
    userId: string,
    fileId: string,
    versionNumber: number,
    rangeHeader: string,
  ): Promise<PartialDownloadResult> {
    // 1. Verify file ownership
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // 2. Find the specific version
    const version = await this.prisma.fileVersion.findUnique({
      where: {
        fileId_versionNumber: {
          fileId,
          versionNumber,
        },
      },
    });

    if (!version) {
      throw new NotFoundException(
        `Version ${versionNumber} not found for this file`,
      );
    }

    // 3. Stream partial content from MinIO
    const result = await this.minioService.getObjectStreamWithRange(
      version.storagePath,
      rangeHeader,
    );

    return {
      stream: result.stream,
      contentLength: result.contentLength,
      contentRange: result.contentRange,
      contentType: file.mimeType || 'application/octet-stream',
      fileName: file.name,
      totalSize: Number(version.size),
    };
  }
}
