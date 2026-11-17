import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { ReplicationJobStatus } from '@prisma/client';
import { CacheManagerService } from '../common/cache-manager/cache-manager.service';
import { KafkaService } from '../common/kafka/kafka.service';
import { MinioService } from '../common/minio/minio.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';
import { ReplicationProcessor } from './replication.processor';
import { ReplicationJobData } from './replication.service';

type PrismaMock = {
  replicationStatus: { update: jest.Mock };
  fileVersion: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
};

type MinioMock = { getObjectStream: jest.Mock };
type CacheMock = { cacheFile: jest.Mock };
type KafkaMock = {
  emitReplicationStatusChanged: jest.Mock;
  emitReplicationDLQ: jest.Mock;
};
type TelemetryMock = { broadcastDLQAlert: jest.Mock };
type MetricsMock = {
  dlqEventsTotal: { inc: jest.Mock };
  dlqActiveItems: { inc: jest.Mock };
};

const makeJob = (
  overrides: Partial<Job<ReplicationJobData>> = {},
): Job<ReplicationJobData> =>
  ({
    data: {
      fileId: 'file-1',
      versionId: '2',
      edgeNodeId: 'edge-node-01',
      storagePath: 'files/file-1/v2/video.mp4',
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  }) as unknown as Job<ReplicationJobData>;

const makeVersion = (overrides: Record<string, unknown> = {}) => ({
  id: 'version-2',
  versionNumber: 2,
  size: BigInt(11),
  checksum: 'checksum-2',
  isCompressed: false,
  storagePath: 'files/file-1/v2/video.mp4',
  file: {
    ownerId: 'user-1',
    mimeType: 'video/mp4',
  },
  ...overrides,
});

describe('ReplicationProcessor', () => {
  let processor: ReplicationProcessor;
  let prisma: PrismaMock;
  let minio: MinioMock;
  let cache: CacheMock;
  let kafka: KafkaMock;
  let telemetry: TelemetryMock;
  let metrics: MetricsMock;

  const updateData = (index: number): Record<string, unknown> => {
    const call = prisma.replicationStatus.update.mock.calls[
      index
    ] as unknown as [{ data: Record<string, unknown> }];
    return call[0].data;
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    prisma = {
      replicationStatus: { update: jest.fn().mockResolvedValue({}) },
      fileVersion: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    minio = {
      getObjectStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('hello world')])),
    };
    cache = { cacheFile: jest.fn().mockResolvedValue(undefined) };
    kafka = {
      emitReplicationStatusChanged: jest.fn(),
      emitReplicationDLQ: jest.fn(),
    };
    telemetry = { broadcastDLQAlert: jest.fn() };
    metrics = {
      dlqEventsTotal: { inc: jest.fn() },
      dlqActiveItems: { inc: jest.fn() },
    };

    processor = new ReplicationProcessor(
      prisma as unknown as PrismaService,
      minio as unknown as MinioService,
      cache as unknown as CacheManagerService,
      kafka as unknown as KafkaService,
      telemetry as unknown as TelemetryGateway,
      metrics as unknown as MetricsService,
    );
  });

  it('replicates a numeric version into the edge cache', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(makeVersion());

    await processor.process(makeJob());

    expect(prisma.fileVersion.findFirst).toHaveBeenCalledWith({
      where: { fileId: 'file-1', versionNumber: 2 },
      include: { file: true },
    });
    expect(minio.getObjectStream).toHaveBeenCalledWith(
      'files/file-1/v2/video.mp4',
    );
    expect(cache.cacheFile).toHaveBeenCalledWith(
      'file-1',
      'version-2',
      {
        ownerId: 'user-1',
        contentType: 'video/mp4',
        size: 11,
        checksum: 'checksum-2',
        etag: '"checksum-2"',
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: undefined,
      },
      Buffer.from('hello world'),
    );
    expect(prisma.replicationStatus.update).toHaveBeenCalledTimes(2);
    expect(prisma.replicationStatus.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          fileId_edgeNodeId: {
            fileId: 'file-1',
            edgeNodeId: 'edge-node-01',
          },
        },
      }),
    );
    expect(updateData(0)).toEqual(
      expect.objectContaining({
        status: ReplicationJobStatus.IN_PROGRESS,
        attempts: 1,
      }),
    );
    expect(updateData(1)).toEqual(
      expect.objectContaining({
        status: ReplicationJobStatus.COMPLETE,
        lastError: null,
        isDeadLetter: false,
      }),
    );
    expect(kafka.emitReplicationStatusChanged).toHaveBeenCalledWith(
      'file-1',
      'edge-node-01',
      'complete',
      1,
    );
  });

  it('looks up non-numeric version ids as UUIDs', async () => {
    prisma.fileVersion.findUnique.mockResolvedValue(makeVersion());

    await processor.process(
      makeJob({
        data: {
          fileId: 'file-1',
          versionId: 'uuid-version-1',
          edgeNodeId: 'edge-node-01',
          storagePath: 'files/file-1/v2/video.mp4',
        },
      }),
    );

    expect(prisma.fileVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'uuid-version-1' },
      include: { file: true },
    });
  });

  it('bypasses the RAM cache for objects above 20 MB', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(
      makeVersion({ size: BigInt(21 * 1024 * 1024) }),
    );

    await processor.process(makeJob());

    expect(minio.getObjectStream).not.toHaveBeenCalled();
    expect(cache.cacheFile).not.toHaveBeenCalled();
    expect(updateData(1)).toEqual(
      expect.objectContaining({
        status: ReplicationJobStatus.COMPLETE,
        lastError: 'Bypassed: Exceeds RAM Limit',
        isDeadLetter: false,
      }),
    );
  });

  it('records a retryable failure on a non-final attempt', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(null);

    await expect(processor.process(makeJob())).rejects.toThrow(
      'Version 2 not found for file file-1',
    );

    expect(updateData(1)).toEqual(
      expect.objectContaining({
        status: ReplicationJobStatus.IN_PROGRESS,
        lastError: 'Version 2 not found for file file-1',
        isDeadLetter: false,
      }),
    );
    expect(kafka.emitReplicationDLQ).not.toHaveBeenCalled();
    expect(telemetry.broadcastDLQAlert).not.toHaveBeenCalled();
  });

  it('moves a final failure to the DLQ and alerts admins', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(null);

    await expect(
      processor.process(makeJob({ attemptsMade: 2 })),
    ).rejects.toThrow('Version 2 not found for file file-1');

    expect(updateData(1)).toEqual(
      expect.objectContaining({
        status: ReplicationJobStatus.FAILED,
        isDeadLetter: true,
      }),
    );
    expect(kafka.emitReplicationDLQ).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        versionId: '2',
        edgeNodeId: 'edge-node-01',
        attempts: 3,
        maxAttempts: 3,
      }),
    );
    expect(kafka.emitReplicationStatusChanged).toHaveBeenCalledWith(
      'file-1',
      'edge-node-01',
      'failed',
      3,
    );
    expect(telemetry.broadcastDLQAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        attempts: 3,
      }),
    );
    expect(metrics.dlqEventsTotal.inc).toHaveBeenCalledWith({
      topic: 'file.uploaded.dlq',
      edge_id: 'edge-node-01',
      action: 'queued',
    });
    expect(metrics.dlqActiveItems.inc).toHaveBeenCalled();
  });

  it('handles a stream error on the final attempt', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(makeVersion());
    minio.getObjectStream.mockResolvedValue(
      new Readable({
        read() {
          this.destroy(new Error('stream failed'));
        },
      }),
    );

    await expect(
      processor.process(makeJob({ attemptsMade: 2 })),
    ).rejects.toThrow('stream failed');

    expect(cache.cacheFile).not.toHaveBeenCalled();
    expect(kafka.emitReplicationDLQ).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'stream failed' }),
    );
  });

  it('handles a cache write failure on the final attempt', async () => {
    prisma.fileVersion.findFirst.mockResolvedValue(makeVersion());
    cache.cacheFile.mockRejectedValue(new Error('cache write failed'));

    await expect(
      processor.process(makeJob({ attemptsMade: 2 })),
    ).rejects.toThrow('cache write failed');

    expect(kafka.emitReplicationDLQ).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'cache write failed' }),
    );
  });
});
