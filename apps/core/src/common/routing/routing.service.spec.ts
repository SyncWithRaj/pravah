import { EdgeNodeStatus } from '@prisma/client';
import {
  EdgeNodeRecord,
  HealthCheckService,
} from '../health-check/health-check.service';
import { MetricsService } from '../../metrics/metrics.service';
import { RoutingService } from './routing.service';

type HealthCheckMock = {
  getHealthyNodes: jest.Mock;
};

type MetricsMock = {
  geoRoutingTotal: { inc: jest.Mock };
};

const makeNode = (overrides: Partial<EdgeNodeRecord> = {}): EdgeNodeRecord => ({
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

describe('RoutingService', () => {
  let service: RoutingService;
  let healthCheck: HealthCheckMock;
  let metrics: MetricsMock;

  beforeEach(() => {
    healthCheck = { getHealthyNodes: jest.fn() };
    metrics = { geoRoutingTotal: { inc: jest.fn() } };
    service = new RoutingService(
      healthCheck as unknown as HealthCheckService,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when the client region is missing', () => {
    const decision = service.selectBestEdge(undefined);

    expect(decision).toBeNull();
    expect(healthCheck.getHealthyNodes).not.toHaveBeenCalled();
  });

  it('returns null when no edge nodes are healthy', () => {
    healthCheck.getHealthyNodes.mockReturnValue([]);

    expect(service.selectBestEdge('ap-south-1')).toBeNull();
    expect(metrics.geoRoutingTotal.inc).not.toHaveBeenCalled();
  });

  it('selects an exact-region edge and records the routing metric', () => {
    const mumbai = makeNode();
    healthCheck.getHealthyNodes.mockReturnValue([mumbai]);

    const decision = service.selectBestEdge('ap-south-1');

    expect(decision).toEqual({
      edge: mumbai,
      distanceKm: null,
      strategy: 'exact-region',
    });
    expect(metrics.geoRoutingTotal.inc).toHaveBeenCalledWith({
      edge_name: 'Mumbai Edge',
      edge_region: 'ap-south-1',
      strategy: 'exact-region',
    });
  });

  it('uses the random selection when several edges share the exact region', () => {
    const first = makeNode({ id: 'edge-a', name: 'Mumbai A' });
    const second = makeNode({ id: 'edge-b', name: 'Mumbai B' });
    healthCheck.getHealthyNodes.mockReturnValue([first, second]);
    jest.spyOn(Math, 'random').mockReturnValue(0.99);

    const decision = service.selectBestEdge('ap-south-1');

    expect(decision?.edge.id).toBe('edge-b');
  });

  it('routes to the nearest healthy edge when the exact region is unavailable', () => {
    const virginia = makeNode({
      id: 'edge-us',
      name: 'Virginia Edge',
      region: 'us-east-1',
      latitude: 37.4316,
      longitude: -78.6569,
    });
    const frankfurt = makeNode({
      id: 'edge-eu',
      name: 'Frankfurt Edge',
      region: 'eu-central-1',
      latitude: 50.1109,
      longitude: 8.6821,
    });
    healthCheck.getHealthyNodes.mockReturnValue([virginia, frankfurt]);

    const decision = service.selectBestEdge('ap-south-1');

    expect(decision?.edge.id).toBe('edge-eu');
    expect(decision?.strategy).toBe('nearest-geo');
    expect(decision?.distanceKm).toEqual(expect.any(Number));
    expect(metrics.geoRoutingTotal.inc).toHaveBeenCalledWith({
      edge_name: 'Frankfurt Edge',
      edge_region: 'eu-central-1',
      strategy: 'nearest-geo',
    });
  });

  it('returns null for an unknown client region with no exact match', () => {
    healthCheck.getHealthyNodes.mockReturnValue([makeNode()]);

    expect(service.selectBestEdge('unknown-region-1')).toBeNull();
    expect(metrics.geoRoutingTotal.inc).not.toHaveBeenCalled();
  });
});
