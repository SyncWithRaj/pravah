import { Module } from '@nestjs/common';
import { EdgeContentController } from './edge-content.controller';
import { CacheManagerModule } from '../common/cache-manager/cache-manager.module';
import { MinioModule } from '../common/minio/minio.module';
import { PrismaModule } from '../prisma/prisma.module';

import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [CacheManagerModule, MinioModule, PrismaModule, JwtModule],
  controllers: [EdgeContentController],
})
export class EdgeContentModule {}
