/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InterServiceGuard } from './inter-service.guard';
import { Role } from '@prisma/client';
import * as crypto from 'crypto';

describe('InterServiceGuard', () => {
  let guard: InterServiceGuard;
  const secret = 'test-internal-secret-key-123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterServiceGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(secret),
          },
        },
      ],
    }).compile();

    guard = module.get<InterServiceGuard>(InterServiceGuard);
  });

  const createMockContext = (
    headers: Record<string, string>,
    method = 'POST',
    url = '/api/v1/admin/health/heartbeat',
  ): ExecutionContext => {
    const req = {
      headers,
      method,
      url,
      user: undefined,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  };

  it('should throw UnauthorizedException when signature or timestamp is missing', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when timestamp has clock drift > 5 minutes', () => {
    const expiredTimestamp = Date.now() - 6 * 60 * 1000;
    const context = createMockContext({
      'x-service-signature': 'somehash',
      'x-service-timestamp': expiredTimestamp.toString(),
    });
    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException(
        'Inter-service signature expired or excessive clock drift detected',
      ),
    );
  });

  it('should throw UnauthorizedException when HMAC signature does not match', () => {
    const timestamp = Date.now();
    const context = createMockContext({
      'x-service-id': 'edge-mumbai-01',
      'x-service-timestamp': timestamp.toString(),
      'x-service-signature':
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Invalid inter-service HMAC signature'),
    );
  });

  it('should successfully authenticate valid HMAC signature and attach ADMIN user', () => {
    const timestamp = Date.now();
    const serviceId = 'edge-mumbai-01';
    const method = 'POST';
    const path = '/api/v1/admin/health/heartbeat';
    const payload = `${serviceId}:${method}:${path}:${timestamp}`;
    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    const context = createMockContext(
      {
        'x-service-id': serviceId,
        'x-service-timestamp': timestamp.toString(),
        'x-service-signature': validSignature,
      },
      method,
      path,
    );

    const result = guard.canActivate(context);
    expect(result).toBe(true);
    const req = context.switchToHttp().getRequest();
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe(serviceId);
    expect(req.user.role).toBe(Role.ADMIN);
    expect(req.user.isInterService).toBe(true);
  });
});
