import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { signEdgeUrl } from '../src/common/security/edge-url.util';
import { signServiceRequest } from '../src/common/security/service-hmac.util';

/**
 * Live HTTP end-to-end suite.
 *
 * Prerequisites:
 *   1. Start the full local stack (core API on :3000, PostgreSQL, Redis, MinIO,
 *      Kafka, and the seeded edge nodes).
 *   2. Seed the database so the RBAC users and edge nodes exist.
 *   3. Run with `E2E_LIVE=1 pnpm --filter core test:e2e`.
 *
 * The suite is skipped unless E2E_LIVE=1 so the normal unit-test run does not
 * require infrastructure. Set E2E_BASE_URL to point at a different origin.
 */
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const API = `${BASE_URL}/api/v1`;
const LIVE = process.env.E2E_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
}

interface MeResponse {
  message: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
}

interface InitUploadResponse {
  fileId: string;
  name: string;
  totalChunks: number;
  status: string;
}

interface ChunkResponse {
  success: boolean;
  fileId: string;
  chunkIndex: number;
  uploadedChunks: number;
  totalChunks: number;
}

interface CompleteUploadResponse {
  message: string;
  fileId: string;
  name: string;
  storagePath: string;
  status: string;
}

interface FileVersion {
  id: string;
  versionNumber: number;
  size: string;
  checksum: string;
  storagePath: string;
}

interface FileDetails {
  id: string;
  name: string;
  status: string;
  totalSize: string;
  mimeType: string;
  currentVersion: FileVersion | null;
  versions?: FileVersion[];
}

