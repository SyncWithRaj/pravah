/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EdgeNodeStatus, Role, User } from '@prisma/client';
import { Request, Response } from 'express';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';
import {
  RoutingDecision,
  RoutingService,
} from '../common/routing/routing.service';
import { UnifiedAuthGuard } from '../auth';

type DownloadServiceMock = {
  assertVersionAccess: jest.Mock;
};

type RoutingServiceMock = {
  selectBestEdge: jest.Mock;
};

type ConfigServiceMock = {
  get: jest.Mock;
};

describe('DownloadController version authorization', () => {
  let controller: DownloadController;
  let downloadService: DownloadServiceMock;
  let routingService: RoutingServiceMock;
  let configService: ConfigServiceMock;

  beforeEach(async () => {
    downloadService = { assertVersionAccess: jest.fn() };
    routingService = { selectBestEdge: jest.fn() };
    configService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DownloadController],
      providers: [
        { provide: DownloadService, useValue: downloadService },
        { provide: RoutingService, useValue: routingService },
        { provide: ConfigService, useValue: configService },
      ],
    })
      .overrideGuard(UnifiedAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DownloadController>(DownloadController);
  });

  const mockUser = (id: string): User => ({
    id,
    email: `${id}@example.com`,
    username: id,
    passwordHash: 'test-hash',
    role: Role.USER,
    isVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const mockRequest = (): Request => ({ headers: {} }) as unknown as Request;

  const mockResponse = (): Response =>
    ({
      setHeader: jest.fn(),
      redirect: jest.fn(),
    }) as unknown as Response;

  it('rejects a non-owner before selecting an edge', async () => {
    downloadService.assertVersionAccess.mockRejectedValue(
      new ForbiddenException('Access denied'),
    );
    const res = mockResponse();

    await expect(
      controller.downloadVersion(
        mockUser('user-b'),
        'file-a',
        1,
        mockRequest(),
        res,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(downloadService.assertVersionAccess).toHaveBeenCalledWith(
      'user-b',
      'file-a',
      1,
    );
    expect(routingService.selectBestEdge).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects the owner to the selected edge', async () => {
    const decision: RoutingDecision = {
      edge: {
        id: 'edge-node-01',
        name: 'Mumbai Edge',
        region: 'ap-south-1',
        endpointUrl: 'http://edge-1:3001',
        latitude: 19.076,
        longitude: 72.8777,
        status: EdgeNodeStatus.HEALTHY,
        missedCycles: 0,
      },
      distanceKm: null,
      strategy: 'exact-region',
    };

    downloadService.assertVersionAccess.mockResolvedValue(undefined);
    routingService.selectBestEdge.mockReturnValue(decision);
    configService.get.mockReturnValue('test-signing-secret');

    const res = mockResponse();

    await controller.downloadVersion(
      mockUser('user-a'),
      'file-a',
      2,
      mockRequest(),
      res,
    );

    expect(downloadService.assertVersionAccess).toHaveBeenCalledWith(
      'user-a',
      'file-a',
      2,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('/edge/content/file-a?v=2'),
    );
  });
});
