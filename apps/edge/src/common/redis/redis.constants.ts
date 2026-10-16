/**
 * Centralized Redis password accessor and configuration helper for Edge.
 * Enforces fail-fast behavior in production if REDIS_PASSWORD is not set.
 */
export const REDIS_PASSWORD = (): string => {
  const password = process.env.REDIS_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production') {
    throw new Error('REDIS_PASSWORD is required in production environment. Boot halted.');
  }
  return password ?? '';
};

export const getRedisConnectionConfig = (
  host: string,
  port: number,
  additional: Record<string, unknown> = {},
) => {
  const password = REDIS_PASSWORD();
  return {
    host,
    port,
    ...(password ? { password } : {}),
    ...additional,
  };
};
