import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthenticatedSocketData {
  userId: string;
  role: Role;
}

@WebSocketGateway({
  cors: {
    origin: process.env.DASHBOARD_ORIGIN ?? 'http://localhost:8080',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TelemetryGateway.name);
  private readonly fileOwnerCache = new Map<string, string>();
  private readonly MAX_CACHE_ENTRIES = 10000;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const authObj = client.handshake.auth as
        Record<string, unknown> | undefined;
      const authToken =
        typeof authObj?.token === 'string' ? authObj.token : null;
      const authHeader =
        typeof client.handshake.headers['authorization'] === 'string'
          ? client.handshake.headers['authorization'].replace(/^Bearer\s+/i, '')
          : null;
      const queryToken =
        typeof client.handshake.query?.token === 'string'
          ? client.handshake.query.token
          : null;
      const rawToken = authToken || authHeader || queryToken;

      if (!rawToken) {
        this.logger.warn(
          `Unauthenticated WebSocket connection rejected: ${client.id}`,
        );
        client.disconnect(true);
        return;
      }

      const secret = this.configService.get<string>('JWT_SECRET');
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email?: string;
        role?: Role;
      }>(rawToken, { secret });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true },
      });

      if (!user) {
        this.logger.warn(
          `Telemetry WebSocket authentication failed: user not found in DB ${payload.sub}`,
        );
        client.disconnect(true);
        return;
      }

      const clientData = client.data as { userId?: string; role?: Role };
      clientData.userId = user.id;
      clientData.role = user.role;
      await client.join(`user:${user.id}`);
      await client.join(`role:${user.role}`);

      this.logger.log(
        `Client authenticated on Telemetry WebSocket: ${client.id} (user: ${user.id}, role: ${user.role})`,
      );
      client.emit('connection_ack', {
        status: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(
        `Telemetry WebSocket authentication failed for ${client.id}: ${errorMsg}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(_client: Socket): string {
    return 'pong';
  }

  /**
   * Helper to emit an event only to connected sockets matching a predicate.
   */
  emitToUsers<T>(
    event: string,
    predicate: (user: AuthenticatedSocketData) => boolean,
    payload: T,
  ): void {
    if (!this.server?.sockets?.sockets) {
      return;
    }
    for (const [, socket] of this.server.sockets.sockets) {
      const data = socket.data as Partial<AuthenticatedSocketData>;
      if (data?.userId && data?.role) {
        if (predicate({ userId: data.userId, role: data.role })) {
          socket.emit(event, payload);
        }
      }
    }
  }

  async getFileOwner(fileId: string): Promise<string | null> {
    const cached = this.fileOwnerCache.get(fileId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const file = await this.prisma.file.findUnique({
        where: { id: fileId },
        select: { ownerId: true },
      });
      const ownerId = file?.ownerId ?? null;
      if (ownerId) {
        if (this.fileOwnerCache.size >= this.MAX_CACHE_ENTRIES) {
          this.fileOwnerCache.clear();
        }
        this.fileOwnerCache.set(fileId, ownerId);
      }
      return ownerId;
    } catch (err: unknown) {
      this.logger.error(
        `Failed to resolve owner for file ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async emitToFileOwnerAndAdmin<T>(
    fileId: string,
    event: string,
    payload: T,
  ): Promise<void> {
    const ownerId = await this.getFileOwner(fileId);
    this.emitToUsers(
      event,
      (user) =>
        user.role === Role.ADMIN ||
        (ownerId !== null && user.userId === ownerId),
      payload,
    );
  }

  private emitToAdminsAndStreamers<T>(event: string, payload: T): void {
    this.emitToUsers(
      event,
      (user) => user.role === Role.ADMIN || user.role === Role.STREAMER,
      payload,
    );
  }

  // 1. Upload Progress (chunk-by-chunk) -> emitted only to file owner and ADMIN
  broadcastUploadProgress(data: {
    fileId: string;
    fileName: string;
    chunkIndex: number;
    totalChunks: number;
    percentage: number;
  }) {
    void this.emitToFileOwnerAndAdmin(data.fileId, 'upload.progress', data);
  }

  // 2. Download Activity Stream -> emitted only to file owner and ADMIN
  broadcastDownloadActivity(data: {
    fileId: string;
    edgeId: string;
    region: string;
    status: string;
    latencyMs: number;
    bytes: number;
    timestamp: string;
  }) {
    void this.emitToFileOwnerAndAdmin(data.fileId, 'download.activity', data);
  }

  // 3. Current Bandwidth / Throughput Stream -> emitted only to ADMIN and STREAMER
  broadcastThroughput(data: {
    bandwidthBps: number;
    totalBytesDelivered: number;
    requestsPerSecond: number;
    totalHits: number;
    totalMisses: number;
    hitRatio: number;
  }) {
    this.emitToAdminsAndStreamers('telemetry.throughput', data);
  }

  // 4. Live Cache Hit/Miss Feed -> emitted only to file owner and ADMIN
  broadcastCacheAccess(data: {
    fileId: string;
    version: string;
    edgeId: string;
    region: string;
    eventType: 'hit' | 'miss' | 'peer_fill';
    bytesServed: number;
    downloadLatencyMs: number;
    timestamp: string;
  }) {
    void this.emitToFileOwnerAndAdmin(data.fileId, 'cache.access', data);
  }

  // 5. Active Edge Node Health Map -> emitted only to ADMIN and STREAMER
  broadcastHealthChange(data: {
    edgeId: string;
    oldStatus: string;
    newStatus: string;
    timestamp: string;
  }) {
    this.emitToAdminsAndStreamers('edge.health_changed', data);
  }

  // 6. Replication Queue Status -> emitted only to ADMIN and STREAMER
  broadcastReplicationStatus(data: {
    fileId: string;
    edgeNodeId: string;
    status: string;
    attempts: number;
    timestamp: string;
  }) {
    this.emitToAdminsAndStreamers('replication.status', data);
  }

  // 7. Cache Invalidation Broadcast -> emitted only to file owner and ADMIN
  broadcastCacheInvalidated(data: {
    fileId: string;
    reason?: string;
    timestamp: string;
  }) {
    void this.emitToFileOwnerAndAdmin(data.fileId, 'cache.invalidated', data);
  }

  // 8. Dead Letter Queue (DLQ) Alert Notification -> emitted only to file owner and ADMIN
  broadcastDLQAlert(data: {
    fileId: string;
    edgeNodeId: string;
    attempts: number;
    error: string;
    timestamp: string;
  }) {
    // Sanitize error text to strip raw stacktraces before emission
    const sanitizedError = data.error
      ? data.error.split('\n')[0].substring(0, 250)
      : 'Replication job failed';

    void this.emitToFileOwnerAndAdmin(data.fileId, 'dlq.alert', {
      ...data,
      error: sanitizedError,
    });
  }

  // 9. Self-Healing Dynamic Replication Repair Broadcast -> emitted only to ADMIN and STREAMER
  broadcastReplicationRepaired(data: {
    fileId: string;
    deadNodeId: string;
    replacementNodeId: string;
    timestamp: string;
  }) {
    this.emitToAdminsAndStreamers('replication.repaired', data);
  }
}
