import {
  signEdgeUrl,
  signEdgeSegmentUrl,
  verifyEdgeUrl,
} from './edge-url.util';

describe('edge-url.util', () => {
  const secret = 'super-secure-edge-signing-secret-key-32b';
  const fileId = 'file-abc-123';
  const version = '1';

  describe('signEdgeUrl', () => {
    it('should throw an error if secret is missing', () => {
      expect(() => signEdgeUrl(fileId, version, 60, '')).toThrow(
        'EDGE_URL_SIGNING_SECRET is required to sign edge URLs',
      );
    });

    it('should generate a valid expiration and signature query string', () => {
      const signed = signEdgeUrl(fileId, version, 60, secret);
      expect(signed).toHaveProperty('exp');
      expect(signed).toHaveProperty('sig');
      expect(signed.query).toBe(`exp=${signed.exp}&sig=${signed.sig}`);
      expect(typeof signed.exp).toBe('number');
      expect(signed.sig).toHaveLength(64); // sha256 hex is 64 chars
    });
  });

  describe('signEdgeSegmentUrl', () => {
    it('should generate signature specific to segment subpath', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      const signed = signEdgeSegmentUrl(fileId, version, '1080p/segment-000.ts', exp, secret);
      expect(signed.sig).toHaveLength(64);
      expect(signed.query).toContain(`exp=${exp}`);
      expect(signed.query).toContain(`sig=${signed.sig}`);
    });
  });

  describe('verifyEdgeUrl', () => {
    it('should return true for a freshly signed valid URL', () => {
      const signed = signEdgeUrl(fileId, version, 120, secret);
      const isValid = verifyEdgeUrl(fileId, version, signed.exp, signed.sig, secret);
      expect(isValid).toBe(true);
    });

    it('should verify segment URL with subpath', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      const subpath = '1080p/segment-000.ts';
      const signed = signEdgeSegmentUrl(fileId, version, subpath, exp, secret);
      const isValid = verifyEdgeUrl(fileId, version, signed.exp, signed.sig, secret, subpath);
      expect(isValid).toBe(true);
    });

    it('should reject segment URL when subpath is tampered', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      const signed = signEdgeSegmentUrl(fileId, version, '1080p/segment-000.ts', exp, secret);
      const isValid = verifyEdgeUrl(fileId, version, signed.exp, signed.sig, secret, '1080p/segment-001.ts');
      expect(isValid).toBe(false);
    });

    it('should return false if timestamp has expired', () => {
      const signed = signEdgeUrl(fileId, version, -10, secret); // expired 10s ago
      const isValid = verifyEdgeUrl(fileId, version, signed.exp, signed.sig, secret);
      expect(isValid).toBe(false);
    });

    it('should return false if fileId is tampered with', () => {
      const signed = signEdgeUrl(fileId, version, 120, secret);
      const isValid = verifyEdgeUrl('tampered-file-id', version, signed.exp, signed.sig, secret);
      expect(isValid).toBe(false);
    });

    it('should return false if version is tampered with', () => {
      const signed = signEdgeUrl(fileId, version, 120, secret);
      const isValid = verifyEdgeUrl(fileId, '2', signed.exp, signed.sig, secret);
      expect(isValid).toBe(false);
    });

    it('should return false if signed with a different secret', () => {
      const signed = signEdgeUrl(fileId, version, 120, 'wrong-secret');
      const isValid = verifyEdgeUrl(fileId, version, signed.exp, signed.sig, secret);
      expect(isValid).toBe(false);
    });

    it('should return false without throwing when signature length is mismatched or garbage', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;

      // Too short
      expect(verifyEdgeUrl(fileId, version, exp, 'abc', secret)).toBe(false);
      // Empty string
      expect(verifyEdgeUrl(fileId, version, exp, '', secret)).toBe(false);
      // 63 chars (off by 1 from 64-char sha256 hex)
      expect(verifyEdgeUrl(fileId, version, exp, 'a'.repeat(63), secret)).toBe(false);
      // 65 chars
      expect(verifyEdgeUrl(fileId, version, exp, 'a'.repeat(65), secret)).toBe(false);
      // 128 chars
      expect(verifyEdgeUrl(fileId, version, exp, 'a'.repeat(128), secret)).toBe(false);
      // Odd-length non-hex garbage that could fail Buffer.from hex decode
      expect(verifyEdgeUrl(fileId, version, exp, 'invalid-non-hex-sig-value', secret)).toBe(false);
    });

    it('should return false if any required argument is undefined or invalid', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      expect(verifyEdgeUrl(fileId, version, exp, undefined, secret)).toBe(false);
      expect(verifyEdgeUrl(fileId, version, undefined, 'some-sig', secret)).toBe(false);
      expect(verifyEdgeUrl(fileId, version, 'invalid-exp', 'some-sig', secret)).toBe(false);
      expect(verifyEdgeUrl(fileId, version, exp, 'some-sig', '')).toBe(false);
    });
  });
});
