jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@prisma/client', () => {
  class PrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
  }
  return { PrismaClient };
});

import { PrismaService } from './prisma.service';

type PrismaInternals = {
  $connect: jest.Mock;
  $disconnect: jest.Mock;
};

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(() => {
    service = new PrismaService();
  });

  it('connects during module init', async () => {
    await service.onModuleInit();

    expect((service as unknown as PrismaInternals).$connect).toHaveBeenCalled();
  });

  it('disconnects during module destroy', async () => {
    await service.onModuleDestroy();

    expect(
      (service as unknown as PrismaInternals).$disconnect,
    ).toHaveBeenCalled();
  });
});
