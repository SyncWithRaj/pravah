import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { REDIS_PASSWORD } from '../common/redis/redis.constants';

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days in seconds

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private redis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Allows injecting a mock Redis client for unit testing
   */
  setRedis(redisClient?: Redis) {
    this.redis = redisClient;
  }

  onModuleInit() {
    try {
      const password = REDIS_PASSWORD();
      this.redis = new Redis({
        host: this.configService.get<string>('REDIS_HOST') || 'localhost',
        port: this.configService.get<number>('REDIS_PORT') || 6379,
        ...(password ? { password } : {}),
        lazyConnect: true,
      });
      this.redis.connect().catch(() => {});
    } catch {
      // Redis optional in isolated test environments
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async register(registerDto: RegisterDto) {
    const { email, username, password } = registerDto;

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        throw new ConflictException('Email already in use');
      }
      throw new ConflictException('Username already taken');
    }

    const hashedPassword = await argon2.hash(password);

    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        passwordHash: hashedPassword,
      },
    });

    const { passwordHash, ...userWithoutPassword } = user;
    void passwordHash;
    return userWithoutPassword;
  }

  async login(loginDto: LoginDto) {
    const { identifier, password } = loginDto;

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessPayload = { sub: user.id, email: user.email };
    const jti = crypto.randomUUID();
    const refreshPayload = { sub: user.id, email: user.email, jti };

    const [access_token, refresh_token] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
          '15m') as JwtSignOptions['expiresIn'],
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ||
          '7d') as JwtSignOptions['expiresIn'],
      }),
    ]);

    const familyId = crypto.randomUUID();
    if (this.redis) {
      try {
        if (typeof this.redis.pipeline === 'function') {
          const pipe = this.redis.pipeline();
          pipe.set(
            `auth:refresh:${user.id}:${jti}`,
            familyId,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          pipe.sadd(`auth:refreshfamily:${familyId}`, jti);
          pipe.expire(`auth:refreshfamily:${familyId}`, REFRESH_TOKEN_TTL_SECONDS);
          pipe.sadd(`auth:refresh:user:${user.id}`, jti);
          pipe.expire(`auth:refresh:user:${user.id}`, REFRESH_TOKEN_TTL_SECONDS);
          await pipe.exec();
        } else {
          await this.redis.set(
            `auth:refresh:${user.id}:${jti}`,
            familyId,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          if (typeof this.redis.sadd === 'function') {
            await this.redis.sadd(`auth:refreshfamily:${familyId}`, jti);
            await this.redis.sadd(`auth:refresh:user:${user.id}`, jti);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Redis failure';
        this.logger.error(`Failed to store refresh token in Redis: ${msg}`);
      }
    }

    const { passwordHash, ...userWithoutPassword } = user;
    void passwordHash;
    return {
      access_token,
      refresh_token,
      user: userWithoutPassword,
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        jti?: string;
      }>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User no longer exists');
      }

      // Legacy tokens minted before this deploy have no jti. Reject explicitly.
      if (!payload.jti) {
        throw new UnauthorizedException(
          'Legacy refresh token not supported. Please log in again.',
        );
      }

      // Redis is required for the refresh path: fail closed if unavailable
      if (!this.redis) {
        this.logger.error('Redis connection unavailable for refresh token verification');
        throw new UnauthorizedException('Authentication service unavailable');
      }

      const tokenKey = `auth:refresh:${user.id}:${payload.jti}`;
      let tokenState: string | null = null;
      try {
        tokenState = await this.redis.get(tokenKey);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Redis failure';
        this.logger.error(`Failed to verify refresh token in Redis: ${msg}`);
        throw new UnauthorizedException('Authentication service unavailable');
      }

      // 1. Detect reuse of an already-consumed token in a family
      if (tokenState?.startsWith('consumed:')) {
        const familyId = tokenState.substring('consumed:'.length);
        await this.revokeFamily(user.id, familyId);
        throw new UnauthorizedException(
          'Refresh token reuse detected. Revoked token family.',
        );
      }

      // 2. Token was never issued, or was already purged
      if (!tokenState) {
        throw new UnauthorizedException('Refresh token has been revoked or reused');
      }

      const familyId = tokenState === 'active' ? crypto.randomUUID() : tokenState;

      const accessPayload = { sub: user.id, email: user.email };
      const newJti = crypto.randomUUID();
      const newRefreshPayload = { sub: user.id, email: user.email, jti: newJti };

      const [new_access_token, new_refresh_token] = await Promise.all([
        this.jwtService.signAsync(accessPayload, {
          secret: this.configService.get<string>('JWT_SECRET'),
          expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
            '15m') as JwtSignOptions['expiresIn'],
        }),
        this.jwtService.signAsync(newRefreshPayload, {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
          expiresIn: (this.configService.get<string>(
            'JWT_REFRESH_EXPIRES_IN',
          ) || '7d') as JwtSignOptions['expiresIn'],
        }),
      ]);

      // 3. Rotate out token: mark old token as consumed and register new token in family
      try {
        if (typeof this.redis.pipeline === 'function') {
          const pipe = this.redis.pipeline();
          pipe.set(
            tokenKey,
            `consumed:${familyId}`,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          pipe.set(
            `auth:refresh:${user.id}:${newJti}`,
            familyId,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          pipe.sadd(`auth:refreshfamily:${familyId}`, newJti);
          pipe.expire(`auth:refreshfamily:${familyId}`, REFRESH_TOKEN_TTL_SECONDS);
          pipe.sadd(`auth:refresh:user:${user.id}`, newJti);
          pipe.expire(`auth:refresh:user:${user.id}`, REFRESH_TOKEN_TTL_SECONDS);
          await pipe.exec();
        } else {
          await this.redis.set(
            tokenKey,
            `consumed:${familyId}`,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          await this.redis.set(
            `auth:refresh:${user.id}:${newJti}`,
            familyId,
            'EX',
            REFRESH_TOKEN_TTL_SECONDS,
          );
          if (typeof this.redis.sadd === 'function') {
            await this.redis.sadd(`auth:refreshfamily:${familyId}`, newJti);
            await this.redis.sadd(`auth:refresh:user:${user.id}`, newJti);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Redis failure';
        this.logger.error(`Failed to rotate refresh token in Redis: ${msg}`);
        throw new UnauthorizedException('Authentication service unavailable');
      }

      return {
        access_token: new_access_token,
        refresh_token: new_refresh_token,
      };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async revokeFamily(userId: string, familyId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const familyKey = `auth:refreshfamily:${familyId}`;
      const jtis =
        typeof this.redis.smembers === 'function'
          ? await this.redis.smembers(familyKey)
          : [];
      if (jtis && jtis.length > 0) {
        for (const jti of jtis) {
          await this.redis.del(`auth:refresh:${userId}:${jti}`);
          if (typeof this.redis.srem === 'function') {
            await this.redis.srem(`auth:refresh:user:${userId}`, jti);
          }
        }
        await this.redis.del(familyKey);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Redis failure';
      this.logger.error(`Failed to revoke refresh family ${familyId}: ${msg}`);
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const userKey = `auth:refresh:user:${userId}`;
      const jtis =
        typeof this.redis.smembers === 'function'
          ? await this.redis.smembers(userKey)
          : [];
      if (jtis && jtis.length > 0) {
        for (const jti of jtis) {
          await this.redis.del(`auth:refresh:${userId}:${jti}`);
        }
        await this.redis.del(userKey);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Redis failure';
      this.logger.error(`Failed to revoke all user tokens for ${userId}: ${msg}`);
    }
  }
}
