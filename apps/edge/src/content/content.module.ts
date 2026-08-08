import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EdgeContentController } from './edge-content.controller';
import { CacheModule } from '../cache/cache.module';
import { MinioModule } from '../minio/minio.module';

@Module({
  imports: [HttpModule, CacheModule, MinioModule],
  controllers: [EdgeContentController],
})
export class ContentModule {}
