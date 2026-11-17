import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EdgeNodeStatus } from '@prisma/client';
import { HealthCheckController } from './health-check.controller';
import { HealthCheckService } from './health-check.service';

type HealthCheckMock = {
  isRegistered: jest.Mock;
  sendHeartbeat: jest.Mock;
  getAllNodes: jest.Mock;
  getHealthyNodes: jest.Mock;
};

describe('HealthCheckController', () => {
  let controller: HealthCheckController;
  let service: HealthCheckMock;

  beforeEach(() => {
    service = {
      isRegistered: jest.fn(),
      sendHeartbeat: jest.fn().mockResolvedValue(undefined),
      getAllNodes: jest.fn(),
      getHealthyNodes: jest.fn(),
    };
    controller = new HealthCheckController(
      service as unknown as HealthCheckService,
    );
  });

  it('rejects a heartbeat without an edge id', async () => {
    await expect(
      controller.receiveHeartbeat({ edgeId: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.sendHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects an unregistered edge node', async () => {
    service.isRegistered.mockReturnValue(false);

    await expect(
      controller.receiveHeartbeat({ edgeId: 'edge-node-99' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.sendHeartbeat).not.toHaveBeenCalled();
  });

  it('records a heartbeat for a registered edge node', async () => {
    service.isRegistered.mockReturnValue(true);

    await expect(
      controller.receiveHeartbeat({ edgeId: 'edge-node-01' }),
    ).resolves.toEqual({ status: 'ok' });
    expect(service.sendHeartbeat).toHaveBeenCalledWith('edge-node-01');
  });

  it('summarises node health by status', () => {
    service.getAllNodes.mockReturnValue([
      { id: 'edge-node-01', status: EdgeNodeStatus.HEALTHY },
      { id: 'edge-node-02', status: EdgeNodeStatus.HEALTHY },
      { id: 'edge-node-03', status: EdgeNodeStatus.DEGRADED },
      { id: 'edge-node-04', status: EdgeNodeStatus.DOWN },
    ]);

    const result = controller.getAllNodes();

    expect(result).toMatchObject({
      total: 4,
      healthy: 2,
      degraded: 1,
      down: 1,
    });
    expect(result.nodes).toHaveLength(4);
  });

  it('returns only healthy nodes', () => {
    const healthy = [{ id: 'edge-node-01' }];
    service.getHealthyNodes.mockReturnValue(healthy);

    expect(controller.getHealthyNodes()).toBe(healthy);
  });
});
