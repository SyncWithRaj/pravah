import { Test, TestingModule } from '@nestjs/testing';
import { TranscodingProcessor } from './transcoding.processor';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/minio/minio.service';
import { KafkaService } from '../common/kafka/kafka.service';
import { Job } from 'bullmq';
import { TranscodingJobData } from './transcoding.interfaces';
import { Readable } from 'stream';
import * as fs from 'fs';

describe('TranscodingProcessor', () => {
  let processor: TranscodingProcessor;
  let mockPrisma: {
    videoTranscode: {
      upsert: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let mockMinio: {
    getObjectStream: jest.Mock;
    uploadChunk: jest.Mock;
  };
  let mockKafka: {
    emitVideoTranscoded: jest.Mock;
  };

  beforeEach(async () => {
    mockPrisma = {
      videoTranscode: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockMinio = {
      getObjectStream: jest
        .fn()
        .mockResolvedValue(Readable.from(Buffer.from('fake-video-bytes'))),
      uploadChunk: jest.fn().mockResolvedValue({}),
    };

    mockKafka = {
      emitVideoTranscoded: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscodingProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MinioService, useValue: mockMinio },
        { provide: KafkaService, useValue: mockKafka },
      ],
    }).compile();

    processor = module.get<TranscodingProcessor>(TranscodingProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should probe 720p video, transcode into 5 profiles (no 1080p upscaling), and upload HLS files', async () => {
    // Mock runCommand on processor
    const runCommandSpy = jest
      .spyOn(
        processor as unknown as {
          runCommand: (cmd: string, args: string[]) => Promise<string>;
        },
        'runCommand',
      )
      .mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'ffprobe') {
          return Promise.resolve(
            JSON.stringify({
              streams: [{ width: 1280, height: 720, duration: '10.5' }],
            }),
          );
        }
        if (cmd === 'ffmpeg') {
          // Simulate ffmpeg creating index.m3u8 and segment-000.ts in the profile dir
          const outputM3u8 = args[args.length - 1];
          const dir = outputM3u8.substring(0, outputM3u8.lastIndexOf('/'));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            outputM3u8,
            '#EXTM3U\n#EXTINF:4.0,\nsegment-000.ts\n#EXT-X-ENDLIST',
          );
          fs.writeFileSync(`${dir}/segment-000.ts`, Buffer.from('ts-data'));
          return Promise.resolve('');
        }
        return Promise.resolve('');
      });

    const job = {
      id: 'job-1',
      data: {
        fileId: 'file-100',
        versionId: 'ver-1',
        ownerId: 'user-1',
        rawStoragePath: 'files/user-1/file-100/v1/input.mp4',
        contentType: 'video/mp4',
        sizeBytes: 5000000,
      },
    } as Job<TranscodingJobData>;

    await processor.process(job);

    // Verify ffprobe was called
    expect(runCommandSpy).toHaveBeenCalledWith('ffprobe', expect.any(Array));

    // Verify 5 ffmpeg calls for 720p, 480p, 360p, 240p, 144p (NO 1080p)
    const ffmpegCalls = runCommandSpy.mock.calls.filter(
      (c) => c[0] === 'ffmpeg',
    );
    expect(ffmpegCalls.length).toBe(5);

    // Verify Prisma upsert called 5 times
    expect(mockPrisma.videoTranscode.upsert).toHaveBeenCalledTimes(5);

    // Verify master.m3u8 and segment chunks uploaded to MinIO
    expect(mockMinio.uploadChunk).toHaveBeenCalledWith(
      'hls/user-1/file-100/ver-1/master.m3u8',
      expect.any(Buffer),
    );

    // Verify Kafka event emitted
    expect(mockKafka.emitVideoTranscoded).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-100',
        versionId: 'ver-1',
        masterManifestPath: 'hls/user-1/file-100/ver-1/master.m3u8',
        resolutions: ['720p', '480p', '360p', '240p', '144p'],
        totalSegments: 5,
        durationSeconds: 10.5,
      }),
    );
  });
});
