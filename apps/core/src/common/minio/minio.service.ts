import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private s3Client: S3Client;
  private bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const endpoint = this.configService.get<string>(
      'MINIO_ENDPOINT',
      'localhost',
    );
    const port = this.configService.get<string>('MINIO_PORT', '9000');
    const useSsl =
      this.configService.get<string>('MINIO_USE_SSL', 'false') === 'true';
    const accessKey = this.configService.get<string>(
      'MINIO_ACCESS_KEY',
      'admin_minio',
    );
    const secretKey = this.configService.get<string>(
      'MINIO_SECRET_KEY',
      'minio_password',
    );

    const protocol = useSsl ? 'https' : 'http';
    const endpointUrl = `${protocol}://${endpoint}:${port}`;

    this.bucketName = this.configService.get<string>(
      'MINIO_BUCKET_NAME',
      'pravah-origin',
    );

    this.s3Client = new S3Client({
      endpoint: endpointUrl,
      region: 'us-east-1', // Default dummy region for MinIO
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true, // Mandatory for MinIO
    });
  }

  async onModuleInit() {
    await this.ensureBucketExists();
  }

  /**
   * Ensures the configured bucket exists in MinIO upon module startup.
   */
  private async ensureBucketExists(): Promise<void> {
    try {
      await this.s3Client.send(
        new HeadBucketCommand({ Bucket: this.bucketName }),
      );
      this.logger.log(`MinIO bucket "${this.bucketName}" is ready.`);
    } catch {
      this.logger.warn(
        `MinIO bucket "${this.bucketName}" not found. Creating bucket...`,
      );
      try {
        await this.s3Client.send(
          new CreateBucketCommand({ Bucket: this.bucketName }),
        );
        this.logger.log(
          `MinIO bucket "${this.bucketName}" created successfully.`,
        );
      } catch (createErr) {
        this.logger.error(
          `Failed to create MinIO bucket "${this.bucketName}":`,
          createErr,
        );
      }
    }
  }

  /**
   * Uploads a single buffer chunk to MinIO.
   */
  async uploadChunk(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<string> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /**
   * Assembles multiple chunk objects into a single file directly on MinIO server using Multipart Upload & Part Copy.
   */
  async assembleChunks(
    chunkKeys: string[],
    destinationKey: string,
    contentType?: string,
  ): Promise<string> {
    // 1. Initiate Multipart Upload for destination object
    const initRes = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: destinationKey,
        ContentType: contentType,
      }),
    );

    const uploadId = initRes.UploadId;
    if (!uploadId) {
      throw new Error('Failed to initiate Multipart Upload in MinIO.');
    }

    const completedParts: { ETag: string; PartNumber: number }[] = [];

    try {
      // 2. Copy each chunk into the multipart upload
      for (let i = 0; i < chunkKeys.length; i++) {
        const partNumber = i + 1;
        const sourceKey = chunkKeys[i];

        const copyRes = await this.s3Client.send(
          new UploadPartCopyCommand({
            Bucket: this.bucketName,
            Key: destinationKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource: `${this.bucketName}/${sourceKey}`,
          }),
        );

        if (!copyRes.CopyPartResult?.ETag) {
          throw new Error(
            `Failed to copy part ${partNumber} from source key ${sourceKey}`,
          );
        }

        completedParts.push({
          ETag: copyRes.CopyPartResult.ETag,
          PartNumber: partNumber,
        });
      }

      // 3. Complete Multipart Upload
      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: destinationKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: completedParts,
          },
        }),
      );

      this.logger.log(
        `Assembled ${chunkKeys.length} chunks into "${destinationKey}" via S3 Multipart Upload.`,
      );
      return destinationKey;
    } catch (err: unknown) {
      const errorObj = err as { Code?: string; name?: string };
      if (
        errorObj?.Code === 'EntityTooSmall' ||
        errorObj?.name === 'EntityTooSmall'
      ) {
        this.logger.warn(
          `Chunk size is below S3 5MB limit. Falling back to stream assembly for "${destinationKey}"...`,
        );
        return this.assembleChunksInMemory(chunkKeys, destinationKey, contentType);
      }
      this.logger.error(
        `Error assembling chunks for "${destinationKey}":`,
        err,
      );
      throw err;
    }
  }

  /**
   * Fallback assembly for small test files (< 5MB per chunk) where S3 Multipart Upload is rejected.
   */
  private async assembleChunksInMemory(
    chunkKeys: string[],
    destinationKey: string,
    contentType?: string,
  ): Promise<string> {
    const buffers: Buffer[] = [];

    for (const key of chunkKeys) {
      const stream = await this.getObjectStream(key);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Uint8Array);
      }
      buffers.push(Buffer.concat(chunks));
    }

    const finalBuffer = Buffer.concat(buffers);
    await this.uploadChunk(destinationKey, finalBuffer, contentType);

    this.logger.log(
      `Assembled ${chunkKeys.length} small chunks into "${destinationKey}" via stream concatenation.`,
    );
    return destinationKey;
  }

  /**
   * Deletes multiple objects (e.g. temporary chunks) from MinIO.
   */
  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys || keys.length === 0) return;

    await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: {
          Objects: keys.map((key) => ({ Key: key })),
        },
      }),
    );
  }

  /**
   * Retrieves an object stream from MinIO (for downloading/processing).
   */
  async getObjectStream(key: string): Promise<Readable> {
    const res = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return res.Body as Readable;
  }

  /**
   * Gets object metadata (size, content-type) from MinIO without downloading the file.
   */
  async getObjectMetadata(
    key: string,
  ): Promise<{ contentLength: number; contentType: string }> {
    const res = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  }

  /**
   * Generates a pre-signed URL for direct download from MinIO.
   * The URL is time-limited and self-authenticating — no JWT needed to use it.
   */
  async generateSignedUrl(
    key: string,
    expiresInSeconds = 900,
    forceDownloadFileName?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ResponseContentDisposition: forceDownloadFileName
        ? `attachment; filename="${forceDownloadFileName}"`
        : undefined,
    });

    // Cast needed due to AWS SDK internal version mismatch between client-s3 and s3-request-presigner
    const client = this.s3Client as unknown as Parameters<typeof getSignedUrl>[0];

    return getSignedUrl(client, command, {
      expiresIn: expiresInSeconds,
    });
  }

  /**
   * Retrieves a partial object stream from MinIO using an HTTP Range header.
   * Used for video seeking / scrubbing (HTTP 206 Partial Content).
   */
  async getObjectStreamWithRange(
    key: string,
    range: string,
  ): Promise<{ stream: Readable; contentLength: number; contentRange: string }> {
    const res = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Range: range,
      }),
    );

    return {
      stream: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentRange: res.ContentRange ?? '',
    };
  }

  getBucketName(): string {
    return this.bucketName;
  }
}
