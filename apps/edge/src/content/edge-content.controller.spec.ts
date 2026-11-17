import { NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { of } from 'rxjs';
import { Readable } from 'stream';
import { EdgeCacheService } from '../cache/cache.service';
import { KafkaService } from '../kafka/kafka.service';
import { MetricsService } from '../metrics/metrics.service';
import { MinioService } from '../minio/minio.service';
import {
  signEdgeSegmentUrl,
  signEdgeUrl,
} from '../common/security/edge-url.util';
import { signServiceRequest } from '../common/security/service-hmac.util';
import { EdgeContentController } from './edge-content.controller';

type CacheMock = {
  getHlsContent: jest.Mock;
  getBinary: jest.Mock;
  getMetadata: jest.Mock;
  acquireStampedeLock: jest.Mock;
  releaseStampedeLock: jest.Mock;
  cacheFile: jest.Mock;
  cacheHlsContent: jest.Mock;
  evictFile: jest.Mock;
};

type MinioMock = { getObjectStream: jest.Mock };
type HttpMock = {
  get: jest.Mock;
  axiosRef: { get: jest.Mock };
};
type MetricsMock = {
  cacheHitsTotal: { inc: jest.Mock };
  cacheMissesTotal: { inc: jest.Mock };
  peerFetchesTotal: { inc: jest.Mock };
  bytesServedTotal: { inc: jest.Mock };
  requestDuration: { observe: jest.Mock };
};
type KafkaMock = { emitCacheAccess: jest.Mock };

type ReplyMock = {
  header: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
  sent: boolean;
};

const SECRET = 'edge-signing-secret';
const SERVICE_SECRET = 'internal-service-secret';
const NODE_ID = 'edge-node-01';

const configFor = (values: Record<string, string | number | undefined>) =>
  ({
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const value = values[key];
      return value === undefined ? defaultValue : value;
    }),
  }) as unknown as ConfigService;

const makeReply = (): ReplyMock => {
  const res = {
    header: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
    sent: false,
  };
  res.status.mockReturnValue(res);
  res.send.mockImplementation(() => {
    res.sent = true;
  });
  return res;
};

const makeRequest = (
  url = '/edge/content/file-1?v=1',
  method = 'GET',
  headers: Record<string, string> = {},
  body?: unknown,
) =>
  ({
    url,
    method,
    headers,
    body,
  }) as unknown as FastifyRequest;

const signedQuery = (fileId = 'file-1', version = '1', subpath?: string) => {
  if (subpath) {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const signed = signEdgeSegmentUrl(fileId, version, subpath, exp, SECRET);
    return { exp: String(exp), sig: signed.sig };
  }
  const signed = signEdgeUrl(fileId, version, 60, SECRET);
  return { exp: String(signed.exp), sig: signed.sig };
};

const placement = (overrides: Record<string, unknown> = {}) => ({
  fileId: 'file-1',
  version: 1,
  storagePath: 'files/user-1/file-1/v1/video.mp4',
  mimeType: 'video/mp4',
  size: '11',
  ownerId: 'user-1',
  checksum: 'checksum-1',
  responsibleReplicas: [],
  ...overrides,
});

