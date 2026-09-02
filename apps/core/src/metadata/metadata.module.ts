import { Module } from '@nestjs/common';
import { MetadataService } from './metadata.service';
import {
  MetadataController,
  InternalMetadataController,
} from './metadata.controller';
import { KafkaModule } from '../common/kafka/kafka.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, KafkaModule],
  controllers: [MetadataController, InternalMetadataController],
  providers: [MetadataService],
  exports: [MetadataService],
})
export class MetadataModule {}
