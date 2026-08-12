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
import * as zlib from 'zlib';
import { Upload } from '@aws-sdk/lib-storage';

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
      region: 'us-east-1', 
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true, 
    });
  }

  async onModuleInit() {
    await this.ensureBucketExists();
  }

  
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

  
  async assembleChunks(
    chunkKeys: string[],
    destinationKey: string,
    contentType?: string,
  ): Promise<string> {
    
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
        return this.assembleChunksInMemory(
          chunkKeys,
          destinationKey,
          contentType,
        );
      }
      this.logger.error(
        `Error assembling chunks for "${destinationKey}":`,
        err,
      );
      throw err;
    }
  }

  
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

  
  async assembleAndCompressChunks(
    chunkKeys: string[],
    destinationKey: string,
    contentType?: string,
  ): Promise<{ destinationKey: string; compressedSize: number }> {
    
    let currentChunkIndex = 0;
    let currentStream: Readable | null = null;

    
    const fetchChunkStream = (key: string) => this.getObjectStream(key);

    const chunkReadableStream = new Readable({
      read() {
        if (!currentStream) {
          if (currentChunkIndex >= chunkKeys.length) {
            this.push(null); 
            return;
          }
          fetchChunkStream(chunkKeys[currentChunkIndex])
            .then((stream) => {
              currentStream = stream;
              currentChunkIndex++;

              currentStream.on('data', (chunk: Buffer) => {
                const canContinue = this.push(chunk);
                if (!canContinue) {
                  currentStream?.pause();
                }
              });

              currentStream.on('end', () => {
                currentStream = null;
                
                this._read(0);
              });

              currentStream.on('error', (err: Error) => {
                this.destroy(err);
              });
            })
            .catch((err: Error) => {
              this.destroy(err);
            });
        } else {
          currentStream.resume();
        }
      },
    });

    
    const gzipStream = zlib.createGzip();
    const compressedStream = chunkReadableStream.pipe(gzipStream);

    
    let compressedSize = 0;
    compressedStream.on('data', (chunk: Buffer) => {
      compressedSize += chunk.length;
    });

    
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.bucketName,
        Key: destinationKey,
        Body: compressedStream,
        ContentType: contentType,
        ContentEncoding: 'gzip',
      },
    });

    await upload.done();

    this.logger.log(
      `Assembled and compressed ${chunkKeys.length} chunks into "${destinationKey}". Final size: ${compressedSize} bytes.`,
    );

    return { destinationKey, compressedSize };
  }

  
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

  
  async getObjectStream(key: string): Promise<Readable> {
    const res = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return res.Body as Readable;
  }

  
  async getObjectMetadata(
    key: string,
  ): Promise<{ contentLength: number; contentType: string; etag?: string }> {
    const res = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? 'application/octet-stream',
      etag: res.ETag,
    };
  }

  
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

    
    const client = this.s3Client as unknown as Parameters<
      typeof getSignedUrl
    >[0];

    return getSignedUrl(client, command, {
      expiresIn: expiresInSeconds,
    });
  }

  
  async getObjectStreamWithRange(
    key: string,
    range: string,
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange: string;
  }> {
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
