import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { FileUploadedEvent } from './events/file-uploaded.event';

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
    this.kafkaClient.emit('file.uploaded', event);
    this.logger.log(`Emitted file.uploaded event for file: ${event.fileId}`);
  }
}
