import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { FileUploadedEvent } from './events/file-uploaded.event';
import { CacheAccessEvent } from './events/cache-access.event';

@Injectable()
export class KafkaService implements OnModuleInit {
  private readonly logger = new Logger(KafkaService.name);

  constructor(
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka,
  ) {}

  async onModuleInit() {
    // Connect the producer when the module initializes
    await this.kafkaClient.connect();
    this.logger.log('Kafka Producer connected successfully');
  }

  /**
   * Emits the file.uploaded event to the Kafka broker.
   */
  emitFileUploaded(event: FileUploadedEvent) {
    this.kafkaClient.emit(event.eventType, event);
    this.logger.log(
      `Emitted ${event.eventType} event for file: ${event.fileId}`,
    );
  }

  /**
   * Emits the cache.invalidate event to broadcast an eviction to all edge nodes.
   */
  emitCacheInvalidate(fileId: string) {
    this.kafkaClient.emit('cache.invalidate', { fileId });
    this.logger.log(`Emitted cache.invalidate event for file: ${fileId}`);
  }

  /**
   * Emits the cache.access event to the Kafka broker for telemetry.
   */
  emitCacheAccess(event: CacheAccessEvent) {
    this.kafkaClient.emit('cache.access', event);
  }

  /**
   * Emits the edge.health_changed event when a node transitions status.
   * Consumed by: Replication Service, Routing Layer, Admin Dashboard.
   */
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
}
