import { Queue } from 'bullmq';
import { ReplicationJobStatus } from '@prisma/client';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';
import { ReplicationService } from './replication.service';

type QueueMock = {
  add: jest.Mock<Promise<unknown>, [string, unknown, Record<string, unknown>]>;
};

type PrismaMock = {
  replicationStatus: {
    count: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    upsert: jest.Mock;
  };
  fileVersion: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
  };
};

type HealthCheckMock = {
  getHealthyNodes: jest.Mock;
};

type MetricsMock = {
  dlqActiveItems: { set: jest.Mock; inc: jest.Mock };
  dlqEventsTotal: { inc: jest.Mock };
};

const edgeNode = (id: string, name: string, region: string) => ({
  id,
  name,
  region,
  endpointUrl: `http://localhost/${id}`,
  latitude: 0,
  longitude: 0,
  status: 'HEALTHY' as const,
  missedCycles: 0,
});

describe('ReplicationService', () => {
  let service: ReplicationService;
  let queue: QueueMock;
  let prisma: PrismaMock;
  let healthCheck: HealthCheckMock;
  let metrics: MetricsMock;

  beforeEach(() => {
    queue = {
      add: jest
        .fn<Promise<unknown>, [string, unknown, Record<string, unknown>]>()
        .mockResolvedValue({}),
    };
    prisma = {
      replicationStatus: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      fileVersion: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    healthCheck = { getHealthyNodes: jest.fn().mockReturnValue([]) };
    metrics = {
      dlqActiveItems: { set: jest.fn(), inc: jest.fn() },
      dlqEventsTotal: { inc: jest.fn() },
    };

    service = new ReplicationService(
      queue as unknown as Queue,
      prisma as unknown as PrismaService,
      healthCheck as unknown as HealthCheckService,
      metrics as unknown as MetricsService,
      { broadcastDLQAlert: jest.fn() } as unknown as TelemetryGateway,
    );
  });

  describe('syncDlqGauge', () => {
    it('sets the dead-letter gauge from the database count', async () => {
      prisma.replicationStatus.count.mockResolvedValue(7);

      await service.syncDlqGauge();

      expect(metrics.dlqActiveItems.set).toHaveBeenCalledWith(7);
    });

    it('swallows database errors', async () => {
      prisma.replicationStatus.count.mockRejectedValue(new Error('db down'));

      await expect(service.syncDlqGauge()).resolves.toBeUndefined();
      expect(metrics.dlqActiveItems.set).not.toHaveBeenCalled();
    });

    it('syncs the gauge on module init', async () => {
      prisma.replicationStatus.count.mockResolvedValue(2);

      await service.onModuleInit();

      expect(metrics.dlqActiveItems.set).toHaveBeenCalledWith(2);
    });
  });

  describe('dispatchReplication', () => {
    it('does nothing when no edge is healthy', async () => {
      await service.dispatchReplication(
        'file-1',
        'version-1',
        'files/file-1/v1/video.mp4',
      );

      expect(prisma.replicationStatus.upsert).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('upserts status and queues edge and central replication jobs', async () => {
      healthCheck.getHealthyNodes.mockReturnValue([
        edgeNode('edge-node-01', 'Mumbai Edge', 'ap-south-1'),
        edgeNode('edge-node-02', 'Virginia Edge', 'us-east-1'),
      ]);
      prisma.fileVersion.findUnique.mockResolvedValue({ versionNumber: 2 });

      await service.dispatchReplication(
        'file-1',
        'version-1',
        'files/file-1/v2/video.mp4',
      );

      expect(prisma.fileVersion.findUnique).toHaveBeenCalledWith({
        where: { id: 'version-1' },
        select: { versionNumber: true },
      });
      expect(prisma.replicationStatus.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.replicationStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            fileId_edgeNodeId: {
              fileId: 'file-1',
              edgeNodeId: 'edge-node-01',
            },
          },
          create: {
            fileId: 'file-1',
            edgeNodeId: 'edge-node-01',
            status: ReplicationJobStatus.PENDING,
          },
        }),
      );
      expect(queue.add).toHaveBeenCalledTimes(4);
      expect(queue.add).toHaveBeenCalledWith(
        'replicate-file',
        expect.objectContaining({
          fileId: 'file-1',
          versionId: '2',
          edgeNodeId: 'edge-node-01',
          storagePath: 'files/file-1/v2/video.mp4',
        }),
        expect.objectContaining({ attempts: 3, priority: 5 }),
      );
    });

    it('falls back to version 1 when the version row is missing', async () => {
      healthCheck.getHealthyNodes.mockReturnValue([
        edgeNode('edge-node-01', 'Mumbai Edge', 'ap-south-1'),
      ]);
      prisma.fileVersion.findUnique.mockResolvedValue(null);

      await service.dispatchReplication('file-1', 'missing', 'files/file-1');

      expect(queue.add).toHaveBeenCalledWith(
        'replicate-file',
        expect.objectContaining({ versionId: '1' }),
        expect.any(Object),
      );
    });

    it('continues to the central queue when an edge queue enqueue fails', async () => {
      healthCheck.getHealthyNodes.mockReturnValue([
        edgeNode('edge-node-01', 'Mumbai Edge', 'ap-south-1'),
      ]);
      prisma.fileVersion.findUnique.mockResolvedValue({ versionNumber: 1 });
      queue.add
        .mockRejectedValueOnce(new Error('redis edge queue down'))
        .mockResolvedValueOnce({});

      await expect(
        service.dispatchReplication('file-1', 'version-1', 'files/file-1'),
      ).resolves.toBeUndefined();
      expect(queue.add).toHaveBeenCalledTimes(2);
    });
  });

  it('reads replication status with the edge relation', async () => {
    prisma.replicationStatus.findMany.mockResolvedValue([]);

    await service.getReplicationStatus('file-1');

    expect(prisma.replicationStatus.findMany).toHaveBeenCalledWith({
      where: { fileId: 'file-1' },
      include: { edgeNode: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('reads failed jobs and DLQ events with safe fields', async () => {
    prisma.replicationStatus.findMany.mockResolvedValue([]);

    await service.getFailedJobs();
    await service.getDLQEvents();

    expect(prisma.replicationStatus.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { status: ReplicationJobStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    expect(prisma.replicationStatus.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          OR: [{ isDeadLetter: true }, { status: ReplicationJobStatus.FAILED }],
        },
      }),
    );
  });

  it('reads a single DLQ event', async () => {
    prisma.replicationStatus.findUnique.mockResolvedValue(null);

    await service.getDLQEventById('replication-1');

    expect(prisma.replicationStatus.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'replication-1' } }),
    );
  });

  describe('replayDLQEvent', () => {
    const record = {
      id: 'replication-1',
      fileId: 'file-1',
      edgeNodeId: 'edge-node-01',
      edgeNode: { name: 'Mumbai Edge' },
      file: { id: 'file-1' },
    };
    const version = {
      id: 'version-2',
      versionNumber: 2,
      storagePath: 'files/file-1/v2/video.mp4',
    };

    it('replays a DLQ record and requeues the latest version', async () => {
      prisma.replicationStatus.findUnique.mockResolvedValue(record);
      prisma.fileVersion.findFirst.mockResolvedValue(version);

      const result = await service.replayDLQEvent('replication-1');

      expect(prisma.replicationStatus.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'replication-1' } }),
      );
      const updateCall = prisma.replicationStatus.update.mock
        .calls[0] as unknown as [
        { data: Record<string, unknown> & { replayedAt?: Date } },
      ];
      expect(updateCall[0].data).toEqual(
        expect.objectContaining({
          status: ReplicationJobStatus.PENDING,
          attempts: 0,
          isDeadLetter: false,
          lastError: null,
        }),
      );
      expect(updateCall[0].data.replayedAt).toBeInstanceOf(Date);
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        'replicate-file',
        expect.objectContaining({
          fileId: 'file-1',
          versionId: 'version-2',
          edgeNodeId: 'edge-node-01',
          storagePath: 'files/file-1/v2/video.mp4',
        }),
        expect.any(Object),
      );
      expect(metrics.dlqEventsTotal.inc).toHaveBeenCalledWith({
        topic: 'file.uploaded.dlq',
        edge_id: 'edge-node-01',
        action: 'replayed',
      });
      expect(metrics.dlqActiveItems.set).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message: 'Replication job for file file-1 replayed to Mumbai Edge',
        replicationId: 'replication-1',
      });
    });

    it('throws when the record or latest version is missing', async () => {
      prisma.replicationStatus.findUnique.mockResolvedValueOnce(null);
      await expect(service.replayDLQEvent('missing')).rejects.toThrow(
        'DLQ record missing not found',
      );

      prisma.replicationStatus.findUnique.mockResolvedValueOnce(record);
      prisma.fileVersion.findFirst.mockResolvedValueOnce(null);
      await expect(service.replayDLQEvent('replication-1')).rejects.toThrow(
        'No file version found for file file-1',
      );
    });

    it('still queues centrally when the edge queue fails', async () => {
      prisma.replicationStatus.findUnique.mockResolvedValue(record);
      prisma.fileVersion.findFirst.mockResolvedValue(version);
      queue.add
        .mockRejectedValueOnce(new Error('edge queue down'))
        .mockResolvedValueOnce({});

      await expect(service.replayDLQEvent('replication-1')).resolves.toEqual(
        expect.objectContaining({ success: true }),
      );
      expect(queue.add).toHaveBeenCalledTimes(2);
    });
  });

  it('replays all DLQ events and reports only successful ids', async () => {
    jest
      .spyOn(service, 'getDLQEvents')
      .mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never);
    jest
      .spyOn(service, 'replayDLQEvent')
      .mockResolvedValueOnce({
        success: true,
        message: 'ok',
        replicationId: 'a',
      })
      .mockRejectedValueOnce(new Error('still broken'));

    const result = await service.replayAllDLQEvents();

    expect(result).toEqual({ replayedCount: 1, replayedIds: ['a'] });
  });

  it('purges a DLQ record', async () => {
    prisma.replicationStatus.findUnique.mockResolvedValue({ id: 'a' });

    const result = await service.purgeDLQEvent('a');

    expect(prisma.replicationStatus.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: {
        isDeadLetter: false,
        deadLetterReason: 'Purged by Admin',
      },
    });
    expect(result).toEqual({
      success: true,
      message: 'DLQ record a purged successfully',
    });
  });

  it('throws when purging an unknown DLQ record', async () => {
    prisma.replicationStatus.findUnique.mockResolvedValue(null);

    await expect(service.purgeDLQEvent('missing')).rejects.toThrow(
      'DLQ record missing not found',
    );
  });

  it('delegates retryFailedJob to replayDLQEvent', async () => {
    const replaySpy = jest.spyOn(service, 'replayDLQEvent').mockResolvedValue({
      success: true,
      message: 'ok',
      replicationId: 'a',
    });

    await service.retryFailedJob('a');

    expect(replaySpy).toHaveBeenCalledWith('a');
  });
});
