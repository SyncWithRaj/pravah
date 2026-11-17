import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChunkStatus, FileStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { CacheManagerService } from '../common/cache-manager/cache-manager.service';
import { KafkaService } from '../common/kafka/kafka.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { TranscodingService } from '../transcoding/transcoding.service';
import { UploadService } from './upload.service';
import { InitUploadDto } from './dto/init-upload.dto';

type PrismaMock = {
  file: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  fileChunk: {
    createMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  fileVersion: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  $transaction: jest.Mock;
};

type MinioMock = {
  uploadChunk: jest.Mock;
  assembleChunks: jest.Mock;
  assembleAndCompressChunks: jest.Mock;
  deleteObjects: jest.Mock;
};

type KafkaMock = {
  emitFileUploaded: jest.Mock;
  emitCacheInvalidate: jest.Mock;
};

type CacheMock = {
  setCurrentVersion: jest.Mock;
};

type TranscodingMock = {
  queueTranscoding: jest.Mock;
};

const initDto: InitUploadDto = {
  name: 'notes.txt',
  mimeType: 'text/plain',
  totalSize: 11,
  totalChunks: 1,
  fullFileChecksum: 'checksum-1',
};

const fileRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'file-1',
  ownerId: 'user-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  totalSize: BigInt(11),
  totalChunks: 1,
  uploadedChunks: 0,
  checksum: 'checksum-1',
  status: FileStatus.PENDING,
  storagePath: null,
  currentVersionId: null,
  bucketName: 'pravah-origin',
  chunks: [
    {
      chunkIndex: 0,
      storagePath: 'chunks/file-1/chunk-0',
      status: ChunkStatus.VERIFIED,
    },
  ],
  ...overrides,
});

const updatedFileRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'file-1',
  ownerId: 'user-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  status: FileStatus.COMPLETED,
  bucketName: 'pravah-origin',
  ...overrides,
});

