import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Response } from 'express';
import { Observable, of, throwError } from 'rxjs';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

type MetricsMock = {
  getContentType: jest.Mock;
  getMetrics: jest.Mock;
  httpRequestsTotal: { inc: jest.Mock };
  httpRequestDuration: { observe: jest.Mock };
};

type ResponseMock = {
  setHeader: jest.Mock;
  send: jest.Mock;
};

const contextFor = (
  type: string,
  req: Record<string, unknown>,
  res: Record<string, unknown>,
): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  }) as unknown as ExecutionContext;

describe('MetricsController', () => {
  let controller: MetricsController;
  let metrics: MetricsMock;
  let response: ResponseMock;

  beforeEach(() => {
    metrics = {
      getContentType: jest.fn().mockReturnValue('text/plain'),
      getMetrics: jest.fn().mockResolvedValue('metric 1'),
      httpRequestsTotal: { inc: jest.fn() },
      httpRequestDuration: { observe: jest.fn() },
    };
    response = { setHeader: jest.fn(), send: jest.fn() };
    controller = new MetricsController(metrics as unknown as MetricsService);
  });

  it('sets the Prometheus content type and sends metrics', async () => {
    await controller.getMetrics(response as unknown as Response);

    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain',
    );
    expect(response.send).toHaveBeenCalledWith('metric 1');
  });
});

describe('MetricsInterceptor', () => {
  let interceptor: MetricsInterceptor;
  let metrics: MetricsMock;

  beforeEach(() => {
    metrics = {
      getContentType: jest.fn(),
      getMetrics: jest.fn(),
      httpRequestsTotal: { inc: jest.fn() },
      httpRequestDuration: { observe: jest.fn() },
    };
    interceptor = new MetricsInterceptor(metrics as unknown as MetricsService);
  });

  const run = async (
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> => {
    const stream = interceptor.intercept(context, next);
    return new Promise((resolve) => {
      stream.subscribe({
        next: (value) => {
          resolve(value);
        },
        error: () => {
          resolve(undefined);
        },
        complete: () => {
          resolve(undefined);
        },
      });
    });
  };

  it('records successful HTTP requests', async () => {
    const context = contextFor(
      'http',
      { method: 'GET', baseUrl: '/api/v1/files', url: '/api/v1/files' },
      { statusCode: 201 },
    );
    const next: CallHandler = { handle: (): Observable<unknown> => of('ok') };

    await expect(run(context, next)).resolves.toBe('ok');

    expect(metrics.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'GET',
      route: '/api/v1/files',
      status_code: '201',
    });
    expect(metrics.httpRequestDuration.observe).toHaveBeenCalledWith(
      { method: 'GET', route: '/api/v1/files', status_code: '201' },
      expect.any(Number),
    );
  });

  it('falls back to path and 200 when fields are missing', async () => {
    const context = contextFor(
      'http',
      { path: '/fallback' },
      { statusCode: 0 },
    );
    const next: CallHandler = { handle: (): Observable<unknown> => of(null) };

    await run(context, next);

    expect(metrics.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'GET',
      route: '/fallback',
      status_code: '200',
    });
  });

  it('records error responses using the thrown status', async () => {
    const context = contextFor(
      'http',
      { method: 'POST', path: '/api/v1/upload/init' },
      { statusCode: 200 },
    );
    const next: CallHandler = {
      handle: (): Observable<unknown> => throwError(() => ({ status: 409 })),
    };

    await run(context, next);

    expect(metrics.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'POST',
      route: '/api/v1/upload/init',
      status_code: '409',
    });
  });

  it('records a 500 for unknown errors', async () => {
    const context = contextFor(
      'http',
      { method: 'DELETE', path: '/api/v1/files/1' },
      {},
    );
    const next: CallHandler = {
      handle: (): Observable<unknown> => throwError(() => new Error('boom')),
    };

    await run(context, next);

    expect(metrics.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'DELETE',
      route: '/api/v1/files/1',
      status_code: '500',
    });
  });

  it('passes non-HTTP contexts through without recording', async () => {
    const context = contextFor('rpc', {}, {});
    const next: CallHandler = { handle: (): Observable<unknown> => of('rpc') };

    await expect(run(context, next)).resolves.toBe('rpc');
    expect(metrics.httpRequestsTotal.inc).not.toHaveBeenCalled();
  });
});
