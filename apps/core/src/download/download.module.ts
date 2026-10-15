import { Module } from '@nestjs/common';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';
import { AuthModule } from '../auth/auth.module';
import { CacheManagerModule } from '../common/cache-manager/cache-manager.module';
import { RoutingModule } from '../common/routing/routing.module';

@Module({
  imports: [AuthModule, CacheManagerModule, RoutingModule],
  controllers: [DownloadController],
  providers: [DownloadService],
})
export class DownloadModule {}
