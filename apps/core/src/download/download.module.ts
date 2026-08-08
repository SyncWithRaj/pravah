import { Module } from '@nestjs/common';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';

import { EdgeCacheModule } from '../common/edge-cache/edge-cache.module';
import { RoutingModule } from '../common/routing/routing.module';

@Module({
  imports: [EdgeCacheModule, RoutingModule],
  controllers: [DownloadController],
  providers: [DownloadService],
})
export class DownloadModule {}
