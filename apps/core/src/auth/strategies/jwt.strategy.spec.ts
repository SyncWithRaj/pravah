import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

type PrismaMock = {
  user: { findUnique: jest.Mock };
};

const config = (secret?: string): ConfigService =>
  ({ get: jest.fn().mockReturnValue(secret) }) as unknown as ConfigService;

describe('JwtStrategy', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
  });

  it('requires JWT_SECRET at construction', () => {
    expect(
      () => new JwtStrategy(prisma as unknown as PrismaService, config()),
    ).toThrow('JWT_SECRET is required');
  });

  it('returns the database user without the password hash', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'secret-hash',
      role: Role.USER,
    });
    const strategy = new JwtStrategy(
      prisma as unknown as PrismaService,
      config('jwt-secret'),
    );

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'user@example.com',
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
    expect(result).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      role: Role.USER,
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('rejects tokens for deleted users', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const strategy = new JwtStrategy(
      prisma as unknown as PrismaService,
      config('jwt-secret'),
    );

    await expect(
      strategy.validate({ sub: 'missing', email: 'missing@example.com' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
