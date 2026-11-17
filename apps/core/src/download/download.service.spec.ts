import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { CacheManagerService } from '../common/cache-manager/cache-manager.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { DownloadService } from './download.service';

type PrismaMock = {
  file: { findUnique: jest.Mock };
  fileVersion: { findUnique: jest.Mock };
};

type MinioMock = {
  getObjectMetadata: jest.Mock;
  getObjectStream: jest.Mock;
  getObjectStreamWithRange: jest.Mock;
  generateSignedUrl: jest.Mock;
};

type CacheMock = {
  getMetadata: jest.Mock;
  getCurrentVersion: jest.Mock;
  setCurrentVersion: jest.Mock;
  getBinary: jest.Mock;
  acquireStampedeLock: jest.Mock;
  waitForCache: jest.Mock;
  releaseStampedeLock: jest.Mock;
  cacheFile: jest.Mock;
  emitCacheMiss: jest.Mock;
};

type ConfigMock = {
  get: jest.Mock;
};

const versionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'version-1',
  fileId: 'file-1',
  versionNumber: 1,
  storagePath: 'files/user-1/file-1/v1/video.mp4',
  size: BigInt(11),
  checksum: 'checksum-1',
  isCompressed: false,
  file: {
    id: 'file-1',
    ownerId: 'user-1',
    name: 'video.mp4',
    mimeType: 'video/mp4',
    status: 'COMPLETED',
    storagePath: 'files/user-1/file-1/v1/video.mp4',
    currentVersionId: 'version-1',
  },
  ...overrides,
});

const cachedMetadata = (overrides: Record<string, unknown> = {}) => ({
  ownerId: 'user-1',
  contentType: 'text/plain',
  size: 11,
  checksum: 'checksum-1',
  etag: '"etag-1"',
  cacheControl: 'public, max-age=86400',
  ...overrides,
});

