import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { GetFilesQueryDto } from './dto/get-files-query.dto';

@Injectable()
export class MetadataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  async findAll(userId: string, query: GetFilesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const [files, total] = await Promise.all([
      this.prisma.file.findMany({
        where: { ownerId: userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          currentVersion: {
            select: { versionNumber: true, size: true, createdAt: true },
          },
        },
      }),
      this.prisma.file.count({ where: { ownerId: userId } }),
    ]);

    // Map BigInts to Strings for JSON serialization
    const mappedFiles = files.map((f) => ({
      ...f,
      totalSize: f.totalSize.toString(),
      currentVersion: f.currentVersion
        ? {
            ...f.currentVersion,
            size: f.currentVersion.size.toString(),
          }
        : null,
    }));

    return {
      data: mappedFiles,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(userId: string, fileId: string) {
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

    return {
      ...file,
      totalSize: file.totalSize.toString(),
      currentVersion: file.currentVersion
        ? {
            ...file.currentVersion,
            size: file.currentVersion.size.toString(),
          }
        : null,
    };
  }

  async findVersions(userId: string, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
        },
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return file.versions.map((v) => ({
      ...v,
      size: v.size.toString(),
    }));
  }

  async remove(userId: string, fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        versions: true,
        chunks: true,
      },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (file.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // 1. Gather all MinIO keys to delete
    const keysToDelete: string[] = [];

    // Add main file storage path if it exists
    if (file.storagePath) keysToDelete.push(file.storagePath);

    // Add all historical version storage paths
    file.versions.forEach((v) => {
      if (v.storagePath) keysToDelete.push(v.storagePath);
    });

    // Add any lingering temporary chunks
    file.chunks.forEach((c) => {
      if (c.storagePath) keysToDelete.push(c.storagePath);
    });

    // 2. Delete physical objects from MinIO
    if (keysToDelete.length > 0) {
      await this.minioService.deleteObjects(keysToDelete);
    }

    // 3. Delete from PostgreSQL
    // Because of @relation(onDelete: Cascade) on FileVersion and FileChunk,
    // this single command will clean up all related rows automatically.
    await this.prisma.file.delete({
      where: { id: fileId },
    });

    return { success: true, message: 'File deleted completely' };
  }

  async findInternalVersion(fileId: string, versionNumber: number) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });
    if (!file) throw new NotFoundException('File not found');

    const fileVersion = await this.prisma.fileVersion.findFirst({
      where: { fileId, versionNumber },
    });
    if (!fileVersion) throw new NotFoundException('Version not found');

    return {
      storagePath: fileVersion.storagePath,
      size: fileVersion.size.toString(),
      checksum: fileVersion.checksum,
      mimeType: file.mimeType,
      ownerId: file.ownerId,
    };
  }

  async findInternalFile(fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { currentVersion: true }
    });
    if (!file) throw new NotFoundException('File not found');

    return {
      ownerId: file.ownerId,
      mimeType: file.mimeType,
      currentVersion: file.currentVersion ? {
        checksum: file.currentVersion.checksum,
        size: file.currentVersion.size.toString(),
      } : null,
    };
  }
}
