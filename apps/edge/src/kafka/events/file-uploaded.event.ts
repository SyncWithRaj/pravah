export interface FileUploadedEvent {
  eventId: string;
  eventType: 'file.uploaded' | 'file.version_created';
  fileId: string;
  versionId: string;
  ownerId: string;
  objectKey: string;
  bucket: string;
  size: number;
  mimeType: string;
  checksum: string;
  compression: 'none' | 'gzip' | 'br';
  schemaVersion: 1;
  uploadedAt: string;
}
