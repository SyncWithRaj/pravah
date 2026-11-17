import { HttpService } from '@nestjs/axios';
import { Job } from 'bullmq';
import { of } from 'rxjs';
import { Readable } from 'stream';
import { EdgeCacheService } from '../cache/cache.service';
import { KafkaService } from '../kafka/kafka.service';
import { MinioService } from '../minio/minio.service';
import { ReplicationProcessor } from './replication.processor';

type HttpMock = { get: jest.Mock };
type MinioMock = { getObjectStream: jest.Mock };
type CacheMock = { cacheFile: jest.Mock };
type KafkaMock = { emitReplicationStatusChanged: jest.Mock };

type JobData = {
  fileId: string;
  versionId: string;
  edgeNodeId: string;
  storagePath: string;
};

const makeJob = (
  overrides: Partial<Job<JobData>> = {},
): Job<JobData> =>
  ({
    data: {
      fileId: 'file-1',
      versionId: 'version-2',
      edgeNodeId: 'edge-node-01',
      storagePath: 'files/file-1/v2/video.mp4',
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  }) as unknown as Job<JobData>;

const metadata = {
  ownerId: 'user-1',
  mimeType: 'video/mp4',
  currentVersion: { checksum: 'checksum-2', versionNumber: 2 },
};

describe('Edge ReplicationProcessor', () => {
  let processor: ReplicationProcessor;
  let http: HttpMock;
  let minio: MinioMock;
  let cache: CacheMock;
  let kafka: KafkaMock;

  const previousNodeId = process.env.EDGE_NODE_ID;

  beforeEach(() => {
    process.env.EDGE_NODE_ID = 'edge-node-01';
    http = {
      get: jest.fn().mockReturnValue(of({ data: metadata })),
    };
    minio = {
      getObjectStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('hello world')])),
    };
    cache = { cacheFile: jest.fn().mockResolvedValue(undefined) };
    kafka = { emitReplicationStatusChanged: jest.fn() };

    processor = new ReplicationProcessor(
      minio as unknown as MinioService,
      cache as unknown as EdgeCacheService,
      kafka as unknown as KafkaService,
      http as unknown as HttpService,
    );
  });

  afterAll(() => {
    if (previousNodeId === undefined) {
      delete process.env.EDGE_NODE_ID;
    } else {
      process.env.EDGE_NODE_ID = previousNodeId;
    }
  });

  it('replicates a file into the edge cache', async () => {
    await processor.process(makeJob());

    expect(http.get).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/internal/metadata/files/file-1',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-service-id': 'edge-node-01' }),
      }),
    );
    expect(minio.getObjectStream).toHaveBeenCalledWith(
      'files/file-1/v2/video.mp4',
    );
    expect(cache.cacheFile).toHaveBeenCalledWith(
      'file-1',
      '2',
      {
        ownerId: 'user-1',
        contentType: 'video/mp4',
        size: 11,
        checksum: 'checksum-2',
        etag: '"checksum-2"',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      Buffer.from('hello world'),
    );
    expect(kafka.emitReplicationStatusChanged).toHaveBeenNthCalledWith(
      1,
      'file-1',
      'edge-node-01',
      'in_progress',
      1,
    );
    expect(kafka.emitReplicationStatusChanged).toHaveBeenNthCalledWith(
      2,
      'file-1',
      'edge-node-01',
      'complete',
      1,
    );
  });

  it('falls back to safe metadata when the core lookup fails', async () => {
    http.get.mockImplementation(() => {
      throw new Error('core down');
    });

    await processor.process(makeJob());

    expect(cache.cacheFile).toHaveBeenCalledWith(
      'file-1',
      '1',
      expect.objectContaining({
        ownerId: 'unknown',
        contentType: 'application/octet-stream',
        checksum: '',
      }),
      Buffer.from('hello world'),
    );
  });

  it('skips caching files above the 20 MB RAM limit', async () => {
    minio.getObjectStream.mockResolvedValue(
      Readable.from([Buffer.alloc(21 * 1024 * 1024)]),
    );

    await processor.process(makeJob());

    expect(cache.cacheFile).not.toHaveBeenCalled();
    expect(kafka.emitReplicationStatusChanged).toHaveBeenLastCalledWith(
      'file-1',
      'edge-node-01',
      'complete',
      1,
    );
  });

  it('reports a failed status on the final attempt', async () => {
    minio.getObjectStream.mockRejectedValue(new Error('minio down'));

    await expect(
      processor.process(makeJob({ attemptsMade: 2 })),
    ).rejects.toThrow('minio down');
    expect(kafka.emitReplicationStatusChanged).toHaveBeenLastCalledWith(
      'file-1',
      'edge-node-01',
      'failed',
      3,
    );
  });

  it('does not report a final failure on a retryable attempt', async () => {
    minio.getObjectStream.mockRejectedValue(new Error('minio down'));

    await expect(processor.process(makeJob())).rejects.toThrow('minio down');
    expect(kafka.emitReplicationStatusChanged).toHaveBeenCalledTimes(1);
    expect(kafka.emitReplicationStatusChanged).toHaveBeenCalledWith(
      'file-1',
      'edge-node-01',
      'in_progress',
      1,
    );
  });
});
