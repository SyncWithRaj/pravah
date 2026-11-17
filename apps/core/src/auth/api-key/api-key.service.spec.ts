import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiKeyService } from './api-key.service';

type PrismaMock = {
  apiKey: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = {
      apiKey: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new ApiKeyService(prisma as unknown as PrismaService);
  });

  describe('createApiKey', () => {
    it('hashes the plaintext key and returns it only once', async () => {
      prisma.apiKey.create.mockImplementation(
        (args: { data: { name: string; keyPrefix: string } }) => ({
          id: 'key-1',
          name: args.data.name,
          keyPrefix: args.data.keyPrefix,
          role: Role.USER,
          expiresAt: null,
          createdAt: new Date('2026-01-01'),
        }),
      );

      const result = await service.createApiKey('user-1', {
        name: 'CI key',
      });

      expect(result.apiKey).toMatch(/^prv_live_[a-f0-9]{48}$/);
      expect(result.keyPrefix).toMatch(/^prv_live_[a-f0-9]{8}\.\.\.$/);
      expect(result.message).toContain('not be able to view it again');
      expect(result.role).toBe(Role.USER);

      const createCall = prisma.apiKey.create.mock.calls[0] as unknown as [
        {
          data: {
            name: string;
            keyHash: string;
            keyPrefix: string;
            role: Role;
            userId?: string;
            expiresAt: Date | null;
            isActive: boolean;
          };
        },
      ];
      const data = createCall[0].data;
      expect(data.name).toBe('CI key');
      expect(data.keyHash).toBe(
        crypto.createHash('sha256').update(result.apiKey).digest('hex'),
      );
      expect(data.keyPrefix).toBe(result.keyPrefix);
      expect(data.userId).toBe('user-1');
      expect(data.expiresAt).toBeNull();
      expect(data.isActive).toBe(true);
    });

    it('honours an explicit role and expiry', async () => {
      prisma.apiKey.create.mockResolvedValue({
        id: 'key-1',
        name: 'Admin key',
        keyPrefix: 'prv_live_12345678...',
        role: Role.ADMIN,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      });

      const result = await service.createApiKey(null, {
        name: 'Admin key',
        role: Role.ADMIN,
        expiresInDays: 30,
      });

      expect(result.role).toBe(Role.ADMIN);
      const createCall = prisma.apiKey.create.mock.calls[0] as unknown as [
        {
          data: {
            userId?: string;
            expiresAt: Date | null;
          };
        },
      ];
      expect(createCall[0].data.userId).toBeUndefined();
      expect(createCall[0].data.expiresAt).toBeInstanceOf(Date);
      const remainingMs =
        (createCall[0].data.expiresAt as Date).getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
      expect(remainingMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    });

    it('treats non-positive expiry as no expiry', async () => {
      prisma.apiKey.create.mockResolvedValue({
        id: 'key-1',
        name: 'Permanent',
        keyPrefix: 'prv_live_12345678...',
        role: Role.USER,
        expiresAt: null,
        createdAt: new Date(),
      });

      await service.createApiKey('user-1', {
        name: 'Permanent',
        expiresInDays: 0,
      });

      const createCall = prisma.apiKey.create.mock.calls[0] as unknown as [
        { data: { expiresAt: Date | null } },
      ];
      expect(createCall[0].data.expiresAt).toBeNull();
    });
  });

  it('lists only active keys for a user', async () => {
    prisma.apiKey.findMany.mockResolvedValue([]);

    await service.listUserApiKeys('user-1');

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', isActive: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const listCall = prisma.apiKey.findMany.mock.calls[0] as unknown as [
      { select: Record<string, boolean> },
    ];
    expect(listCall[0].select).toEqual(
      expect.objectContaining({
        id: true,
        name: true,
        keyPrefix: true,
        role: true,
      }),
    );
  });

  it('lists all keys with their owning user for admins', async () => {
    prisma.apiKey.findMany.mockResolvedValue([]);

    await service.listAllApiKeys();

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
      }),
    );
    const listCall = prisma.apiKey.findMany.mock.calls[0] as unknown as [
      {
        select: {
          userId?: boolean;
          user?: {
            select: { id: boolean; email: boolean; username: boolean };
          };
        };
      },
    ];
    expect(listCall[0].select.userId).toBe(true);
    expect(listCall[0].select.user).toEqual({
      select: { id: true, email: true, username: true },
    });
  });

  describe('revokeApiKey', () => {
    it('throws when the key does not exist', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeApiKey('key-1', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids a non-owner non-admin', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        userId: 'user-2',
      });

      await expect(
        service.revokeApiKey('key-1', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('allows the owner to revoke a key', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
      });
      prisma.apiKey.update.mockResolvedValue({
        id: 'key-1',
        isActive: false,
      });

      await service.revokeApiKey('key-1', 'user-1');

      expect(prisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: { isActive: false },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          isActive: true,
          updatedAt: true,
        },
      });
    });

    it('allows an admin to revoke another user’s key', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        userId: 'user-2',
      });
      prisma.apiKey.update.mockResolvedValue({
        id: 'key-1',
        isActive: false,
      });

      await service.revokeApiKey('key-1', 'admin-1', true);

      expect(prisma.apiKey.update).toHaveBeenCalled();
    });
  });
});
