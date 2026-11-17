import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';
import {
  THROTTLE_LIMIT_KEY,
  THROTTLE_TTL_KEY,
} from '../decorators/throttle.decorator';

describe('Edge RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RateLimitGuard(reflector);
  });

  const contextFor = (
    ip: string,
    url = '/edge/content/file-1',
    type = 'http',
    rawIp?: string,
  ) =>
    ({
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          raw: { socket: { remoteAddress: rawIp || ip } },
          url,
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as never;

  const limitTo = (limit: number, ttl = 60): void => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: string) =>
        key === THROTTLE_LIMIT_KEY ? limit : key === THROTTLE_TTL_KEY ? ttl : undefined,
      );
  };

  it('allows requests up to the configured limit', () => {
    limitTo(2);
    const context = contextFor('1.2.3.4');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws 429 once the limit is exceeded', () => {
    limitTo(1);
    const context = contextFor('5.6.7.8');

    expect(guard.canActivate(context)).toBe(true);
    try {
      guard.canActivate(context);
      throw new Error('expected guard to reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it('normalises IPv6-mapped IPv4 addresses into one bucket', () => {
    limitTo(2);
    const ipv4 = contextFor('192.168.1.10');
    const ipv6 = contextFor('::ffff:192.168.1.10');

    expect(guard.canActivate(ipv4)).toBe(true);
    expect(guard.canActivate(ipv6)).toBe(true);
    expect(() => guard.canActivate(ipv4)).toThrow(HttpException);
  });

  it('keeps separate quotas per route', () => {
    limitTo(1);
    const content = contextFor('10.0.0.1', '/edge/content/a');
    const health = contextFor('10.0.0.1', '/health');

    expect(guard.canActivate(content)).toBe(true);
    expect(() => guard.canActivate(content)).toThrow(HttpException);
    expect(guard.canActivate(health)).toBe(true);
  });

  it('bypasses non-HTTP contexts', () => {
    limitTo(1);
    const context = contextFor('1.2.3.4', '/rpc', 'rpc');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('uses the raw socket address when request.ip is missing', () => {
    limitTo(1);
    const context = contextFor('', '/edge/content/a', 'http', '9.9.9.9');

    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
  });
});
