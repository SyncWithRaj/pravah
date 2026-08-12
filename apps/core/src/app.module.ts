import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MinioModule } from './common/minio/minio.module';
import { UploadModule } from './upload/upload.module';
import { DownloadModule } from './download/download.module';
import { MetadataModule } from './metadata/metadata.module';
import { KafkaModule } from './common/kafka/kafka.module';
import { EdgeCacheModule } from './common/edge-cache/edge-cache.module';
import { HealthCheckModule } from './common/health-check/health-check.module';
import { ReplicationModule } from './replication/replication.module';
import { RoutingModule } from './common/routing/routing.module';
import { EdgeContentModule } from './edge-content/edge-content.module';
import { PlacementModule } from './placement/placement.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),

    PrismaModule,

    MinioModule,
    KafkaModule,
    EdgeCacheModule,
    HealthCheckModule,
    ReplicationModule,
    RoutingModule,
    EdgeContentModule,

    AuthModule,
    UploadModule,
    DownloadModule,
    MetadataModule,
    PlacementModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
