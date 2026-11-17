import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MinioService } from './minio.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest
    .fn()
    .mockImplementation(
      (options: { params: { Body: AsyncIterable<Uint8Array> } }) => ({
        done: jest.fn(async () => {
          let bytes = 0;
          for await (const chunk of options.params.Body) {
            bytes += chunk.length;
          }
          return { bytes };
        }),
      }),
    ),
}));

type S3ClientMock = {
  send: jest.Mock<Promise<unknown>, [unknown]>;
};

type ConfigMock = {
  get: jest.Mock;
};

type ServiceInternals = {
  s3Client: S3ClientMock;
  presignerClient: S3ClientMock;
  bucketName: string;
};

const getSignedUrlMock = getSignedUrl as unknown as jest.Mock<
  Promise<string>,
  [unknown, unknown, { expiresIn: number }]
>;

describe('MinioService', () => {
  let service: MinioService;
  let s3Client: S3ClientMock;
  let internals: ServiceInternals;

  beforeEach(() => {
    const config: ConfigMock = {
      get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
    };
    service = new MinioService(config as unknown as ConfigService);

    s3Client = { send: jest.fn<Promise<unknown>, [unknown]>() };
    internals = service as unknown as ServiceInternals;
    internals.s3Client = s3Client;
    internals.presignerClient = {
      send: jest.fn<Promise<unknown>, [unknown]>(),
    };
    internals.bucketName = 'pravah-origin';
    getSignedUrlMock.mockReset();
  });

  it('confirms an existing bucket on module init', async () => {
    s3Client.send.mockResolvedValue({});

    await service.onModuleInit();

    expect(s3Client.send).toHaveBeenCalledTimes(1);
    expect(s3Client.send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('creates the bucket when it does not exist', async () => {
    s3Client.send
      .mockRejectedValueOnce(new Error('NotFound'))
      .mockResolvedValueOnce({});

    await service.onModuleInit();

    expect(s3Client.send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('does not throw when bucket creation also fails', async () => {
    s3Client.send
      .mockRejectedValueOnce(new Error('NotFound'))
      .mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('uploads a chunk with the correct object metadata', async () => {
    s3Client.send.mockResolvedValue({});
    const buffer = Buffer.from('chunk-data');

    const key = await service.uploadChunk(
      'chunks/file-1/0',
      buffer,
      'text/plain',
    );

    expect(key).toBe('chunks/file-1/0');
    const command = s3Client.send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual(
      expect.objectContaining({
        Bucket: 'pravah-origin',
        Key: 'chunks/file-1/0',
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: 'text/plain',
      }),
    );
  });

  it('assembles chunks with a multipart copy and completion', async () => {
    s3Client.send
      .mockResolvedValueOnce({ UploadId: 'upload-1' })
      .mockResolvedValueOnce({ CopyPartResult: { ETag: 'etag-1' } })
      .mockResolvedValueOnce({ CopyPartResult: { ETag: 'etag-2' } })
      .mockResolvedValueOnce({});

    const destination = await service.assembleChunks(
      ['chunks/file-1/0', 'chunks/file-1/1'],
      'files/file-1/v1/video.mp4',
      'video/mp4',
    );

    expect(destination).toBe('files/file-1/v1/video.mp4');
    expect(s3Client.send).toHaveBeenCalledTimes(4);
    expect(s3Client.send.mock.calls[0][0]).toBeInstanceOf(
      CreateMultipartUploadCommand,
    );
    expect(s3Client.send.mock.calls[1][0]).toBeInstanceOf(
      UploadPartCopyCommand,
    );
    expect(s3Client.send.mock.calls[2][0]).toBeInstanceOf(
      UploadPartCopyCommand,
    );

    const complete = s3Client.send.mock
      .calls[3][0] as CompleteMultipartUploadCommand;
    expect(complete.input.MultipartUpload?.Parts).toEqual([
      { ETag: 'etag-1', PartNumber: 1 },
      { ETag: 'etag-2', PartNumber: 2 },
    ]);
  });

  it('rejects when multipart upload initialization has no upload id', async () => {
    s3Client.send.mockResolvedValueOnce({});

    await expect(
      service.assembleChunks(['chunk-1'], 'destination'),
    ).rejects.toThrow('Failed to initiate Multipart Upload');
  });

  it('falls back to streaming when S3 rejects small parts', async () => {
    s3Client.send
      .mockResolvedValueOnce({ UploadId: 'upload-1' })
      .mockRejectedValueOnce({ Code: 'EntityTooSmall' })
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('abc')]) })
      .mockResolvedValueOnce({});

    const destination = await service.assembleChunks(
      ['chunk-1'],
      'destination',
    );

    expect(destination).toBe('destination');
    expect(s3Client.send.mock.calls[2][0]).toBeInstanceOf(GetObjectCommand);
    expect(s3Client.send.mock.calls[3][0]).toBeInstanceOf(PutObjectCommand);
  });

  it('deletes objects and skips empty delete requests', async () => {
    s3Client.send.mockResolvedValue({});

    await service.deleteObjects([]);
    expect(s3Client.send).not.toHaveBeenCalled();

    await service.deleteObjects(['chunk-1', 'chunk-2']);
    const command = s3Client.send.mock.calls[0][0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input.Delete?.Objects).toEqual([
      { Key: 'chunk-1' },
      { Key: 'chunk-2' },
    ]);
  });

  it('returns object streams and metadata', async () => {
    const stream = Readable.from([Buffer.from('data')]);
    s3Client.send
      .mockResolvedValueOnce({ Body: stream })
      .mockResolvedValueOnce({
        ContentLength: 4,
        ContentType: 'text/plain',
        ETag: 'etag-1',
      });

    await expect(service.getObjectStream('object-key')).resolves.toBe(stream);
    await expect(service.getObjectMetadata('object-key')).resolves.toEqual({
      contentLength: 4,
      contentType: 'text/plain',
      etag: 'etag-1',
    });
  });

  it('applies metadata defaults when headers are absent', async () => {
    s3Client.send.mockResolvedValue({});

    await expect(service.getObjectMetadata('object-key')).resolves.toEqual({
      contentLength: 0,
      contentType: 'application/octet-stream',
      etag: undefined,
    });
  });

  it('creates a signed URL with an optional download disposition', async () => {
    getSignedUrlMock.mockResolvedValue('https://minio.example/signed');

    const url = await service.generateSignedUrl(
      'files/file-1/v1/report.pdf',
      300,
      'report.pdf',
    );

    expect(url).toBe('https://minio.example/signed');
    expect(getSignedUrlMock).toHaveBeenCalledWith(
      internals.presignerClient,
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
    const command = getSignedUrlMock.mock.calls[0][1] as GetObjectCommand;
    expect(command.input.ResponseContentDisposition).toContain(
      'attachment; filename="report.pdf"',
    );
  });

  it('returns a ranged object stream with range metadata', async () => {
    const stream = Readable.from([Buffer.from('data')]);
    s3Client.send.mockResolvedValue({
      Body: stream,
      ContentLength: 4,
      ContentRange: 'bytes 0-3/10',
    });

    await expect(
      service.getObjectStreamWithRange('object-key', 'bytes=0-3'),
    ).resolves.toEqual({
      stream,
      contentLength: 4,
      contentRange: 'bytes 0-3/10',
    });

    const command = s3Client.send.mock.calls[0][0] as GetObjectCommand;
    expect(command.input.Range).toBe('bytes=0-3');
  });

  it('exposes the configured bucket name', () => {
    expect(service.getBucketName()).toBe('pravah-origin');
  });

  it('assembles and gzip-compresses streamed chunks', async () => {
    s3Client.send.mockResolvedValue({
      Body: Readable.from([Buffer.from('hello world')]),
    });

    const result = await service.assembleAndCompressChunks(
      ['chunk-1'],
      'destination',
      'text/plain',
    );

    expect(result.destinationKey).toBe('destination');
    expect(result.compressedSize).toBeGreaterThan(0);
    expect(s3Client.send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });

  it('returns a ranged stream even when the origin omits optional headers', async () => {
    const stream = Readable.from([Buffer.from('data')]);
    s3Client.send.mockResolvedValue({ Body: stream });

    await expect(
      service.getObjectStreamWithRange('object-key', 'bytes=0-3'),
    ).resolves.toEqual({
      stream,
      contentLength: 0,
      contentRange: '',
    });
  });
});
