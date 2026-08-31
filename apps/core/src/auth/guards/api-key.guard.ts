import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Role, ApiKey } from '@prisma/client';
import * as crypto from 'crypto';
import { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  isApiKey?: boolean;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthenticatedUser;
        apiKey?: ApiKey;
      }
    >();

    const rawKey = this.extractApiKey(request);
    if (!rawKey) {
      throw new UnauthorizedException(
        'API key is required in x-api-key or x-edge-api-key header',
      );
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const apiKeyRecord = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });

    if (!apiKeyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!apiKeyRecord.isActive) {
      throw new UnauthorizedException('API key has been revoked');
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Update lastUsedAt asynchronously without blocking the request
    this.prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {
        // Suppress background update error
      });

    // Populate user and apiKey metadata on request
    request.user = {
      id: apiKeyRecord.userId || apiKeyRecord.id,
      email: apiKeyRecord.user?.email || `${apiKeyRecord.name}@apikey.local`,
      role: apiKeyRecord.role,
      isApiKey: true,
    };
    request.apiKey = apiKeyRecord;

    return true;
  }

  private extractApiKey(request: Request): string | null {
    const xApiKey = request.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.trim()) {
      return xApiKey.trim();
    }

    const xEdgeApiKey = request.headers['x-edge-api-key'];
    if (typeof xEdgeApiKey === 'string' && xEdgeApiKey.trim()) {
      return xEdgeApiKey.trim();
    }

    const authHeader = request.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('ApiKey ')) {
      return authHeader.substring(7).trim();
    }

    return null;
  }
}
