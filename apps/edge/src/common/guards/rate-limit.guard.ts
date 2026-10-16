import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  THROTTLE_LIMIT_KEY,
  THROTTLE_TTL_KEY,
} from '../decorators/throttle.decorator';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly memoryStore = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (typeof context.getType === 'function' && context.getType() !== 'http') {
      return true;
    }

    const limit =
      this.reflector.getAllAndOverride<number>(THROTTLE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 60; // Tighter default for Edge

    const ttl =
      this.reflector.getAllAndOverride<number>(THROTTLE_TTL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 60;

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      raw?: { socket?: { remoteAddress?: string } };
      socket?: { remoteAddress?: string };
      routerPath?: string;
      url?: string;
    }>();

    let clientIp: string =
      request.ip ||
      request.raw?.socket?.remoteAddress ||
      request.socket?.remoteAddress ||
      'unknown';

    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }

    const route =
      request.routerPath || request.url?.split('?')[0] || 'unknown';
    const key = `ratelimit:${route}:${clientIp}`;

    const now = Date.now();
    const existing = this.memoryStore.get(key);

    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      if (existing.count > limit) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Rate limit exceeded. Maximum ${limit} requests per ${ttl} seconds.`,
            error: 'Too Many Requests',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } else {
      this.memoryStore.set(key, { count: 1, expiresAt: now + ttl * 1000 });
      // Periodically clean up expired entries
      if (this.memoryStore.size > 5000) {
        for (const [k, v] of this.memoryStore.entries()) {
          if (v.expiresAt <= now) {
            this.memoryStore.delete(k);
          }
        }
      }
    }

    return true;
  }
}
