export interface VideoProcessingRequestedEvent {
  eventId: string;
  fileId: string;
  versionId: string;
  ownerId: string;
  rawStoragePath: string;
  contentType: string;
  sizeBytes: number;
  timestamp: string;
}

export interface VideoTranscodedEvent {
  eventId: string;
  fileId: string;
  versionId: string;
  masterManifestPath: string;
  resolutions: string[];
  totalSegments: number;
  durationSeconds: number;
  timestamp: string;
}
