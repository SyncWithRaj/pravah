import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    guard = new JwtAuthGuard();
  });

  it('returns the authenticated user', () => {
    const user = { id: 'user-1', role: 'ADMIN' };

    expect(
      guard.handleRequest<{ id: string; role: string }>(null, user, undefined),
    ).toBe(user);
  });

  it('rethrows errors raised by the passport strategy', () => {
    const error = new Error('strategy failed');

    expect(() => guard.handleRequest(error, false, undefined)).toThrow(error);
  });

  it('maps a missing user to an authentication error', () => {
    expect(() => guard.handleRequest(null, false, undefined)).toThrow(
      new UnauthorizedException('Authentication token is missing or invalid'),
    );
  });

  it('uses string failures from passport as the message', () => {
    expect(() => guard.handleRequest('jwt expired', null, undefined)).toThrow(
      new UnauthorizedException('jwt expired'),
    );
  });
});