const waitFor = async (assertion: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe('DownloadService', () => {
  let service: DownloadService;
  let prisma: PrismaMock;
  let minio: MinioMock;
  let cache: CacheMock;
  let config: ConfigMock;

  beforeEach(() => {
    prisma = {
      file: { findUnique: jest.fn() },
      fileVersion: { findUnique: jest.fn() },
    };
    minio = {
      getObjectMetadata: jest.fn(),
      getObjectStream: jest.fn(),
      getObjectStreamWithRange: jest.fn(),
      generateSignedUrl: jest.fn(),
    };
    cache = {
      getMetadata: jest.fn().mockResolvedValue(null),
      getCurrentVersion: jest.fn().mockResolvedValue(null),
      setCurrentVersion: jest.fn().mockResolvedValue(undefined),
      getBinary: jest.fn().mockResolvedValue(null),
      acquireStampedeLock: jest.fn().mockResolvedValue(true),
      waitForCache: jest.fn().mockResolvedValue(false),
      releaseStampedeLock: jest.fn().mockResolvedValue(undefined),
      cacheFile: jest.fn().mockResolvedValue(undefined),
      emitCacheMiss: jest.fn(),
    };
    config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'MAX_CACHE_SIZE') return 20 * 1024 * 1024;
        if (key === 'SIGNED_URL_EXPIRES_IN') return '900';
        return defaultValue;
      }),
    };

    service = new DownloadService(
      prisma as unknown as PrismaService,
      minio as unknown as MinioService,
      config as unknown as ConfigService,
      cache as unknown as CacheManagerService,
    );
  });

  describe('getCurrentVersion', () => {
    it('returns the current version number for the owner', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        currentVersion: { versionNumber: 3 },
      });

      await expect(service.getCurrentVersion('user-1', 'file-1')).resolves.toBe(
        3,
      );
    });

    it('throws when the file does not exist', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(
        service.getCurrentVersion('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the caller is not the owner', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-2',
        currentVersion: { versionNumber: 1 },
      });

      await expect(
        service.getCurrentVersion('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the file has no current version', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        currentVersion: null,
      });

      await expect(
        service.getCurrentVersion('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assertVersionAccess', () => {
    it('accepts the file owner', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue({
        file: { ownerId: 'user-1' },
      });

      await expect(
        service.assertVersionAccess('user-1', 'file-1', 1),
      ).resolves.toBeUndefined();
    });

    it('rejects a non-owner, including an admin JWT holder', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue({
        file: { ownerId: 'user-2' },
      });

      await expect(
        service.assertVersionAccess('user-3', 'file-1', 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the version does not exist', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(null);

      await expect(
        service.assertVersionAccess('user-1', 'file-1', 99),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('downloadCurrentVersion', () => {
    it('uses the cached current-version pointer and delegates to processDownload', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        status: 'COMPLETED',
        currentVersionId: 'version-1',
      });
      cache.getCurrentVersion.mockResolvedValue('version-1');
      const processSpy = jest
        .spyOn(service, 'processDownload')
        .mockResolvedValue({ stream: Readable.from([]) });

      await service.downloadCurrentVersion('user-1', 'file-1');

      expect(cache.setCurrentVersion).not.toHaveBeenCalled();
      expect(processSpy).toHaveBeenCalledWith(
        'user-1',
        'file-1',
        'version-1',
        undefined,
        undefined,
      );
    });

    it('refreshes a stale current-version pointer', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        status: 'COMPLETED',
        currentVersionId: 'version-2',
      });
      cache.getCurrentVersion.mockResolvedValue('version-1');
      const processSpy = jest
        .spyOn(service, 'processDownload')
        .mockResolvedValue({ stream: Readable.from([]) });

      await service.downloadCurrentVersion('user-1', 'file-1');

      expect(cache.setCurrentVersion).toHaveBeenCalledWith(
        'file-1',
        'version-2',
      );
      expect(processSpy).toHaveBeenCalledWith(
        'user-1',
        'file-1',
        'version-2',
        undefined,
        undefined,
      );
    });

    it('rejects an upload that has not completed', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        status: 'UPLOADING',
        currentVersionId: null,
      });

      await expect(
        service.downloadCurrentVersion('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-2',
        status: 'COMPLETED',
        currentVersionId: 'version-1',
      });

      await expect(
        service.downloadCurrentVersion('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('processDownload', () => {
    it('rejects a cached metadata record owned by another user', async () => {
      cache.getMetadata.mockResolvedValue(
        cachedMetadata({ ownerId: 'user-2' }),
      );

      await expect(
        service.processDownload('user-1', 'file-1', 'version-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 304 when the cached ETag matches If-None-Match', async () => {
      cache.getMetadata.mockResolvedValue(cachedMetadata());

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
        '"etag-1"',
      );

      expect(result).toEqual({
        isNotModified: true,
        etag: '"etag-1"',
        cacheControl: 'public, max-age=86400',
      });
    });

    it('serves a full cache hit without touching MinIO', async () => {
      cache.getMetadata.mockResolvedValue(cachedMetadata());
      cache.getBinary.mockResolvedValue(Buffer.from('hello world'));

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
      );

      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.contentLength).toBe(11);
      expect(result.contentType).toBe('text/plain');
      expect(result.etag).toBe('"etag-1"');
      expect(minio.getObjectStream).not.toHaveBeenCalled();
      expect(cache.emitCacheMiss).not.toHaveBeenCalled();
    });

    it('serves a valid byte range from the cache', async () => {
      cache.getMetadata.mockResolvedValue(cachedMetadata());
      cache.getBinary.mockResolvedValue(Buffer.from('hello world'));

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
        undefined,
        'bytes=0-4',
      );

      expect(result.contentLength).toBe(5);
      expect(result.contentRange).toBe('bytes 0-4/11');
    });

    it('rejects an unsatisfiable byte range', async () => {
      cache.getMetadata.mockResolvedValue(cachedMetadata());
      cache.getBinary.mockResolvedValue(Buffer.from('hello world'));

      await expect(
        service.processDownload(
          'user-1',
          'file-1',
          'version-1',
          undefined,
          'bytes=20-30',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the version is missing and no cache metadata exists', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(null);

      await expect(
        service.processDownload('user-1', 'file-1', 'missing-version'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-owner before opening an origin stream', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(
        versionRecord({ file: { ownerId: 'user-2' } }),
      );

      await expect(
        service.processDownload('user-1', 'file-1', 'version-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(minio.getObjectStream).not.toHaveBeenCalled();
    });

    it('streams a non-cacheable origin object and emits a cache miss', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(versionRecord());
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'video/mp4',
      });
      minio.getObjectStream.mockResolvedValue(
        Readable.from([Buffer.from('hello world')]),
      );

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
      );

      expect(result.stream).toBeInstanceOf(Readable);
      expect(result.fileName).toBe('video.mp4');
      expect(result.etag).toBe('"etag-origin"');
      expect(cache.acquireStampedeLock).not.toHaveBeenCalled();
      expect(cache.emitCacheMiss).toHaveBeenCalledWith(
        'file-1',
        expect.any(Number),
      );
    });

    it('uses a ranged origin fetch when requested', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(versionRecord());
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'video/mp4',
      });
      const stream = Readable.from([Buffer.from('hello')]);
      minio.getObjectStreamWithRange.mockResolvedValue({
        stream,
        contentLength: 5,
        contentRange: 'bytes 0-4/11',
      });

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
        undefined,
        'bytes=0-4',
      );

      expect(result.stream).toBe(stream);
      expect(result.contentLength).toBe(5);
      expect(result.contentRange).toBe('bytes 0-4/11');
      expect(minio.getObjectStreamWithRange).toHaveBeenCalledWith(
        'files/user-1/file-1/v1/video.mp4',
        'bytes=0-4',
      );
    });

    it('populates the cache in the background for a cacheable object', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(
        versionRecord({
          file: {
            ownerId: 'user-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            status: 'COMPLETED',
          },
        }),
      );
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'text/plain',
      });
      minio.getObjectStream.mockResolvedValue(
        Readable.from([Buffer.from('hello world')]),
      );

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
      );

      expect(result.stream).toBeInstanceOf(Readable);
      expect(cache.acquireStampedeLock).toHaveBeenCalled();
      await waitFor(() => cache.cacheFile.mock.calls.length > 0);
      expect(cache.cacheFile).toHaveBeenCalledWith(
        'file-1',
        'version-1',
        expect.objectContaining({ ownerId: 'user-1' }),
        expect.any(Buffer),
      );
      await waitFor(() => cache.releaseStampedeLock.mock.calls.length > 0);
    });

    it('waits for another request to fill the cache, then serves it', async () => {
      cache.getMetadata
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cachedMetadata());
      prisma.fileVersion.findUnique.mockResolvedValue(
        versionRecord({
          file: {
            ownerId: 'user-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            status: 'COMPLETED',
          },
        }),
      );
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'text/plain',
      });
      cache.acquireStampedeLock
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      cache.waitForCache.mockResolvedValue(true);
      cache.getBinary
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(Buffer.from('hello world'));

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
      );

      expect(result.contentLength).toBe(11);
      expect(cache.waitForCache).toHaveBeenCalledWith('file-1', 'version-1');
    });

    it('falls back to the origin when the stampede lock is unavailable', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(
        versionRecord({
          file: {
            ownerId: 'user-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            status: 'COMPLETED',
          },
        }),
      );
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'text/plain',
      });
      minio.getObjectStream.mockResolvedValue(
        Readable.from([Buffer.from('hello world')]),
      );
      cache.acquireStampedeLock.mockResolvedValue(false);
      cache.waitForCache.mockResolvedValue(false);

      const result = await service.processDownload(
        'user-1',
        'file-1',
        'version-1',
      );

      expect(result.stream).toBeInstanceOf(Readable);
      expect(cache.acquireStampedeLock).toHaveBeenCalledTimes(2);
    });

    it('releases the stampede lock when the origin fetch fails', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(
        versionRecord({
          file: {
            ownerId: 'user-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            status: 'COMPLETED',
          },
        }),
      );
      minio.getObjectMetadata.mockResolvedValue({
        etag: 'etag-origin',
        contentType: 'text/plain',
      });
      minio.getObjectStream.mockRejectedValue(new Error('origin down'));

      await expect(
        service.processDownload('user-1', 'file-1', 'version-1'),
      ).rejects.toThrow('origin down');
      expect(cache.releaseStampedeLock).toHaveBeenCalled();
    });
  });

  describe('downloadSpecificVersion', () => {
    it('resolves the version id and delegates to processDownload', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue({ id: 'version-2' });
      const processSpy = jest
        .spyOn(service, 'processDownload')
        .mockResolvedValue({ stream: Readable.from([]) });

      await service.downloadSpecificVersion('user-1', 'file-1', 2);

      expect(processSpy).toHaveBeenCalledWith(
        'user-1',
        'file-1',
        'version-2',
        undefined,
        undefined,
      );
    });

    it('throws when the requested version does not exist', async () => {
      prisma.fileVersion.findUnique.mockResolvedValue(null);

      await expect(
        service.downloadSpecificVersion('user-1', 'file-1', 2),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getSignedDownloadUrl', () => {
    it('returns a signed URL for the current version', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        name: 'video.mp4',
        storagePath: 'fallback-path',
        currentVersion: { storagePath: 'files/user-1/file-1/v1/video.mp4' },
      });
      minio.generateSignedUrl.mockResolvedValue('https://minio/signed');

      const result = await service.getSignedDownloadUrl(
        'user-1',
        'file-1',
        true,
      );

      expect(result).toEqual({
        url: 'https://minio/signed',
        expiresIn: 900,
        fileName: 'video.mp4',
      });
      expect(minio.generateSignedUrl).toHaveBeenCalledWith(
        'files/user-1/file-1/v1/video.mp4',
        900,
        'video.mp4',
      );
    });

    it('falls back to the file storage path when there is no current version', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        name: 'video.mp4',
        storagePath: 'fallback-path',
        currentVersion: null,
      });
      minio.generateSignedUrl.mockResolvedValue('https://minio/signed');

      await service.getSignedDownloadUrl('user-1', 'file-1');

      expect(minio.generateSignedUrl).toHaveBeenCalledWith(
        'fallback-path',
        900,
        undefined,
      );
    });

    it('does not reveal whether a file exists to a non-owner', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-2',
        name: 'video.mp4',
        storagePath: 'fallback-path',
        currentVersion: null,
      });

      await expect(
        service.getSignedDownloadUrl('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when no storage path can be resolved', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        name: 'video.mp4',
        storagePath: null,
        currentVersion: null,
      });

      await expect(
        service.getSignedDownloadUrl('user-1', 'file-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
