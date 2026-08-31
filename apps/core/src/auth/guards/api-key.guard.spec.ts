/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import * as crypto from 'crypto';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyGuard,
        {
          provide: PrismaService,
          useValue: {
            apiKey: {
              findUnique: jest.fn(),
              update: jest.fn().mockResolvedValue({}),
            },
          },
        },
      ],
    }).compile();

    guard = module.get<ApiKeyGuard>(ApiKeyGuard);
    prisma = module.get<PrismaService>(PrismaService);
  });

  const createMockContext = (
    headers: Record<string, string>,
  ): ExecutionContext => {
    const req = {
      headers,
      user: undefined,
      apiKey: undefined,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  };

  it('should throw UnauthorizedException when no API key header is present', async () => {
    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when API key is not found in database', async () => {
    jest.spyOn(prisma.apiKey, 'findUnique').mockResolvedValue(null);
    const context = createMockContext({ 'x-api-key': 'prv_live_invalid12345' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when API key is revoked / inactive', async () => {
    jest.spyOn(prisma.apiKey, 'findUnique').mockResolvedValue({
      id: 'key-1',
      name: 'Revoked Key',
      keyHash: 'dummyhash',
      keyPrefix: 'prv_live_...',
      role: Role.STREAMER,
      userId: 'user-1',
      expiresAt: null,
      isActive: false,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'user-1', email: 'streamer@test.com' },
    } as any);

    const context = createMockContext({ 'x-api-key': 'prv_live_revoked' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('API key has been revoked'),
    );
  });

  it('should throw UnauthorizedException when API key has expired', async () => {
    const pastDate = new Date(Date.now() - 100000);
    jest.spyOn(prisma.apiKey, 'findUnique').mockResolvedValue({
      id: 'key-2',
      name: 'Expired Key',
      keyHash: 'dummyhash',
      keyPrefix: 'prv_live_...',
      role: Role.STREAMER,
      userId: 'user-1',
      expiresAt: pastDate,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'user-1', email: 'streamer@test.com' },
    } as any);

    const context = createMockContext({ 'x-api-key': 'prv_live_expired' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('API key has expired'),
    );
  });

  it('should successfully authenticate valid API key and attach user context', async () => {
    const rawKey = 'prv_live_supervalidkey1234567890';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    jest.spyOn(prisma.apiKey, 'findUnique').mockResolvedValue({
      id: 'key-3',
      name: 'Production Key',
      keyHash,
      keyPrefix: 'prv_live_superval...',
      role: Role.STREAMER,
      userId: 'user-100',
      expiresAt: null,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'user-100', email: 'creator@pravah.io' },
    } as any);

    const context = createMockContext({ 'x-api-key': rawKey });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    const req = context.switchToHttp().getRequest();
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe('user-100');
    expect(req.user.role).toBe(Role.STREAMER);
    expect(req.user.isApiKey).toBe(true);
  });
});
