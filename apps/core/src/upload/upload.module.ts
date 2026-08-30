import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

import { KafkaModule } from '../common/kafka/kafka.module';
import { EdgeCacheModule } from '../common/edge-cache/edge-cache.module';
import { TranscodingModule } from '../transcoding/transcoding.module';

@Module({
  imports: [KafkaModule, EdgeCacheModule, TranscodingModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
