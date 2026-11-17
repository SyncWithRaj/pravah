import * as crypto from 'crypto';
import {
  buildServiceHmacPayload,
  computeBodyHash,
  signServiceRequest,
  verifyServiceSignature,
} from './service-hmac.util';

describe('service HMAC utilities', () => {
  const secret = 'test-service-secret';
  const serviceId = 'edge-node-01';

  it('hashes undefined bodies as an empty JSON object', () => {
    const expected = crypto.createHash('sha256').update('{}').digest('hex');

    expect(computeBodyHash(undefined)).toBe(expected);
    expect(computeBodyHash(null)).toBe(expected);
  });

  it('hashes string bodies without JSON encoding them again', () => {
    const expected = crypto
      .createHash('sha256')
      .update('raw-payload')
      .digest('hex');

    expect(computeBodyHash('raw-payload')).toBe(expected);
  });

  it('normalises the HTTP method to upper case in the payload', () => {
    const payload = buildServiceHmacPayload(
      serviceId,
      'post',
      '/api/v1/upload/init',
      123,
      { name: 'video.mp4' },
    );

    expect(payload).toMatch(
      /^edge-node-01:POST:\/api\/v1\/upload\/init:123:[a-f0-9]{64}$/,
    );
  });

  it('signs and verifies a valid request', () => {
    const timestamp = Date.now();
    const headers = signServiceRequest(
      serviceId,
      'POST',
      '/api/v1/upload/init',
      secret,
      { name: 'video.mp4' },
      timestamp,
    );

    expect(headers['x-service-id']).toBe(serviceId);
    expect(headers['x-service-timestamp']).toBe(timestamp.toString());
    expect(headers['x-service-signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifyServiceSignature(
        serviceId,
        'POST',
        '/api/v1/upload/init',
        timestamp,
        headers['x-service-signature'],
        secret,
        { name: 'video.mp4' },
      ),
    ).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const timestamp = Date.now();
    const headers = signServiceRequest(
      serviceId,
      'GET',
      '/api/v1/admin/health/nodes',
      secret,
      undefined,
      timestamp,
    );

    expect(
      verifyServiceSignature(
        serviceId,
        'GET',
        '/api/v1/admin/health/nodes',
        timestamp,
        'deadbeef',
        secret,
      ),
    ).toBe(false);
    expect(headers['x-service-signature']).not.toBe('deadbeef');
  });

  it('rejects a request whose method, URL, or body changed', () => {
    const timestamp = Date.now();
    const headers = signServiceRequest(
      serviceId,
      'PUT',
      '/api/v1/upload/file-1/chunk/0',
      secret,
      { checksum: 'abc' },
      timestamp,
    );

    expect(
      verifyServiceSignature(
        serviceId,
        'POST',
        '/api/v1/upload/file-1/chunk/0',
        timestamp,
        headers['x-service-signature'],
        secret,
        { checksum: 'abc' },
      ),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        serviceId,
        'PUT',
        '/api/v1/upload/file-2/chunk/0',
        timestamp,
        headers['x-service-signature'],
        secret,
        { checksum: 'abc' },
      ),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        serviceId,
        'PUT',
        '/api/v1/upload/file-1/chunk/0',
        timestamp,
        headers['x-service-signature'],
        secret,
        { checksum: 'changed' },
      ),
    ).toBe(false);
  });

  it('rejects timestamps outside the allowed clock drift', () => {
    const staleTimestamp = Date.now() - 6 * 60 * 1000;
    const staleHeaders = signServiceRequest(
      serviceId,
      'GET',
      '/api/v1/admin/health/nodes',
      secret,
      undefined,
      staleTimestamp,
    );

    expect(
      verifyServiceSignature(
        serviceId,
        'GET',
        '/api/v1/admin/health/nodes',
        staleTimestamp,
        staleHeaders['x-service-signature'],
        secret,
      ),
    ).toBe(false);

    const futureTimestamp = Date.now() + 6 * 60 * 1000;
    const futureHeaders = signServiceRequest(
      serviceId,
      'GET',
      '/api/v1/admin/health/nodes',
      secret,
      undefined,
      futureTimestamp,
    );

    expect(
      verifyServiceSignature(
        serviceId,
        'GET',
        '/api/v1/admin/health/nodes',
        futureTimestamp,
        futureHeaders['x-service-signature'],
        secret,
      ),
    ).toBe(false);
  });

  it('honours a custom clock drift window', () => {
    const timestamp = Date.now() - 30 * 1000;
    const headers = signServiceRequest(
      serviceId,
      'GET',
      '/api/v1/admin/health/nodes',
      secret,
      undefined,
      timestamp,
    );

    expect(
      verifyServiceSignature(
        serviceId,
        'GET',
        '/api/v1/admin/health/nodes',
        timestamp,
        headers['x-service-signature'],
        secret,
        undefined,
        10 * 1000,
      ),
    ).toBe(false);
  });

  it('rejects missing, empty, or malformed credentials', () => {
    const timestamp = Date.now();

    expect(
      verifyServiceSignature(serviceId, 'GET', '/x', timestamp, '', secret),
    ).toBe(false);
    expect(
      verifyServiceSignature(serviceId, 'GET', '/x', timestamp, 'abc', ''),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        serviceId,
        'GET',
        '/x',
        timestamp,
        'not-hex',
        secret,
      ),
    ).toBe(false);
  });
});
