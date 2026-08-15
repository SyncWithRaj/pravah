export interface CacheAccessEvent {
  fileId: string;
  eventType: 'hit' | 'miss' | 'peer_fill';
  bytesServed: number;
  downloadLatencyMs: number;
  version?: string;
  edgeId?: string;
  region?: string;
  timestamp?: string;
}
