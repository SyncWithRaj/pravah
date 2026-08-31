import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';
import { InterServiceGuard } from './inter-service.guard';
import { Request } from 'express';

@Injectable()
export class UnifiedAuthGuard implements CanActivate {
  constructor(
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly apiKeyGuard: ApiKeyGuard,
    private readonly interServiceGuard: InterServiceGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // 1. Check Inter-Service signature first if present
    if (request.headers['x-service-signature']) {
      const passed = this.interServiceGuard.canActivate(context);
      if (passed) return true;
    }

    // 2. Check API Key header next if present
    if (
      request.headers['x-api-key'] ||
      request.headers['x-edge-api-key'] ||
      (typeof request.headers['authorization'] === 'string' &&
        request.headers['authorization'].startsWith('ApiKey '))
    ) {
      const passed = await this.apiKeyGuard.canActivate(context);
      if (passed) return true;
    }

    // 3. Fallback to standard Bearer JWT token validation
    try {
      const passed = (await this.jwtAuthGuard.canActivate(context)) as boolean;
      if (passed) return true;
    } catch {
      throw new UnauthorizedException(
        'Authentication required: Provide a valid Bearer JWT token, API key (x-api-key), or Inter-Service signature',
      );
    }

    throw new UnauthorizedException('Authentication failed');
  }
}
