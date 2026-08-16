import { Injectable, Logger } from '@nestjs/common';
import { TelemetryGateway } from './telemetry.gateway';
import { Interval } from '@nestjs/schedule';

export interface CacheAccessMessage {
  fileId: string;
  version: string;
  edgeId: string;
  region: string;
  eventType: 'hit' | 'miss' | 'peer_fill';
  bytesServed: number;
  downloadLatencyMs: number;
  timestamp: string;
}

export interface HealthChangeMessage {
  edgeId: string;
  oldStatus: string;
  newStatus: string;
  timestamp: string;
}

export interface ReplicationStatusMessage {
  fileId: string;
  edgeNodeId: string;
  status: string;
  attempts: number;
  timestamp?: string;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  // Real-time In-Memory Counters
  private totalBytesServed = 0;
  private intervalBytes = 0;
  private totalHits = 0;
  private totalMisses = 0;
  private totalPeerFills = 0;
  private intervalRequests = 0;

  constructor(private readonly telemetryGateway: TelemetryGateway) {}

  // Process cache.access event from Kafka / Edge nodes
  handleCacheAccess(data: CacheAccessMessage) {
    this.totalBytesServed += data.bytesServed || 0;
    this.intervalBytes += data.bytesServed || 0;
    this.intervalRequests += 1;

    if (data.eventType === 'hit') {
      this.totalHits += 1;
    } else if (data.eventType === 'peer_fill') {
      this.totalPeerFills += 1;
      this.totalHits += 1;
    } else {
      this.totalMisses += 1;
    }

    // Broadcast live download activity
    this.telemetryGateway.broadcastDownloadActivity({
      fileId: data.fileId,
      edgeId: data.edgeId,
      region: data.region,
      status: data.eventType,
      latencyMs: data.downloadLatencyMs,
      bytes: data.bytesServed,
      timestamp: data.timestamp || new Date().toISOString(),
    });

    // Broadcast cache access feed
    this.telemetryGateway.broadcastCacheAccess(data);
  }

  // Process edge.health_changed event
  handleHealthChange(data: HealthChangeMessage) {
    this.logger.log(
      `[Telemetry] Edge health transition: ${data.edgeId} ${data.oldStatus} -> ${data.newStatus}`,
    );
    this.telemetryGateway.broadcastHealthChange(data);
  }

  // Process replication.status_changed event
  handleReplicationStatus(data: ReplicationStatusMessage) {
    this.telemetryGateway.broadcastReplicationStatus({
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    });
  }

  // Process cache.invalidate event
  handleCacheInvalidation(fileId: string, reason?: string) {
    this.telemetryGateway.broadcastCacheInvalidated({
      fileId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  // Periodic Throughput & Bandwidth Computation (Every 2 seconds)
  @Interval(2000)
  computeAndBroadcastThroughput() {
    const bandwidthBps = Math.round(this.intervalBytes / 2); // bytes per second
    const rps = Math.round((this.intervalRequests / 2) * 10) / 10;
    const totalReqs = this.totalHits + this.totalMisses;
    const hitRatio =
      totalReqs > 0 ? Math.round((this.totalHits / totalReqs) * 100) : 100;

    this.telemetryGateway.broadcastThroughput({
      bandwidthBps,
      totalBytesDelivered: this.totalBytesServed,
      requestsPerSecond: rps,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      hitRatio,
    });

    // Reset window counters
    this.intervalBytes = 0;
    this.intervalRequests = 0;
  }
}
