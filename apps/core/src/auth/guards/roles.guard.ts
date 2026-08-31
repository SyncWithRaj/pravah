import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

// Role hierarchy definition: higher level roles inherit permissions of lower roles
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [Role.ADMIN]: [Role.ADMIN, Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.STREAMER]: [Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.VIEWER]: [Role.VIEWER, Role.USER],
  [Role.USER]: [Role.USER, Role.VIEWER],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: { id?: string; email?: string; role?: Role };
    }>();
    const user = request.user;

    if (!user || !user.role) {
      throw new ForbiddenException(
        'Access denied: Authentication required for role verification',
      );
    }

    const userGrantedRoles = ROLE_HIERARCHY[user.role] || [user.role];
    const hasPermission = requiredRoles.some((role) =>
      userGrantedRoles.includes(role),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Access denied: Required role [${requiredRoles.join(', ')}] but user has role [${user.role}]`,
      );
    }

    return true;
  }
}
