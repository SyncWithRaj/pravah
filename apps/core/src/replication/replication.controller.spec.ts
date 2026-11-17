import { ReplicationJobStatus } from '@prisma/client';
import { ReplicationController } from './replication.controller';
import { ReplicationService } from './replication.service';

type ReplicationMock = {
  dispatchReplication: jest.Mock;
  handleEdgeCrashFailover: jest.Mock;
  getReplicationStatus: jest.Mock;
  getFailedJobs: jest.Mock;
  retryFailedJob: jest.Mock;
};

describe('ReplicationController', () => {
  let controller: ReplicationController;
  let service: ReplicationMock;

  beforeEach(() => {
    service = {
      dispatchReplication: jest.fn().mockResolvedValue(undefined),
      handleEdgeCrashFailover: jest
        .fn()
        .mockResolvedValue({ repairedFilesCount: 0, dispatchedJobsCount: 0 }),
      getReplicationStatus: jest.fn().mockResolvedValue([]),
      getFailedJobs: jest.fn().mockResolvedValue([]),
      retryFailedJob: jest.fn().mockResolvedValue(undefined),
    };
    controller = new ReplicationController(
      service as unknown as ReplicationService,
    );
  });

  it('dispatches a valid file.uploaded event', async () => {
    await controller.handleFileUploaded({
      fileId: 'file-1',
      versionId: 'version-1',
      objectKey: 'files/file-1/v1/video.mp4',
    });

    expect(service.dispatchReplication).toHaveBeenCalledWith(
      'file-1',
      'version-1',
      'files/file-1/v1/video.mp4',
    );
  });

  it('dispatches a Kafka envelope for file.version_created', async () => {
    await controller.handleFileVersionCreated({
      value: {
        fileId: 'file-1',
        versionId: 'version-2',
        objectKey: 'files/file-1/v2/video.mp4',
      },
    });

    expect(service.dispatchReplication).toHaveBeenCalledWith(
      'file-1',
      'version-2',
      'files/file-1/v2/video.mp4',
    );
  });

  it('does not dispatch incomplete file events', async () => {
    await controller.handleFileUploaded({ fileId: 'file-1' });
    await controller.handleFileUploaded({ value: { versionId: 'v1' } });
    await controller.handleFileUploaded('not-an-object');

    expect(service.dispatchReplication).not.toHaveBeenCalled();
  });

  it('triggers failover only for DOWN edge events', async () => {
    await controller.handleEdgeHealthChanged({
      edgeId: 'edge-node-01',
      newStatus: 'DOWN',
    });
    await controller.handleEdgeHealthChanged({
      value: { edgeId: 'edge-node-02', newStatus: 'HEALTHY' },
    });
    await controller.handleEdgeHealthChanged({ edgeId: 'edge-node-03' });

    expect(service.handleEdgeCrashFailover).toHaveBeenCalledTimes(1);
    expect(service.handleEdgeCrashFailover).toHaveBeenCalledWith(
      'edge-node-01',
    );
  });

  it('summarises replication status counts', async () => {
    service.getReplicationStatus.mockResolvedValue([
      { status: ReplicationJobStatus.COMPLETE },
      { status: ReplicationJobStatus.COMPLETE },
      { status: ReplicationJobStatus.FAILED },
      { status: ReplicationJobStatus.PENDING },
      { status: ReplicationJobStatus.IN_PROGRESS },
    ]);

    const result = await controller.getStatus('file-1');

    expect(result).toMatchObject({
      fileId: 'file-1',
      totalJobs: 5,
      completed: 2,
      failed: 1,
      pending: 1,
      inProgress: 1,
    });
    expect(result.jobs).toHaveLength(5);
  });

  it('lists failed jobs', async () => {
    service.getFailedJobs.mockResolvedValue([{ id: 'replication-1' }]);

    await expect(controller.getFailedJobs()).resolves.toEqual({
      total: 1,
      jobs: [{ id: 'replication-1' }],
    });
  });

  it('requires a replication id before retrying', async () => {
    await expect(controller.retryJob('')).resolves.toEqual({
      success: false,
      message: 'replicationId is required',
    });
    expect(service.retryFailedJob).not.toHaveBeenCalled();
  });

  it('reports success and failure from retries', async () => {
    await expect(controller.retryJob('replication-1')).resolves.toEqual({
      success: true,
      message: 'Job re-queued successfully',
    });

    service.retryFailedJob.mockRejectedValueOnce(new Error('dlq missing'));
    await expect(controller.retryJob('replication-2')).resolves.toEqual({
      success: false,
      message: 'dlq missing',
    });

    service.retryFailedJob.mockRejectedValueOnce('unknown');
    await expect(controller.retryJob('replication-3')).resolves.toEqual({
      success: false,
      message: 'Unknown error',
    });
  });

  it('triggers a manual failover', async () => {
    service.handleEdgeCrashFailover.mockResolvedValue({
      repairedFilesCount: 2,
      dispatchedJobsCount: 4,
    });

    await expect(controller.triggerFailover('edge-node-01')).resolves.toEqual({
      repairedFilesCount: 2,
      dispatchedJobsCount: 4,
    });
  });
});
