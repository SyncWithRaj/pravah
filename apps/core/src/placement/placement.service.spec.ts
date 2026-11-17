import { NotFoundException } from '@nestjs/common';
import { EdgeNodeStatus } from '@prisma/client';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlacementService } from './placement.service';

type PrismaMock = {
  file: { findUnique: jest.Mock };
  fileVersion: { findFirst: jest.Mock };
};

type HealthCheckMock = {
  getAllNodes: jest.Mock;
};

const node = (overrides: Record<string, unknown> = {}) => ({
  id: 'edge-node-01',
  name: 'Mumbai Edge',
  region: 'ap-south-1',
  endpointUrl: 'http://localhost:3001',
  latitude: 19.076,
  longitude: 72.8777,
  status: EdgeNodeStatus.HEALTHY,
  missedCycles: 0,
  ...overrides,
});

describe('PlacementService', () => {
  let service: PlacementService;
  let prisma: PrismaMock;
  let healthCheck: HealthCheckMock;

  beforeEach(() => {
    prisma = {
      file: { findUnique: jest.fn() },
      fileVersion: { findFirst: jest.fn() },
    };
    healthCheck = { getAllNodes: jest.fn() };
    service = new PlacementService(
      prisma as unknown as PrismaService,
      healthCheck as unknown as HealthCheckService,
    );
  });

  it('throws when the file does not exist', async () => {
    prisma.file.findUnique.mockResolvedValue(null);

    await expect(
      service.getPlacement('file-1', 1, 'edge-node-01'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws when the requested version does not exist', async () => {
    prisma.file.findUnique.mockResolvedValue({
      id: 'file-1',
      ownerId: 'user-1',
      mimeType: 'video/mp4',
    });
    prisma.fileVersion.findFirst.mockResolvedValue(null);

    await expect(
      service.getPlacement('file-1', 1, 'edge-node-01'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns healthy replicas excluding the requesting edge, sorted by distance', async () => {
    prisma.file.findUnique.mockResolvedValue({
      id: 'file-1',
      ownerId: 'user-1',
      mimeType: 'video/mp4',
    });
    prisma.fileVersion.findFirst.mockResolvedValue({
      versionNumber: 2,
      storagePath: 'files/user-1/file-1/v2/video.mp4',
      size: BigInt(1024),
      checksum: 'checksum-2',
    });
    healthCheck.getAllNodes.mockReturnValue([
      node(),
      node({
        id: 'edge-node-02',
        name: 'Virginia Edge',
        region: 'us-east-1',
        endpointUrl: 'http://localhost:4001',
        latitude: 37.4316,
        longitude: -78.6569,
      }),
      node({
        id: 'edge-node-03',
        name: 'Frankfurt Edge',
        region: 'eu-central-1',
        endpointUrl: 'http://localhost:5001',
        latitude: 50.1109,
        longitude: 8.6821,
      }),
      node({
        id: 'edge-node-04',
        name: 'Down Edge',
        region: 'eu-central-1',
        endpointUrl: 'http://localhost:5002',
        latitude: 50.1109,
        longitude: 8.6821,
        status: EdgeNodeStatus.DOWN,
      }),
    ]);

    const placement = await service.getPlacement('file-1', 2, 'edge-node-01');

    expect(placement).toMatchObject({
      fileId: 'file-1',
      version: 2,
      storagePath: 'files/user-1/file-1/v2/video.mp4',
      mimeType: 'video/mp4',
      size: '1024',
      ownerId: 'user-1',
      checksum: 'checksum-2',
    });
    expect(placement.responsibleReplicas).toHaveLength(2);
    expect(placement.responsibleReplicas.map((r) => r.edgeId)).not.toContain(
      'edge-node-01',
    );
    expect(placement.responsibleReplicas.map((r) => r.edgeId)).not.toContain(
      'edge-node-04',
    );
    expect(placement.responsibleReplicas[0].distanceKm).toBeLessThanOrEqual(
      placement.responsibleReplicas[1].distanceKm,
    );
  });

  it('returns zero-distance replicas when the requesting edge is unknown', async () => {
    prisma.file.findUnique.mockResolvedValue({
      id: 'file-1',
      ownerId: 'user-1',
      mimeType: 'text/plain',
    });
    prisma.fileVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      storagePath: 'files/file-1/v1/notes.txt',
      size: BigInt(9),
      checksum: 'checksum-1',
    });
    healthCheck.getAllNodes.mockReturnValue([
      node({ id: 'edge-node-02', endpointUrl: 'http://localhost:4001' }),
    ]);

    const placement = await service.getPlacement('file-1', 1, 'unknown-edge');

    expect(placement.responsibleReplicas).toEqual([
      expect.objectContaining({
        edgeId: 'edge-node-02',
        endpoint: 'http://localhost:4001',
        distanceKm: 0,
      }),
    ]);
  });

  it('returns no replicas when the cluster has no nodes', async () => {
    prisma.file.findUnique.mockResolvedValue({
      id: 'file-1',
      ownerId: 'user-1',
      mimeType: 'video/mp4',
    });
    prisma.fileVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      storagePath: 'files/file-1/v1/video.mp4',
      size: BigInt(10),
      checksum: 'checksum-1',
    });
    healthCheck.getAllNodes.mockReturnValue([]);

    const placement = await service.getPlacement('file-1', 1, 'edge-node-01');

    expect(placement.responsibleReplicas).toEqual([]);
  });
});
