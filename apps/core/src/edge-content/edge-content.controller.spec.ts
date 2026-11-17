import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { CacheManagerService } from '../common/cache-manager/cache-manager.service';
import { MinioService } from '../common/minio/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { EdgeContentController } from './edge-content.controller';

type PrismaMock = {
  file: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};

type CacheMock = {
  getBinary: jest.Mock;
};

type JwtMock = {
  verifyAsync: jest.Mock;
};

type ConfigMock = {
  get: jest.Mock;
};

describe('EdgeContentController authorization', () => {
  let controller: EdgeContentController;
  let prisma: PrismaMock;
  let cache: CacheMock;
  let jwt: JwtMock;
  let config: ConfigMock;

  beforeEach(() => {
    prisma = {
      file: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    cache = { getBinary: jest.fn() };
    jwt = { verifyAsync: jest.fn() };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_SECRET') return 'jwt-secret';
        if (key === 'EDGE_URL_SIGNING_SECRET') return 'edge-secret';
        if (key === 'INTERNAL_SERVICE_SECRET') return 'service-secret';
        return undefined;
      }),
    };

    controller = new EdgeContentController(
      cache as unknown as CacheManagerService,
      {} as unknown as MinioService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      jwt as unknown as JwtService,
    );
  });

  const request = (): Request =>
    ({
      headers: { authorization: 'Bearer token' },
      query: {},
      method: 'GET',
      url: '/edge/content/file-a?v=1',
    }) as unknown as Request;

  const response = (): Response =>
    ({
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
      json: jest.fn(),
    }) as unknown as Response;

  it('rejects a JWT for a file owned by another user before reading the cache', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-b' });
    prisma.file.findUnique.mockResolvedValue({ ownerId: 'user-a' });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });

    await expect(
      controller.getEdgeContent('file-a', 1, request(), response()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.file.findUnique).toHaveBeenCalledWith({
      where: { id: 'file-a' },
      select: { ownerId: true },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-b' },
      select: { role: true },
    });
    expect(cache.getBinary).not.toHaveBeenCalled();
  });

  it("allows an admin JWT to reach the cache for another user's file", async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-admin' });
    prisma.file.findUnique.mockResolvedValue({ ownerId: 'user-a' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    cache.getBinary.mockRejectedValue(new Error('stop-after-authz'));

    await expect(
      controller.getEdgeContent('file-a', 1, request(), response()),
    ).rejects.toThrow('stop-after-authz');

    expect(cache.getBinary).toHaveBeenCalledWith('file-a', '1', 0);
  });
});
