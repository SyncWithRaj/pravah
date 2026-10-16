import * as crypto from 'crypto';

export function computeBodyHash(body?: unknown): string {
  const rawBody =
    body !== undefined && body !== null
      ? typeof body === 'string'
        ? body
        : JSON.stringify(body)
      : JSON.stringify({});
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

export function buildServiceHmacPayload(
  serviceId: string,
  method: string,
  url: string,
  timestamp: number | string,
  body?: unknown,
): string {
  const bodyHash = computeBodyHash(body);
  return `${serviceId}:${method.toUpperCase()}:${url}:${timestamp}:${bodyHash}`;
}

export function signServiceRequest(
  serviceId: string,
  method: string,
  url: string,
  secret: string,
  body?: unknown,
  timestamp: number = Date.now(),
): {
  'x-service-id': string;
  'x-service-timestamp': string;
  'x-service-signature': string;
} {
  const payload = buildServiceHmacPayload(
    serviceId,
    method,
    url,
    timestamp,
    body,
  );
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return {
    'x-service-id': serviceId,
    'x-service-timestamp': timestamp.toString(),
    'x-service-signature': signature,
  };
}

export function verifyServiceSignature(
  serviceId: string,
  method: string,
  url: string,
  timestamp: number,
  signature: string,
  secret: string,
  body?: unknown,
  maxClockDriftMs: number = 5 * 60 * 1000,
): boolean {
  if (!signature || !secret) return false;
  const now = Date.now();
  if (Math.abs(now - timestamp) > maxClockDriftMs) return false;

  const payload = buildServiceHmacPayload(
    serviceId,
    method,
    url,
    timestamp,
    body,
  );
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
