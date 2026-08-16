/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { DlqController } from './dlq.controller';
import { ReplicationService } from './replication.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ReplicationJobStatus, EdgeNodeStatus } from '@prisma/client';

describe('DlqController', () => {
  let controller: DlqController;
  let replicationService: jest.Mocked<ReplicationService>;

  beforeEach(async () => {
    const mockReplicationService = {
      getDLQEvents: jest.fn(),
      getDLQEventById: jest.fn(),
      replayDLQEvent: jest.fn(),
      replayAllDLQEvents: jest.fn(),
      purgeDLQEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DlqController],
      providers: [
        {
          provide: ReplicationService,
          useValue: mockReplicationService,
        },
      ],
    }).compile();

    controller = module.get<DlqController>(DlqController);
    replicationService = module.get(ReplicationService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getAllDLQEvents', () => {
    it('should return formatted list of DLQ events', async () => {
      const mockEvents = [
        {
          id: 'dlq-1',
          fileId: 'file-1',
          file: {
            id: 'file-1',
            name: 'test.mp4',
            mimeType: 'video/mp4',
            totalSize: BigInt(1000),
            ownerId: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          edgeNodeId: 'edge-1',
          edgeNode: {
            id: 'edge-1',
            name: 'Mumbai Edge',
            region: 'ap-south-1',
            endpointUrl: 'http://localhost:3001',
            latitude: 19.076,
            longitude: 72.8777,
            status: EdgeNodeStatus.HEALTHY,
            lastHeartbeat: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          status: ReplicationJobStatus.FAILED,
          attempts: 3,
          lastError: 'Connection timeout',
          isDeadLetter: true,
          deadLetterAt: new Date('2026-08-16T19:00:00Z'),
          deadLetterReason: 'Connection timeout',
          replayedAt: null,
          payload: null,
          startedAt: new Date(),
          completedAt: null,
          durationMs: 1200,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      replicationService.getDLQEvents.mockResolvedValue(
        mockEvents as unknown as Awaited<
          ReturnType<ReplicationService['getDLQEvents']>
        >,
      );

      const result = await controller.getAllDLQEvents();

      expect(result.total).toBe(1);
      expect(result.topic).toBe('file.uploaded.dlq');
      expect(result.events[0].id).toBe('dlq-1');
      expect(result.events[0].edgeNodeName).toBe('Mumbai Edge');
      expect(result.events[0].attempts).toBe(3);
    });
  });

  describe('getDLQEventById', () => {
    it('should return a single DLQ event if found', async () => {
      const mockEvent = {
        id: 'dlq-1',
        fileId: 'file-1',
        attempts: 3,
        status: ReplicationJobStatus.FAILED,
        isDeadLetter: true,
        edgeNodeId: 'edge-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        file: { id: 'file-1', name: 'test.mp4' },
        edgeNode: { id: 'edge-1', name: 'Mumbai Edge' },
      };

      replicationService.getDLQEventById.mockResolvedValue(
        mockEvent as unknown as Awaited<
          ReturnType<ReplicationService['getDLQEventById']>
        >,
      );

      const result = await controller.getDLQEventById('dlq-1');
      expect(result.id).toBe('dlq-1');
    });

    it('should throw NotFoundException if event does not exist', async () => {
      replicationService.getDLQEventById.mockResolvedValue(null);

      await expect(controller.getDLQEventById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('replayDLQEvent', () => {
    it('should replay a single DLQ event by replicationId', async () => {
      replicationService.replayDLQEvent.mockResolvedValue({
        success: true,
        message: 'Replayed',
        replicationId: 'dlq-1',
      });

      const result = await controller.replayDLQEvent({
        replicationId: 'dlq-1',
      });
      expect(result.success).toBe(true);
      expect(replicationService.replayDLQEvent).toHaveBeenCalledWith('dlq-1');
    });

    it('should replay all matching events for a fileId', async () => {
      const mockEvents = [
        { id: 'dlq-1', fileId: 'file-100' },
        { id: 'dlq-2', fileId: 'file-100' },
      ];

      replicationService.getDLQEvents.mockResolvedValue(
        mockEvents as unknown as Awaited<
          ReturnType<ReplicationService['getDLQEvents']>
        >,
      );
      replicationService.replayDLQEvent.mockResolvedValue({
        success: true,
        message: 'Replayed',
        replicationId: 'dlq-1',
      });

      const result = await controller.replayDLQEvent({ fileId: 'file-100' });
      expect(result.success).toBe(true);
      expect(replicationService.replayDLQEvent).toHaveBeenCalledTimes(2);
    });

    it('should throw BadRequestException if no identifier provided', async () => {
      await expect(controller.replayDLQEvent({})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('purgeDLQEvent', () => {
    it('should purge a DLQ event by ID', async () => {
      replicationService.purgeDLQEvent.mockResolvedValue({
        success: true,
        message: 'Purged',
      });

      const result = await controller.purgeDLQEvent('dlq-1');
      expect(result.success).toBe(true);
      expect(replicationService.purgeDLQEvent).toHaveBeenCalledWith('dlq-1');
    });
  });
});
