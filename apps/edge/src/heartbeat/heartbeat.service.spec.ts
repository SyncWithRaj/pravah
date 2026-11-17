import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HeartbeatService } from './heartbeat.service';
import { verifyServiceSignature } from '../common/security/service-hmac.util';

type ConfigMock = { get: jest.Mock };
type HttpMock = { axiosRef: { post: jest.Mock } };

const configFor = (values: Record<string, string | undefined>): ConfigService =>
  ({
    get: jest.fn((key: string, defaultValue?: string) => {
      const value = values[key];
      return value === undefined ? defaultValue : value;
    }),
  }) as unknown as ConfigService;

describe('HeartbeatService', () => {
  const secret = 'test-internal-secret';

  it('sends a signed heartbeat to the core API', async () => {
    const http: HttpMock = { axiosRef: { post: jest.fn().mockResolvedValue({}) } };
    const service = new HeartbeatService(
      http as unknown as HttpService,
      configFor({
        EDGE_NODE_ID: 'edge-node-02',
        CORE_API_URL: 'http://core-api:3000/api/v1/',
        INTERNAL_SERVICE_SECRET: secret,
      }),
    );

    await service.sendHeartbeat();

    expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = http.axiosRef.post.mock.calls[0] as [
      string,
      { edgeId: string },
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe('http://core-api:3000/api/v1/admin/health/heartbeat');
    expect(body).toEqual({ edgeId: 'edge-node-02' });
    expect(options.timeout).toBe(3000);
    expect(options.headers['x-service-id']).toBe('edge-node-02');

    const timestamp = Number(options.headers['x-service-timestamp']);
    expect(
      verifyServiceSignature(
        'edge-node-02',
        'POST',
        '/api/v1/admin/health/heartbeat',
        timestamp,
        options.headers['x-service-signature'],
        secret,
        body,
      ),
    ).toBe(true);
  });

  it('normalises a core URL without the API prefix', async () => {
    const http: HttpMock = { axiosRef: { post: jest.fn().mockResolvedValue({}) } };
    const service = new HeartbeatService(
      http as unknown as HttpService,
      configFor({
        EDGE_NODE_ID: 'edge-node-01',
        CORE_API_URL: 'http://core-api:3000/',
        INTERNAL_SERVICE_SECRET: secret,
      }),
    );

    await service.sendHeartbeat();

    expect(http.axiosRef.post.mock.calls[0][0]).toBe(
      'http://core-api:3000/api/v1/admin/health/heartbeat',
    );
  });

  it('logs and swallows heartbeat failures', async () => {
    const http: HttpMock = {
      axiosRef: { post: jest.fn().mockRejectedValue(new Error('core down')) },
    };
    const service = new HeartbeatService(
      http as unknown as HttpService,
      configFor({ INTERNAL_SERVICE_SECRET: secret }),
    );

    await expect(service.sendHeartbeat()).resolves.toBeUndefined();
  });
});
