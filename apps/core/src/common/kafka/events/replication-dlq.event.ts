export interface ReplicationDLQEvent {
  fileId: string;
  versionId: string;
  edgeNodeId: string;
  attempts: number;
  maxAttempts: number;
  error: string;
  stack?: string;
  storagePath: string;
  failedAt: string;
  payload?: Record<string, unknown>;
}