interface FileListResponse {
  data: FileDetails[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

interface SignedUrlResponse {
  url: string;
  expiresIn: number;
  fileName: string;
}

interface ApiKeyResponse {
  id: string;
  name: string;
  apiKey: string;
  keyPrefix: string;
  role: string;
}

interface HealthNodesResponse {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  nodes: Array<{ id: string; name: string; region: string; status: string }>;
}

interface DlqResponse {
  total: number;
  topic: string;
  events: unknown[];
}

interface ReplicationStatusResponse {
  fileId: string;
  totalJobs: number;
  completed: number;
  failed: number;
  pending: number;
  inProgress: number;
  jobs: unknown[];
}

interface TranscodingStatusResponse {
  fileId: string;
  totalRecords: number;
  transcodes: unknown[];
}

function readEnvSecret(key: string): string | undefined {
  const fromEnvironment = process.env[key];
  if (fromEnvironment) return fromEnvironment;

  try {
    const envFile = fs.readFileSync(
      path.resolve(__dirname, '../../../.env'),
      'utf8',
    );
    const match = new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?`, 'm').exec(
      envFile,
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this live e2e test`);
  }
  return value;
}

function jwt(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function responseBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.alloc(0);
}

const serviceSecret = readEnvSecret('INTERNAL_SERVICE_SECRET');
const edgeSigningSecret = readEnvSecret('EDGE_URL_SIGNING_SECRET');
const itWithServiceSecret = serviceSecret ? it : it.skip;
const itWithEdgeSecret = edgeSigningSecret ? it : it.skip;

describeLive('Core API live e2e', () => {
  jest.setTimeout(120_000);

  const api = request(BASE_URL);

  let adminLogin: LoginResponse;
  let streamerLogin: LoginResponse;
  let viewerLogin: LoginResponse;

  let fileId = '';
  let currentVersionNumber = 1;
  let fileBytes = Buffer.alloc(0);
  let fileDeleted = false;

  let streamerApiKey = '';
  let adminApiKey = '';

  async function login(
    identifier: string,
    password: string,
  ): Promise<LoginResponse> {
    const response = await api
      .post(`${API}/auth/login`)
      .send({ identifier, password });

    if (response.status !== 200) {
      throw new Error(
        `Login failed for ${identifier}: ${response.status} ${response.text}`,
      );
    }

    return response.body as LoginResponse;
  }

  beforeAll(async () => {
    try {
      const health = await api
        .get(`${API}/health`)
        .timeout({ response: 5_000, deadline: 10_000 });
      if (health.status !== 200) {
        throw new Error(`health returned ${health.status}`);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Core API is not reachable at ${BASE_URL}. Start the stack, seed the ` +
          `database, then run E2E_LIVE=1 pnpm --filter core test:e2e. (${detail})`,
      );
    }

    [adminLogin, streamerLogin, viewerLogin] = await Promise.all([
      login('admin-rbac-test@pravah.io', 'Admin123!@#'),
      login('streamer-rbac-test@pravah.io', 'Stream123!@#'),
      login('viewer-rbac-test@pravah.io', 'View123!@#'),
    ]);

    fileBytes = Buffer.from(
      `Pravah live e2e payload ${Date.now()} ${'x'.repeat(128)}`,
    );
    const split = Math.ceil(fileBytes.length / 2);
    const chunks = [fileBytes.subarray(0, split), fileBytes.subarray(split)];
    const fullChecksum = sha256(fileBytes);

    const init = await api
      .post(`${API}/upload/init`)
      .set(jwt(streamerLogin.access_token))
      .send({
        name: `live-e2e-${Date.now()}.bin`,
        mimeType: 'application/octet-stream',
        totalSize: fileBytes.length,
        totalChunks: chunks.length,
        fullFileChecksum: fullChecksum,
      })
      .expect(201);
    const initBody = init.body as InitUploadResponse;
    fileId = initBody.fileId;

    for (const [index, chunk] of chunks.entries()) {
      const chunkResponse = await api
        .put(`${API}/upload/${fileId}/chunk/${index}`)
        .set(jwt(streamerLogin.access_token))
        .field('checksum', sha256(chunk))
        .attach('file', chunk, {
          filename: `chunk-${index}.bin`,
          contentType: 'application/octet-stream',
        })
        .expect(200);
      const chunkBody = chunkResponse.body as ChunkResponse;
      expect(chunkBody.success).toBe(true);
      expect(chunkBody.uploadedChunks).toBe(index + 1);
    }

    const complete = await api
      .post(`${API}/upload/complete`)
      .set(jwt(streamerLogin.access_token))
      .send({ fileId })
      .expect(201);
    const completeBody = complete.body as CompleteUploadResponse;
    expect(completeBody.status).toBe('COMPLETED');
    expect(completeBody.fileId).toBe(fileId);

    const details = await api
      .get(`${API}/metadata/files/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const detailsBody = details.body as FileDetails;
    expect(detailsBody.status).toBe('COMPLETED');
    expect(detailsBody.currentVersion).not.toBeNull();
    currentVersionNumber = detailsBody.currentVersion?.versionNumber ?? 1;
  });

  afterAll(async () => {
    if (!fileId || fileDeleted) return;

    try {
      await api
        .delete(`${API}/metadata/files/${fileId}`)
        .set(jwt(streamerLogin.access_token));
    } catch {
      // Best-effort cleanup; the suite reports failures from the real tests.
    }
  });

  it('serves public health and Prometheus metrics', async () => {
    const health = await api.get(`${API}/health`).expect(200);
    const healthBody = health.body as {
      status: string;
      service: string;
      timestamp: string;
    };
    expect(healthBody).toEqual({
      status: 'ok',
      service: 'pravah-core',
      timestamp: expect.any(String) as string,
    });

    const metrics = await api.get(`${API}/metrics`).expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain('pravah_core_http_requests_total');
  });

  it('rejects invalid credentials and protects /auth/me', async () => {
    await api
      .post(`${API}/auth/login`)
      .send({
        identifier: 'viewer-rbac-test@pravah.io',
        password: 'not-the-password',
      })
      .expect(401);

    const me = await api
      .get(`${API}/auth/me`)
      .set(jwt(viewerLogin.access_token))
      .expect(200);
    const meBody = me.body as MeResponse;
    expect(meBody.user.id).toBe(viewerLogin.user.id);
    expect(meBody.user.role).toBe('VIEWER');
    expect(meBody.user).not.toHaveProperty('passwordHash');

    await api.get(`${API}/auth/me`).expect(401);
  });

  it('enforces streamer/admin upload access and blocks viewers', async () => {
    await api
      .post(`${API}/upload/init`)
      .set(jwt(viewerLogin.access_token))
      .send({})
      .expect(403);

    await api
      .post(`${API}/upload/init`)
      .set(jwt(streamerLogin.access_token))
      .send({})
      .expect(400);

    await api
      .post(`${API}/upload/init`)
      .set(jwt(adminLogin.access_token))
      .send({})
      .expect(400);

    await api.post(`${API}/upload/init`).send({}).expect(401);
  });

  it('enforces admin-only DLQ access', async () => {
    await api
      .get(`${API}/admin/dlq`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    await api
      .get(`${API}/admin/dlq`)
      .set(jwt(streamerLogin.access_token))
      .expect(403);
    await api.get(`${API}/admin/dlq`).expect(401);

    const adminDlq = await api
      .get(`${API}/admin/dlq`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
    const dlqBody = adminDlq.body as DlqResponse;
    expect(dlqBody.total).toEqual(expect.any(Number) as number);
    expect(Array.isArray(dlqBody.events)).toBe(true);
  });

  it('exposes edge health to viewers through the USER role and admin endpoints to admins', async () => {
    const nodes = await api
      .get(`${API}/admin/health/nodes`)
      .set(jwt(viewerLogin.access_token))
      .expect(200);
    const nodesBody = nodes.body as HealthNodesResponse;
    expect(nodesBody.total).toBeGreaterThanOrEqual(3);
    expect(nodesBody.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['edge-node-01', 'edge-node-02', 'edge-node-03']),
    );

    await api
      .get(`${API}/admin/api-keys`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    const keys = await api
      .get(`${API}/admin/api-keys`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
    expect(Array.isArray(keys.body)).toBe(true);
  });

  it('enforces transcoding and replication admin views', async () => {
    await api
      .get(`${API}/admin/transcoding/status/${fileId}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);

    const transcodes = await api
      .get(`${API}/admin/transcoding/status/${fileId}`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
    const transcodeBody = transcodes.body as TranscodingStatusResponse;
    expect(transcodeBody.fileId).toBe(fileId);
    expect(transcodeBody.totalRecords).toEqual(expect.any(Number) as number);

    const replication = await api
      .get(`${API}/admin/replication/status/${fileId}`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
    const replicationBody = replication.body as ReplicationStatusResponse;
    expect(replicationBody.fileId).toBe(fileId);
    expect(replicationBody.totalJobs).toEqual(expect.any(Number) as number);
    expect(Array.isArray(replicationBody.jobs)).toBe(true);

    await api
      .get(`${API}/admin/replication/failed`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
  });

  it('creates scoped API keys and enforces their roles', async () => {
    const streamerKeyResponse = await api
      .post(`${API}/auth/api-keys`)
      .set(jwt(streamerLogin.access_token))
      .send({ name: `live-e2e-streamer-${Date.now()}` })
      .expect(201);
    const streamerKeyBody = streamerKeyResponse.body as ApiKeyResponse;
    streamerApiKey = streamerKeyBody.apiKey;
    expect(streamerKeyBody.role).toBe('STREAMER');

    const adminKeyResponse = await api
      .post(`${API}/auth/api-keys`)
      .set(jwt(adminLogin.access_token))
      .send({ name: `live-e2e-admin-${Date.now()}`, role: 'ADMIN' })
      .expect(201);
    const adminKeyBody = adminKeyResponse.body as ApiKeyResponse;
    adminApiKey = adminKeyBody.apiKey;
    expect(adminKeyBody.role).toBe('ADMIN');

    await api
      .post(`${API}/upload/init`)
      .set('x-api-key', streamerApiKey)
      .send({})
      .expect(400);

    await api
      .get(`${API}/admin/dlq`)
      .set('x-api-key', streamerApiKey)
      .expect(403);

    await api.get(`${API}/admin/dlq`).set('x-api-key', adminApiKey).expect(200);

    await api
      .get(`${API}/admin/dlq`)
      .set('x-api-key', 'prv_live_fakefakefakefakefakefake')
      .expect(401);

    await api
      .delete(`${API}/auth/api-keys/${streamerKeyBody.id}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    await api
      .delete(`${API}/admin/api-keys/${adminKeyBody.id}`)
      .set(jwt(adminLogin.access_token))
      .expect(200);

    await api.get(`${API}/admin/dlq`).set('x-api-key', adminApiKey).expect(401);
  });

  it('keeps metadata and direct downloads owner-only', async () => {
    const list = await api
      .get(`${API}/metadata/files`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const listBody = list.body as FileListResponse;
    expect(listBody.data.some((file) => file.id === fileId)).toBe(true);

    const details = await api
      .get(`${API}/metadata/files/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const detailsBody = details.body as FileDetails;
    expect(detailsBody.totalSize).toBe(String(fileBytes.length));
    expect(detailsBody.status).toBe('COMPLETED');

    await api
      .get(`${API}/metadata/files/${fileId}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    await api
      .get(`${API}/metadata/files/${fileId}`)
      .set(jwt(adminLogin.access_token))
      .expect(403);

    const versions = await api
      .get(`${API}/metadata/files/${fileId}/versions`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const versionsBody = versions.body as FileVersion[];
    expect(versionsBody.map((version) => version.versionNumber)).toContain(
      currentVersionNumber,
    );

    await api
      .get(`${API}/metadata/files/${fileId}/versions`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);

    const download = await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    expect(responseBuffer(download.body as unknown)).toEqual(fileBytes);
    expect(download.headers['content-type']).toContain(
      'application/octet-stream',
    );

    await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(adminLogin.access_token))
      .expect(403);
  });

  it('serves ranges and honours conditional requests for the owner', async () => {
    const download = await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const etag = download.headers['etag'];
    expect(etag).toBeTruthy();

    await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .set('If-None-Match', etag)
      .expect(304);

    const range = await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .set('Range', 'bytes=0-3')
      .expect(206);
    expect(range.headers['content-range']).toBe(
      `bytes 0-3/${fileBytes.length}`,
    );
    expect(responseBuffer(range.body as unknown)).toEqual(
      fileBytes.subarray(0, 4),
    );
  });

  it('authorizes versioned downloads before routing', async () => {
    const owner = await api
      .get(`${API}/download/${fileId}/versions/${currentVersionNumber}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    expect(responseBuffer(owner.body as unknown)).toEqual(fileBytes);

    await api
      .get(`${API}/download/${fileId}/versions/${currentVersionNumber}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    await api
      .get(`${API}/download/${fileId}/versions/${currentVersionNumber}`)
      .set(jwt(adminLogin.access_token))
      .expect(403);
  });

  it('issues signed origin URLs only to the owner', async () => {
    const signed = await api
      .get(`${API}/download/${fileId}/signed?download=true`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const signedBody = signed.body as SignedUrlResponse;
    expect(signedBody.url).toMatch(/^https?:\/\//);
    expect(signedBody.expiresIn).toBeGreaterThan(0);
    expect(signedBody.fileName).toBeTruthy();

    await api
      .get(`${API}/download/${fileId}/signed`)
      .set(jwt(viewerLogin.access_token))
      .expect(404);
    await api
      .get(`${API}/download/${fileId}/signed`)
      .set(jwt(adminLogin.access_token))
      .expect(404);
  });

  it('authorizes JWT edge-content requests by ownership or DB admin role', async () => {
    await api
      .get(`${API}/edge/content/${fileId}?v=${currentVersionNumber}`)
      .expect(401);

    const owner = await api
      .get(`${API}/edge/content/${fileId}?v=${currentVersionNumber}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    expect(responseBuffer(owner.body as unknown)).toEqual(fileBytes);

    await api
      .get(`${API}/edge/content/${fileId}?v=${currentVersionNumber}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);

    const admin = await api
      .get(`${API}/edge/content/${fileId}?v=${currentVersionNumber}`)
      .set(jwt(adminLogin.access_token))
      .expect(200);
    expect(responseBuffer(admin.body as unknown)).toEqual(fileBytes);
  });

  itWithEdgeSecret(
    'accepts a valid signed edge URL without a JWT',
    async () => {
      const secret = requireSecret(
        edgeSigningSecret,
        'EDGE_URL_SIGNING_SECRET',
      );
      const signed = signEdgeUrl(fileId, currentVersionNumber, 120, secret);

      const response = await api
        .get(
          `${API}/edge/content/${fileId}?v=${currentVersionNumber}&exp=${signed.exp}&sig=${signed.sig}`,
        )
        .expect(200);
      expect(responseBuffer(response.body as unknown)).toEqual(fileBytes);

      const tampered =
        signed.sig.slice(0, -1) + (signed.sig.endsWith('a') ? 'b' : 'a');
      await api
        .get(
          `${API}/edge/content/${fileId}?v=${currentVersionNumber}&exp=${signed.exp}&sig=${tampered}`,
        )
        .expect(401);
    },
  );

  it('redirects regional clients to a signed edge URL when edges are healthy', async () => {
    const routed = await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .set('x-test-client-region', 'ap-south-1');

    expect([200, 302]).toContain(routed.status);

    if (routed.status === 302) {
      const location = routed.headers['location'];
      expect(location).toContain('/edge/content/');
      const edgeUrl = new URL(location);
      expect(edgeUrl.searchParams.get('exp')).toBeTruthy();
      expect(edgeUrl.searchParams.get('sig')).toBeTruthy();

      await api
        .get(
          `${API}/edge/content/${fileId}?v=${currentVersionNumber}&exp=${edgeUrl.searchParams.get(
            'exp',
          )}&sig=${edgeUrl.searchParams.get('sig')}`,
        )
        .expect(200);
    } else {
      expect(responseBuffer(routed.body as unknown)).toEqual(fileBytes);
    }
  });

  it('forbids non-owners from deleting and lets the owner cascade-delete', async () => {
    await api
      .delete(`${API}/metadata/files/${fileId}`)
      .set(jwt(viewerLogin.access_token))
      .expect(403);
    await api
      .delete(`${API}/metadata/files/${fileId}`)
      .set(jwt(adminLogin.access_token))
      .expect(403);

    const deleted = await api
      .delete(`${API}/metadata/files/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(200);
    const deletedBody = deleted.body as { success: boolean; message: string };
    expect(deletedBody.success).toBe(true);
    fileDeleted = true;

    await api
      .get(`${API}/download/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(404);
    await api
      .get(`${API}/metadata/files/${fileId}`)
      .set(jwt(streamerLogin.access_token))
      .expect(404);
  });

  itWithServiceSecret(
    'accepts valid inter-service HMACs and rejects replay/tampering',
    async () => {
      const secret = requireSecret(serviceSecret, 'INTERNAL_SERVICE_SECRET');
      const heartbeatBody = { edgeId: 'edge-node-01' };
      const heartbeatHeaders = signServiceRequest(
        'edge-node-01',
        'POST',
        '/api/v1/admin/health/heartbeat',
        secret,
        heartbeatBody,
      );

      await api
        .post(`${API}/admin/health/heartbeat`)
        .set(heartbeatHeaders)
        .send(heartbeatBody)
        .expect(201);

      const nodesHeaders = signServiceRequest(
        'edge-node-01',
        'GET',
        '/api/v1/admin/health/nodes',
        secret,
      );
      await api.get(`${API}/admin/health/nodes`).set(nodesHeaders).expect(200);

      const tamperedHeaders = {
        ...nodesHeaders,
        'x-service-signature': 'deadbeef'.repeat(8),
      };
      await api
        .get(`${API}/admin/health/nodes`)
        .set(tamperedHeaders)
        .expect(401);

      const staleTimestamp = Date.now() - 10 * 60 * 1000;
      const staleHeaders = signServiceRequest(
        'edge-node-01',
        'GET',
        '/api/v1/admin/health/nodes',
        secret,
        undefined,
        staleTimestamp,
      );
      await api.get(`${API}/admin/health/nodes`).set(staleHeaders).expect(401);
    },
  );

  itWithServiceSecret(
    'rejects unknown edge heartbeats signed with a valid HMAC',
    async () => {
      const secret = requireSecret(serviceSecret, 'INTERNAL_SERVICE_SECRET');
      const body = { edgeId: 'edge-node-99' };
      const headers = signServiceRequest(
        'edge-node-01',
        'POST',
        '/api/v1/admin/health/heartbeat',
        secret,
        body,
      );
      await api
        .post(`${API}/admin/health/heartbeat`)
        .set(headers)
        .send(body)
        .expect(404);
    },
  );
});
