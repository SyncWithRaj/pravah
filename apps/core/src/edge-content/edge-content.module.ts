import { Module } from '@nestjs/common';
import { EdgeContentController } from './edge-content.controller';
import { EdgeCacheModule } from '../common/edge-cache/edge-cache.module';
import { MinioModule } from '../common/minio/minio.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [EdgeCacheModule, MinioModule, PrismaModule],
  controllers: [EdgeContentController],
})
export class EdgeContentModule {}
