/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './roles.guard';
import { Role } from '@prisma/client';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  const createMockContext = (user?: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
  };

  it('should allow access if no roles are required on route', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException if user is not attached to request', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow ADMIN to access ADMIN routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockContext({ id: 'u1', role: Role.ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow ADMIN to access STREAMER and VIEWER routes (Role Hierarchy)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.STREAMER]);
    const context = createMockContext({ id: 'u1', role: Role.ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow STREAMER to access STREAMER routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.STREAMER]);
    const context = createMockContext({ id: 'u2', role: Role.STREAMER });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should DENY STREAMER from accessing ADMIN routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockContext({ id: 'u2', role: Role.STREAMER });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow VIEWER to access VIEWER routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.VIEWER]);
    const context = createMockContext({ id: 'u3', role: Role.VIEWER });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should DENY VIEWER from accessing STREAMER or ADMIN routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.STREAMER]);
    const context = createMockContext({ id: 'u3', role: Role.VIEWER });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow INTERNAL to access INTERNAL routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.INTERNAL]);
    const context = createMockContext({ id: 'edge-1', role: Role.INTERNAL });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should DENY INTERNAL from accessing ADMIN routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.ADMIN]);
    const context = createMockContext({ id: 'edge-1', role: Role.INTERNAL });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should DENY ADMIN from accessing strictly INTERNAL routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.INTERNAL]);
    const context = createMockContext({ id: 'u1', role: Role.ADMIN });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow both ADMIN and INTERNAL when route allows both', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([Role.ADMIN, Role.INTERNAL]);
    const adminCtx = createMockContext({ id: 'u1', role: Role.ADMIN });
    const internalCtx = createMockContext({
      id: 'edge-1',
      role: Role.INTERNAL,
    });
    expect(guard.canActivate(adminCtx)).toBe(true);
    expect(guard.canActivate(internalCtx)).toBe(true);
  });
});