describe('EdgeContentController', () => {
  let controller: EdgeContentController;
  let cache: CacheMock;
  let minio: MinioMock;
  let http: HttpMock;
  let metrics: MetricsMock;
  let kafka: KafkaMock;

  beforeEach(() => {
    cache = {
      getHlsContent: jest.fn().mockResolvedValue(null),
      getBinary: jest.fn().mockResolvedValue(null),
      getMetadata: jest.fn().mockResolvedValue({
        contentType: 'video/mp4',
        etag: '"checksum-1"',
        contentEncoding: undefined,
      }),
      acquireStampedeLock: jest.fn().mockResolvedValue(true),
      releaseStampedeLock: jest.fn().mockResolvedValue(undefined),
      cacheFile: jest.fn().mockResolvedValue(undefined),
      cacheHlsContent: jest.fn().mockResolvedValue(undefined),
      evictFile: jest.fn().mockResolvedValue([]),
    };
    minio = {
      getObjectStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('origin-data')])),
    };
    http = {
      get: jest.fn().mockReturnValue(of({ data: placement() })),
      axiosRef: { get: jest.fn() },
    };
    metrics = {
      cacheHitsTotal: { inc: jest.fn() },
      cacheMissesTotal: { inc: jest.fn() },
      peerFetchesTotal: { inc: jest.fn() },
      bytesServedTotal: { inc: jest.fn() },
      requestDuration: { observe: jest.fn() },
    };
    kafka = { emitCacheAccess: jest.fn() };

    controller = new EdgeContentController(
      cache as unknown as EdgeCacheService,
      minio as unknown as MinioService,
      http as unknown as HttpService,
      configFor({
        CORE_API_URL: 'http://core-api:3000',
        EDGE_NODE_ID: NODE_ID,
        EDGE_REGION: 'ap-south-1',
        PEER_FETCH_TIMEOUT_MS: 2000,
        PEER_MAX_ATTEMPTS: 3,
        INTERNAL_SERVICE_SECRET: SERVICE_SECRET,
        EDGE_URL_SIGNING_SECRET: SECRET,
      }),
      metrics as unknown as MetricsService,
      kafka as unknown as KafkaService,
    );
  });

  it('rejects unauthenticated content requests before touching the cache', async () => {
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      undefined,
      undefined,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(cache.getBinary).not.toHaveBeenCalled();
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });

  it('requires service auth for peer cache-fill requests', async () => {
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      undefined,
      undefined,
      'peer',
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(cache.getBinary).not.toHaveBeenCalled();
  });

  it('serves a signed URL directly from the RAM cache', async () => {
    const query = signedQuery();
    const buffer = Buffer.from('cached-data');
    cache.getBinary.mockResolvedValue(buffer);
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      query.exp,
      query.sig,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(buffer);
    expect(res.header).toHaveBeenCalledWith('X-Cache', 'HIT');
    expect(res.header).toHaveBeenCalledWith('Content-Type', 'video/mp4');
    expect(metrics.cacheHitsTotal.inc).toHaveBeenCalled();
    expect(metrics.bytesServedTotal.inc).toHaveBeenCalledWith(
      { source: 'ram_cache' },
      buffer.length,
    );
    expect(kafka.emitCacheAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        eventType: 'hit',
        bytesServed: buffer.length,
      }),
    );
  });

  it('serves a peer-fill hit only after validating service auth', async () => {
    const url = '/edge/content/file-1?v=1';
    const headers = signServiceRequest(
      NODE_ID,
      'GET',
      url,
      SERVICE_SECRET,
    );
    const buffer = Buffer.from('peer-cached');
    cache.getBinary.mockResolvedValue(buffer);
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      undefined,
      undefined,
      'peer',
      makeRequest(url, 'GET', headers),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(metrics.bytesServedTotal.inc).toHaveBeenCalledWith(
      { source: 'peer_cache' },
      buffer.length,
    );
    expect(kafka.emitCacheAccess).not.toHaveBeenCalled();
  });

  it('returns 404 for a peer-fill miss', async () => {
    const url = '/edge/content/file-1?v=1';
    const headers = signServiceRequest(
      NODE_ID,
      'GET',
      url,
      SERVICE_SECRET,
    );

    await expect(
      controller.getEdgeContent(
        'file-1',
        1,
        undefined,
        undefined,
        'peer',
        makeRequest(url, 'GET', headers),
        makeReply() as unknown as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fills the cache from the nearest healthy peer', async () => {
    const query = signedQuery();
    cache.getBinary.mockResolvedValue(null);
    http.get.mockReturnValue(
      of({
        data: placement({
          responsibleReplicas: [
            {
              edgeId: 'edge-node-02',
              endpoint: 'http://localhost:4001',
              region: 'us-east-1',
              distanceKm: 100,
            },
          ],
        }),
      }),
    );
    http.axiosRef.get.mockResolvedValue({
      status: 200,
      data: Buffer.from('peer-data'),
    });
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      query.exp,
      query.sig,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(http.axiosRef.get).toHaveBeenCalledWith(
      'http://edge-node-02:4001/edge/content/file-1?v=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Cache-Fill-Mode': 'peer',
        }),
        responseType: 'arraybuffer',
      }),
    );
    expect(cache.cacheFile).toHaveBeenCalledWith(
      'file-1',
      '1',
      expect.objectContaining({
        ownerId: 'user-1',
        contentType: 'video/mp4',
        size: 11,
        checksum: 'checksum-1',
      }),
      Buffer.from('peer-data'),
    );
    expect(metrics.peerFetchesTotal.inc).toHaveBeenCalledWith({
      peer_id: 'edge-node-02',
      status: 'success',
    });
    expect(kafka.emitCacheAccess).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'peer_fill' }),
    );
    expect(res.header).toHaveBeenCalledWith('X-Cache', 'PEER_HIT');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('falls back to origin storage when no peers are available', async () => {
    const query = signedQuery();
    cache.getBinary.mockResolvedValue(null);
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      query.exp,
      query.sig,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(minio.getObjectStream).toHaveBeenCalledWith(
      'files/user-1/file-1/v1/video.mp4',
    );
    expect(cache.cacheFile).toHaveBeenCalledWith(
      'file-1',
      '1',
      expect.objectContaining({ ownerId: 'user-1' }),
      Buffer.from('origin-data'),
    );
    expect(metrics.bytesServedTotal.inc).toHaveBeenCalledWith(
      { source: 'origin_stream' },
      11,
    );
    expect(kafka.emitCacheAccess).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'miss' }),
    );
    expect(res.header).toHaveBeenCalledWith('X-Cache', 'MISS');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('waits for an in-flight cache fill and serves the result', async () => {
    const query = signedQuery();
    cache.getBinary
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('after-wait'));
    cache.acquireStampedeLock.mockResolvedValue(false);
    jest
      .spyOn(
        controller as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      query.exp,
      query.sig,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(cache.releaseStampedeLock).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(Buffer.from('after-wait'));
    expect(metrics.cacheHitsTotal.inc).toHaveBeenCalled();
  });

  it('returns 502 when the origin fetch fails', async () => {
    const query = signedQuery();
    cache.getBinary.mockResolvedValue(null);
    minio.getObjectStream.mockRejectedValue(new Error('minio down'));
    const res = makeReply();

    await controller.getEdgeContent(
      'file-1',
      1,
      query.exp,
      query.sig,
      undefined,
      makeRequest(),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(502);
    expect(cache.releaseStampedeLock).toHaveBeenCalled();
  });

  it('requires service auth to purge a local cache', async () => {
    const res = makeReply();

    await controller.purgeLocalCache(
      'file-1',
      makeRequest('/edge/content/file-1/purge', 'POST'),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(cache.evictFile).not.toHaveBeenCalled();
  });

  it('purges a local cache with a valid service signature', async () => {
    const url = '/edge/content/file-1/purge';
    const headers = signServiceRequest(
      NODE_ID,
      'POST',
      url,
      SERVICE_SECRET,
    );
    const res = makeReply();

    await controller.purgeLocalCache(
      'file-1',
      makeRequest(url, 'POST', headers),
      res as unknown as FastifyReply,
    );

    expect(cache.evictFile).toHaveBeenCalledWith('file-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        edgeNodeId: NODE_ID,
        fileId: 'file-1',
      }),
    );
  });

  it('rejects unauthenticated and path-traversing HLS requests', async () => {
    const unauthorized = makeReply();
    await controller.getHlsContent(
      'file-1',
      '1',
      undefined,
      undefined,
      makeRequest('/edge/content/file-1/hls/master.m3u8?v=1'),
      unauthorized as unknown as FastifyReply,
    );
    expect(unauthorized.status).toHaveBeenCalledWith(401);

    const traversal = makeReply();
    await controller.getHlsContent(
      'file-1',
      '1',
      undefined,
      undefined,
      makeRequest('/edge/content/file-1/hls/../secret'),
      traversal as unknown as FastifyReply,
    );
    expect(traversal.status).toHaveBeenCalledWith(400);
    expect(cache.getHlsContent).not.toHaveBeenCalled();
  });

  it('serves a cached HLS playlist and signs child URIs', async () => {
    const subpath = 'master.m3u8';
    const query = signedQuery('file-1', '1', subpath);
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      'segment-000.ts',
      '',
    ].join('\n');
    cache.getHlsContent.mockResolvedValue(Buffer.from(playlist));
    const res = makeReply();

    await controller.getHlsContent(
      'file-1',
      '1',
      query.exp,
      query.sig,
      makeRequest(`/edge/content/file-1/hls/${subpath}?v=1`),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.send.mock.calls[0][0] as Buffer;
    const text = body.toString('utf-8');
    expect(text).toContain('URI="key.bin?v=1&exp=');
    expect(text).toContain('segment-000.ts?v=1&exp=');
    expect(metrics.cacheHitsTotal.inc).toHaveBeenCalled();
  });

  it('fetches an HLS object from origin and caches it', async () => {
    const url = '/edge/content/file-1/hls/master.m3u8?v=1';
    const headers = signServiceRequest(
      NODE_ID,
      'GET',
      url,
      SERVICE_SECRET,
    );
    http.get.mockReturnValue(
      of({ data: { file: { ownerId: 'user-1' }, id: 'version-1' } }),
    );
    const res = makeReply();

    await controller.getHlsContent(
      'file-1',
      '1',
      undefined,
      undefined,
      makeRequest(url, 'GET', headers),
      res as unknown as FastifyReply,
    );

    expect(minio.getObjectStream).toHaveBeenCalledWith(
      'hls/user-1/file-1/version-1/master.m3u8',
    );
    expect(cache.cacheHlsContent).toHaveBeenCalledWith(
      'file-1',
      '1',
      'master.m3u8',
      Buffer.from('origin-data'),
      60,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when an HLS object is missing', async () => {
    const url = '/edge/content/file-1/hls/segment-000.ts?v=1';
    const headers = signServiceRequest(
      NODE_ID,
      'GET',
      url,
      SERVICE_SECRET,
    );
    minio.getObjectStream.mockRejectedValue(new Error('missing'));
    const res = makeReply();

    await controller.getHlsContent(
      'file-1',
      '1',
      undefined,
      undefined,
      makeRequest(url, 'GET', headers),
      res as unknown as FastifyReply,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
