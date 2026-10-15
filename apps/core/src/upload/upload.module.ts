import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

import { KafkaModule } from '../common/kafka/kafka.module';
import { CacheManagerModule } from '../common/cache-manager/cache-manager.module';
import { TranscodingModule } from '../transcoding/transcoding.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [KafkaModule, CacheManagerModule, TranscodingModule, AuthModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
