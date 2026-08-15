import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
})
export class TelemetryGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TelemetryGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to Telemetry WebSocket: ${client.id}`);
    client.emit('connection_ack', {
      status: 'connected',
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): string {
    return 'pong';
  }

  // 1. Upload Progress (chunk-by-chunk)
  broadcastUploadProgress(data: {
    fileId: string;
    fileName: string;
    chunkIndex: number;
    totalChunks: number;
    percentage: number;
  }) {
    this.server?.emit('upload.progress', data);
  }

  // 2. Download Activity Stream
  broadcastDownloadActivity(data: {
    fileId: string;
    edgeId: string;
    region: string;
    status: string;
    latencyMs: number;
    bytes: number;
    timestamp: string;
  }) {
    this.server?.emit('download.activity', data);
  }

  // 3. Current Bandwidth / Throughput Stream
  broadcastThroughput(data: {
    bandwidthBps: number;
    totalBytesDelivered: number;
    requestsPerSecond: number;
    totalHits: number;
    totalMisses: number;
    hitRatio: number;
  }) {
    this.server?.emit('telemetry.throughput', data);
  }

  // 4. Live Cache Hit/Miss Feed
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
    this.server?.emit('cache.access', data);
  }

  // 5. Active Edge Node Health Map
  broadcastHealthChange(data: {
    edgeId: string;
    oldStatus: string;
    newStatus: string;
    timestamp: string;
  }) {
    this.server?.emit('edge.health_changed', data);
  }

  // 6. Replication Queue Status
  broadcastReplicationStatus(data: {
    fileId: string;
    edgeNodeId: string;
    status: string;
    attempts: number;
    timestamp: string;
  }) {
    this.server?.emit('replication.status', data);
  }

  // 7. Cache Invalidation Broadcast
  broadcastCacheInvalidated(data: {
    fileId: string;
    reason?: string;
    timestamp: string;
  }) {
    this.server?.emit('cache.invalidated', data);
  }
}
