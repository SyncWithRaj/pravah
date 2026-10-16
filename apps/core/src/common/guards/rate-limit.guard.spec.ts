import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RateLimitGuard(reflector);
    // Don't initialize Redis connection so it tests memory fallback cleanly
  });

  afterEach(() => {
    guard.onModuleDestroy();
  });

  function createMockContext(
    ip: string,
    url: string = '/api/v1/auth/login',
    type: string = 'http',
    socketIp?: string,
  ): ExecutionContext {
    const mockRequest = {
      ip,
      socket: { remoteAddress: socketIp || ip },
      url,
      route: { path: url },
    };

    return {
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('should allow requests within limit', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(5); // limit = 5

    const ctx = createMockContext('1.2.3.4');
    for (let i = 0; i < 5; i++) {
      const allowed = await guard.canActivate(ctx);
      expect(allowed).toBe(true);
    }
  });

  it('should throw 429 when rate limit is exceeded', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(3); // limit = 3

    const ctx = createMockContext('5.6.7.8');
    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await guard.canActivate(ctx);

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(ctx);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HttpException);
      const httpErr = err as HttpException;
      expect(httpErr.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(httpErr.message).toBe('Too many requests, please try again later');
    }
  });

  it('should normalize IPv6-mapped IPv4 addresses to share the rate limit bucket', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(2);

    const ctxIpv4 = createMockContext('192.168.1.100');
    const ctxIpv6 = createMockContext('::ffff:192.168.1.100');

    expect(await guard.canActivate(ctxIpv4)).toBe(true);
    expect(await guard.canActivate(ctxIpv6)).toBe(true);
    // 3rd request from either should fail
    await expect(guard.canActivate(ctxIpv4)).rejects.toThrow(HttpException);
  });

  it('should bypass non-HTTP execution contexts (e.g., Kafka message pattern)', async () => {
    const ctxRpc = createMockContext('1.2.3.4', '/kafka', 'rpc');
    const allowed = await guard.canActivate(ctxRpc);
    expect(allowed).toBe(true);
  });

  it('should isolate rate limits across different routes for the same IP', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(2);

    const ctxLogin = createMockContext('10.0.0.1', '/api/v1/auth/login');
    const ctxRegister = createMockContext('10.0.0.1', '/api/v1/auth/register');

    expect(await guard.canActivate(ctxLogin)).toBe(true);
    expect(await guard.canActivate(ctxLogin)).toBe(true);
    await expect(guard.canActivate(ctxLogin)).rejects.toThrow(HttpException);

    // Register route should have its own separate quota
    expect(await guard.canActivate(ctxRegister)).toBe(true);
    expect(await guard.canActivate(ctxRegister)).toBe(true);
  });

  it('should use socket.remoteAddress if request.ip is empty', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(1);

    const ctx = createMockContext('', '/api/test', 'http', '9.9.9.9');
    expect(await guard.canActivate(ctx)).toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
  });
});
