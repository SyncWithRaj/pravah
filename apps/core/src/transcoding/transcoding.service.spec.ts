import { Test, TestingModule } from '@nestjs/testing';
import { TranscodingService } from './transcoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bullmq';
import { TRANSCODE_QUEUE_NAME } from './transcoding.constants';
import { TranscodeQuality, TranscodeStatus } from '@prisma/client';

describe('TranscodingService', () => {
  let service: TranscodingService;
  let mockQueue: { add: jest.Mock };
  let mockPrisma: { videoTranscode: { findMany: jest.Mock } };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-123' }),
    };

    mockPrisma = {
      videoTranscode: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscodingService,
        {
          provide: getQueueToken(TRANSCODE_QUEUE_NAME),
          useValue: mockQueue,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<TranscodingService>(TranscodingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('queueTranscoding', () => {
    it('should queue a job when MIME type is video/mp4', async () => {
      await service.queueTranscoding(
        'file-1',
        'ver-1',
        'user-1',
        'files/user-1/file-1/v1/video.mp4',
        'video/mp4',
        10485760,
      );

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'transcode',
        {
          fileId: 'file-1',
          versionId: 'ver-1',
          ownerId: 'user-1',
          rawStoragePath: 'files/user-1/file-1/v1/video.mp4',
          contentType: 'video/mp4',
          sizeBytes: 10485760,
        },
        expect.objectContaining({
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    });

    it('should ignore non-video files (e.g. image/png)', async () => {
      await service.queueTranscoding(
        'file-2',
        'ver-1',
        'user-1',
        'files/user-1/file-2/v1/image.png',
        'image/png',
        2048576,
      );

      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getTranscodeStatus', () => {
    it('should query Prisma for video transcodes by fileId', async () => {
      const records = [
        {
          id: 't-1',
          fileId: 'file-1',
          versionId: 'ver-1',
          quality: TranscodeQuality.Q_720P,
          status: TranscodeStatus.COMPLETED,
        },
      ];
      mockPrisma.videoTranscode.findMany.mockResolvedValue(records);

      const result = await service.getTranscodeStatus('file-1');
      expect(result).toEqual(records);
      expect(mockPrisma.videoTranscode.findMany).toHaveBeenCalledWith({
        where: { fileId: 'file-1' },
        orderBy: [{ createdAt: 'desc' }, { quality: 'asc' }],
      });
    });
  });
});
