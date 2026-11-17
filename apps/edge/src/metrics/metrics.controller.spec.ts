import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

type MetricsMock = {
  getContentType: jest.Mock;
  getMetrics: jest.Mock;
};

describe('Edge MetricsController', () => {
  let controller: MetricsController;
  let metrics: MetricsMock;

  beforeEach(() => {
    metrics = {
      getContentType: jest.fn().mockReturnValue('text/plain; version=0.0.4'),
      getMetrics: jest.fn().mockResolvedValue('metric 1'),
    };
    controller = new MetricsController(metrics as unknown as MetricsService);
  });

  it('sets the content type on a Fastify-style reply and returns metrics', async () => {
    const res = { header: jest.fn() };

    await expect(controller.getMetrics(res)).resolves.toBe('metric 1');
    expect(res.header).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4',
    );
  });

  it('falls back to setHeader for Express-style replies', async () => {
    const res = { setHeader: jest.fn() };

    await controller.getMetrics(res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4',
    );
  });

  it('returns metrics even when the reply has no header API', async () => {
    await expect(controller.getMetrics({})).resolves.toBe('metric 1');
  });
});
