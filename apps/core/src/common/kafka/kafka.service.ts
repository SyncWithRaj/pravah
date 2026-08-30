import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { FileUploadedEvent } from './events/file-uploaded.event';
import { CacheAccessEvent } from './events/cache-access.event';
import { ReplicationDLQEvent } from './events/replication-dlq.event';
import {
  VideoProcessingRequestedEvent,
  VideoTranscodedEvent,
} from './events/video-processing.event';

@Injectable()
export class KafkaService implements OnModuleInit {
  private readonly logger = new Logger(KafkaService.name);

  constructor(
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka,
  ) {}

  async onModuleInit() {
    await this.kafkaClient.connect();
    this.logger.log('Kafka Producer connected successfully');
  }

  emitFileUploaded(event: FileUploadedEvent) {
    this.kafkaClient.emit(event.eventType, event);
    this.logger.log(
      `Emitted ${event.eventType} event for file: ${event.fileId}`,
    );
  }

  emitCacheInvalidate(fileId: string) {
    this.kafkaClient.emit('cache.invalidate', { fileId });
    this.logger.log(`Emitted cache.invalidate event for file: ${fileId}`);
  }

  emitCacheAccess(event: CacheAccessEvent) {
    this.kafkaClient.emit('cache.access', event);
  }

  emitEdgeHealthChanged(edgeId: string, oldStatus: string, newStatus: string) {
    this.kafkaClient.emit('edge.health_changed', {
      edgeId,
      oldStatus,
      newStatus,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(
      `Emitted edge.health_changed: ${edgeId} ${oldStatus} -> ${newStatus}`,
    );
  }

  emitReplicationStatusChanged(
    fileId: string,
    edgeNodeId: string,
    status: string,
    attempts: number,
  ) {
    this.kafkaClient.emit('replication.status_changed', {
      fileId,
      edgeNodeId,
      status,
      attempts,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(
      `Emitted replication.status_changed: ${fileId} -> ${edgeNodeId} (${status})`,
    );
  }

  emitReplicationDLQ(event: ReplicationDLQEvent) {
    this.kafkaClient.emit('file.uploaded.dlq', event);
    this.kafkaClient.emit('replication.dlq', event);
    this.logger.error(
      `Emitted Dead Letter Queue (DLQ) event for file ${event.fileId} -> edge ${event.edgeNodeId} after ${event.attempts} failed attempts`,
    );
  }

  emitVideoProcessingRequested(event: VideoProcessingRequestedEvent) {
    this.kafkaClient.emit('video.processing_requested', event);
    this.logger.log(
      `Emitted video.processing_requested for file: ${event.fileId}`,
    );
  }

  emitVideoTranscoded(event: VideoTranscodedEvent) {
    this.kafkaClient.emit('video.transcoded', event);
    this.logger.log(
      `Emitted video.transcoded for file: ${event.fileId} (${event.resolutions.join(', ')}, ${event.totalSegments} segments)`,
    );
  }
}
