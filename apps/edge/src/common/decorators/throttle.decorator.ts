import { applyDecorators, SetMetadata } from '@nestjs/common';

export const THROTTLE_LIMIT_KEY = 'throttle_limit';
export const THROTTLE_TTL_KEY = 'throttle_ttl';

export const Throttle = (limit = 60, ttlSeconds = 60) =>
  applyDecorators(
    SetMetadata(THROTTLE_LIMIT_KEY, limit),
    SetMetadata(THROTTLE_TTL_KEY, ttlSeconds),
  );
