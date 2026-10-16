import * as crypto from 'crypto';

/**
 * Generates HMAC signature query parameters for an edge content URL.
 * Format: `exp=${exp}&sig=${sig}`
 * Payload format: `${fileId}:${version}:${exp}`
 */
export function signEdgeUrl(
  fileId: string,
  version: string | number,
  expiresInSec: number,
  secret: string,
): { exp: number; sig: string; query: string } {
  if (!secret) {
    throw new Error('EDGE_URL_SIGNING_SECRET is required to sign edge URLs');
  }
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const data = `${fileId}:${version}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return {
    exp,
    sig,
    query: `exp=${exp}&sig=${sig}`,
  };
}

/**
 * Generates HMAC signature for a specific HLS segment or child playlist.
 * Payload format: `${fileId}:${version}:${subpath}:${exp}`
 */
export function signEdgeSegmentUrl(
  fileId: string,
  version: string | number,
  subpath: string,
  exp: number | string,
  secret: string,
): { exp: number | string; sig: string; query: string } {
  if (!secret) {
    throw new Error('EDGE_URL_SIGNING_SECRET is required to sign edge URLs');
  }
  const cleanSubpath = subpath.replace(/^\/+/, '');
  const data = `${fileId}:${version}:${cleanSubpath}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return {
    exp,
    sig,
    query: `exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`,
  };
}

/**
 * Validates the HMAC signature and expiration timestamp for an edge URL.
 * Supports top-level URLs `${fileId}:${version}:${exp}` and HLS subpaths `${fileId}:${version}:${subpath}:${exp}`.
 * Safely guards against crypto.timingSafeEqual RangeError when buffer lengths differ.
 */
export function verifyEdgeUrl(
  fileId: string,
  version: string | number,
  expStr: string | number | undefined,
  sig: string | undefined,
  secret: string,
  subpath?: string,
): boolean {
  if (!secret || !expStr || !sig) {
    return false;
  }

  const exp = typeof expStr === 'number' ? expStr : parseInt(String(expStr), 10);
  if (isNaN(exp)) {
    return false;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > exp) {
    return false; // Expired
  }

  if (typeof sig !== 'string') {
    return false;
  }

  let sigBuffer: Buffer;
  try {
    sigBuffer = Buffer.from(sig, 'hex');
    if (sigBuffer.length === 0) return false;
  } catch {
    return false;
  }

  const candidatePayloads = [`${fileId}:${version}:${exp}`];
  if (subpath) {
    const cleanSubpath = subpath.replace(/^\/+/, '');
    candidatePayloads.push(`${fileId}:${version}:${cleanSubpath}:${exp}`);
    if (subpath !== cleanSubpath) {
      candidatePayloads.push(`${fileId}:${version}:${subpath}:${exp}`);
    }
  }

  for (const data of candidatePayloads) {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    if (sig.length === expectedSig.length) {
      try {
        const expectedBuffer = Buffer.from(expectedSig, 'hex');
        if (
          sigBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(sigBuffer, expectedBuffer)
        ) {
          return true;
        }
      } catch {
        // continue
      }
    }
  }

  return false;
}
