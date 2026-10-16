/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Role } from '@prisma/client';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };
  let jwtService: {
    signAsync: jest.Mock;
    verifyAsync: jest.Mock;
  };
  let configService: {
    get: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    jwtService = {
      signAsync: jest.fn(),
      verifyAsync: jest.fn(),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return 'test-jwt-secret';
        if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
        if (key === 'JWT_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('refreshToken', () => {
    const mockUser = {
      id: 'user-uuid-123',
      email: 'user@example.com',
      username: 'testuser',
      passwordHash: 'hashedpassword',
      role: Role.USER,
      isVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should reject legacy tokens with no jti (fail closed)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        // no jti
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      await expect(
        service.refreshToken('legacy-refresh-token'),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Legacy refresh token not supported. Please log in again.',
        ),
      );
    });

    it('should reject refresh when Redis is disconnected (fail closed)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        jti: 'jti-uuid-456',
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      // Explicitly set redis to undefined
      service.setRedis(undefined);

      await expect(service.refreshToken('valid-looking-token')).rejects.toThrow(
        new UnauthorizedException('Authentication service unavailable'),
      );
    });

    it('should reject refresh when Redis errors on lookup (fail closed, never fail open)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        jti: 'jti-uuid-456',
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const mockRedis = {
        get: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
        del: jest.fn(),
        setex: jest.fn(),
        status: 'ready',
      } as unknown as Redis;

      service.setRedis(mockRedis);

      await expect(service.refreshToken('valid-token')).rejects.toThrow(
        new UnauthorizedException('Authentication service unavailable'),
      );
    });

    it('should reject revoked or reused refresh token (jti not in Redis)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        jti: 'revoked-jti',
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const mockRedis = {
        get: jest.fn().mockResolvedValue(null), // Revoked/missing in Redis
        del: jest.fn(),
        setex: jest.fn(),
        status: 'ready',
      } as unknown as Redis;

      service.setRedis(mockRedis);

      await expect(service.refreshToken('revoked-token')).rejects.toThrow(
        new UnauthorizedException('Refresh token has been revoked or reused'),
      );
    });

    it('should rotate token and return new tokens when refresh token is valid and active', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        jti: 'active-jti-789',
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);
      jwtService.signAsync
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token');

      const mockRedis = {
        get: jest.fn().mockResolvedValue('family-uuid-1'),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
        sadd: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
        status: 'ready',
      } as unknown as Redis;

      service.setRedis(mockRedis);

      const result = await service.refreshToken('valid-active-token');

      expect(result).toEqual({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      });

      // Verify old token marked consumed with family id
      expect(mockRedis.set).toHaveBeenCalledWith(
        `auth:refresh:${mockUser.id}:active-jti-789`,
        'consumed:family-uuid-1',
        'EX',
        7 * 24 * 3600,
      );
      // Verify new token stored with same family id
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^auth:refresh:${mockUser.id}:`)),
        'family-uuid-1',
        'EX',
        7 * 24 * 3600,
      );
    });

    it('should detect reuse of already-consumed token and invalidate sibling tokens in the same family but not other sessions', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: mockUser.id,
        email: mockUser.email,
        jti: 'reused-jti-101',
      });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const deletedKeys: string[] = [];
      const mockRedis = {
        get: jest.fn().mockResolvedValue('consumed:family-A'),
        smembers: jest.fn().mockImplementation((key: string) => {
          if (key === 'auth:refreshfamily:family-A') {
            return Promise.resolve(['reused-jti-101', 'sibling-jti-102']);
          }
          return Promise.resolve([]);
        }),
        del: jest.fn().mockImplementation((key: string) => {
          deletedKeys.push(key);
          return Promise.resolve(1);
        }),
        srem: jest.fn().mockResolvedValue(1),
        status: 'ready',
      } as unknown as Redis;

      service.setRedis(mockRedis);

      await expect(service.refreshToken('reused-token')).rejects.toThrow(
        new UnauthorizedException(
          'Refresh token reuse detected. Revoked token family.',
        ),
      );

      // Verify all tokens in family-A were revoked
      expect(deletedKeys).toContain(
        `auth:refresh:${mockUser.id}:reused-jti-101`,
      );
      expect(deletedKeys).toContain(
        `auth:refresh:${mockUser.id}:sibling-jti-102`,
      );
      expect(deletedKeys).toContain('auth:refreshfamily:family-A');

      // Verify other session tokens (e.g. from family-B) were NOT touched
      expect(deletedKeys).not.toContain(
        `auth:refresh:${mockUser.id}:other-session-jti`,
      );
    });
  });
});
