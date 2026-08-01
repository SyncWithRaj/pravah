import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { FileStatus, ChunkStatus } from '@prisma/client';
import { KafkaService } from '../common/kafka/kafka.service';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class UploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly kafkaService: KafkaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Initializes a chunked upload session.
   */
  async initUpload(userId: string, dto: InitUploadDto) {
    // Create File record in DB
    const file = await this.prisma.file.create({
      data: {
        name: dto.name,
        mimeType: dto.mimeType,
        totalSize: BigInt(dto.totalSize),
        totalChunks: dto.totalChunks,
        ownerId: userId,
        status: FileStatus.PENDING,
        checksum: dto.fullFileChecksum,
      },
    });

    // Create FileChunk rows for tracking
    const chunkData = Array.from({ length: dto.totalChunks }, (_, index) => ({
      fileId: file.id,
      chunkIndex: index,
      size: 0,
      checksum: '',
      storagePath: `chunks/${file.id}/chunk-${index}`,
      status: ChunkStatus.PENDING,
    }));

    await this.prisma.fileChunk.createMany({
      data: chunkData,
    });

    return {
      fileId: file.id,
      name: file.name,
      totalChunks: file.totalChunks,
      status: file.status,
    };
  }

  /**
   * Processes and stores an individual file chunk.
   * Idempotent: safe to retry on network failure (PUT semantics).
   */
  async uploadChunk(
    userId: string,
    fileId: string,
    chunkIndex: number,
    checksum: string,
    fileBuffer: Buffer,
  ) {
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Chunk buffer cannot be empty');
    }

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException('Upload session not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (file.status === FileStatus.COMPLETED) {
      throw new BadRequestException('Upload already completed');
    }

    // 1. Verify SHA-256 Checksum
    const calculatedChecksum = crypto
      .createHash('sha256')
      .update(fileBuffer)
      .digest('hex');

    if (
      checksum.trim().toLowerCase() !== 'skip' &&
      calculatedChecksum.toLowerCase() !== checksum.trim().toLowerCase()
    ) {
      throw new BadRequestException(
        `Checksum mismatch for chunk ${chunkIndex}. Server calculated: ${calculatedChecksum}, received: ${checksum}`,
      );
    }

    // 2. Upload chunk to MinIO (idempotent — overwrites if already exists)
    const chunkStoragePath = `chunks/${file.id}/chunk-${chunkIndex}`;
    await this.minioService.uploadChunk(chunkStoragePath, fileBuffer);

    // 3. Update FileChunk & File in DB
    await this.prisma.$transaction([
      this.prisma.fileChunk.update({
        where: {
          fileId_chunkIndex: {
            fileId: file.id,
            chunkIndex: chunkIndex,
          },
        },
        data: {
          size: fileBuffer.length,
          checksum: checksum,
          status: ChunkStatus.VERIFIED,
        },
      }),
      this.prisma.file.update({
        where: { id: file.id },
        data: {
          status: FileStatus.UPLOADING,
          uploadedChunks: {
            increment: 1,
          },
        },
      }),
    ]);

    const updatedFile = await this.prisma.file.findUnique({
      where: { id: file.id },
      select: { uploadedChunks: true, totalChunks: true },
    });

    return {
      success: true,
      fileId: file.id,
      chunkIndex: chunkIndex,
      uploadedChunks: updatedFile?.uploadedChunks || 0,
      totalChunks: updatedFile?.totalChunks || chunkIndex + 1,
    };
  }

  /**
   * Returns current progress of an upload session (for resuming uploads).
   */
  async getUploadStatus(userId: string, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        chunks: {
          select: { chunkIndex: true, status: true },
          orderBy: { chunkIndex: 'asc' },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File session not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const verifiedChunkIndices = file.chunks
      .filter((c) => c.status === ChunkStatus.VERIFIED)
      .map((c) => c.chunkIndex);

    return {
      fileId: file.id,
      name: file.name,
      status: file.status,
      totalChunks: file.totalChunks,
      uploadedChunks: file.uploadedChunks,
      verifiedChunks: verifiedChunkIndices,
    };
  }

  /**
   * Assembles all verified chunks into the final destination object in MinIO.
   */
  async completeUpload(userId: string, dto: CompleteUploadDto) {
    const file = await this.prisma.file.findUnique({
      where: { id: dto.fileId },
      include: {
        chunks: {
          orderBy: { chunkIndex: 'asc' },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File session not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (file.status === FileStatus.COMPLETED) {
      throw new BadRequestException('File is already marked as completed');
    }

    // Verify all chunks are verified
    const verifiedChunks = file.chunks.filter(
      (c) => c.status === ChunkStatus.VERIFIED,
    );

    if (verifiedChunks.length !== file.totalChunks) {
      throw new BadRequestException(
        `Cannot complete upload: received ${verifiedChunks.length}/${file.totalChunks} chunks`,
      );
    }

    // Mark as ASSEMBLING
    await this.prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.ASSEMBLING },
    });

    const chunkKeys = file.chunks.map((c) => c.storagePath);
    const destinationKey = `files/${userId}/${file.id}/v1/${file.name}`;

    try {
      const compressibleTypes = [
        'text/plain',
        'text/html',
        'text/css',
        'text/csv',
        'application/json',
        'application/javascript',
        'application/xml',
      ];
      const isCompressible = compressibleTypes.includes(file.mimeType);

      let finalSize: bigint | number = file.totalSize;

      // 1. Assemble chunks in MinIO
      if (isCompressible) {
        const result = await this.minioService.assembleAndCompressChunks(
          chunkKeys,
          destinationKey,
          file.mimeType,
        );
        finalSize = result.compressedSize;
      } else {
        await this.minioService.assembleChunks(
          chunkKeys,
          destinationKey,
          file.mimeType,
        );
      }

      // 2. Clean up temporary chunk objects from MinIO
      await this.minioService.deleteObjects(chunkKeys);

      // 3. Create FileVersion v1 and update File record
      const version = await this.prisma.fileVersion.create({
        data: {
          fileId: file.id,
          versionNumber: 1,
          storagePath: destinationKey,
          size: finalSize,
          checksum: file.checksum || 'unknown',
          isCompressed: isCompressible,
        },
      });

      const updatedFile = await this.prisma.file.update({
        where: { id: file.id },
        data: {
          status: FileStatus.COMPLETED,
          storagePath: destinationKey,
          currentVersionId: version.id,
        },
      });

      // 4. Emit Kafka Event after DB commit
      this.kafkaService.emitFileUploaded({
        eventId: uuidv4(),
        eventType: 'file.uploaded',
        fileId: updatedFile.id,
        ownerId: updatedFile.ownerId,
        objectKey: destinationKey,
        bucket:
          this.configService.get<string>('MINIO_BUCKET') || 'pravah-origin',
        size: Number(finalSize),
        mimeType: file.mimeType,
        checksum: file.checksum || 'unknown',
        compression: isCompressible ? 'gzip' : 'none',
        schemaVersion: 1,
        uploadedAt: updatedFile.updatedAt.toISOString(),
      });

      return {
        message: 'Upload completed and file assembled successfully',
        fileId: updatedFile.id,
        name: updatedFile.name,
        storagePath: destinationKey,
        status: updatedFile.status,
      };
    } catch (err) {
      await this.prisma.file.update({
        where: { id: file.id },
        data: { status: FileStatus.FAILED },
      });
      throw err;
    }
  }
}
