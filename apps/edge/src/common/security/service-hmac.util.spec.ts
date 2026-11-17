import * as crypto from 'crypto';
import {
  buildServiceHmacPayload,
  computeBodyHash,
  signServiceRequest,
  verifyServiceSignature,
} from './service-hmac.util';

describe('Edge service HMAC utilities', () => {
  const secret = 'edge-service-secret';

  it('hashes undefined and null bodies like an empty object', () => {
    const emptyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({}))
      .digest('hex');

    expect(computeBodyHash()).toBe(emptyHash);
    expect(computeBodyHash(null)).toBe(emptyHash);
  });

  it('hashes strings verbatim and objects by JSON encoding', () => {
    expect(computeBodyHash('raw')).toBe(
      crypto.createHash('sha256').update('raw').digest('hex'),
    );
    expect(computeBodyHash({ b: 2, a: 1 })).toBe(
      crypto
        .createHash('sha256')
        .update(JSON.stringify({ b: 2, a: 1 }))
        .digest('hex'),
    );
  });

  it('builds the canonical payload with an uppercase method', () => {
    const payload = buildServiceHmacPayload(
      'edge-node-01',
      'post',
      '/api/v1/internal/placement/file-1/v/1',
      123,
      { fileId: 'file-1' },
    );

    expect(payload).toBe(
      `edge-node-01:POST:/api/v1/internal/placement/file-1/v/1:123:${computeBodyHash({ fileId: 'file-1' })}`,
    );
  });

  it('signs and verifies a request', () => {
    const timestamp = Date.now();
    const body = { edgeId: 'edge-node-01' };
    const headers = signServiceRequest(
      'edge-node-01',
      'POST',
      '/api/v1/admin/health/heartbeat',
      secret,
      body,
      timestamp,
    );

    expect(headers).toEqual({
      'x-service-id': 'edge-node-01',
      'x-service-timestamp': String(timestamp),
      'x-service-signature': expect.any(String),
    });
    expect(
      verifyServiceSignature(
        'edge-node-01',
        'POST',
        '/api/v1/admin/health/heartbeat',
        timestamp,
        headers['x-service-signature'],
        secret,
        body,
      ),
    ).toBe(true);
  });

  it('rejects tampered requests and stale timestamps', () => {
    const timestamp = Date.now();
    const valid = signServiceRequest(
      'edge-node-01',
      'GET',
      '/api/v1/internal/metadata/files/file-1',
      secret,
      undefined,
      timestamp,
    )['x-service-signature'];

    expect(
      verifyServiceSignature(
        'edge-node-01',
        'POST',
        '/api/v1/internal/metadata/files/file-1',
        timestamp,
        valid,
        secret,
      ),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        'edge-node-01',
        'GET',
        '/api/v1/internal/metadata/files/file-1',
        timestamp,
        valid,
        secret,
        { extra: true },
      ),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        'edge-node-01',
        'GET',
        '/api/v1/internal/metadata/files/file-1',
        timestamp,
        valid,
        'wrong-secret',
      ),
    ).toBe(false);
    expect(
      verifyServiceSignature(
        'edge-node-01',
        'GET',
        '/api/v1/internal/metadata/files/file-1',
        timestamp - 6 * 60 * 1000,
        valid,
        secret,
      ),
    ).toBe(false);
  });

  it('rejects missing or malformed signatures', () => {
    expect(
      verifyServiceSignature('svc', 'GET', '/url', Date.now(), '', secret),
    ).toBe(false);
    expect(
      verifyServiceSignature('svc', 'GET', '/url', Date.now(), 'abc', ''),
    ).toBe(false);
    expect(
      verifyServiceSignature('svc', 'GET', '/url', Date.now(), 'zz', secret),
    ).toBe(false);
  });
});
