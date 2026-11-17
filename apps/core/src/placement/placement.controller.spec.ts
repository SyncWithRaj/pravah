import { PlacementController } from './placement.controller';
import { PlacementService } from './placement.service';

type PlacementMock = { getPlacement: jest.Mock };

describe('PlacementController', () => {
  let controller: PlacementController;
  let service: PlacementMock;

  beforeEach(() => {
    service = { getPlacement: jest.fn().mockResolvedValue({}) };
    controller = new PlacementController(
      service as unknown as PlacementService,
    );
  });

  it('forwards the requesting edge node and version', async () => {
    await controller.getPlacement('file-1', 2, 'edge-node-01');

    expect(service.getPlacement).toHaveBeenCalledWith(
      'file-1',
      2,
      'edge-node-01',
    );
  });
});
