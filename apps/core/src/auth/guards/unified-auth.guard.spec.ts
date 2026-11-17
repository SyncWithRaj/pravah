import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { UnifiedAuthGuard } from './unified-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { InterServiceGuard } from './inter-service.guard';

type GuardMock = {
  canActivate: jest.Mock<boolean | Promise<boolean>, [ExecutionContext]>;
};

type RequestHeaders = Record<string, string | undefined>;

const contextFor = (
  headers: RequestHeaders,
  type = 'http',
): ExecutionContext => {
  const request = { headers } as unknown as Request;
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

describe('UnifiedAuthGuard', () => {
  let guard: UnifiedAuthGuard;
  let jwt: GuardMock;
  let apiKey: GuardMock;
  let interService: GuardMock;

  beforeEach(() => {
    jwt = {
      canActivate: jest.fn<boolean | Promise<boolean>, [ExecutionContext]>(),
    };
    apiKey = {
      canActivate: jest.fn<boolean | Promise<boolean>, [ExecutionContext]>(),
    };
    interService = {
      canActivate: jest.fn<boolean | Promise<boolean>, [ExecutionContext]>(),
    };
    guard = new UnifiedAuthGuard(
      jwt as unknown as JwtAuthGuard,
      apiKey as unknown as ApiKeyGuard,
      interService as unknown as InterServiceGuard,
    );
  });

  it('accepts non-HTTP contexts without authentication', async () => {
    await expect(guard.canActivate(contextFor({}, 'rpc'))).resolves.toBe(true);
    expect(jwt.canActivate).not.toHaveBeenCalled();
  });

  it('accepts a valid inter-service signature first', async () => {
    interService.canActivate.mockReturnValue(true);

    await expect(
      guard.canActivate(contextFor({ 'x-service-signature': 'sig' })),
    ).resolves.toBe(true);
    expect(interService.canActivate).toHaveBeenCalled();
    expect(apiKey.canActivate).not.toHaveBeenCalled();
    expect(jwt.canActivate).not.toHaveBeenCalled();
  });

  it('falls through when the inter-service signature is invalid', async () => {
    interService.canActivate.mockReturnValue(false);
    jwt.canActivate.mockResolvedValue(true);

    await expect(
      guard.canActivate(contextFor({ 'x-service-signature': 'bad' })),
    ).resolves.toBe(true);
    expect(jwt.canActivate).toHaveBeenCalled();
  });

  it('accepts a valid API key from any supported header', async () => {
    apiKey.canActivate.mockResolvedValue(true);

    for (const header of [
      { 'x-api-key': 'key' },
      { 'x-edge-api-key': 'key' },
      { authorization: 'ApiKey key' },
    ]) {
      await expect(guard.canActivate(contextFor(header))).resolves.toBe(true);
    }

    expect(apiKey.canActivate).toHaveBeenCalledTimes(3);
    expect(jwt.canActivate).not.toHaveBeenCalled();
  });

  it('falls back to JWT when API keys are rejected', async () => {
    apiKey.canActivate.mockResolvedValue(false);
    jwt.canActivate.mockResolvedValue(true);

    await expect(
      guard.canActivate(contextFor({ 'x-api-key': 'bad' })),
    ).resolves.toBe(true);
    expect(jwt.canActivate).toHaveBeenCalled();
  });

  it('maps JWT errors to a single authentication error', async () => {
    jwt.canActivate.mockRejectedValue(new Error('jwt expired'));

    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(contextFor({}))).rejects.toThrow(
      'Authentication required',
    );
  });

  it('rejects when the JWT guard returns false', async () => {
    jwt.canActivate.mockResolvedValue(false);

    await expect(guard.canActivate(contextFor({}))).rejects.toThrow(
      'Authentication failed',
    );
  });
});
