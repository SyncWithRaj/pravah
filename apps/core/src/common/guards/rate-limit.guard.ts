import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  THROTTLE_LIMIT_KEY,
  THROTTLE_TTL_KEY,
} from '../decorators/throttle.decorator';
import { REDIS_PASSWORD } from '../redis/redis.constants';

@Injectable()
export class RateLimitGuard
  implements CanActivate, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RateLimitGuard.name);
  private redis?: Redis;
  private readonly memoryStore = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit() {
    try {
      const password = REDIS_PASSWORD();
      this.redis = new Redis({
        host: this.configService?.get<string>('REDIS_HOST') || 'localhost',
        port: this.configService?.get<number>('REDIS_PORT') || 6379,
        ...(password ? { password } : {}),
        lazyConnect: true,
      });
      this.redis.connect().catch(() => {});
    } catch {
      // Memory store fallback
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (typeof context.getType === 'function' && context.getType() !== 'http') {
      return true;
    }

    const limit =
      this.reflector.getAllAndOverride<number>(THROTTLE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 120;

    const ttl =
      this.reflector.getAllAndOverride<number>(THROTTLE_TTL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 60;

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      socket?: { remoteAddress?: string };
      url?: string;
    }>();
    let clientIp: string =
      request.ip || request.socket?.remoteAddress || 'unknown';
    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }
    const route =
      typeof request.url === 'string' ? request.url.split('?')[0] : 'unknown';
    const key = `ratelimit:${route}:${clientIp}`;

    let currentCount = 1;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, ttl);
        }
        currentCount = count;
      } catch {
        currentCount = this.checkMemory(key, ttl);
      }
    } else {
      currentCount = this.checkMemory(key, ttl);
    }

    if (currentCount > limit) {
      throw new HttpException(
        'Too many requests, please try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private checkMemory(key: string, ttlSeconds: number): number {
    const now = Date.now();
    const record = this.memoryStore.get(key);
    if (!record || record.expiresAt < now) {
      this.memoryStore.set(key, {
        count: 1,
        expiresAt: now + ttlSeconds * 1000,
      });
      return 1;
    }
    record.count++;
    return record.count;
  }
}