describe('UploadService', () => {
  let service: UploadService;
  let prisma: PrismaMock;
  let minio: MinioMock;
  let kafka: KafkaMock;
  let cache: CacheMock;
  let transcoding: TranscodingMock;

  beforeEach(() => {
    prisma = {
      file: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fileChunk: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fileVersion: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (
        arg: Promise<unknown>[] | ((tx: PrismaMock) => Promise<unknown>),
      ): Promise<unknown> => {
        if (typeof arg === 'function') return arg(prisma);
        return Promise.all(arg);
      },
    );

    minio = {
      uploadChunk: jest.fn().mockResolvedValue('chunks/file-1/chunk-0'),
      assembleChunks: jest.fn().mockResolvedValue('files/file-1/v2/notes.txt'),
      assembleAndCompressChunks: jest.fn().mockResolvedValue({
        destinationKey: 'files/file-1/v2/notes.txt',
        compressedSize: 5,
      }),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
    kafka = {
      emitFileUploaded: jest.fn(),
      emitCacheInvalidate: jest.fn(),
    };
    cache = { setCurrentVersion: jest.fn().mockResolvedValue(undefined) };
    transcoding = { queueTranscoding: jest.fn().mockResolvedValue(undefined) };

    service = new UploadService(
      prisma as unknown as PrismaService,
      minio as unknown as MinioService,
      kafka as unknown as KafkaService,
      { get: jest.fn() } as unknown as ConfigService,
      cache as unknown as CacheManagerService,
      transcoding as unknown as TranscodingService,
    );
  });

  describe('initUpload', () => {
    it('creates the file and one pending chunk per chunk index', async () => {
      prisma.file.create.mockResolvedValue({
        id: 'file-1',
        name: 'notes.txt',
        totalChunks: 2,
        status: FileStatus.PENDING,
      });

      const result = await service.initUpload('user-1', {
        ...initDto,
        totalChunks: 2,
      });

      expect(result).toEqual({
        fileId: 'file-1',
        name: 'notes.txt',
        totalChunks: 2,
        status: FileStatus.PENDING,
      });
      expect(prisma.file.create).toHaveBeenCalledWith({
        data: {
          name: 'notes.txt',
          mimeType: 'text/plain',
          totalSize: BigInt(11),
          totalChunks: 2,
          ownerId: 'user-1',
          status: FileStatus.PENDING,
          checksum: 'checksum-1',
        },
      });
      expect(prisma.fileChunk.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            fileId: 'file-1',
            chunkIndex: 0,
            storagePath: 'chunks/file-1/chunk-0',
            status: ChunkStatus.PENDING,
          }),
          expect.objectContaining({
            fileId: 'file-1',
            chunkIndex: 1,
            storagePath: 'chunks/file-1/chunk-1',
            status: ChunkStatus.PENDING,
          }),
        ],
      });
    });
  });

  describe('initVersionUpload', () => {
    it('replaces chunks and rewinds upload progress in a transaction', async () => {
      prisma.file.findUnique.mockResolvedValue(fileRecord());
      prisma.file.update.mockResolvedValue(
        updatedFileRecord({ totalChunks: 2, status: FileStatus.PENDING }),
      );

      const result = await service.initVersionUpload('user-1', 'file-1', {
        ...initDto,
        totalChunks: 2,
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.fileChunk.deleteMany).toHaveBeenCalledWith({
        where: { fileId: 'file-1' },
      });
      expect(prisma.file.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'file-1' } }),
      );
      const updateCall = prisma.file.update.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ];
      expect(updateCall[0].data).toEqual(
        expect.objectContaining({
          uploadedChunks: 0,
          totalSize: BigInt(11),
          status: FileStatus.PENDING,
          checksum: 'checksum-1',
        }),
      );
      expect(prisma.fileChunk.createMany).toHaveBeenCalled();
      expect(result).toEqual({
        fileId: 'file-1',
        name: 'notes.txt',
        totalChunks: 2,
        status: FileStatus.PENDING,
      });
    });

    it('rejects a missing file', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(
        service.initVersionUpload('user-1', 'file-1', initDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({ ownerId: 'user-2' }),
      );

      await expect(
        service.initVersionUpload('user-1', 'file-1', initDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('uploadChunk', () => {
    it('rejects an empty chunk before touching the database', async () => {
      await expect(
        service.uploadChunk('user-1', 'file-1', 0, 'checksum', Buffer.alloc(0)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.file.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a missing upload session', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadChunk(
          'user-1',
          'file-1',
          0,
          'checksum',
          Buffer.from('x'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({ ownerId: 'user-2' }),
      );

      await expect(
        service.uploadChunk(
          'user-1',
          'file-1',
          0,
          'checksum',
          Buffer.from('x'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a chunk after the file has completed', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({ status: FileStatus.COMPLETED }),
      );

      await expect(
        service.uploadChunk(
          'user-1',
          'file-1',
          0,
          'checksum',
          Buffer.from('x'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown chunk index', async () => {
      prisma.file.findUnique.mockResolvedValue(fileRecord());
      prisma.fileChunk.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadChunk(
          'user-1',
          'file-1',
          4,
          'checksum',
          Buffer.from('x'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a checksum mismatch without uploading to MinIO', async () => {
      prisma.file.findUnique.mockResolvedValue(fileRecord());
      prisma.fileChunk.findUnique.mockResolvedValue({
        status: ChunkStatus.PENDING,
      });

      await expect(
        service.uploadChunk(
          'user-1',
          'file-1',
          0,
          'not-the-checksum',
          Buffer.from('hello'),
        ),
      ).rejects.toThrow('Checksum mismatch for chunk 0');
      expect(minio.uploadChunk).not.toHaveBeenCalled();
    });

    it('uploads, verifies, and increments the uploaded-chunk counter', async () => {
      const buffer = Buffer.from('hello world');
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      prisma.file.findUnique
        .mockResolvedValueOnce(fileRecord({ status: FileStatus.UPLOADING }))
        .mockResolvedValueOnce({ uploadedChunks: 1, totalChunks: 2 });
      prisma.fileChunk.findUnique.mockResolvedValue({
        status: ChunkStatus.PENDING,
      });

      const result = await service.uploadChunk(
        'user-1',
        'file-1',
        0,
        checksum.toUpperCase(),
        buffer,
      );

      expect(minio.uploadChunk).toHaveBeenCalledWith(
        'chunks/file-1/chunk-0',
        buffer,
      );
      expect(prisma.fileChunk.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            fileId_chunkIndex: { fileId: 'file-1', chunkIndex: 0 },
          },
        }),
      );
      const chunkUpdateCall = prisma.fileChunk.update.mock
        .calls[0] as unknown as [{ data: Record<string, unknown> }];
      expect(chunkUpdateCall[0].data).toEqual(
        expect.objectContaining({
          size: buffer.length,
          checksum,
          status: ChunkStatus.VERIFIED,
        }),
      );
      expect(prisma.file.update).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        data: {
          status: FileStatus.UPLOADING,
          uploadedChunks: { increment: 1 },
        },
      });
      expect(result).toEqual({
        success: true,
        fileId: 'file-1',
        chunkIndex: 0,
        uploadedChunks: 1,
        totalChunks: 2,
      });
    });

    it('does not double-count a chunk that is already verified', async () => {
      const buffer = Buffer.from('hello world');
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      prisma.file.findUnique
        .mockResolvedValueOnce(fileRecord({ status: FileStatus.UPLOADING }))
        .mockResolvedValueOnce({ uploadedChunks: 1, totalChunks: 1 });
      prisma.fileChunk.findUnique.mockResolvedValue({
        status: ChunkStatus.VERIFIED,
      });

      await service.uploadChunk('user-1', 'file-1', 0, checksum, buffer);

      expect(prisma.file.update).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        data: { status: FileStatus.UPLOADING },
      });
    });

    it('falls back to safe counters when the refreshed file is missing', async () => {
      const buffer = Buffer.from('hello world');
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
      prisma.file.findUnique
        .mockResolvedValueOnce(fileRecord({ status: FileStatus.UPLOADING }))
        .mockResolvedValueOnce(null);
      prisma.fileChunk.findUnique.mockResolvedValue({
        status: ChunkStatus.PENDING,
      });

      const result = await service.uploadChunk(
        'user-1',
        'file-1',
        0,
        checksum,
        buffer,
      );

      expect(result.uploadedChunks).toBe(0);
      expect(result.totalChunks).toBe(1);
    });
  });

  describe('getUploadStatus', () => {
    it('returns verified chunk indices', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        ownerId: 'user-1',
        name: 'notes.txt',
        status: FileStatus.UPLOADING,
        totalChunks: 3,
        uploadedChunks: 2,
        chunks: [
          { chunkIndex: 0, status: ChunkStatus.VERIFIED },
          { chunkIndex: 1, status: ChunkStatus.PENDING },
          { chunkIndex: 2, status: ChunkStatus.VERIFIED },
        ],
      });

      await expect(
        service.getUploadStatus('user-1', 'file-1'),
      ).resolves.toEqual({
        fileId: 'file-1',
        name: 'notes.txt',
        status: FileStatus.UPLOADING,
        totalChunks: 3,
        uploadedChunks: 2,
        verifiedChunks: [0, 2],
      });
    });

    it('rejects a missing file or a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getUploadStatus('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.file.findUnique.mockResolvedValueOnce(
        fileRecord({ ownerId: 'user-2', chunks: [] }),
      );
      await expect(
        service.getUploadStatus('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('completeUpload', () => {
    const setupCompletion = (
      fileOverrides: Record<string, unknown> = {},
      maxVersion: { versionNumber: number } | null = { versionNumber: 1 },
    ) => {
      prisma.file.findUnique.mockResolvedValue(fileRecord(fileOverrides));
      prisma.fileVersion.findFirst.mockResolvedValue(maxVersion);
      prisma.fileVersion.create.mockResolvedValue({
        id: 'version-2',
        versionNumber: 2,
        isCompressed: false,
      });
      prisma.file.update.mockResolvedValue(
        updatedFileRecord({ currentVersionId: 'version-2' }),
      );
    };

    it('rejects a missing session', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({ ownerId: 'user-2' }),
      );

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an already-completed file', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({ status: FileStatus.COMPLETED }),
      );

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toThrow('File is already marked as completed');
    });

    it('rejects an incomplete chunk set', async () => {
      prisma.file.findUnique.mockResolvedValue(
        fileRecord({
          totalChunks: 2,
          chunks: [
            { chunkIndex: 0, status: ChunkStatus.VERIFIED },
            { chunkIndex: 1, status: ChunkStatus.PENDING },
          ],
        }),
      );

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toThrow('received 1/2 chunks');
    });

    it('rejects a concurrent completion claim', async () => {
      prisma.file.findUnique.mockResolvedValue(fileRecord());
      prisma.file.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('assembles a new non-compressed version and emits upload events', async () => {
      setupCompletion({ mimeType: 'video/mp4' }, null);
      prisma.file.update.mockResolvedValue(
        updatedFileRecord({
          currentVersionId: 'version-1',
          mimeType: 'video/mp4',
        }),
      );
      prisma.fileVersion.create.mockResolvedValue({
        id: 'version-1',
        versionNumber: 1,
        isCompressed: false,
      });

      const result = await service.completeUpload('user-1', {
        fileId: 'file-1',
      });

      expect(minio.assembleChunks).toHaveBeenCalledWith(
        ['chunks/file-1/chunk-0'],
        'files/user-1/file-1/v1/notes.txt',
        'video/mp4',
      );
      expect(minio.assembleAndCompressChunks).not.toHaveBeenCalled();
      expect(minio.deleteObjects).toHaveBeenCalledWith([
        'chunks/file-1/chunk-0',
      ]);
      expect(prisma.fileVersion.create).toHaveBeenCalledWith({
        data: {
          fileId: 'file-1',
          versionNumber: 1,
          storagePath: 'files/user-1/file-1/v1/notes.txt',
          size: BigInt(11),
          checksum: 'checksum-1',
          isCompressed: false,
        },
      });
      expect(cache.setCurrentVersion).toHaveBeenCalledWith(
        'file-1',
        'version-1',
      );
      expect(kafka.emitFileUploaded).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'file.uploaded',
          fileId: 'file-1',
          versionId: 'version-1',
          compression: 'none',
        }),
      );
      expect(kafka.emitCacheInvalidate).not.toHaveBeenCalled();
      expect(transcoding.queueTranscoding).toHaveBeenCalledWith(
        'file-1',
        'version-1',
        'user-1',
        'files/user-1/file-1/v1/notes.txt',
        'video/mp4',
        11,
      );
      expect(result).toEqual({
        message: 'Upload completed and file assembled successfully',
        fileId: 'file-1',
        name: 'notes.txt',
        storagePath: 'files/user-1/file-1/v1/notes.txt',
        status: FileStatus.COMPLETED,
      });
    });

    it('creates a later version and invalidates caches', async () => {
      setupCompletion({ mimeType: 'video/mp4' });

      await service.completeUpload('user-1', { fileId: 'file-1' });

      expect(prisma.fileVersion.create).toHaveBeenCalled();
      const createCall = prisma.fileVersion.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ];
      expect(createCall[0].data).toEqual(
        expect.objectContaining({ versionNumber: 2 }),
      );
      expect(kafka.emitFileUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'file.version_created' }),
      );
      expect(kafka.emitCacheInvalidate).toHaveBeenCalledWith('file-1');
    });

    it('gzip-compresses compressible content and stores the compressed size', async () => {
      setupCompletion({ mimeType: 'text/plain' });
      prisma.fileVersion.create.mockResolvedValue({
        id: 'version-2',
        versionNumber: 2,
        isCompressed: true,
      });

      await service.completeUpload('user-1', { fileId: 'file-1' });

      expect(minio.assembleAndCompressChunks).toHaveBeenCalledWith(
        ['chunks/file-1/chunk-0'],
        'files/user-1/file-1/v2/notes.txt',
        'text/plain',
      );
      expect(prisma.fileVersion.create).toHaveBeenCalled();
      const createCall = prisma.fileVersion.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ];
      expect(createCall[0].data).toEqual(
        expect.objectContaining({
          size: 5,
          isCompressed: true,
        }),
      );
      expect(kafka.emitFileUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ compression: 'gzip', size: 5 }),
      );
    });

    it('marks the file failed when assembly throws', async () => {
      setupCompletion({ mimeType: 'video/mp4' });
      minio.assembleChunks.mockRejectedValue(new Error('assembly failed'));

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toThrow('assembly failed');

      expect(prisma.file.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'file-1', status: FileStatus.ASSEMBLING },
        data: { status: FileStatus.FAILED },
      });
    });

    it('swallows cache pointer failures without failing the upload', async () => {
      setupCompletion({ mimeType: 'video/mp4' });
      cache.setCurrentVersion.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).resolves.toEqual(
        expect.objectContaining({ status: FileStatus.COMPLETED }),
      );
    });

    it('marks the file failed when the transcoding queue fails', async () => {
      setupCompletion({ mimeType: 'video/mp4' });
      transcoding.queueTranscoding.mockRejectedValue(
        new Error('queue unavailable'),
      );

      await expect(
        service.completeUpload('user-1', { fileId: 'file-1' }),
      ).rejects.toThrow('queue unavailable');
      expect(prisma.file.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'file-1', status: FileStatus.ASSEMBLING },
        data: { status: FileStatus.FAILED },
      });
    });
  });
});
