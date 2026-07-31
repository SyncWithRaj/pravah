import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

import { KafkaModule } from '../common/kafka/kafka.module';

@Module({
  imports: [KafkaModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
