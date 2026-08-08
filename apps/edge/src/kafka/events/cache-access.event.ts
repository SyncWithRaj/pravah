export interface CacheAccessEvent {
  fileId: string;
  eventType: 'hit' | 'miss';
  bytesServed: number;
  downloadLatencyMs: number;
}
