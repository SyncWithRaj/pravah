# Pravah CDN Security Audit — Verified Findings & Fix Plan

**Date:** 2026-10-16  
**Scope:** `apps/core` (Control Plane), `apps/edge` (Data Plane), `dashboard/` (Admin UI), `infra/` (Docker, Kubernetes, Terraform)  
**Methodology:** Comprehensive manual static code trace and live runtime validation. Every finding below has been verified against the current codebase.

---

## Executive Vulnerability Matrix

| ID | Severity | Category | Description | Primary Affected File(s) |
|---|:---:|---|---|---|
| **V-01** | **CRITICAL** | Auth Bypass / Privilege Escalation | Hardcoded `INTERNAL_SERVICE_SECRET` fallback grants `Role.ADMIN` on all `UnifiedAuthGuard` endpoints | `apps/core/src/auth/guards/inter-service.guard.ts` |
| **V-02** | **CRITICAL** | Broken Access Control | Completely unauthenticated cluster control plane (Cache Purge, Replication Failover, Heartbeat Spoofing, Kafka) | `replication.controller.ts`, `cache-manager.controller.ts`, `health-check.controller.ts` |
| **V-03** | **CRITICAL** | Broken Access Control / IDOR | Unauthenticated internal data plane (`/internal/metadata`, `/internal/placement`, and entire edge service) | `metadata.controller.ts`, `placement.controller.ts`, `edge/content/edge-content.controller.ts` |
| **V-04** | **CRITICAL** | Credential Exposure | Production secrets, database credentials, and signing keys hardcoded & committed in Git | `infra/k8s/02-secrets.yaml`, `infra/terraform/...` |
| **V-05** | **HIGH** | Privilege Escalation | API Key creation DTO lacks runtime validation and defaults omitted role to `STREAMER` | `api-key.controller.ts`, `api-key.service.ts` |
| **V-06** | **HIGH** | IDOR / Trust Boundary | Unauthenticated Redis + trust-the-cache download logic enables cross-tenant object read & substitution | `download.service.ts`, `cache-manager.service.ts` |
| **V-07** | **HIGH** | Path Traversal (CWE-22) | Unsanitized HLS subpath allows arbitrary `*.ts` disk cache read across the host filesystem | `edge/content/edge-content.controller.ts`, `edge/cache/cache.service.ts` |
| **V-08** | **HIGH** | Stored XSS (CWE-79) | Unescaped API key names in dashboard `innerHTML` execute arbitrary scripts and steal admin JWTs | `dashboard/app.js`, `api-key.service.ts` |
| **V-09** | **HIGH** | Information Disclosure | Unauthenticated Telemetry WebSocket gateway broadcasts active file IDs, filenames, and cluster topology | `telemetry.gateway.ts` |
| **V-10** | **HIGH** | Concurrency Race Condition | Race condition in `completeUpload` version allocation and catch-block marking successful files `FAILED` | `upload.service.ts` |
| **V-11** | **HIGH** | Race Condition / Data Loss | `uploadChunk` state validation bypass during assembly + non-atomic chunk reset in `initVersionUpload` | `upload.service.ts` |
| **V-12** | **MEDIUM** | IDOR / Broken Object Level Auth | Transcoding status endpoints verify caller role (`STREAMER`) but omit file ownership check | `transcoding.controller.ts`, `transcoding.service.ts` |
| **V-13** | **MEDIUM** | Denial of Service (OOM) | Unbounded query limits, missing Multer file size limits, and unconstrained `totalChunks` array creation | `init-upload.dto.ts`, `upload.controller.ts`, `get-files-query.dto.ts` |
| **V-14** | **MEDIUM** | Integrity Bypass / Resource Leak | Chunk checksum bypass via `"skip"` and writing chunks to MinIO before slot existence validation | `upload.service.ts`, `upload-chunk.dto.ts` |
| **V-15** | **MEDIUM** | Brute-Force / Resource Exhaustion | Complete absence of rate limiting across authentication, upload, and metadata routes | `main.ts`, `auth.controller.ts` |
| **V-16** | **MEDIUM** | Event Replay / State Desync | Non-deterministic Kafka consumer `groupId` re-processes all historical messages upon every application restart | `apps/core/src/main.ts` |
| **V-17** | **MEDIUM** | Architecture Split-Brain | Core and Edge register BullMQ replication queues against isolated Redis instances; key scheme mismatch | `replication.processor.ts`, `docker-compose.*.yml` |
| **V-18** | **MEDIUM** | Information Disclosure | Internal MinIO storage paths and full job payloads leaked through unauthenticated failed-job endpoint | `replication.controller.ts`, `replication.service.ts` |
| **V-19** | **MEDIUM** | Cryptographic Weakness | Hardcoded fallback signing secret for JWT access tokens (`'super-secret-default-key-change-me'`) | `auth.module.ts`, `jwt.strategy.ts` |
| **V-20** | **MEDIUM** | Broken Session Management | Stateless refresh tokens without persistence, rotation, revocation, or reuse detection | `auth.service.ts` |
| **V-21** | **MEDIUM** | Privilege Escalation / Hierarchy | Symmetric inheritance between `USER` and `VIEWER` roles allows unintended role escalation | `roles.guard.ts` |

---

## Detailed Vulnerability Analysis & Exact Fix Strategies

---

### V-01: Hardcoded `INTERNAL_SERVICE_SECRET` Fallback Grants Blanket ADMIN

