import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    // Add any custom authentication logic here if needed
    return super.canActivate(context);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(
    err: unknown,
    user: unknown,
    _info: unknown,
  ): TUser {
    // You can throw an exception based on either "info" or "err" arguments
    if (err || !user) {
      if (err instanceof Error) {
        throw err;
      }
      throw new UnauthorizedException(
        typeof err === 'string'
          ? err
          : 'Authentication token is missing or invalid',
      );
    }
    return user as TUser;
  }
}
