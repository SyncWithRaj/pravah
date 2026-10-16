import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { verifyServiceSignature } from '../../common/security/service-hmac.util';

@Injectable()
export class InterServiceGuard implements CanActivate {
  private readonly maxClockDriftMs = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (typeof context.getType === 'function' && context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      Request & {
        user?: {
          id: string;
          email: string;
          role: Role;
          isInterService: boolean;
        };
      }
    >();

    const signature = request.headers['x-service-signature'];
    const timestampStr = request.headers['x-service-timestamp'];
    const rawServiceId = request.headers['x-service-id'];
    const serviceId =
      typeof rawServiceId === 'string' && rawServiceId.trim()
        ? rawServiceId.trim()
        : 'pravah-edge-node';

    if (
      typeof signature !== 'string' ||
      typeof timestampStr !== 'string' ||
      !signature.trim() ||
      !timestampStr.trim()
    ) {
      throw new UnauthorizedException(
        'Missing inter-service authentication headers (x-service-signature, x-service-timestamp)',
      );
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new UnauthorizedException(
        'Invalid x-service-timestamp header format',
      );
    }

    const now = Date.now();
    if (Math.abs(now - timestamp) > this.maxClockDriftMs) {
      throw new UnauthorizedException(
        'Inter-service signature expired or excessive clock drift detected',
      );
    }

    const secret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
    if (!secret) {
      throw new UnauthorizedException(
        'INTERNAL_SERVICE_SECRET is not configured',
      );
    }

    const method = request.method.toUpperCase();
    const url = request.url;
    const isValid = verifyServiceSignature(
      serviceId,
      method,
      url,
      timestamp,
      signature,
      secret,
      request.body,
      this.maxClockDriftMs,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid inter-service HMAC signature');
    }

    // Attach system-level internal user context to request
    request.user = {
      id: serviceId,
      email: `${serviceId}@internal.pravah`,
      role: Role.INTERNAL,
      isInterService: true,
    };

    return true;
  }
}
