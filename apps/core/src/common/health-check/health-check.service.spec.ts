import { ConfigService } from '@nestjs/config';
import { EdgeNodeStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { KafkaService } from '../kafka/kafka.service';
import { EdgeNodeRecord, HealthCheckService } from './health-check.service';

type RedisMock = {
  set: jest.Mock;
  get: jest.Mock;
  on: jest.Mock;
};

type PrismaMock = {
  edgeNode: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

type KafkaMock = {
  emitEdgeHealthChanged: jest.Mock;
};

type MetricsMock = {
  edgeHealthStatus: { set: jest.Mock };
};

type ConfigMock = {
  get: jest.Mock;
};

type ServiceInternals = {
  redis: Redis;
  nodeMap: Map<string, EdgeNodeRecord>;
};

const makeRecord = (
  overrides: Partial<EdgeNodeRecord> = {},
): EdgeNodeRecord => ({
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

const makeDbNode = (overrides: Record<string, unknown> = {}) => ({
  id: 'edge-node-01',
  name: 'Mumbai Edge',
  region: 'ap-south-1',
  endpointUrl: 'http://localhost:3001',
  latitude: 19.076,
  longitude: 72.8777,
  status: EdgeNodeStatus.HEALTHY,
  lastHeartbeat: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('HealthCheckService', () => {
  let service: HealthCheckService;
  let redis: RedisMock;
  let prisma: PrismaMock;
  let kafka: KafkaMock;
  let metrics: MetricsMock;
  let internals: ServiceInternals;

  beforeEach(() => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      on: jest.fn(),
    };
    prisma = {
      edgeNode: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    kafka = { emitEdgeHealthChanged: jest.fn() };
    metrics = { edgeHealthStatus: { set: jest.fn() } };

    const config: ConfigMock = { get: jest.fn() };

    service = new HealthCheckService(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
      kafka as unknown as KafkaService,
      metrics as unknown as MetricsService,
    );

    internals = service as unknown as ServiceInternals;
    internals.redis = redis as unknown as Redis;
    internals.nodeMap = new Map();
  });

  it('stores heartbeats with a fifteen second expiry', async () => {
    await service.sendHeartbeat('edge-node-01');

    expect(redis.set).toHaveBeenCalledWith(
      'edge:edge-node-01:heartbeat',
      expect.any(String),
      'EX',
      15,
    );
  });

  it('refreshes the node map and sets health gauges', async () => {
    prisma.edgeNode.findMany.mockResolvedValue([
      makeDbNode(),
      makeDbNode({
        id: 'edge-node-02',
        name: 'Virginia Edge',
        region: 'us-east-1',
        status: EdgeNodeStatus.DEGRADED,
      }),
      makeDbNode({
        id: 'edge-node-03',
        name: 'Frankfurt Edge',
        region: 'eu-central-1',
        status: EdgeNodeStatus.DOWN,
      }),
    ]);
    internals.nodeMap.set('edge-node-01', makeRecord({ missedCycles: 7 }));

    await service.refreshNodeMap();

    expect(service.getAllNodes()).toHaveLength(3);
    expect(service.getAllNodes()[0].missedCycles).toBe(7);
    expect(metrics.edgeHealthStatus.set).toHaveBeenCalledWith(
      expect.objectContaining({ edge_id: 'edge-node-01' }),
      1,
    );
    expect(metrics.edgeHealthStatus.set).toHaveBeenCalledWith(
      expect.objectContaining({ edge_id: 'edge-node-02' }),
      0.5,
    );
    expect(metrics.edgeHealthStatus.set).toHaveBeenCalledWith(
      expect.objectContaining({ edge_id: 'edge-node-03' }),
      0,
    );
  });

  it('does nothing when monitoring an empty node map', async () => {
    await service.monitorEdgeHealth();

    expect(redis.get).not.toHaveBeenCalled();
  });

  it('keeps a healthy node healthy while heartbeats arrive', async () => {
    internals.nodeMap.set('edge-node-01', makeRecord());
    redis.get.mockResolvedValue(Date.now().toString());

    await service.monitorEdgeHealth();

    expect(prisma.edgeNode.update).not.toHaveBeenCalled();
    expect(kafka.emitEdgeHealthChanged).not.toHaveBeenCalled();
  });

  it('marks a healthy node degraded after one missed heartbeat', async () => {
    internals.nodeMap.set('edge-node-01', makeRecord());
    redis.get.mockResolvedValue(null);

    await service.monitorEdgeHealth();

    expect(service.getAllNodes()[0]).toMatchObject({
      status: EdgeNodeStatus.DEGRADED,
      missedCycles: 1,
    });
    expect(prisma.edgeNode.update).toHaveBeenCalledWith({
      where: { id: 'edge-node-01' },
      data: {
        status: EdgeNodeStatus.DEGRADED,
        lastHeartbeat: undefined,
      },
    });
    expect(kafka.emitEdgeHealthChanged).toHaveBeenCalledWith(
      'edge-node-01',
      EdgeNodeStatus.HEALTHY,
      EdgeNodeStatus.DEGRADED,
    );
  });

  it('marks a degraded node down after three missed heartbeats', async () => {
    internals.nodeMap.set(
      'edge-node-01',
      makeRecord({
        status: EdgeNodeStatus.DEGRADED,
        missedCycles: 2,
      }),
    );
    redis.get.mockResolvedValue(null);

    await service.monitorEdgeHealth();

    expect(service.getAllNodes()[0]).toMatchObject({
      status: EdgeNodeStatus.DOWN,
      missedCycles: 3,
    });
    expect(prisma.edgeNode.update).toHaveBeenCalledWith({
      where: { id: 'edge-node-01' },
      data: {
        status: EdgeNodeStatus.DOWN,
        lastHeartbeat: undefined,
      },
    });
  });

  it('recovers a degraded node when a heartbeat arrives', async () => {
    internals.nodeMap.set(
      'edge-node-01',
      makeRecord({
        status: EdgeNodeStatus.DEGRADED,
        missedCycles: 2,
      }),
    );
    redis.get.mockResolvedValue(Date.now().toString());

    await service.monitorEdgeHealth();

    expect(service.getAllNodes()[0]).toMatchObject({
      status: EdgeNodeStatus.HEALTHY,
      missedCycles: 0,
    });
    expect(prisma.edgeNode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'edge-node-01' },
      }),
    );
    const updateCall = prisma.edgeNode.update.mock.calls[0] as unknown as [
      { data: { lastHeartbeat: Date } },
    ];
    expect(updateCall[0].data.lastHeartbeat).toBeInstanceOf(Date);
    expect(metrics.edgeHealthStatus.set).toHaveBeenCalledWith(
      expect.objectContaining({ edge_id: 'edge-node-01' }),
      1,
    );
  });

  it('does not transition a node that is already down', async () => {
    internals.nodeMap.set(
      'edge-node-01',
      makeRecord({
        status: EdgeNodeStatus.DOWN,
        missedCycles: 5,
      }),
    );
    redis.get.mockResolvedValue(null);

    await service.monitorEdgeHealth();

    expect(prisma.edgeNode.update).not.toHaveBeenCalled();
    expect(kafka.emitEdgeHealthChanged).not.toHaveBeenCalled();
  });

  it('filters healthy nodes and answers registration checks', () => {
    internals.nodeMap.set('edge-node-01', makeRecord());
    internals.nodeMap.set(
      'edge-node-02',
      makeRecord({
        id: 'edge-node-02',
        status: EdgeNodeStatus.DEGRADED,
      }),
    );

    expect(service.getHealthyNodes()).toHaveLength(1);
    expect(service.getHealthyNodes()[0].id).toBe('edge-node-01');
    expect(service.getAllNodes()).toHaveLength(2);
    expect(service.isRegistered('edge-node-01')).toBe(true);
    expect(service.isRegistered('missing-node')).toBe(false);
  });
});
