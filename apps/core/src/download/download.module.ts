import { Module } from '@nestjs/common';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';

import { EdgeCacheModule } from '../common/edge-cache/edge-cache.module';

@Module({
  imports: [EdgeCacheModule],
  controllers: [DownloadController],
  providers: [DownloadService],
})
export class DownloadModule {}
