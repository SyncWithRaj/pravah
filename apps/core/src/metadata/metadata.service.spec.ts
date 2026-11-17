import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { KafkaService } from '../common/kafka/kafka.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetadataService } from './metadata.service';

type PrismaMock = {
  file: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
  };
  fileVersion: {
    findFirst: jest.Mock;
  };
};

type MinioMock = {
  deleteObjects: jest.Mock;
};

type KafkaMock = {
  emitCacheInvalidate: jest.Mock;
};

describe('MetadataService', () => {
  let service: MetadataService;
  let prisma: PrismaMock;
  let minio: MinioMock;
  let kafka: KafkaMock;

  beforeEach(() => {
    prisma = {
      file: {
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      fileVersion: { findFirst: jest.fn() },
    };
    minio = { deleteObjects: jest.fn().mockResolvedValue(undefined) };
    kafka = { emitCacheInvalidate: jest.fn() };

    service = new MetadataService(
      prisma as unknown as PrismaService,
      minio as unknown as MinioService,
      kafka as unknown as KafkaService,
    );
  });

  describe('findAll', () => {
    it('paginates and serialises bigint sizes', async () => {
      prisma.file.findMany.mockResolvedValue([
        {
          id: 'file-1',
          totalSize: BigInt(1024),
          currentVersion: {
            versionNumber: 1,
            size: BigInt(512),
            createdAt: new Date('2026-01-01'),
          },
        },
        {
          id: 'file-2',
          totalSize: BigInt(0),
          currentVersion: null,
        },
      ]);
      prisma.file.count.mockResolvedValue(22);

      const result = await service.findAll('user-1', { page: 2, limit: 10 });

      expect(prisma.file.findMany).toHaveBeenCalledWith({
        where: { ownerId: 'user-1' },
        skip: 10,
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          currentVersion: {
            select: { versionNumber: true, size: true, createdAt: true },
          },
        },
      });
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(
        expect.objectContaining({ id: 'file-1', totalSize: '1024' }),
      );
      expect(result.data[0].currentVersion).toEqual(
        expect.objectContaining({ size: '512' }),
      );
      expect(result.data[1]).toEqual(
        expect.objectContaining({
          id: 'file-2',
          totalSize: '0',
          currentVersion: null,
        }),
      );
      expect(result.meta).toEqual({
        total: 22,
        page: 2,
        limit: 10,
        totalPages: 3,
      });
    });

    it('applies default pagination', async () => {
      prisma.file.findMany.mockResolvedValue([]);
      prisma.file.count.mockResolvedValue(0);

      const result = await service.findAll('user-1', {});

      expect(prisma.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
      expect(result.meta).toEqual({
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
    });
  });

  describe('findOne', () => {
    it('returns a file owned by the caller with serialised sizes', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        ownerId: 'user-1',
        totalSize: BigInt(10),
        currentVersion: { id: 'version-1', size: BigInt(5) },
      });

      const result = await service.findOne('user-1', 'file-1');

      expect(result.totalSize).toBe('10');
      expect(result.currentVersion).toEqual(
        expect.objectContaining({ id: 'version-1', size: '5' }),
      );
    });

    it('throws for missing files and non-owners', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(service.findOne('user-1', 'file-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.file.findUnique.mockResolvedValueOnce({
        ownerId: 'user-2',
        totalSize: BigInt(1),
        currentVersion: null,
      });
      await expect(service.findOne('user-1', 'file-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('findVersions', () => {
    it('returns versions with string sizes', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        versions: [
          { id: 'v2', versionNumber: 2, size: BigInt(20) },
          { id: 'v1', versionNumber: 1, size: BigInt(10) },
        ],
      });

      await expect(service.findVersions('user-1', 'file-1')).resolves.toEqual([
        { id: 'v2', versionNumber: 2, size: '20' },
        { id: 'v1', versionNumber: 1, size: '10' },
      ]);
    });

    it('enforces existence and ownership', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.findVersions('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.file.findUnique.mockResolvedValueOnce({
        ownerId: 'user-2',
        versions: [],
      });
      await expect(
        service.findVersions('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('deletes origin, version, and chunk objects before the database row', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        storagePath: 'files/file-1/v2/current.txt',
        versions: [
          { storagePath: 'files/file-1/v2/current.txt' },
          { storagePath: 'files/file-1/v1/old.txt' },
        ],
        chunks: [
          { storagePath: 'chunks/file-1/chunk-0' },
          { storagePath: null },
        ],
      });

      const result = await service.remove('user-1', 'file-1');

      expect(minio.deleteObjects).toHaveBeenCalledWith([
        'files/file-1/v2/current.txt',
        'files/file-1/v2/current.txt',
        'files/file-1/v1/old.txt',
        'chunks/file-1/chunk-0',
      ]);
      expect(prisma.file.delete).toHaveBeenCalledWith({
        where: { id: 'file-1' },
      });
      expect(kafka.emitCacheInvalidate).toHaveBeenCalledWith('file-1');
      expect(result).toEqual({
        success: true,
        message: 'File deleted completely and cache invalidated',
      });
    });

    it('skips MinIO when there are no stored objects', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        storagePath: null,
        versions: [],
        chunks: [],
      });

      await service.remove('user-1', 'file-1');

      expect(minio.deleteObjects).not.toHaveBeenCalled();
      expect(prisma.file.delete).toHaveBeenCalled();
    });

    it('enforces existence and ownership', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove('user-1', 'file-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.file.findUnique.mockResolvedValueOnce({
        ownerId: 'user-2',
        versions: [],
        chunks: [],
      });
      await expect(service.remove('user-1', 'file-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.file.delete).not.toHaveBeenCalled();
    });
  });

  describe('internal lookups', () => {
    it('resolves a version with the parent file MIME type', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        mimeType: 'video/mp4',
      });
      prisma.fileVersion.findFirst.mockResolvedValue({
        id: 'version-1',
        versionNumber: 1,
        storagePath: 'files/file-1/v1/video.mp4',
        size: BigInt(100),
        checksum: 'checksum-1',
      });

      await expect(service.findInternalVersion('file-1', 1)).resolves.toEqual({
        versionId: 'version-1',
        versionNumber: 1,
        storagePath: 'files/file-1/v1/video.mp4',
        size: '100',
        checksum: 'checksum-1',
        mimeType: 'video/mp4',
        ownerId: 'user-1',
      });
    });

    it('throws for a missing file or version', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.findInternalVersion('file-1', 1),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.file.findUnique.mockResolvedValueOnce({
        ownerId: 'user-1',
        mimeType: 'video/mp4',
      });
      prisma.fileVersion.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.findInternalVersion('file-1', 1),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the internal file view with the current version summary', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        mimeType: 'text/plain',
        currentVersion: { checksum: 'checksum-1', size: BigInt(9) },
      });

      await expect(service.findInternalFile('file-1')).resolves.toEqual({
        ownerId: 'user-1',
        mimeType: 'text/plain',
        currentVersion: { checksum: 'checksum-1', size: '9' },
      });
    });

    it('returns null current versions when none exist', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        mimeType: 'text/plain',
        currentVersion: null,
      });

      await expect(service.findInternalFile('file-1')).resolves.toEqual({
        ownerId: 'user-1',
        mimeType: 'text/plain',
        currentVersion: null,
      });
    });
  });
});