- **Severity:** 🔴 CRITICAL
- **CWE:** CWE-798 (Use of Hard-coded Credentials), CWE-287 (Improper Authentication)
- **Affected Files:**
  - [`apps/core/src/auth/guards/inter-service.guard.ts:14-15, 65-67, 94-99`](file:///home/raj/Desktop/pravah/apps/core/src/auth/guards/inter-service.guard.ts#L14-L15)
  - [`apps/core/src/auth/guards/unified-auth.guard.ts:23-27`](file:///home/raj/Desktop/pravah/apps/core/src/auth/guards/unified-auth.guard.ts#L23-L27)
  - [`apps/edge/src/heartbeat/heartbeat.service.ts:20-23`](file:///home/raj/Desktop/pravah/apps/edge/src/heartbeat/heartbeat.service.ts#L20-L23)

#### Vulnerability Mechanics
In `inter-service.guard.ts`:
```typescript
private readonly defaultSecret = 'pravah-internal-microservice-super-secret-2026';
...
const secret = this.configService.get<string>('INTERNAL_SERVICE_SECRET') || this.defaultSecret;
```
When `INTERNAL_SERVICE_SECRET` is not explicitly set in the environment, the guard falls back to `defaultSecret`. When a valid HMAC signature is calculated with this secret, lines 94–99 attach:
```typescript
request.user = {
  id: serviceId,
  email: `${serviceId}@internal.pravah`,
  role: Role.ADMIN,
  isInterService: true,
};
```
Because `UnifiedAuthGuard` evaluates `x-service-signature` first before checking user JWTs or API keys, any caller who reads the source code can forge HMAC signatures and automatically acquire **`Role.ADMIN`** permissions across all endpoints protected by `UnifiedAuthGuard`.

#### Fix Strategy
1. Remove `defaultSecret` completely. Fail fast on application boot if `INTERNAL_SERVICE_SECRET` is missing.
2. Introduce a dedicated `Role.INTERNAL` role rather than granting blanket `Role.ADMIN`.
3. Include the request body hash in the HMAC signature to prevent replay attacks within the 5-minute clock drift window.

```typescript
// apps/core/src/auth/guards/inter-service.guard.ts
const secret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
if (!secret) {
  throw new InternalServerErrorException('INTERNAL_SERVICE_SECRET is not configured');
}

const method = request.method.toUpperCase();
const url = request.url;
const rawBody = JSON.stringify(request.body || {});
const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
const payload = `${serviceId}:${method}:${url}:${timestamp}:${bodyHash}`;

// Assign scoped role instead of Role.ADMIN
request.user = {
  id: serviceId,
  email: `${serviceId}@internal.pravah`,
  role: Role.INTERNAL,
  isInterService: true,
};
```

---

### V-02: Unauthenticated Cluster Control Plane (HTTP & Kafka)

- **Severity:** 🔴 CRITICAL
- **CWE:** CWE-306 (Missing Authentication for Critical Function)
- **Affected Files:**
  - [`apps/core/src/replication/replication.controller.ts:5-6, 93-134`](file:///home/raj/Desktop/pravah/apps/core/src/replication/replication.controller.ts#L5-L6)
  - [`apps/core/src/common/cache-manager/cache-manager.controller.ts:16, 27-44`](file:///home/raj/Desktop/pravah/apps/core/src/common/cache-manager/cache-manager.controller.ts#L16)
  - [`apps/core/src/common/health-check/health-check.controller.ts:12-16`](file:///home/raj/Desktop/pravah/apps/core/src/common/health-check/health-check.controller.ts#L12-L16)
  - [`infra/docker/docker-compose.core.yml:41-45`](file:///home/raj/Desktop/pravah/infra/docker/docker-compose.core.yml#L41-L45)

#### Vulnerability Mechanics
1. **HTTP Surface:** `ReplicationController` and `CacheManagerController` have **no `@UseGuards()` decorator at all**. Anyone can call:
   - `POST /api/v1/admin/cache/purge` and `POST /api/v1/metadata/purge`: Triggers cluster-wide cache wipes.
   - `POST /api/v1/admin/replication/failover/:edgeId`: Forcibly triggers dynamic replication failover, creating mass job storms.
   - `POST /api/v1/admin/replication/retry`: Injects jobs into the queue.
   - `POST /api/v1/admin/health/heartbeat`: Spoofs node health without auth, keeping failing nodes marked as healthy.
2. **Kafka Broker Surface:** Redpanda/Kafka binds to `0.0.0.0:19092` with `PLAINTEXT` and no SASL/SCRAM authentication. Any client on the network can inject `file.uploaded`, `cache.invalidate`, or `edge.health_changed` events.

#### Fix Strategy
1. Secure `ReplicationController` and `CacheManagerController` with `@UseGuards(UnifiedAuthGuard, RolesGuard)` and `@Roles(Role.ADMIN)`.
2. Secure `POST /admin/health/heartbeat` with `InterServiceGuard` and validate that `edgeId` exists in the registered node list.
3. Remove public host port mapping `19092:19092` for Kafka in production or enable SASL authentication.

```typescript
// apps/core/src/replication/replication.controller.ts
@Controller('admin/replication')
@UseGuards(UnifiedAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ReplicationController { ... }

// apps/core/src/common/cache-manager/cache-manager.controller.ts
@Controller(['admin/cache', 'metadata'])
@UseGuards(UnifiedAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CacheManagerController { ... }

// apps/core/src/common/health-check/health-check.controller.ts
@Post('heartbeat')
@UseGuards(InterServiceGuard)
async receiveHeartbeat(@Body() body: { edgeId: string }) {
  if (!this.healthCheckService.isRegistered(body.edgeId)) {
    throw new NotFoundException('Unknown edge node');
  }
  await this.healthCheckService.sendHeartbeat(body.edgeId);
  return { status: 'ok' };
}
```

---

### V-03: Unauthenticated Data Plane (Core Internal APIs & Edge Service)

- **Severity:** 🔴 CRITICAL
- **CWE:** CWE-284 (Improper Access Control), CWE-200 (Exposure of Sensitive Information)
- **Affected Files:**
  - [`apps/core/src/metadata/metadata.controller.ts:52-71`](file:///home/raj/Desktop/pravah/apps/core/src/metadata/metadata.controller.ts#L52-L71) (`InternalMetadataController`)
  - [`apps/core/src/placement/placement.controller.ts:4-16`](file:///home/raj/Desktop/pravah/apps/core/src/placement/placement.controller.ts#L4-L16)
  - [`apps/core/src/edge-content/edge-content.controller.ts:20-40, 123-250`](file:///home/raj/Desktop/pravah/apps/core/src/edge-content/edge-content.controller.ts#L20-L40)
  - [`apps/edge/src/content/edge-content.controller.ts:100-424`](file:///home/raj/Desktop/pravah/apps/edge/src/content/edge-content.controller.ts#L100-L424)

#### Vulnerability Mechanics
- `InternalMetadataController` (`/api/v1/internal/metadata/files/:fileId`) and `PlacementController` (`/api/v1/internal/placement/:fileId/v/:version`) have no auth guards. Anyone can extract internal MinIO storage paths, owner IDs, checksums, and edge replica endpoints.
- `apps/edge/src/content/edge-content.controller.ts` has zero guards. Any client can request any file directly via `GET /edge/content/:fileId?v=1` or evict cache entries via `POST /edge/content/:fileId/purge`.
- Nginx reverse proxy (`infra/nginx/conf.d/edge.conf`) exposes edge ports without token/signature verification.

#### Fix Strategy
1. Guard all `internal/*` controllers on Core using `InterServiceGuard`.
2. Implement HMAC-signed URLs for edge content delivery (`sig`, `exp`). The edge node verifies the signature and expiration timestamp before serving from cache or origin.

```typescript
// Shared Edge Token Utility
export function signEdgeUrl(fileId: string, version: number, expiresInSec: number, secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSec;
  const payload = `${fileId}:${version}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `exp=${expiresAt}&sig=${sig}`;
}

export function verifyEdgeUrl(fileId: string, version: number, expStr: string, sig: string, secret: string): boolean {
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = `${fileId}:${version}:${exp}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
}
```

---

### V-04: Production Secrets & Database Credentials Committed in Git

- **Severity:** 🔴 CRITICAL
- **CWE:** CWE-522 (Insufficiently Protected Credentials)
- **Affected Files:**
  - [`infra/k8s/02-secrets.yaml:13, 15, 18-19, 22-23, 28-29`](file:///home/raj/Desktop/pravah/infra/k8s/02-secrets.yaml#L13)
  - `infra/terraform/ec2-multi-region/modules/core_node/scripts/user_data.sh:48, 54-58`
  - `infra/terraform/ec2-multi-region/modules/edge_node/scripts/user_data.sh:47-48`
  - `infra/terraform/eks-load-test/deploy_and_test.sh:96`

#### Vulnerability Mechanics
Real plaintext passwords and master keys (`POSTGRES_PASSWORD`, `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_SERVICE_SECRET`, `MINIO_SECRET_KEY`) are committed directly to Git in Kubernetes manifests and Terraform bootstrap scripts. Anyone with repository access can decrypt or forge tokens and access the production database.

#### Fix Strategy
1. Rotate all committed secrets immediately (Postgres, MinIO, JWT, HMAC secret).
2. Remove plaintext secrets from Git tracking and use Kubernetes External Secrets Operator, AWS Secrets Manager, or HashiCorp Vault.
3. Clean Git history using `git filter-repo` to eliminate historical plaintext secret commits.

---

### V-05: API Keys Default to `STREAMER` Role (Privilege Escalation)

- **Severity:** 🟠 HIGH
- **CWE:** CWE-269 (Improper Privilege Management), CWE-20 (Improper Input Validation)
- **Affected Files:**
  - [`apps/core/src/auth/api-key/api-key.controller.ts:28-30`](file:///home/raj/Desktop/pravah/apps/core/src/auth/api-key/api-key.controller.ts#L28-L30)
  - [`apps/core/src/auth/api-key/api-key.service.ts:10-14, 37`](file:///home/raj/Desktop/pravah/apps/core/src/auth/api-key/api-key.service.ts#L10-L14)

#### Vulnerability Mechanics
`CreateApiKeyDto` is declared as a TypeScript `interface`:
```typescript
export interface CreateApiKeyDto {
  name: string;
  role?: Role;
  expiresInDays?: number;
}
```
Because it is an interface and not a `class` decorated with `class-validator`, NestJS `ValidationPipe` skips it completely.
In `api-key.controller.ts`:
```typescript
if (dto.role && req.user.role !== Role.ADMIN) {
  dto.role = req.user.role;
}
```
If a standard `USER` or `VIEWER` omits the `role` property in the JSON payload, `dto.role` is `undefined`. The check is bypassed, and line 37 in `api-key.service.ts` assigns the default:
```typescript
role: dto.role || Role.STREAMER
```
The caller's generated API key is granted `Role.STREAMER`. When calling with `x-api-key`, `ApiKeyGuard` assigns `request.user.role = apiKeyRecord.role`, granting access to streamer and upload routes.

#### Fix Strategy
1. Convert `CreateApiKeyDto` to a class with `class-validator` decorators.
2. In the controller, ensure non-admin users always inherit their own role, regardless of whether `dto.role` was provided.
3. In `ApiKeyGuard`, take the authoritative role from `apiKeyRecord.user.role`.

```typescript
// apps/core/src/auth/api-key/dto/create-api-key.dto.ts
export class CreateApiKeyDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

// apps/core/src/auth/api-key/api-key.controller.ts
@Post()
async createApiKey(@Req() req: Request & { user: { id: string; role: Role } }, @Body() dto: CreateApiKeyDto) {
  const role = req.user.role === Role.ADMIN ? (dto.role ?? Role.STREAMER) : req.user.role;
  return this.apiKeyService.createApiKey(req.user.id, { ...dto, role });
}
```

---

### V-06: Cache-Trust BOLA / IDOR & Content Substitution in Download Pipeline

- **Severity:** 🟠 HIGH
- **CWE:** CWE-639 (Authorization Bypass Through User-Controlled Key), CWE-345 (Insufficient Verification of Data Authenticity)
- **Affected Files:**
  - [`apps/core/src/download/download.service.ts:129-157, 167-176, 288-294`](file:///home/raj/Desktop/pravah/apps/core/src/download/download.service.ts#L129-L157)
  - [`apps/core/src/common/cache-manager/cache-manager.service.ts:40-43`](file:///home/raj/Desktop/pravah/apps/core/src/common/cache-manager/cache-manager.service.ts#L40-L43)

#### Vulnerability Mechanics
1. **Unchecked Pointer Resolution:** `resolveCurrentVersion()` checks Redis key `file:{fileId}:current`. If present, it returns immediately without verifying `file.ownerId === userId` against PostgreSQL.
2. **Untrusted Metadata Authorization:** In `processDownload()`, on a cache hit the ownership check relies solely on `metadata.ownerId` retrieved from Redis hash `file:{fileId}:{versionId}:meta`.
3. **Missing Re-Check on MinIO Fallback:** If `metadata` is cached but `getBinary()` misses (file > 20MB or evicted), lines 288–294 fetch `versionRec.storagePath` and stream it directly without re-verifying `versionRec.file.ownerId === userId`.
4. **Unauthenticated Redis:** Redis is exposed without password authentication. An attacker who writes `file:{victimA}:current` pointing to `versionId-of-victimB` and sets `file:{victimA}:{versionId}:meta` with `ownerId: victimA` causes victim A to download victim B's private object.

#### Fix Strategy
1. Always verify file ownership in PostgreSQL inside `resolveCurrentVersion()`.
2. Verify `versionRec.file.ownerId === userId` immediately before streaming from MinIO.
3. Configure `requirepass` on Redis and require password authentication across all Redis clients.

```typescript
// apps/core/src/download/download.service.ts
private async resolveCurrentVersion(userId: string, fileId: string) {
  const file = await this.prisma.file.findUnique({
    where: { id: fileId },
    include: { currentVersion: true },
  });
  if (!file) throw new NotFoundException('File not found');
  if (file.ownerId !== userId) throw new ForbiddenException('Access denied');

  const cached = await this.cacheManagerService.getCurrentVersion(fileId);
  if (cached && cached === file.currentVersionId) return cached;
  
  const versionId = file.currentVersionId || 'v1';
  await this.cacheManagerService.setCurrentVersion(fileId, versionId);
  return versionId;
}
```

---

### V-07: Unauthenticated Path Traversal on Edge HLS Disk Cache

- **Severity:** 🟠 HIGH
- **CWE:** CWE-22 (Improper Limitation of a Pathname to a Restricted Directory)
- **Affected Files:**
  - [`apps/edge/src/content/edge-content.controller.ts:107-110`](file:///home/raj/Desktop/pravah/apps/edge/src/content/edge-content.controller.ts#L107-L110)
  - [`apps/edge/src/cache/cache.service.ts:366-387, 389-414`](file:///home/raj/Desktop/pravah/apps/edge/src/cache/cache.service.ts#L366-L387)

#### Vulnerability Mechanics
In `apps/edge/src/content/edge-content.controller.ts`:
```typescript
const urlParts = req.url.split('/hls/');
const rawSubpath = urlParts[1]?.split('?')[0] || 'master.m3u8';
```
In `apps/edge/src/cache/cache.service.ts`:
```typescript
const diskPath = path.join(this.diskCachePath, fileId, `v${version}`, 'hls', subpath);
return await fs.promises.readFile(diskPath);
```
`path.join()` resolves relative path segments (`../`). Fastify does not reject encoded or unencoded traversal sequences in wildcard parameters. If `subpath` contains `../../../../target.ts`, `path.join` traverses out of `/tmp/pravah-disk-cache` and reads arbitrary `.ts` files from the host filesystem.

#### Fix Strategy
1. Validate `fileId` and `version` against strict alphanumeric regex patterns.
2. Resolve the target path using `path.resolve` and verify that it strictly starts with the expected base directory.

```typescript
// apps/edge/src/cache/cache.service.ts
const baseDir = path.resolve(this.diskCachePath, fileId, `v${version}`, 'hls');
const resolvedPath = path.resolve(baseDir, subpath);

if (!resolvedPath.startsWith(baseDir + path.sep)) {
  throw new BadRequestException('Path traversal detected');
}
```

---

### V-08: Stored XSS in Dashboard Admin Panel

- **Severity:** 🟠 HIGH
- **CWE:** CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Affected Files:**
  - [`dashboard/app.js:1502-1513, 715-727, 1411-1422`](file:///home/raj/Desktop/pravah/dashboard/app.js#L1502-L1513)
  - [`apps/core/src/auth/api-key/api-key.service.ts:10-14`](file:///home/raj/Desktop/pravah/apps/core/src/auth/api-key/api-key.service.ts#L10-L14)

#### Vulnerability Mechanics
API key names and uploaded file names are rendered directly into HTML table rows via template strings:
```javascript
tbody.innerHTML = keys.map(k => `
  <tr>
    <td class="p-3 font-bold text-slate-200">${k.name}</td>
...
```
Because API key creation accepts any arbitrary string without HTML escaping or length limits (V-05), an attacker registers an account, creates an API key with `<img src=x onerror="...">`, and when an administrator visits the Keys view, the script executes in the admin's browser session, stealing `localStorage.getItem('pravah_jwt_token')`.

#### Fix Strategy
1. Implement context-aware HTML escaping for all user-supplied data in `dashboard/app.js`.
2. Add `@Length(1, 100)` and `@Matches(/^[a-zA-Z0-9_\-\.\s]+$/)` validation on API key names in `CreateApiKeyDto`.
3. Add a strict Content Security Policy (`CSP`) to `dashboard/index.html`.

```javascript
// dashboard/app.js
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
// Render safely:
`<td class="p-3 font-bold text-slate-200">${escapeHtml(k.name)}</td>`
```

---

### V-09: Unauthenticated Telemetry WebSocket Broadcasting Sensitive Data

- **Severity:** 🟠 HIGH
- **CWE:** CWE-306 (Missing Authentication for Critical Function), CWE-200 (Exposure of Sensitive Information)
- **Affected Files:**
  - [`apps/core/src/telemetry/telemetry.gateway.ts:11-31, 42-141`](file:///home/raj/Desktop/pravah/apps/core/src/telemetry/telemetry.gateway.ts#L11-L31)

#### Vulnerability Mechanics
`TelemetryGateway` sets `cors: { origin: '*' }` and performs no JWT or API key authentication in `handleConnection()`. Any client can connect over Socket.IO and listen to cluster-wide events:
- `upload.progress`: Exposes `fileId` and `fileName`.
- `cache.access`: Exposes `fileId`, `edgeId`, and `region`.
- `dlq.alert`: Exposes failure details and internal storage keys.

#### Fix Strategy
1. Authenticate WebSocket handshakes using `JwtService`. Disconnect unauthenticated clients immediately.
2. Restrict CORS origin to configured dashboard domains.
3. Emit sensitive telemetry only to sockets belonging to `ADMIN` or the owning user.

```typescript
// apps/core/src/telemetry/telemetry.gateway.ts
async handleConnection(client: Socket) {
  try {
    const token = client.handshake.auth?.token || client.handshake.headers['authorization']?.replace('Bearer ', '');
    if (!token) throw new UnauthorizedException();
    const payload = await this.jwtService.verifyAsync(token);
    client.data.userId = payload.sub;
  } catch {
    client.disconnect(true);
  }
}
```

---

### V-10: Concurrency Race Condition in `completeUpload`

- **Severity:** 🟠 HIGH
- **CWE:** CWE-362 (Concurrent Execution using Shared Resource with Improper Synchronization)
- **Affected Files:**
  - [`apps/core/src/upload/upload.service.ts:262-274, 376-382`](file:///home/raj/Desktop/pravah/apps/core/src/upload/upload.service.ts#L262-L274)

#### Vulnerability Mechanics
In `completeUpload()`:
1. `maxVersion` is queried with `findFirst({ where: { fileId: file.id }, orderBy: { versionNumber: 'desc' } })`.
2. `nextVersionNumber` is computed as `(maxVersion?.versionNumber || 0) + 1`.
3. If two `completeUpload` requests execute concurrently for the same file, both read the same `maxVersion` and compute the same `nextVersionNumber`.
4. The second `fileVersion.create()` fails on unique constraint `@@unique([fileId, versionNumber])`.
5. The `catch (err)` block catches the error and executes:
   ```typescript
   await this.prisma.file.update({
     where: { id: file.id },
     data: { status: FileStatus.FAILED },
   });
   ```
6. The entire file is marked as `FAILED`, overwriting the successful completion from the first thread.

#### Fix Strategy
1. Claim the completion status transition atomically using `updateMany` with a precondition:
   `status: { in: [FileStatus.PENDING, FileStatus.UPLOADING] }`.
2. Only update status to `FAILED` if the current status is `ASSEMBLING`.

```typescript
// apps/core/src/upload/upload.service.ts
const claimed = await this.prisma.file.updateMany({
  where: { id: file.id, status: { in: [FileStatus.PENDING, FileStatus.UPLOADING] } },
  data: { status: FileStatus.ASSEMBLING },
});
if (claimed.count === 0) {
  throw new ConflictException('Upload completion already in progress');
}

try {
  // ... assembly logic
} catch (err) {
  await this.prisma.file.updateMany({
    where: { id: file.id, status: FileStatus.ASSEMBLING },
    data: { status: FileStatus.FAILED },
  });
  throw err;
}
```

---

### V-11: `uploadChunk` State Validation Bypass & Non-Transactional Reset

- **Severity:** 🟠 HIGH
- **CWE:** CWE-362 (Race Condition), CWE-662 (Improper Synchronization)
- **Affected Files:**
  - [`apps/core/src/upload/upload.service.ts:76-104, 137-139, 158-181`](file:///home/raj/Desktop/pravah/apps/core/src/upload/upload.service.ts#L76-L104)

#### Vulnerability Mechanics
1. **Assembly Overwrite Race:** `uploadChunk()` checks `if (file.status === FileStatus.COMPLETED)`. It does NOT check `FileStatus.ASSEMBLING`. A chunk upload arriving during MinIO chunk assembly can overwrite a chunk file in object storage mid-read.
2. **Counter Drift:** In `uploadChunk()`, `file.uploadedChunks` is incremented with `{ increment: 1 }` unconditionally without checking whether the chunk was already `ChunkStatus.VERIFIED`. Retrying a chunk increments the counter multiple times.
3. **Non-Transactional Reset in `initVersionUpload`:** Lines 76–104 execute `deleteMany` of chunks, `file.update`, and `createMany` as 3 separate un-transactioned queries. If the server restarts or errors between steps, the file loses chunk records permanently.

#### Fix Strategy
1. Reject chunk uploads if `file.status !== FileStatus.UPLOADING && file.status !== FileStatus.PENDING`.
2. Only increment `uploadedChunks` if the chunk's previous status was `PENDING`.
3. Wrap `initVersionUpload` operations in a single `prisma.$transaction()`.

```typescript
// apps/core/src/upload/upload.service.ts - in uploadChunk
if (file.status !== FileStatus.PENDING && file.status !== FileStatus.UPLOADING) {
  throw new BadRequestException(`Cannot upload chunks while file is in status ${file.status}`);
}

const existingChunk = await this.prisma.fileChunk.findUnique({
  where: { fileId_chunkIndex: { fileId: file.id, chunkIndex } },
});
if (!existingChunk) throw new BadRequestException('Invalid chunk index');

const isNewVerification = existingChunk.status !== ChunkStatus.VERIFIED;

await this.prisma.$transaction([
  this.prisma.fileChunk.update({
    where: { fileId_chunkIndex: { fileId: file.id, chunkIndex } },
    data: { size: fileBuffer.length, checksum, status: ChunkStatus.VERIFIED },
  }),
  this.prisma.file.update({
    where: { id: file.id },
    data: {
      status: FileStatus.UPLOADING,
      uploadedChunks: isNewVerification ? { increment: 1 } : undefined,
    },
  }),
]);
```

---

### V-12: Transcoding Status IDOR

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-639 (Authorization Bypass Through User-Controlled Key)
- **Affected Files:**
  - [`apps/core/src/transcoding/transcoding.controller.ts:16-45`](file:///home/raj/Desktop/pravah/apps/core/src/transcoding/transcoding.controller.ts#L16-L45)
  - [`apps/core/src/transcoding/transcoding.service.ts:67-82`](file:///home/raj/Desktop/pravah/apps/core/src/transcoding/transcoding.service.ts#L67-L82)

#### Vulnerability Mechanics
`TranscodingController` has `@Roles(Role.ADMIN, Role.STREAMER)` but never passes `user.id` to `transcodingService.getTranscodeStatus(fileId)`. The service queries `videoTranscode.findMany({ where: { fileId } })` without checking file ownership. Any user with role `STREAMER` can query transcode job details for any file in the system.

#### Fix Strategy
Pass `CurrentUser` to the controller and enforce ownership verification in the service:

```typescript
// apps/core/src/transcoding/transcoding.service.ts
async getTranscodeStatus(userId: string, userRole: Role, fileId: string) {
  const file = await this.prisma.file.findUnique({ where: { id: fileId } });
  if (!file) throw new NotFoundException('File not found');
  if (userRole !== Role.ADMIN && file.ownerId !== userId) {
    throw new ForbiddenException('Access denied');
  }
  return this.prisma.videoTranscode.findMany({ where: { fileId } });
}
```

---

### V-13: Unbounded Paging and Upload Memory Denial of Service

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-400 (Uncontrolled Resource Consumption)
- **Affected Files:**
  - [`apps/core/src/metadata/dto/get-files-query.dto.ts:11-16`](file:///home/raj/Desktop/pravah/apps/core/src/metadata/dto/get-files-query.dto.ts#L11-L16)
  - [`apps/core/src/upload/dto/init-upload.dto.ts:22-24`](file:///home/raj/Desktop/pravah/apps/core/src/upload/dto/init-upload.dto.ts#L22-L24)
  - [`apps/core/src/upload/upload.controller.ts:51`](file:///home/raj/Desktop/pravah/apps/core/src/upload/upload.controller.ts#L51)

#### Vulnerability Mechanics
1. `GetFilesQueryDto.limit` has `@Min(1)` with no `@Max()`. Requesting `?limit=1000000` causes massive database memory pressure.
2. `InitUploadDto.totalChunks` has `@Min(1)` with no upper bound. Sending `totalChunks: 1000000` runs `Array.from({ length: 1000000 })` and executes a bulk insert of 1,000,000 rows into PostgreSQL.
3. `FileInterceptor('file')` does not declare Multer limits; large chunk uploads buffer directly in Node.js process RAM.

#### Fix Strategy
Add strict `@Max()` decorators and configure Multer limits:

```typescript
// apps/core/src/metadata/dto/get-files-query.dto.ts
@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 10;

// apps/core/src/upload/dto/init-upload.dto.ts
@IsNumber() @Min(1) @Max(10000) totalChunks!: number;

// apps/core/src/upload/upload.controller.ts
@UseInterceptors(FileInterceptor('file', {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50MB max chunk
}))
```

---

### V-14: Chunk Checksum Bypass via `"skip"` & Orphaned Storage Writes

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-353 (Missing Support for Integrity Check)
- **Affected Files:**
  - [`apps/core/src/upload/upload.service.ts:146-156`](file:///home/raj/Desktop/pravah/apps/core/src/upload/upload.service.ts#L146-L156)

#### Vulnerability Mechanics
1. Sending `checksum: "skip"` bypasses SHA256 integrity verification. The literal string `"skip"` is saved as the verified chunk checksum in PostgreSQL.
2. `this.minioService.uploadChunk()` is called at line 156 before verifying that `chunkIndex` exists in the database. A caller uploading an out-of-bounds `chunkIndex` writes objects into MinIO that have no database record and are never cleaned up.

#### Fix Strategy
1. Remove the `"skip"` bypass branch completely.
2. Verify chunk record existence in PostgreSQL *before* uploading bytes to MinIO.

```typescript
// apps/core/src/upload/upload.service.ts
const chunkRecord = await this.prisma.fileChunk.findUnique({
  where: { fileId_chunkIndex: { fileId: file.id, chunkIndex } },
});
if (!chunkRecord) throw new BadRequestException(`Invalid chunk index ${chunkIndex}`);

const calculatedChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
if (calculatedChecksum.toLowerCase() !== checksum.trim().toLowerCase()) {
  throw new BadRequestException('Checksum mismatch');
}

const chunkStoragePath = `chunks/${file.id}/chunk-${chunkIndex}`;
await this.minioService.uploadChunk(chunkStoragePath, fileBuffer);
```

---

### V-15: Missing Rate Limiting Across All Endpoints

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-307 (Improper Restriction of Excessive Authentication Attempts)
- **Affected Files:**
  - [`apps/core/src/main.ts`](file:///home/raj/Desktop/pravah/apps/core/src/main.ts)
  - [`apps/core/src/auth/auth.controller.ts`](file:///home/raj/Desktop/pravah/apps/core/src/auth/auth.controller.ts)

#### Vulnerability Mechanics
Neither `apps/core` nor `apps/edge` configures `@nestjs/throttler`. Endpoints like `POST /auth/login`, `POST /auth/register`, and `POST /auth/refresh` are vulnerable to high-throughput credential stuffing and user enumeration.

#### Fix Strategy
Register `ThrottlerModule` globally in `AppModule` and apply strict `@Throttle()` decorators on sensitive routes:

```typescript
// apps/core/src/app.module.ts
ThrottlerModule.forRoot([{
  ttl: 60000,
  limit: 100,
}])

// apps/core/src/auth/auth.controller.ts
@Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 attempts per minute
@Post('login')
async login(@Body() dto: LoginDto) { ... }
```

---

### V-16: Non-Deterministic Kafka Consumer Group ID Replaying Historical Events

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-662 (Improper Synchronization)
- **Affected Files:**
  - [`apps/core/src/main.ts:48-51`](file:///home/raj/Desktop/pravah/apps/core/src/main.ts#L48-L51)

#### Vulnerability Mechanics
In `apps/core/src/main.ts`:
```typescript
consumer: {
  groupId: 'pravah-core-edge-' + Math.random().toString(36).substring(7),
}
```
Each application reboot creates a unique random Kafka consumer group ID. Kafka treats this as a brand-new consumer group and replays all retained topic messages (`file.uploaded`, `edge.health_changed`, `cache.invalidate`), triggering redundant replication and mass cache purges.

#### Fix Strategy
Bind `groupId` to a stable configuration value:

```typescript
// apps/core/src/main.ts
consumer: {
  groupId: process.env.KAFKA_GROUP_ID || 'pravah-core-cluster-group',
}
```

---

### V-17: Replication Queue Split-Brain & Key Mismatch Between Core and Edge

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-664 (Improper Control of a Resource Through its Lifetime)
- **Affected Files:**
  - [`apps/core/src/replication/replication.module.ts:25-38`](file:///home/raj/Desktop/pravah/apps/core/src/replication/replication.module.ts#L25-L38)
  - [`apps/core/src/replication/replication.processor.ts:109-114`](file:///home/raj/Desktop/pravah/apps/core/src/replication/replication.processor.ts#L109-L114)
  - [`apps/edge/src/replication/replication.module.ts:14-26`](file:///home/raj/Desktop/pravah/apps/edge/src/replication/replication.module.ts#L14-L26)

#### Vulnerability Mechanics
1. Core connects BullMQ to `REDIS_HOST=redis` (Core Redis), while Edge connects BullMQ to `REDIS_HOST=edge-redis`. Edge nodes never consume jobs dispatched by Core.
2. In `replication.processor.ts`:
   ```typescript
   await this.cacheManagerService.cacheFile(fileId, version.versionNumber.toString(), metadata, fullBuffer);
   ```
   The cache key uses `versionNumber` (e.g. `"1"`), whereas `download.service.ts` looks up cache entries by `versionId` UUID (`"80f677c5-..."`). Populated entries are orphaned and never hit by the download engine.

#### Fix Strategy
1. Standardize cache keys across both replication and download engines to use `version.id`.
2. Connect Edge replication processors to the shared cluster Redis, or implement an authenticated push API from Core to Edge.

```typescript
// apps/core/src/replication/replication.processor.ts
await this.cacheManagerService.cacheFile(
  fileId,
  version.id, // Use UUID consistent with download.service.ts
  metadata,
  fullBuffer,
);
```

---

### V-18: Internal Storage Path Leak via Unauthenticated Failure Endpoints

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor)
- **Affected Files:**
  - [`apps/core/src/replication/replication.controller.ts:107-114`](file:///home/raj/Desktop/pravah/apps/core/src/replication/replication.controller.ts#L107-L114)
  - [`apps/core/src/replication/replication.service.ts:162-168`](file:///home/raj/Desktop/pravah/apps/core/src/replication/replication.service.ts#L162-L168)

#### Vulnerability Mechanics
`GET /admin/replication/failed` is unauthenticated (V-02). The service calls `prisma.replicationStatus.findMany()`, which includes `payload Json?`. The payload contains internal MinIO storage keys (`files/.../v1/file.ext`), edge endpoints, and job metadata.

#### Fix Strategy
Add admin guards and use Prisma `select` projections to exclude `payload`:

```typescript
// apps/core/src/replication/replication.service.ts
async getFailedJobs() {
  return this.prisma.replicationStatus.findMany({
    where: { status: ReplicationJobStatus.FAILED },
    select: {
      id: true,
      fileId: true,
      edgeNodeId: true,
      status: true,
      attempts: true,
      lastError: true,
      createdAt: true,
      // payload explicitly omitted
    },
    orderBy: { updatedAt: 'desc' },
  });
}
```

---

### V-19: Hardcoded Fallback for JWT Signing Secret

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-798 (Use of Hard-coded Credentials)
- **Affected Files:**
  - [`apps/core/src/auth/auth.module.ts:25-27`](file:///home/raj/Desktop/pravah/apps/core/src/auth/auth.module.ts#L25-L27)
  - [`apps/core/src/auth/strategies/jwt.strategy.ts:16-18`](file:///home/raj/Desktop/pravah/apps/core/src/auth/strategies/jwt.strategy.ts#L16-L18)

#### Vulnerability Mechanics
Both `AuthModule` and `JwtStrategy` fall back to `'super-secret-default-key-change-me'` when `JWT_SECRET` is unset. Any deployment with a missing environment variable is vulnerable to arbitrary token forgery.

#### Fix Strategy
Throw on initialization if `JWT_SECRET` is missing and remove the fallback string:

```typescript
// apps/core/src/auth/auth.module.ts
useFactory: (configService: ConfigService) => {
  const secret = configService.get<string>('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET is required');
  return { secret, signOptions: { expiresIn: '15m' } };
}
```

---

### V-20: Stateless Refresh Tokens Without Persistence, Rotation, or Revocation

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-613 (Insufficient Session Expiration)
- **Affected Files:**
  - [`apps/core/src/auth/auth.service.ts:95-134`](file:///home/raj/Desktop/pravah/apps/core/src/auth/auth.service.ts#L95-L134)

#### Vulnerability Mechanics
`refreshToken()` verifies a JWT and issues new tokens without tracking token identity in the database or Redis. A leaked refresh token cannot be revoked, remains valid for 7 days, and can be used concurrently with no reuse detection.

#### Fix Strategy
Implement refresh token rotation and database tracking:
1. Store hashed refresh tokens with family tracking in PostgreSQL or Redis.
2. Invalidate the entire token family upon detection of token reuse.
3. Invalidate all user refresh tokens on password reset.

---

### V-21: Symmetric Role Inheritance Between `USER` and `VIEWER`

- **Severity:** 🟡 MEDIUM
- **CWE:** CWE-269 (Improper Privilege Management)
- **Affected Files:**
  - [`apps/core/src/auth/guards/roles.guard.ts:12-17`](file:///home/raj/Desktop/pravah/apps/core/src/auth/guards/roles.guard.ts#L12-L17)

#### Vulnerability Mechanics
In `roles.guard.ts`:
```typescript
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [Role.ADMIN]: [Role.ADMIN, Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.STREAMER]: [Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.VIEWER]: [Role.VIEWER, Role.USER],
  [Role.USER]: [Role.USER, Role.VIEWER],
};
```
`Role.USER` inherits `Role.VIEWER` and `Role.VIEWER` inherits `Role.USER`. Any endpoint restricted to `@Roles(Role.VIEWER)` will automatically accept any `USER`, breaking intended role differentiation.

#### Fix Strategy
Establish strict hierarchical inheritance:

```typescript
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [Role.ADMIN]: [Role.ADMIN, Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.STREAMER]: [Role.STREAMER, Role.VIEWER, Role.USER],
  [Role.VIEWER]: [Role.VIEWER, Role.USER],
  [Role.USER]: [Role.USER],
};
```

---

## Discarded False Positives & Verified Defenses

During the inspection of the cited files, the following concerns were checked and verified to be safe from exploitation:

1. **SQL / NoSQL Injection:** Verified safe. All database access in `apps/core` utilizes Prisma with typed queries. No `$queryRawUnsafe` or string-concatenated SQL queries exist in the audited controllers or services. Redis Lua scripts strictly parameterize keys and arguments using `KEYS[n]` and `ARGV[n]`.
2. **Command Injection in Transcoding:** Verified safe. `TranscodingProcessor` executes FFmpeg via `spawn(cmd, args)` without `shell: true`. User-provided filenames never enter shell command arguments; working directories and output paths are generated strictly from database UUIDs.
3. **Mass Assignment in Main DTOs:** Verified safe. Global `ValidationPipe` is configured with `whitelist: true` and `forbidNonWhitelisted: true`, preventing unrecognized properties on class-based DTOs. (The exception is unvalidated TypeScript interfaces, which is captured in V-05).
4. **IDOR on Core Download Specific Version:** Verified safe. `downloadSpecificVersion()` delegates execution to `processDownload()`, which checks file ownership against PostgreSQL metadata.
5. **CRLF Header Injection on `Content-Disposition`:** Node.js HTTP parser (`res.setHeader`) rejects carriage returns (`\r`) and newlines (`\n`) by default, preventing HTTP response splitting.
