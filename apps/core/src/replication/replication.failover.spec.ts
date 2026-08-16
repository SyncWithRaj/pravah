import { Test, TestingModule } from '@nestjs/testing';
import { ReplicationService } from './replication.service';
import { ReplicationController } from './replication.controller';
import { PrismaService } from '../prisma/prisma.service';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { MetricsService } from '../metrics/metrics.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';
import { RoutingService } from '../common/routing/routing.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  EdgeNodeStatus,
  FileStatus,
  ReplicationJobStatus,
} from '@prisma/client';

describe('Phase 7 Module 2: Edge Node Crash Failover & Dynamic Self-Healing Replication', () => {
  let replicationService: ReplicationService;
  let replicationController: ReplicationController;
  let routingService: RoutingService;
  let mockQueue: { add: jest.Mock };
  let mockPrisma: {
    replicationStatus: {
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
    edgeNode: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let mockHealthCheckService: {
    getHealthyNodes: jest.Mock;
    getAllNodes: jest.Mock;
  };
  let mockMetricsService: {
    replicationRepairsTotal: { inc: jest.Mock };
    geoRoutingTotal: { inc: jest.Mock };
  };
  let mockTelemetryGateway: {
    broadcastReplicationRepaired: jest.Mock;
  };

  const healthyNodeMumbai = {
    id: 'edge-node-01',
    name: 'Mumbai Edge',
    region: 'ap-south-1',
    endpointUrl: 'http://localhost:3001',
    latitude: 19.076,
    longitude: 72.8777,
    status: EdgeNodeStatus.HEALTHY,
    missedCycles: 0,
  };

  const healthyNodeVirginia = {
    id: 'edge-node-02',
    name: 'Virginia Edge',
    region: 'us-east-1',
    endpointUrl: 'http://localhost:3002',
    latitude: 37.4316,
    longitude: -78.6569,
    status: EdgeNodeStatus.HEALTHY,
    missedCycles: 0,
  };

  const healthyNodeFrankfurt = {
    id: 'edge-node-03',
    name: 'Frankfurt Edge',
    region: 'eu-central-1',
    endpointUrl: 'http://localhost:3003',
    latitude: 50.1109,
    longitude: 8.6821,
    status: EdgeNodeStatus.HEALTHY,
    missedCycles: 0,
  };

  beforeEach(async () => {
    mockQueue = { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) };

    mockPrisma = {
      replicationStatus: {
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      edgeNode: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };

    mockHealthCheckService = {
      getHealthyNodes: jest.fn(),
      getAllNodes: jest.fn(),
    };

    mockMetricsService = {
      replicationRepairsTotal: { inc: jest.fn() },
      geoRoutingTotal: { inc: jest.fn() },
    };

    mockTelemetryGateway = {
      broadcastReplicationRepaired: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReplicationController],
      providers: [
        ReplicationService,
        RoutingService,
        { provide: getQueueToken('replication.normal'), useValue: mockQueue },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: MetricsService, useValue: mockMetricsService },
        { provide: TelemetryGateway, useValue: mockTelemetryGateway },
      ],
    }).compile();

    replicationService = module.get<ReplicationService>(ReplicationService);
    replicationController = module.get<ReplicationController>(
      ReplicationController,
    );
    routingService = module.get<RoutingService>(RoutingService);
  });

  describe('Kafka Event: edge.health_changed', () => {
    it('should trigger dynamic replication repair when an edge node is reported DOWN', async () => {
      const spy = jest
        .spyOn(replicationService, 'handleEdgeCrashFailover')
        .mockResolvedValue({ repairedFilesCount: 2, dispatchedJobsCount: 2 });

      const payload = {
        edgeId: 'edge-node-01',
        oldStatus: 'HEALTHY',
        newStatus: 'DOWN',
        timestamp: new Date().toISOString(),
      };

      const result =
        await replicationController.handleEdgeHealthChanged(payload);

      expect(spy).toHaveBeenCalledWith('edge-node-01');
      expect(result).toEqual({ repairedFilesCount: 2, dispatchedJobsCount: 2 });
    });

    it('should NOT trigger replication repair when node transitions to HEALTHY or DEGRADED', async () => {
      const spy = jest.spyOn(replicationService, 'handleEdgeCrashFailover');

      await replicationController.handleEdgeHealthChanged({
        edgeId: 'edge-node-01',
        oldStatus: 'DOWN',
        newStatus: 'HEALTHY',
      });

      await replicationController.handleEdgeHealthChanged({
        edgeId: 'edge-node-01',
        oldStatus: 'HEALTHY',
        newStatus: 'DEGRADED',
      });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('ReplicationService: handleEdgeCrashFailover', () => {
    it('should re-evaluate placement on remaining healthy nodes and dispatch repair jobs', async () => {
      // Remaining healthy nodes after Mumbai (edge-node-01) crashed
      mockHealthCheckService.getHealthyNodes.mockReturnValue([
        healthyNodeVirginia,
        healthyNodeFrankfurt,
      ]);

      const mockFile = {
        id: 'file-xyz-100',
        name: 'report.pdf',
        status: FileStatus.COMPLETED,
        storagePath: 'files/user-1/file-xyz-100/v1/report.pdf',
        versions: [{ versionNumber: 1 }],
      };

      // Files that had replication on the crashed node
      mockPrisma.replicationStatus.findMany
        .mockResolvedValueOnce([
          {
            id: 'rep-01',
            fileId: 'file-xyz-100',
            edgeNodeId: 'edge-node-01',
            status: ReplicationJobStatus.FAILED,
            file: mockFile,
          },
        ]) // First findMany for affectedReplications
        .mockResolvedValueOnce([
          {
            edgeNodeId: 'edge-node-01',
            status: ReplicationJobStatus.FAILED,
          },
        ]); // Second findMany for existingRecords for this file

      const result =
        await replicationService.handleEdgeCrashFailover('edge-node-01');

      expect(result.repairedFilesCount).toBe(1);
      expect(result.dispatchedJobsCount).toBeGreaterThan(0);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'replicate-file',
        expect.objectContaining({
          fileId: 'file-xyz-100',
          storagePath: 'files/user-1/file-xyz-100/v1/report.pdf',
        }),
        expect.objectContaining({
          priority: 3,
          attempts: 3,
        }),
      );
      expect(
        mockTelemetryGateway.broadcastReplicationRepaired,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'file-xyz-100',
          deadNodeId: 'edge-node-01',
        }),
      );
      expect(
        mockMetricsService.replicationRepairsTotal.inc,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          dead_edge_id: 'edge-node-01',
        }),
      );
    });

    it('should return 0 repairs if no files were hosted on the crashed node', async () => {
      mockHealthCheckService.getHealthyNodes.mockReturnValue([
        healthyNodeVirginia,
        healthyNodeFrankfurt,
      ]);
      mockPrisma.replicationStatus.findMany.mockResolvedValueOnce([]);

      const result =
        await replicationService.handleEdgeCrashFailover('edge-node-01');

      expect(result).toEqual({ repairedFilesCount: 0, dispatchedJobsCount: 0 });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should return 0 repairs if no healthy nodes remain in cluster', async () => {
      mockHealthCheckService.getHealthyNodes.mockReturnValue([]);

      const result =
        await replicationService.handleEdgeCrashFailover('edge-node-01');

      expect(result).toEqual({ repairedFilesCount: 0, dispatchedJobsCount: 0 });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('RoutingService: Dynamic Geo-Routing Failover', () => {
    it('should failover clients to the next closest healthy edge when regional edge is DOWN', () => {
      // Mumbai is DOWN, only Virginia and Frankfurt are HEALTHY
      mockHealthCheckService.getHealthyNodes.mockReturnValue([
        healthyNodeVirginia,
        healthyNodeFrankfurt,
      ]);

      // Client from Mumbai region requests download
      const decision = routingService.selectBestEdge('ap-south-1');

      expect(decision).toBeDefined();
      expect(decision?.strategy).toBe('nearest-geo');
      // Frankfurt (eu-central-1) is geographically closer to Mumbai (ap-south-1) than Virginia (us-east-1)
      expect(decision?.edge.id).toBe('edge-node-03');
      expect(decision?.edge.name).toBe('Frankfurt Edge');
    });

    it('should route directly to exact region if the regional edge is HEALTHY', () => {
      mockHealthCheckService.getHealthyNodes.mockReturnValue([
        healthyNodeMumbai,
        healthyNodeVirginia,
        healthyNodeFrankfurt,
      ]);

      const decision = routingService.selectBestEdge('ap-south-1');

      expect(decision).toBeDefined();
      expect(decision?.strategy).toBe('exact-region');
      expect(decision?.edge.id).toBe('edge-node-01');
      expect(decision?.edge.name).toBe('Mumbai Edge');
    });
  });
});
